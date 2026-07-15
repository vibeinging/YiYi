// L1 应用/用例层 — 非结构化文档管理 + RAG ingest。抽自 routes/unstructured_docs.js,逻辑逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
// 桌面版:文件已在本地磁盘(Electron 原生选择器给 file_path),后端直接读本地路径处理,无需 multipart 上传。
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { ApiError } from "../../errors.js";
import { UnstructuredDataSource } from "../../engine/datasources/unstructured_data_source.js";
import { enqueueProcessDocument } from "../../engine/datasources/unstructured/document_processing_service.js";
import { SUPPORTED_EXTS } from "../../engine/datasources/unstructured/document_loaders.js";
import { createBackgroundJob, latestResourceJob, updateBackgroundJob } from "../../engine/jobs/background_jobs.js";
import {
  generateDocumentsDescriptions,
  generateDatasourceDescription,
} from "../../engine/datasources/unstructured/document_description_service.js";

// 创建文档(本地文件)+ 处理
export async function createDocument(ctx, input) {
  const { pid, dsid } = input.params;
  const body = input.body || {};
  const filePath = body.file_path || body.filePath || body.path;
  if (!filePath) throw new ApiError("缺少 file_path(本地文件路径)", 400);
  if (!existsSync(filePath)) throw new ApiError(`文件不存在: ${filePath}`, 400);
  const ext = extname(filePath).slice(1).toLowerCase();
  if (!SUPPORTED_EXTS.includes(ext)) {
    throw new ApiError(`不支持的文档类型 .${ext}(支持 ${SUPPORTED_EXTS.join('/')})`, 400);
  }
  const src = await ctx.queryOne(
    `SELECT id FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  ).catch(() => null);
  if (!src) throw new ApiError("非结构化数据源不存在", 404);

  const bound = await ctx.queryOne(
    `SELECT id FROM business_data_sources
      WHERE project_id=$1 AND source_type='unstructured_data_source' AND source_id=$2 AND deleted_at IS NULL`,
    [pid, dsid],
  );
  if (!bound) {
    await ctx.query(
      `INSERT INTO business_data_sources (id, project_id, source_type, source_id, created_at, updated_at)
       VALUES ($1, $2, 'unstructured_data_source', $3, now(), now())`,
      [randomUUID(), pid, dsid],
    );
  }

  const docId = randomUUID();
  let size = 0;
  try { size = statSync(filePath).size; } catch { /* ignore */ }
  await ctx.query(
    `INSERT INTO unstructured_documents
       (id, project_id, unstructured_data_source_id, title, source, file_path, file_size, file_ext, status, progress, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'local',$5,$6,$7,'pending',0,$8,now(),now())`,
    [docId, pid, dsid, body.title || basename(filePath), filePath, size, ext, ctx.userId || ""],
  );
  // 后台处理(不阻塞响应):大文档 load+split+embed 可能数十秒甚至更久,detach 进串行队列,
  // 立即返回 status='pending';前端轮询 GET .../documents 看 status/progress(embedding 阶段增量更新)。
  const job = createBackgroundJob({
    projectId: pid,
    sessionId: body.session_id || null,
    userId: ctx.userId || null,
    kind: 'unstructured_document_processing',
    resourceType: 'unstructured_document',
    resourceId: docId,
  });
  enqueueProcessDocument(docId, { projectId: pid, jobId: job.id })
    .catch((e) => console.warn(`[unstructured] 文档 ${docId} 后台处理失败: ${e?.message ?? e}`));
  const doc = await ctx.queryOne(
    `SELECT id, title, file_ext, status, chunk_count, progress, error_msg, created_at FROM unstructured_documents WHERE id=$1`,
    [docId],
  );
  return { data: { document: doc, job }, message: "文档已提交,正在后台解析" };
}

// 列出某源的文档
export async function listDocuments(ctx, input) {
  const rows = await ctx.query(
    `SELECT d.id, d.id AS document_id, d.title, d.title AS file_name, d.file_ext, d.file_path,
            d.file_size, d.file_size AS size, d.description, d.status, d.chunk_count, d.progress,
            d.error_msg, d.created_at, d.updated_at,
            COUNT(c.id) AS actual_chunk_count,
            COALESCE(SUM(CASE WHEN c.embedding IS NOT NULL AND c.embedding <> '' THEN 1 ELSE 0 END), 0) AS embedding_count
       FROM unstructured_documents d
       LEFT JOIN unstructured_contents c ON c.document_id = d.id AND c.deleted_at IS NULL
      WHERE d.unstructured_data_source_id=$1 AND d.project_id=$2 AND d.deleted_at IS NULL
      GROUP BY d.id
      ORDER BY d.created_at DESC`,
    [input.params.dsid, input.params.pid],
  ).catch(() => []);
  const items = rows.map((row) => {
    const chunkCount = Number(row.chunk_count ?? row.actual_chunk_count ?? 0);
    const embeddingCount = Number(row.embedding_count || 0);
    const embeddingStatus = chunkCount <= 0
      ? "none"
      : embeddingCount <= 0
        ? "none"
        : embeddingCount >= chunkCount
          ? "completed"
          : "partial";
    return {
      ...row,
      chunk_count: chunkCount,
      embedding_count: embeddingCount,
      embedding_status: embeddingStatus,
    };
  });
  return { data: { items, total: items.length } };
}

// 查看文档切片
export async function listDocumentChunks(ctx, input) {
  const { pid, docId } = input.params;
  const page = Math.max(1, Number(input.query?.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(input.query?.page_size || input.query?.pageSize || 20)));
  const offset = (page - 1) * pageSize;
  const doc = await ctx.queryOne(
    `SELECT id FROM unstructured_documents WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [docId, pid],
  ).catch(() => null);
  if (!doc) throw new ApiError("文档不存在", 404);

  const rows = await ctx.query(
    `SELECT id, content_index, embedding_content, token_count, meta_info,
            CASE WHEN embedding IS NULL THEN false ELSE true END AS is_embedding
       FROM unstructured_contents
      WHERE document_id=$1 AND deleted_at IS NULL AND content_index >= 0
      ORDER BY content_index ASC
      LIMIT $2 OFFSET $3`,
    [docId, pageSize, offset],
  ).catch(() => []);
  const countRow = await ctx.queryOne(
    `SELECT COUNT(*) AS count
       FROM unstructured_contents
      WHERE document_id=$1 AND deleted_at IS NULL AND content_index >= 0`,
    [docId],
  ).catch(() => ({ count: rows.length }));

  const chunks = rows.map((row) => ({
    id: row.id,
    is_embedding: !!row.is_embedding,
    chunk_content: row.embedding_content || "",
    content_info: {
      content_index: Number(row.content_index || 0),
      content: row.embedding_content || "",
      token_count: row.token_count || 0,
      meta_info: row.meta_info || null,
    },
  }));

  return {
    data: { chunks, items: chunks, total: Number(countRow?.count || chunks.length), page, page_size: pageSize },
    message: "获取文档切片成功",
  };
}

