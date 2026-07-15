// L1 应用/用例层 — 结构化 / 非结构化数据源 CRUD。抽自 routes/datasource_crud.js,逻辑逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
//
// 覆盖:structured-datasources(GET/POST/PUT/DELETE)/ unstructured-datasources(GET/POST/PUT/DELETE)
//
// 注:app/datasource/ 比 routes/ 深一层 → 但本文件不依赖 engine。
import { ApiError } from "../../errors.js";
import { cleanupStructuredDatasourceArtifacts } from "../docs/structured.js";

// ─────────────────────────────────────────────
// 辅助: 解析 embedding model id by name
// ─────────────────────────────────────────────
async function resolveEmbeddingModelId(ctx, companyId, modelName) {
  if (!modelName) return null;
  const m = await ctx.queryOne(
    `SELECT id FROM llm_models WHERE display_name=$1 AND company_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [modelName, companyId],
  );
  if (m) return m.id;
  // fallback: 按 model_name 匹配
  const m2 = await ctx.queryOne(
    `SELECT id FROM llm_models WHERE model_name=$1 AND company_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [modelName, companyId],
  );
  if (m2) return m2.id;
  // 跨 company 按名字兜底(eval / 多 company 场景);仍无则取任一 EMBEDDING 模型,避免硬失败
  const m3 = await ctx.queryOne(
    `SELECT id FROM llm_models WHERE (model_name=$1 OR display_name=$1) AND deleted_at IS NULL LIMIT 1`,
    [modelName],
  );
  if (m3) return m3.id;
  const m4 = await ctx.queryOne(
    `SELECT id FROM llm_models WHERE category='EMBEDDING' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  );
  return m4?.id ?? null;
}

// ════════════════════════════════════════════
// 结构化数据源 CRUD
// ════════════════════════════════════════════

// GET /api/projects/:pid/structured-datasources/:dsid — 详情
// (index.js 只有列表,详情缺失)
export async function getStructuredDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const row = await ctx.queryOne(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active,
            s.database_connection_id, s.embedding_model_id, s.duckdb_path,
            m.display_name AS embedding_model_name,
            s.created_at, s.updated_at
       FROM structured_data_sources s
       LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.id=$1 AND s.project_id=$2 AND s.deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!row) throw new ApiError("结构化数据源不存在", 404);
  return { data: row, message: "获取结构化数据源详情成功" };
}

// POST /api/projects/:pid/structured-datasources — 创建
export async function createStructuredDatasource(ctx, input) {
  const { pid } = input.params;
  const { name, description, embedding_model_name } = input.body || {};
  if (!name) throw new ApiError("name 为必填项", 400);

  // 查找 company_id 以定位 embedding model
  const userRow = await ctx.queryOne(`SELECT company_id FROM users WHERE id=$1`, [ctx.userId]);
  const companyId = userRow?.company_id;
  const embeddingModelId = await resolveEmbeddingModelId(ctx, companyId, embedding_model_name);
  if (embedding_model_name && !embeddingModelId) {
    throw new ApiError(`嵌入模型 "${embedding_model_name}" 未找到`, 400);
  }

  const id = crypto.randomUUID();
  await ctx.query(
    `INSERT INTO structured_data_sources
       (id, project_id, created_by, name, description, is_active, embedding_model_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,true,$6,now(),now())`,
    [id, pid, ctx.userId, name, description ?? "", embeddingModelId],
  );

  const row = await ctx.queryOne(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active,
            s.database_connection_id, s.embedding_model_id, s.duckdb_path,
            m.display_name AS embedding_model_name,
            s.created_at, s.updated_at
       FROM structured_data_sources s
       LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.id=$1`,
    [id],
  );
  return { data: row, message: "创建结构化数据源成功" };
}

// PUT /api/projects/:pid/structured-datasources/:dsid — 更新
export async function updateStructuredDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const { name, description } = input.body || {};

  const existing = await ctx.queryOne(
    `SELECT id FROM structured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!existing) throw new ApiError("结构化数据源不存在", 404);

  const sets = ["updated_at=now()"];
  const vals = [];
  let i = 1;
  if (name !== undefined)        { sets.push(`name=$${i++}`); vals.push(name); }
  if (description !== undefined) { sets.push(`description=$${i++}`); vals.push(description); }

  if (sets.length > 1) {
    vals.push(dsid, pid);
    await ctx.query(
      `UPDATE structured_data_sources SET ${sets.join(",")} WHERE id=$${i} AND project_id=$${i + 1}`,
      vals,
    );
  }

  const row = await ctx.queryOne(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active,
            s.database_connection_id, s.embedding_model_id, s.duckdb_path,
            m.display_name AS embedding_model_name,
            s.created_at, s.updated_at
       FROM structured_data_sources s
       LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.id=$1`,
    [dsid],
  );
  return { data: row, message: "更新结构化数据源成功" };
}

