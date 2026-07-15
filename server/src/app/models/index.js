// L1 应用/用例层 — LLM 模型 CRUD / 测试连接 / 项目模型 / 项目网络搜索模型。
// 抽自 index.js,逻辑逐行对齐。签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
//
// 覆盖:
//   /api/llm_model/{active,create,delete,detail,llm_models,test-config,update}
//   /api/projects/:pid/models
//   /api/projects/:pid/web-search-models
//
// 注:app/models/ 比 routes/ 深一层 → engine/db 用 ../../。
// getCompanyId / MODEL_COLS / normApiFormat / toExtraConfigText / testModelConnection
// 为 index.js 私有 helper,按 recipe 复制到本文件;LLM 请求工具复用 engine/core/llm.js。
import {
  buildRequestHeaders,
  buildRequestData,
  getApiUrl,
  extractErrorDetail,
  ResponseExtractor,
  invalidateModelConfigCache,
} from '../../engine/core/llm.js';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../errors.js';
import { resumeEmbeddingFailedDocuments } from '../../engine/datasources/unstructured/document_processing_service.js';
import { listBlockedBackgroundJobs } from '../../engine/jobs/background_jobs.js';

export function shouldResumeEmbeddingDocuments(model) {
  return String(model?.category || '').toUpperCase() === 'EMBEDDING' && model?.is_enabled !== false;
}

function scheduleEmbeddingRecovery(model, ctx) {
  if (!shouldResumeEmbeddingDocuments(model)) return;
  queueMicrotask(async () => {
    await resumeEmbeddingFailedDocuments()
      .catch((e) => console.warn(`[models] 自动恢复文档向量失败: ${e?.message ?? e}`));
    try {
      const blocked = listBlockedBackgroundJobs('schema_vector_batch');
      if (!blocked.length) return;
      const { storeVectors } = await import('../datasource/tables.js');
      for (const job of blocked) {
        await storeVectors(ctx, {
          params: { pid: job.project_id, cid: job.resource_id },
          query: {},
          body: { retry_job_id: job.id, session_id: job.session_id || null, only_pending: false },
        });
      }
    } catch (e) {
      console.warn(`[models] 自动恢复 schema 向量失败: ${e?.message ?? e}`);
    }
  });
}

async function getCompanyId(ctx, userId) {
  const u = await ctx.queryOne(`SELECT company_id FROM users WHERE id=$1`, [userId]);
  return u?.company_id;
}

// 项目模型配置(复制自 index.js)
const MODEL_COLS = `id, model_name, display_name, category, api_base, supports_streaming, dimension,
  is_enabled, company_id, project_id, extra_config, api_format, created_at, updated_at`;
const VALID_API_FORMATS = new Set(['anthropic', 'chat_completions', 'responses']);
const normApiFormat = (v) => (VALID_API_FORMATS.has(v) ? v : 'chat_completions');

// 系统级模型 CRUD：每角色(PRIMARY/SECONDARY/EMBEDDING)每公司最多一个系统级模型(project_id IS NULL)。
const VALID_MODEL_CATEGORIES = new Set(['PRIMARY', 'SECONDARY', 'EMBEDDING']);
// extra_config 以 JSON 文本存(对齐 Python json.dumps + Text 列);对象→字符串,字符串原样,空→null。
const toExtraConfigText = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() ? v : null;
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return null; }
  }
  return String(v);
};