// 重新处理
export async function reprocessDocument(ctx, input) {
  const doc = await ctx.queryOne(
    `SELECT id FROM unstructured_documents WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [input.params.docId, input.params.pid],
  ).catch(() => null);
  if (!doc) throw new ApiError("文档不存在", 404);
  const body = input.body || {};
  const chunkSize = Number(body.chunk_size || body.chunkSize) > 0 ? Number(body.chunk_size || body.chunkSize) : 512;
  const chunkOverlap = Number(body.chunk_overlap || body.chunkOverlap) >= 0 ? Number(body.chunk_overlap || body.chunkOverlap) : 50;
  // 同 POST:后台串行处理,立即返回;前端轮询 status/progress。
  await ctx.query(`UPDATE unstructured_documents SET status='pending', progress=0, error_msg=NULL, updated_at=now() WHERE id=$1`, [input.params.docId]).catch(() => {});
  const previous = latestResourceJob('unstructured_document', input.params.docId);
  const job = previous && ['blocked_configuration', 'failed'].includes(previous.status)
    ? updateBackgroundJob(previous.id, { status: 'queued', progress: 0, error_code: null, error_message: null, finished_at: null })
    : createBackgroundJob({
      projectId: input.params.pid,
      sessionId: body.session_id || null,
      userId: ctx.userId || null,
      kind: 'unstructured_document_processing',
      resourceType: 'unstructured_document',
      resourceId: input.params.docId,
    });
  enqueueProcessDocument(input.params.docId, { projectId: input.params.pid, chunkSize, chunkOverlap, jobId: job.id })
    .catch((e) => console.warn(`[unstructured] 文档 ${input.params.docId} 后台重处理失败: ${e?.message ?? e}`));
  return { data: { document_id: input.params.docId, status: "pending", job }, message: "已提交重新处理,正在后台解析" };
}

// 删除文档 + 切片(软删文档,硬删切片)
export async function deleteDocument(ctx, input) {
  await ctx.query(`UPDATE unstructured_documents SET deleted_at=now() WHERE id=$1 AND project_id=$2`, [input.params.docId, input.params.pid]).catch(() => {});
  await ctx.query(`DELETE FROM unstructured_contents WHERE document_id=$1`, [input.params.docId]).catch(() => {});
  return { data: { id: input.params.docId }, message: "已删除文档" };
}

export async function deleteDocumentsBatch(ctx, input) {
  const { pid } = input.params;
  const idsRaw = input.body?.document_ids || input.body?.ids || [];
  const documentIds = Array.isArray(idsRaw) ? idsRaw : (() => {
    try {
      const parsed = JSON.parse(String(idsRaw || "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const ids = documentIds.filter(Boolean);
  if (!ids.length) throw new ApiError("document_ids 不能为空", 400);

  const rows = await ctx.query(
    `SELECT id FROM unstructured_documents WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
    [pid, ids],
  ).catch(() => []);
  const existingIds = rows.map((row) => row.id);
  if (existingIds.length) {
    await ctx.query(
      `UPDATE unstructured_documents SET deleted_at=now(), updated_at=now()
        WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
      [pid, existingIds],
    ).catch(() => {});
    await ctx.query(
      `DELETE FROM unstructured_contents WHERE document_id::text = ANY($1::text[])`,
      [existingIds],
    ).catch(() => {});
  }
  return { data: { deleted_ids: existingIds, deleted_count: existingIds.length }, message: "批量删除成功" };
}

// 非结构化数据源检索
export async function searchDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const queryText = input.body?.query || input.body?.search_query || "";
  const topK = Number(input.body?.top_k || input.body?.topK || 10);
  if (!String(queryText).trim()) throw new ApiError("query 不能为空", 400);

  const src = await ctx.queryOne(
    `SELECT id, name, description FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  ).catch(() => null);
  if (!src) throw new ApiError("非结构化数据源不存在", 404);

  const dataSource = new UnstructuredDataSource(null, pid, dsid);
  dataSource.datasource_name = src.name;
  dataSource.description = src.description;
  const result = await dataSource.query(String(queryText), { top_k: topK });
  if (!result.success) throw new ApiError(result.message || "搜索失败", 500);

  const docIds = [...new Set((result.data || []).map((item) => item.document_id).filter(Boolean))];
  const docs = docIds.length
    ? await ctx.query(
        `SELECT id, title, title AS file_name FROM unstructured_documents WHERE id::text = ANY($1::text[])`,
        [docIds],
      ).catch(() => [])
    : [];
  const docMap = new Map(docs.map((doc) => [doc.id, doc]));
  const items = (result.data || []).map((item) => ({
    ...item,
    score: item.similarity ?? item.score ?? 0,
    document: docMap.get(item.document_id) || null,
  }));
  return { data: items, message: "搜索完成" };
}

// 批量生成文档描述(基于 chunk 内容 LLM 生成 + 描述向量化)。同步执行并返回结果(对齐结构化侧)。
// body: { data_source_id, document_ids?, language? }
export async function generateDocumentDescriptions(ctx, input) {
  const { pid } = input.params;
  const body = input.body || {};
  const dataSourceId = body.data_source_id || body.dataSourceId;
  if (!dataSourceId) throw new ApiError("缺少 data_source_id 参数", 400);
  const src = await ctx.queryOne(
    `SELECT id FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dataSourceId, pid],
  ).catch(() => null);
  if (!src) throw new ApiError("非结构化数据源不存在", 404);
  const documentIds = Array.isArray(body.document_ids) ? body.document_ids : null;
  try {
    const result = await generateDocumentsDescriptions({
      dataSourceId, projectId: pid, documentIds, language: body.language || "zh",
    });
    return { data: result, message: "文档描述生成完成" };
  } catch (e) {
    throw new ApiError("文档描述生成失败: " + (e?.message || String(e)), 500);
  }
}

// 基于所有文档描述汇总生成数据源描述。
// body: { language? }
export async function generateDatasourceDescriptionDoc(ctx, input) {
  const { pid, dsid } = input.params;
  const src = await ctx.queryOne(
    `SELECT id FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  ).catch(() => null);
  if (!src) throw new ApiError("非结构化数据源不存在", 404);
  try {
    const description = await generateDatasourceDescription({
      dataSourceId: dsid, projectId: pid, language: input.body?.language || "zh",
    });
    return { data: { data_source_id: dsid, description }, message: "数据源描述生成完成" };
  } catch (e) {
    throw new ApiError("数据源描述生成失败: " + (e?.message || String(e)), 500);
  }
}

// 手动编辑文档描述
export async function updateDocumentDescription(ctx, input) {
  const { pid, docId } = input.params;
  const description = input.body?.description ?? "";
  const doc = await ctx.queryOne(
    `SELECT id FROM unstructured_documents WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [docId, pid],
  ).catch(() => null);
  if (!doc) throw new ApiError("文档不存在", 404);
  await ctx.query(`UPDATE unstructured_documents SET description=$1, updated_at=now() WHERE id=$2`, [description, docId]).catch(() => {});
  return { data: { document_id: docId, description }, message: "文档描述更新成功" };
}

// 手动编辑数据源描述
export async function updateDatasourceDescription(ctx, input) {
  const { pid, dsid } = input.params;
  const description = input.body?.description ?? "";
  const src = await ctx.queryOne(
    `SELECT id FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  ).catch(() => null);
  if (!src) throw new ApiError("非结构化数据源不存在", 404);
  await ctx.query(`UPDATE unstructured_data_sources SET description=$1, updated_at=now() WHERE id=$2`, [description, dsid]).catch(() => {});
  return { data: { data_source_id: dsid, description }, message: "数据源描述更新成功" };
}
