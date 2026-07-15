// L1 应用/用例层 — 结构化数据【文档】导入(本地文件 → DuckDB)。抽自 routes/structured_docs.js,逻辑逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
// 桌面端走本地 file_path(不上传):create(登记路径)→ process(read_*_auto 解析进 DuckDB
// + 注册 DuckDB 连接 + 写 table_metadata/column_metadata)→ list(轮询 status)。
import { randomUUID } from "node:crypto";
import { createBackgroundJob, updateBackgroundJob } from "../../engine/jobs/background_jobs.js";
import { homedir } from "node:os";
import { join, basename, extname } from "node:path";
import { existsSync } from "node:fs";
import { ApiError } from "../../errors.js";
import { duckDeleteDatabase, duckDropTables, duckImportFile, duckFormatForExt, sanitizeTableName } from "../../engine/datasources/duck.js";
import { enrichConnection } from "../../engine/semantic/enrich.js";
import { SchemaRetrievalService } from "../../engine/semantic/schema_retrieval_service.js";

const STRUCT_DIR = join(homedir(), ".yiw", "structured");

function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  return [];
}

async function getStructuredConnection(ctx, pid, dsid) {
  if (!dsid) throw new ApiError("data_source_id 不能为空", 400);
  const ds = await ctx.queryOne(
    `SELECT id, database_connection_id FROM structured_data_sources
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  ).catch(() => null);
  if (!ds) throw new ApiError("结构化数据源不存在", 404);
  return ds.database_connection_id || null;
}

function documentBaseTableName(doc) {
  const base = (doc?.title || "").replace(/\.[^.]+$/, "") || `t_${String(doc?.id || "").slice(0, 8)}`;
  return sanitizeTableName(base);
}

async function resolveDocumentTableName(ctx, connId, baseTableName, documentId) {
  const current = documentId ? await ctx.queryOne(
    `SELECT table_name FROM table_metadata
      WHERE database_connection_id=$1 AND structured_document_id=$2 AND deleted_at IS NULL`,
    [connId, documentId],
  ).catch(() => null) : null;
  if (current?.table_name) return sanitizeTableName(current.table_name);

  const tableName = sanitizeTableName(baseTableName);
  const existing = await ctx.queryOne(
    `SELECT id, structured_document_id FROM table_metadata
      WHERE database_connection_id=$1 AND table_name=$2 AND deleted_at IS NULL`,
    [connId, tableName],
  ).catch(() => null);
  if (!existing || !existing.structured_document_id || existing.structured_document_id === documentId) {
    return tableName;
  }
  return sanitizeTableName(`${tableName}_${String(documentId).slice(0, 8)}`);
}

async function findDocumentTableRows(ctx, connId, doc) {
  if (!connId || !doc?.id) return [];

  const byDoc = await ctx.query(
    `SELECT id, table_name FROM table_metadata
      WHERE database_connection_id=$1 AND structured_document_id=$2 AND deleted_at IS NULL`,
    [connId, doc.id],
  ).catch(() => []);
  if (byDoc.length) return byDoc;

  // 兼容旧数据:老版本没有写 structured_document_id,只能按文件名推断一次。
  const legacyName = documentBaseTableName(doc);
  return await ctx.query(
    `SELECT id, table_name FROM table_metadata
      WHERE database_connection_id=$1 AND table_name=$2
        AND (structured_document_id IS NULL OR structured_document_id='') AND deleted_at IS NULL`,
    [connId, legacyName],
  ).catch(() => []);
}

async function deleteTableMetadataRows(ctx, tableIds) {
  const ids = [...new Set((tableIds || []).filter(Boolean))];
  if (!ids.length) return;
  await ctx.query(`UPDATE relationship_metadata SET deleted_at=now(), updated_at=now()
    WHERE deleted_at IS NULL AND (source_table_id = ANY($1) OR target_table_id = ANY($2))`, [ids, ids]).catch(() => {});
  await ctx.query(`UPDATE column_metadata SET deleted_at=now(), updated_at=now()
    WHERE table_id = ANY($1) AND deleted_at IS NULL`, [ids]);
  await ctx.query(`UPDATE table_metadata SET deleted_at=now(), updated_at=now()
    WHERE id = ANY($1) AND deleted_at IS NULL`, [ids]);
}

async function cleanupStructuredDocumentArtifacts(ctx, docs) {
  const byDuckPath = new Map();
  const tableIds = [];

  for (const doc of docs || []) {
    const tableRows = await findDocumentTableRows(ctx, doc.database_connection_id, doc);
    for (const row of tableRows) {
      tableIds.push(row.id);
      if (doc.duckdb_path && row.table_name) {
        const names = byDuckPath.get(doc.duckdb_path) || [];
        names.push(row.table_name);
        byDuckPath.set(doc.duckdb_path, names);
      }
    }
  }

  for (const [duckdbPath, tableNames] of byDuckPath.entries()) {
    await duckDropTables(duckdbPath, tableNames);
  }
  await deleteTableMetadataRows(ctx, tableIds);
}

// 写 DuckDB 表元数据(table_metadata + column_metadata),供问数召回。幂等:同文档表重建。
async function upsertDuckTable(ctx, connId, tableName, columns, rowCount, documentId) {
  const oldByDoc = documentId ? await ctx.queryOne(
    `SELECT id FROM table_metadata
      WHERE database_connection_id=$1 AND structured_document_id=$2 AND deleted_at IS NULL`,
    [connId, documentId],
  ).catch(() => null) : null;
  const old = oldByDoc || await ctx.queryOne(
    `SELECT id FROM table_metadata WHERE database_connection_id=$1 AND table_name=$2 AND deleted_at IS NULL`,
    [connId, tableName],
  ).catch(() => null);
  let tableId;
  if (old) {
    tableId = old.id;
    await ctx.query(
      `UPDATE table_metadata
          SET table_name=$1, row_count=$2, structured_document_id=$3, updated_at=now()
        WHERE id=$4`,
      [tableName, rowCount ?? null, documentId ?? null, tableId],
    );
    await ctx.query(`UPDATE column_metadata SET deleted_at=now() WHERE table_id=$1 AND deleted_at IS NULL`, [tableId]);
  } else {
    tableId = randomUUID();
    await ctx.query(
      `INSERT INTO table_metadata (id, database_connection_id, schema_name, table_name, table_type, structured_document_id, row_count, is_view, created_at, updated_at)
       VALUES ($1,$2,'main',$3,'BASE TABLE',$4,$5,0,now(),now())`,
      [tableId, connId, tableName, documentId ?? null, rowCount ?? null],
    );
  }
  for (const col of columns || []) {
    await ctx.query(
      `INSERT INTO column_metadata (id, table_id, column_name, data_type, created_at, updated_at)
       VALUES ($1,$2,$3,$4,now(),now())`,
      [randomUUID(), tableId, col.name, col.type || null],
    ).catch(() => {});
  }
}

// ─────────────────────────────────────────
// POST /api/projects/:pid/structured-documents/create
//   按本地路径登记文档
// ─────────────────────────────────────────
export async function createStructuredDocuments(ctx, input) {
  const { pid } = input.params;
  const b = input.body || {};
  const dsid = b.data_source_id;
  const filePaths = parseJsonArray(b.file_paths);
  if (!dsid) throw new ApiError("data_source_id 不能为空", 400);
  if (!filePaths.length) throw new ApiError("file_paths 不能为空", 400);
  const ds = await ctx.queryOne(`SELECT id FROM structured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`, [dsid, pid]);
  if (!ds) throw new ApiError("结构化数据源不存在", 404);

  const created = [];
  for (const fp of filePaths) {
    const ext = extname(fp).slice(1).toLowerCase();
    const docId = randomUUID();
    await ctx.query(
      `INSERT INTO structured_documents (id, project_id, structured_data_source_id, title, source, file_path, file_ext, status, progress, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'local',$5,$6,'pending',0,$7,now(),now())`,
      [docId, pid, dsid, basename(fp), fp, ext, ctx.userId],
    );
    created.push({ document_id: docId, file_path: fp, file_ext: ext });
  }
  return { data: { created_documents: created, count: created.length }, message: "登记文档成功" };
}

// ─────────────────────────────────────────
// POST /api/projects/:pid/structured-documents/process
//   解析进 DuckDB + 注册连接 + 写元数据
// ─────────────────────────────────────────
export async function processStructuredDocuments(ctx, input) {
  const { pid } = input.params;
  const b = input.body || {};
  const dsid = b.data_source_id;
  const docIds = parseJsonArray(b.document_ids);
  if (!dsid) throw new ApiError("data_source_id 不能为空", 400);
  const ds = await ctx.queryOne(
    `SELECT id, name, duckdb_path, database_connection_id FROM structured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!ds) throw new ApiError("结构化数据源不存在", 404);

  // 数据源 CRUD 建源时不一定填 duckdb_path,这里兜底生成并落库。
  const duckdbPath = ds.duckdb_path || join(STRUCT_DIR, `${dsid}.duckdb`);
  if (!ds.duckdb_path) {
    await ctx.query(`UPDATE structured_data_sources SET duckdb_path=$1, updated_at=now() WHERE id=$2`, [duckdbPath, dsid]);
  }

  const docs = docIds.length
    ? await ctx.query(`SELECT id, file_path, file_ext, title FROM structured_documents WHERE structured_data_source_id=$1 AND id = ANY($2) AND deleted_at IS NULL`, [dsid, docIds])
    : await ctx.query(`SELECT id, file_path, file_ext, title FROM structured_documents WHERE structured_data_source_id=$1 AND deleted_at IS NULL`, [dsid]);

  // 1) 确保 DuckDB 连接(host+database 都填 .duckdb 路径,对齐 DatabaseDataSource._resolve_duck_path)
  let connId = ds.database_connection_id;
  if (!connId) {
    connId = randomUUID();
    await ctx.query(
      `INSERT INTO database_connections (id, project_id, created_by, name, db_type, host, database, description, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'DuckDB',$5,$5,$6,now(),now())`,
      [connId, pid, ctx.userId, ds.name, duckdbPath, `结构化数据源 ${ds.name}`],
    );
    await ctx.query(`UPDATE structured_data_sources SET database_connection_id=$1, updated_at=now() WHERE id=$2`, [connId, dsid]);
  }

  // 1.5) 自动绑定数据源到项目(去业务层:直接写 project_id,business_id 留空)。幂等:已绑则跳过。
  //      引擎 BusinessDataSources 按 project_id 取绑定,故「导入即可问数」,无需任何「业务」概念。
  const bound = await ctx.queryOne(
    `SELECT id FROM business_data_sources WHERE project_id=$1 AND source_type='structured_data_source' AND source_id=$2 AND deleted_at IS NULL`,
    [pid, dsid],
  );
  if (!bound) {
    await ctx.query(
      `INSERT INTO business_data_sources (id, project_id, source_type, source_id, created_at, updated_at)
       VALUES ($1, $2, 'structured_data_source', $3, now(), now())`,
      [randomUUID(), pid, dsid],
    );
  }

  // 2) 逐个导入 + 写元数据
  const results = [];
  for (const doc of docs) {
    const fmt = duckFormatForExt(doc.file_ext);
    if (!fmt) {
      await ctx.query(`UPDATE structured_documents SET status='failed', error_msg=$1, updated_at=now() WHERE id=$2`, [`不支持的格式 .${doc.file_ext}`, doc.id]);
      results.push({ document_id: doc.id, status: "failed", error: `不支持 .${doc.file_ext}` });
      continue;
    }
    if (!doc.file_path || !existsSync(doc.file_path)) {
      await ctx.query(`UPDATE structured_documents SET status='failed', error_msg='文件不存在', updated_at=now() WHERE id=$1`, [doc.id]);
      results.push({ document_id: doc.id, status: "failed", error: "文件不存在" });
      continue;
    }
    try {
      await ctx.query(`UPDATE structured_documents SET status='processing', progress=10, error_msg=NULL, updated_at=now() WHERE id=$1`, [doc.id]);
      const tableName = await resolveDocumentTableName(ctx, connId, documentBaseTableName(doc), doc.id);
      const r = await duckImportFile(duckdbPath, tableName, doc.file_path, fmt);
      await upsertDuckTable(ctx, connId, r.table_name, r.columns, r.row_count, doc.id);
      await ctx.query(`UPDATE structured_documents SET status='completed', chunk_count=$1, progress=100, error_msg=NULL, updated_at=now() WHERE id=$2`, [r.row_count, doc.id]);
      results.push({ document_id: doc.id, status: "completed", table_name: r.table_name, row_count: r.row_count });
    } catch (e) {
      await ctx.query(`UPDATE structured_documents SET status='failed', error_msg=$1, updated_at=now() WHERE id=$2`, [String(e?.message ?? e).slice(0, 500), doc.id]);
      results.push({ document_id: doc.id, status: "failed", error: String(e?.message ?? e) });
    }
  }

  // 3) 后台完整语义富化(示例值→去重/枚举→列描述→表描述→向量),与 DB 连接同步共用编排。
  //    火后即返回:queueMicrotask 调度,先返回信封,不阻塞响应。
  const enrichmentJob = createBackgroundJob({
    projectId: pid,
    sessionId: input.body?.session_id || null,
    userId: ctx.userId || null,
    kind: 'structured_connection_enrichment',
    resourceType: 'database_connection',
    resourceId: connId,
  });
  queueMicrotask(() => {
    const startedAt = new Date().toISOString();
    updateBackgroundJob(enrichmentJob.id, { status: 'running', progress: 5, started_at: startedAt, incrementAttempt: true });
    enrichConnection(connId, { projectId: pid })
      .then((result) => updateBackgroundJob(enrichmentJob.id, {
        status: 'completed', progress: 100, result_json: result || { connection_id: connId }, finished_at: new Date().toISOString(),
      }))
      .catch((e) => {
        console.warn(`[structured enrich] 连接 ${connId} 富化失败: ${e?.message ?? e}`);
        updateBackgroundJob(enrichmentJob.id, { status: 'failed', error_code: 'structured_enrichment_failed', error_message: String(e?.message ?? e), finished_at: new Date().toISOString() });
      });
  });

  return {
    data: {
      database_connection_id: connId,
      processed: results,
      success_count: results.filter((r) => r.status === "completed").length,
      job: enrichmentJob,
    },
    message: "处理完成",
  };
}