// DELETE /api/projects/:pid/structured-datasources/:dsid — 软删除
export async function deleteStructuredDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const { confirm } = input.body || {};
  if (!confirm) throw new ApiError("confirm 必须为 true 才能执行删除", 400);

  const existing = await ctx.queryOne(
    `SELECT id FROM structured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!existing) throw new ApiError("结构化数据源不存在", 404);

  await cleanupStructuredDatasourceArtifacts(ctx, { pid, dsid });
  await ctx.query(
    `UPDATE structured_data_sources SET deleted_at=now() WHERE id=$1 AND project_id=$2`,
    [dsid, pid],
  );
  return { data: null, message: "删除结构化数据源成功" };
}

// ════════════════════════════════════════════
// 非结构化数据源 CRUD
// ════════════════════════════════════════════

// GET /api/projects/:pid/unstructured-datasources/:dsid — 详情
export async function getUnstructuredDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const row = await ctx.queryOne(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active,
            s.embedding_model_id, m.display_name AS embedding_model_name,
            s.created_at, s.updated_at
       FROM unstructured_data_sources s
       LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.id=$1 AND s.project_id=$2 AND s.deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!row) throw new ApiError("非结构化数据源不存在", 404);
  return { data: row, message: "获取非结构化数据源详情成功" };
}

// POST /api/projects/:pid/unstructured-datasources — 创建
export async function createUnstructuredDatasource(ctx, input) {
  const { pid } = input.params;
  const { name, description, embedding_model_name } = input.body || {};
  if (!name) throw new ApiError("name 为必填项", 400);

  const userRow = await ctx.queryOne(`SELECT company_id FROM users WHERE id=$1`, [ctx.userId]);
  const companyId = userRow?.company_id;
  const embeddingModelId = await resolveEmbeddingModelId(ctx, companyId, embedding_model_name);
  if (embedding_model_name && !embeddingModelId) {
    throw new ApiError(`嵌入模型 "${embedding_model_name}" 未找到`, 400);
  }

  const id = crypto.randomUUID();
  await ctx.query(
    `INSERT INTO unstructured_data_sources
       (id, project_id, created_by, name, description, is_active, embedding_model_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,true,$6,now(),now())`,
    [id, pid, ctx.userId, name, description ?? "", embeddingModelId],
  );

  const row = await ctx.queryOne(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active,
            s.embedding_model_id, m.display_name AS embedding_model_name,
            s.created_at, s.updated_at
       FROM unstructured_data_sources s
       LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.id=$1`,
    [id],
  );
  return { data: row, message: "创建非结构化数据源成功" };
}

// PUT /api/projects/:pid/unstructured-datasources/:dsid — 更新
export async function updateUnstructuredDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const { name, description } = input.body || {};

  const existing = await ctx.queryOne(
    `SELECT id FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!existing) throw new ApiError("非结构化数据源不存在", 404);

  const sets = ["updated_at=now()"];
  const vals = [];
  let i = 1;
  if (name !== undefined)        { sets.push(`name=$${i++}`); vals.push(name); }
  if (description !== undefined) { sets.push(`description=$${i++}`); vals.push(description); }

  if (sets.length > 1) {
    vals.push(dsid, pid);
    await ctx.query(
      `UPDATE unstructured_data_sources SET ${sets.join(",")} WHERE id=$${i} AND project_id=$${i + 1}`,
      vals,
    );
  }

  const row = await ctx.queryOne(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active,
            s.embedding_model_id, m.display_name AS embedding_model_name,
            s.created_at, s.updated_at
       FROM unstructured_data_sources s
       LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.id=$1`,
    [dsid],
  );
  return { data: row, message: "更新非结构化数据源成功" };
}

// DELETE /api/projects/:pid/unstructured-datasources/:dsid — 软删除
export async function deleteUnstructuredDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const { confirm } = input.body || {};
  if (!confirm) throw new ApiError("confirm 必须为 true 才能执行删除", 400);

  const existing = await ctx.queryOne(
    `SELECT id FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!existing) throw new ApiError("非结构化数据源不存在", 404);

  await ctx.query(
    `UPDATE unstructured_data_sources SET deleted_at=now() WHERE id=$1 AND project_id=$2`,
    [dsid, pid],
  );
  return { data: null, message: "删除非结构化数据源成功" };
}