// 实测模型连通性(对标 backend/core/llm/embed.py test_client)。返回 {success,message,test_type,...}
async function testModelConnection(config) {
  const category = String(config.category || 'PRIMARY').toUpperCase();
  const testType = category === 'EMBEDDING' ? 'embedding_test' : 'llm_test';
  try {
    if (category === 'EMBEDDING') {
      const base = String(config.api_base || '').replace(/\/+$/, '');
      if (!base) throw new Error('缺少 API Base URL');
      const url = /\/embeddings$/.test(base) ? base : `${base}/embeddings`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: buildRequestHeaders(config),
        body: JSON.stringify({ model: config.model_name, input: ['测试文本'] }),
      });
      if (!resp.ok) {
        const detail = extractErrorDetail(await resp.text().catch(() => ''));
        return { success: false, message: `连接失败: ${detail}`, test_type: testType };
      }
      const data = await resp.json();
      let vectors = [];
      try { vectors = ResponseExtractor.extract_embedding(data) || []; } catch { vectors = []; }
      const vec = vectors[0];
      if (Array.isArray(vec) && vec.length) {
        return {
          success: true, message: '连接成功', model: config.model_name, api_base: config.api_base || '',
          dimension: vec.length, vector_preview: vec.slice(0, 10), vector_full: vec, test_type: testType,
        };
      }
      return { success: false, message: '响应格式错误', test_type: testType };
    }

    // chat 模型：发一条极小请求并关闭原生 thinking(否则思考占满 max_tokens 误判失败)
    const body = buildRequestData(config, {
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.3,
      max_tokens: 16,
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    const resp = await fetch(getApiUrl(config), {
      method: 'POST',
      headers: buildRequestHeaders(config),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = extractErrorDetail(await resp.text().catch(() => ''));
      return { success: false, message: `连接失败: ${detail}`, test_type: testType };
    }
    const data = await resp.json();
    let content = null;
    try { content = ResponseExtractor.extract_chat_content(data); } catch { content = null; }
    if (content) {
      return {
        success: true, message: '连接成功', model: config.model_name, api_base: config.api_base || '',
        response_preview: String(content).slice(0, 50), test_type: testType,
      };
    }
    let finish = '';
    try { finish = data?.choices?.[0]?.finish_reason || ''; } catch { /* ignore */ }
    const message = finish === 'length'
      ? '模型输出被 max_tokens 截断且 content 为空，常见于推理模型未关闭思考；请确认该模型支持 enable_thinking=false'
      : `响应中无可用 content（finish_reason=${finish || 'unknown'}）`;
    return { success: false, message, test_type: testType };
  } catch (e) {
    return { success: false, message: `连接失败: ${e?.message || e}`, test_type: testType };
  }
}

// ════════════════════════════════════════════
// 项目模型 / 公司可用模型 / 启用模型
// ════════════════════════════════════════════

// GET /api/projects/:pid/models — 项目级模型(company_id + project_id)
export async function listProjectModels(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const params = [cid, input.params.pid];
  let sql = `SELECT ${MODEL_COLS} FROM llm_models WHERE company_id=$1 AND project_id=$2 AND deleted_at IS NULL`;
  if (input.query.category) { params.push(input.query.category); sql += ` AND category=$3`; }
  sql += ` ORDER BY created_at DESC`;
  const rows = await ctx.query(sql, params);
  return { data: { items: rows, total: rows.length }, message: '获取项目模型成功' };
}

// POST /api/projects/:pid/models — 项目级模型,每项目每角色最多一个。
export async function createProjectModel(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const pid = input.params.pid;
  const b = input.body || {};
  const category = String(b.category || 'PRIMARY').toUpperCase();
  if (!VALID_MODEL_CATEGORIES.has(category)) {
    throw new ApiError('无效的模型类别，支持: EMBEDDING, PRIMARY, SECONDARY', 400);
  }
  if (!b.model_name || !b.api_base) throw new ApiError('模型名称与 API 地址不能为空', 400);

  const exist = await ctx.queryOne(
    `SELECT id FROM llm_models
      WHERE company_id=$1 AND project_id=$2 AND category=$3 AND deleted_at IS NULL LIMIT 1`,
    [cid, pid, category],
  );
  if (exist) throw new ApiError('该项目该角色已有模型，请先编辑或删除现有模型', 400);

  const id = randomUUID();
  const dimension = category === 'EMBEDDING' ? (b.dimension ?? 1024) : (b.dimension ?? null);
  await ctx.query(
    `INSERT INTO llm_models
       (id, company_id, project_id, model_name, display_name, category, api_base, api_key,
        supports_streaming, dimension, is_enabled, extra_config, api_format, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,now(),now())`,
    [id, cid, pid, b.model_name, b.display_name || b.model_name, category, b.api_base, b.api_key || null,
     b.supports_streaming !== false, dimension, toExtraConfigText(b.extra_config), normApiFormat(b.api_format)],
  );
  invalidateModelConfigCache();
  const row = await ctx.queryOne(`SELECT ${MODEL_COLS} FROM llm_models WHERE id=$1`, [id]);
  return { data: row, message: '创建项目模型成功' };
}

// PUT /api/projects/:pid/models — 更新项目级模型。
export async function updateProjectModel(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const pid = input.params.pid;
  const b = input.body || {};
  if (!b.id) throw new ApiError('缺少模型ID', 400);
  const model = await ctx.queryOne(
    `SELECT id FROM llm_models
      WHERE id=$1 AND company_id=$2 AND project_id=$3 AND deleted_at IS NULL`,
    [b.id, cid, pid],
  );
  if (!model) throw new ApiError('模型不存在', 404);

  const sets = [];
  const params = [];
  let i = 1;
  const setCol = (col, val) => { sets.push(`${col}=$${i++}`); params.push(val); };
  if (b.model_name != null) setCol('model_name', b.model_name);
  if (b.display_name != null) setCol('display_name', b.display_name);
  if (b.category != null) setCol('category', String(b.category).toUpperCase());
  if (b.api_base != null) setCol('api_base', b.api_base);
  if (b.api_key != null && !String(b.api_key).includes('****') && String(b.api_key) !== '') setCol('api_key', b.api_key);
  if (b.supports_streaming != null) setCol('supports_streaming', b.supports_streaming);
  if (b.dimension != null) setCol('dimension', b.dimension);
  if (b.is_enabled != null) setCol('is_enabled', b.is_enabled);
  if (b.api_format != null) setCol('api_format', normApiFormat(b.api_format));
  if (b.extra_config !== undefined) setCol('extra_config', toExtraConfigText(b.extra_config));
  sets.push('updated_at=now()');
  params.push(b.id, cid, pid);
  await ctx.query(
    `UPDATE llm_models SET ${sets.join(', ')}
      WHERE id=$${i++} AND company_id=$${i++} AND project_id=$${i++}`,
    params,
  );
  invalidateModelConfigCache();
  const row = await ctx.queryOne(`SELECT ${MODEL_COLS} FROM llm_models WHERE id=$1`, [b.id]);
  return { data: row, message: '更新项目模型成功' };
}

// DELETE /api/projects/:pid/models/:modelId — 删除项目级模型。
export async function deleteProjectModel(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const { pid, modelId } = input.params;
  if (!modelId) throw new ApiError('缺少模型ID', 400);
  const model = await ctx.queryOne(
    `SELECT id FROM llm_models
      WHERE id=$1 AND company_id=$2 AND project_id=$3 AND deleted_at IS NULL`,
    [modelId, cid, pid],
  );
  if (!model) throw new ApiError('模型不存在', 404);
  await ctx.query(
    `UPDATE llm_models SET deleted_at=now(), deleted_by=$1, updated_at=now()
      WHERE id=$2 AND company_id=$3 AND project_id=$4`,
    [ctx.userId, modelId, cid, pid],
  );
  invalidateModelConfigCache();
  return { data: null, message: '删除项目模型成功' };
}

// GET /api/llm_model/llm_models — 公司可用系统级模型(project_id IS NULL)
export async function listModels(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const params = [cid];
  let sql = `SELECT ${MODEL_COLS} FROM llm_models WHERE company_id=$1 AND project_id IS NULL AND deleted_at IS NULL`;
  if (input.query.category) { params.push(input.query.category); sql += ` AND category=$2`; }
  sql += ` ORDER BY created_at DESC`;
  const rows = await ctx.query(sql, params);
  return { data: { items: rows, total: rows.length }, message: '获取模型列表成功' };
}

// GET /api/llm_model/active — 启用中的模型
export async function listActiveModels(ctx, _input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const rows = await ctx.query(
    `SELECT ${MODEL_COLS} FROM llm_models WHERE company_id=$1 AND is_enabled=true AND deleted_at IS NULL`,
    [cid],
  );
  return { data: { items: rows, total: rows.length }, message: '获取启用模型成功' };
}

// ════════════════════════════════════════════
// 系统级模型 CRUD
// ════════════════════════════════════════════

// POST /api/llm_model/create
export async function createModel(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const b = input.body || {};
  const category = String(b.category || 'PRIMARY').toUpperCase();
  if (!VALID_MODEL_CATEGORIES.has(category)) {
    throw new ApiError('无效的模型类别，支持: EMBEDDING, PRIMARY, SECONDARY', 400);
  }
  if (!b.model_name || !b.api_base) throw new ApiError('模型名称与 API 地址不能为空', 400);
  // 单槽约束：该角色已有系统级模型则拒绝(让用户改/删)
  const exist = await ctx.queryOne(
    `SELECT id FROM llm_models WHERE company_id=$1 AND project_id IS NULL AND category=$2 AND deleted_at IS NULL LIMIT 1`,
    [cid, category],
  );
  if (exist) throw new ApiError('该角色已有模型，请先编辑或删除现有模型', 400);

  const id = randomUUID();
  const dimension = category === 'EMBEDDING' ? (b.dimension ?? 1024) : (b.dimension ?? null);
  await ctx.query(
    `INSERT INTO llm_models
       (id, company_id, project_id, model_name, display_name, category, api_base, api_key,
        supports_streaming, dimension, is_enabled, extra_config, api_format, created_at, updated_at)
     VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,now(),now())`,
    [id, cid, b.model_name, b.display_name || b.model_name, category, b.api_base, b.api_key || null,
     b.supports_streaming !== false, dimension, toExtraConfigText(b.extra_config), normApiFormat(b.api_format)],
  );
  invalidateModelConfigCache();
  const row = await ctx.queryOne(`SELECT ${MODEL_COLS} FROM llm_models WHERE id=$1`, [id]);
  scheduleEmbeddingRecovery(row, ctx);
  return { data: row, message: '创建模型成功' };
}

// POST /api/llm_model/update
export async function updateModel(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const b = input.body || {};
  if (!b.id) throw new ApiError('缺少模型ID', 400);
  const model = await ctx.queryOne(
    `SELECT id FROM llm_models WHERE id=$1 AND company_id=$2 AND project_id IS NULL AND deleted_at IS NULL`,
    [b.id, cid],
  );
  if (!model) throw new ApiError('模型不存在', 404);

  // 只更新显式传入的字段(None 不覆盖);不动 id/company_id/project_id/created_at。
  const sets = [];
  const params = [];
  let i = 1;
  const setCol = (col, val) => { sets.push(`${col}=$${i++}`); params.push(val); };
  if (b.model_name != null) setCol('model_name', b.model_name);
  if (b.display_name != null) setCol('display_name', b.display_name);
  if (b.category != null) setCol('category', String(b.category).toUpperCase());
  if (b.api_base != null) setCol('api_base', b.api_base);
  // api_key 含脱敏标记 **** → 不是真实 key,忽略(保留原 key)
  if (b.api_key != null && !String(b.api_key).includes('****')) setCol('api_key', b.api_key);
  if (b.supports_streaming != null) setCol('supports_streaming', b.supports_streaming);
  if (b.dimension != null) setCol('dimension', b.dimension);
  if (b.is_enabled != null) setCol('is_enabled', b.is_enabled);
  if (b.api_format != null) setCol('api_format', normApiFormat(b.api_format));
  if (b.extra_config !== undefined) setCol('extra_config', toExtraConfigText(b.extra_config));
  sets.push('updated_at=now()');
  params.push(b.id, cid);
  await ctx.query(
    `UPDATE llm_models SET ${sets.join(', ')} WHERE id=$${i++} AND company_id=$${i++}`,
    params,
  );
  invalidateModelConfigCache();
  const row = await ctx.queryOne(`SELECT ${MODEL_COLS} FROM llm_models WHERE id=$1`, [b.id]);
  scheduleEmbeddingRecovery(row, ctx);
  return { data: row, message: '更新模型成功' };
}

// POST /api/llm_model/delete
export async function deleteModel(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const id = input.body?.model_id;
  if (!id) throw new ApiError('缺少模型ID', 400);
  const model = await ctx.queryOne(
    `SELECT id FROM llm_models WHERE id=$1 AND company_id=$2 AND project_id IS NULL AND deleted_at IS NULL`,
    [id, cid],
  );
  if (!model) throw new ApiError('模型不存在', 404);
  await ctx.query(
    `UPDATE llm_models SET deleted_at=now(), deleted_by=$1, updated_at=now() WHERE id=$2 AND company_id=$3`,
    [ctx.userId, id, cid],
  );
  invalidateModelConfigCache();
  return { data: null, message: '删除模型成功' };
}

// GET /api/llm_model/detail — 返回完整 api_key(编辑模式回填用)
export async function getModelDetail(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const id = input.query.model_id;
  if (!id) throw new ApiError('缺少模型ID', 400);
  const row = await ctx.queryOne(
    `SELECT ${MODEL_COLS}, api_key FROM llm_models
      WHERE id=$1 AND company_id=$2 AND project_id IS NULL AND deleted_at IS NULL`,
    [id, cid],
  );
  if (!row) throw new ApiError('模型不存在', 404);
  return { data: row, message: '获取模型详情成功' };
}

// POST /api/llm_model/test-config — 用未保存的临时配置实测一次
export async function testModelConfig(_ctx, input) {
  const b = input.body || {};
  const config = {
    model_name: b.model_name,
    category: String(b.category || 'PRIMARY').toUpperCase(),
    api_base: b.api_base,
    api_key: b.api_key,
    api_format: normApiFormat(b.api_format),
    supports_streaming: b.supports_streaming !== false,
    dimension: b.dimension,
    extra_config: {
      input_field: b.input_field || 'input',
      extra_headers: b.extra_headers,
      extra_body: b.extra_body,
    },
  };
  const result = await testModelConnection(config);
  return { data: result, message: '测试模型配置成功' };
}

// ════════════════════════════════════════════
// 项目网络搜索模型
// ════════════════════════════════════════════

// GET /api/projects/:pid/web-search-models
export async function listProjectWebSearchModels(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, name, model, api, description, config_type, is_default, created_at
       FROM web_search_models WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: '获取网络搜索模型成功' };
}