// ─────────────────────────────────────────
// GET /api/projects/:pid/structured-documents/list
//   列出文档(轮询 status)
// ─────────────────────────────────────────
export async function listStructuredDocuments(ctx, input) {
  const { pid } = input.params;
  const dsid = input.query.data_source_id;
  const rows = await ctx.query(
    `SELECT id, id AS document_id, title, title AS file_name, file_ext, file_path, status, chunk_count, progress, error_msg, created_at, updated_at
       FROM structured_documents
      WHERE project_id=$1 ${dsid ? "AND structured_data_source_id=$2" : ""} AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    dsid ? [pid, dsid] : [pid],
  ).catch(() => []);
  return { data: { items: rows, total: rows.length } };
}

export async function deleteStructuredDocument(ctx, input) {
  const { pid } = input.params;
  const documentId = input.body?.document_id || input.body?.id;
  if (!documentId) throw new ApiError("document_id 不能为空", 400);

  const row = await ctx.queryOne(
    `SELECT d.id, d.title, d.structured_data_source_id, s.database_connection_id, s.duckdb_path
       FROM structured_documents d
       JOIN structured_data_sources s ON s.id=d.structured_data_source_id
      WHERE d.project_id=$1 AND d.id=$2 AND d.deleted_at IS NULL`,
    [pid, documentId],
  );
  if (!row) throw new ApiError("文档不存在", 404);

  await cleanupStructuredDocumentArtifacts(ctx, [row]);
  await ctx.query(
    `UPDATE structured_documents
        SET deleted_at=now(), updated_at=now()
      WHERE project_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [pid, documentId],
  );

  return {
    data: { deleted_ids: [documentId], deleted_count: 1 },
    message: "删除成功",
  };
}

export async function deleteStructuredDocumentsBatch(ctx, input) {
  const { pid } = input.params;
  const documentIds = parseJsonArray(input.body?.document_ids).filter(Boolean);
  if (!documentIds.length) throw new ApiError("document_ids 不能为空", 400);

  const rows = await ctx.query(
    `SELECT d.id, d.title, d.structured_data_source_id, s.database_connection_id, s.duckdb_path
       FROM structured_documents d
       JOIN structured_data_sources s ON s.id=d.structured_data_source_id
      WHERE d.project_id=$1 AND d.id = ANY($2) AND d.deleted_at IS NULL`,
    [pid, documentIds],
  ).catch(() => []);
  const existingIds = rows.map((row) => row.id);

  if (existingIds.length) {
    await cleanupStructuredDocumentArtifacts(ctx, rows);
    await ctx.query(
      `UPDATE structured_documents
          SET deleted_at=now(), updated_at=now()
        WHERE project_id=$1 AND id = ANY($2) AND deleted_at IS NULL`,
      [pid, existingIds],
    );
  }

  return {
    data: { deleted_ids: existingIds, deleted_count: existingIds.length },
    message: "批量删除成功",
  };
}

export async function listStructuredTables(ctx, input) {
  const { pid } = input.params;
  const dsid = input.query?.data_source_id;
  const connId = await getStructuredConnection(ctx, pid, dsid);
  if (!connId) return { data: { items: [], total: 0 }, message: "结构化数据源尚未生成表" };
  const rows = await ctx.query(
    `SELECT id, database_connection_id, schema_name, table_name, table_type, description, keywords,
            row_count, is_view, is_materialized, is_high_recall, structured_document_id,
            created_at, updated_at
       FROM table_metadata
      WHERE database_connection_id=$1 AND deleted_at IS NULL
      ORDER BY schema_name, table_name`,
    [connId],
  ).catch(() => []);
  return { data: { items: rows, total: rows.length }, message: "获取表列表成功" };
}

export async function listStructuredTablesByDocument(ctx, input) {
  const { pid } = input.params;
  const documentId = input.query?.document_id;
  if (!documentId) throw new ApiError("document_id 不能为空", 400);
  const doc = await ctx.queryOne(
    `SELECT id, title, structured_data_source_id FROM structured_documents
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [documentId, pid],
  ).catch(() => null);
  if (!doc) throw new ApiError("文档不存在", 404);
  const connId = await getStructuredConnection(ctx, pid, doc.structured_data_source_id);
  if (!connId) return { data: { items: [], total: 0 }, message: "结构化文档尚未生成表" };

  const rows = await ctx.query(
    `SELECT id, database_connection_id, schema_name, table_name, table_type, description, keywords,
            row_count, is_view, is_materialized, is_high_recall, structured_document_id,
            created_at, updated_at
       FROM table_metadata
      WHERE database_connection_id=$1 AND structured_document_id=$2 AND deleted_at IS NULL
      ORDER BY schema_name, table_name`,
    [connId, documentId],
  ).catch(() => []);
  if (!rows.length) {
    const fallbackName = documentBaseTableName(doc);
    const legacyRows = await ctx.query(
      `SELECT id, database_connection_id, schema_name, table_name, table_type, description, keywords,
              row_count, is_view, is_materialized, is_high_recall, structured_document_id,
              created_at, updated_at
        FROM table_metadata
       WHERE database_connection_id=$1 AND table_name=$2
          AND (structured_document_id IS NULL OR structured_document_id='') AND deleted_at IS NULL
        ORDER BY schema_name, table_name`,
      [connId, fallbackName],
    ).catch(() => []);
    return { data: { items: legacyRows, total: legacyRows.length }, message: "获取文档表列表成功" };
  }
  return { data: { items: rows, total: rows.length }, message: "获取文档表列表成功" };
}

export async function cleanupStructuredDatasourceArtifacts(ctx, { pid, dsid }) {
  const ds = await ctx.queryOne(
    `SELECT id, database_connection_id, duckdb_path FROM structured_data_sources
      WHERE id=$1 AND project_id=$2`,
    [dsid, pid],
  ).catch(() => null);
  if (!ds) return;

  const tableRows = ds.database_connection_id ? await ctx.query(
    `SELECT id, table_name FROM table_metadata
      WHERE database_connection_id=$1 AND deleted_at IS NULL`,
    [ds.database_connection_id],
  ).catch(() => []) : [];

  if (ds.duckdb_path && tableRows.length) {
    await duckDropTables(ds.duckdb_path, tableRows.map((row) => row.table_name));
  }
  await deleteTableMetadataRows(ctx, tableRows.map((row) => row.id));
  if (ds.duckdb_path) {
    duckDeleteDatabase(ds.duckdb_path);
  }

  await ctx.query(
    `UPDATE structured_documents SET deleted_at=now(), updated_at=now()
      WHERE project_id=$1 AND structured_data_source_id=$2 AND deleted_at IS NULL`,
    [pid, dsid],
  ).catch(() => {});
  await ctx.query(
    `UPDATE business_data_sources SET deleted_at=now(), updated_at=now()
      WHERE project_id=$1 AND source_type='structured_data_source' AND source_id=$2 AND deleted_at IS NULL`,
    [pid, dsid],
  ).catch(() => {});
  if (ds.database_connection_id) {
    await ctx.query(
      `UPDATE database_connections SET deleted_at=now(), updated_at=now()
        WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
      [ds.database_connection_id, pid],
    ).catch(() => {});
  }
}

export async function searchStructuredTables(ctx, input) {
  const { pid, dsid } = input.params;
  const connId = await getStructuredConnection(ctx, pid, dsid);
  if (!connId) return { data: { items: [], count: 0 }, message: "结构化数据源尚未生成表" };
  const question = input.body?.question || input.body?.query || "";
  if (!String(question).trim()) throw new ApiError("question 不能为空", 400);
  const limit = Number(input.body?.limit || input.body?.top_k || 5);
  const items = await SchemaRetrievalService.search_relevant_tables_with_columns(
    { query: ctx.query, queryOne: ctx.queryOne },
    connId,
    String(question),
    { project_id: pid, limit },
  );
  return { data: { items, count: items.length }, message: "召回完成" };
}
