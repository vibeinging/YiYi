// L1 应用/用例层 — 数据库连接与 Schema 内省。抽自 routes/datasource_crud.js,逻辑逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
//
// 覆盖:databases CRUD / meta.test-connection / meta.schemas.discover / sync-schema /
//       sync-tables / source-tables / upload-db-file
//
// 注:app/datasource/ 比 routes/ 深一层 → engine/db 用 ../../。
import { homedir } from "node:os";
import { join, extname, basename } from "node:path";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { PluginRegistry } from "../../engine/datasources/plugins/index.js";
import { enrichConnection } from "../../engine/semantic/enrich.js";
import { sqlite } from "../../db.js";
import { ApiError } from "../../errors.js";
import { createBackgroundJob, updateBackgroundJob } from "../../engine/jobs/background_jobs.js";

// ─────────────────────────────────────────────
// plugin 配置塑形(连接信息子集)
// ─────────────────────────────────────────────
const pluginConfig = (o) => ({
  db_type: o.db_type, host: o.host, port: o.port,
  username: o.username, password: o.password, database: o.database,
});

// ════════════════════════════════════════════
// 数据库连接 CRUD
// ════════════════════════════════════════════

// POST /api/projects/:pid/databases — 创建数据库连接
export async function createDatabase(ctx, input) {
  const { pid } = input.params;
  const {
    name, db_type, host, port, username, password, database,
    schema_config, extra_config, description,
  } = input.body || {};

  if (!name || !db_type || !database) {
    throw new ApiError("name, db_type, database 为必填项", 400);
  }

  const id = crypto.randomUUID();
  await ctx.query(
    `INSERT INTO database_connections
       (id, project_id, created_by, name, db_type, is_virtual,
        host, port, username, password, database, description,
        schema_config, extra_config, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())`,
    [id, pid, ctx.userId, name, db_type,
     host ?? null, port ?? null, username ?? null, password ?? null,
     database, description ?? null,
     schema_config ?? null, extra_config ?? null],
  );

  const bound = await ctx.queryOne(
    `SELECT id FROM business_data_sources
      WHERE project_id=$1 AND source_type='database_connection' AND source_id=$2 AND deleted_at IS NULL`,
    [pid, id],
  );
  if (!bound) {
    await ctx.query(
      `INSERT INTO business_data_sources (id, project_id, source_type, source_id, created_at, updated_at)
       VALUES ($1, $2, 'database_connection', $3, now(), now())`,
      [crypto.randomUUID(), pid, id],
    );
  }

  const conn = await ctx.queryOne(
    `SELECT id, project_id, name, db_type, is_virtual, host, port, username,
            database AS db_name, description, schema_config, extra_config,
            business_rules, created_at, updated_at
       FROM database_connections WHERE id=$1`,
    [id],
  );
  return { data: conn, message: "创建数据库连接成功" };
}

// PUT /api/projects/:pid/databases/:cid — 更新数据库连接
export async function updateDatabase(ctx, input) {
  const { pid, cid } = input.params;
  const {
    name, host, port, username, password, database,
    description, schema_config, extra_config, business_rules,
  } = input.body || {};

  const existing = await ctx.queryOne(
    `SELECT id FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [cid, pid],
  );
  if (!existing) throw new ApiError("数据库连接不存在", 404);

  // 动态构建 SET 子句
  const sets = ["updated_at=now()"];
  const vals = [];
  let i = 1;
  const push = (col, val) => { sets.push(`${col}=$${i++}`); vals.push(val); };

  if (name !== undefined)           push("name", name);
  if (host !== undefined)           push("host", host);
  if (port !== undefined)           push("port", port);
  if (username !== undefined)       push("username", username);
  if (password !== undefined && password !== "") push("password", password);
  if (database !== undefined)       push("database", database);
  if (description !== undefined)    push("description", description);
  if (schema_config !== undefined)  push("schema_config", schema_config);
  if (extra_config !== undefined)   push("extra_config", extra_config);
  if (business_rules !== undefined) push("business_rules", business_rules);

  vals.push(cid, pid);
  await ctx.query(
    `UPDATE database_connections SET ${sets.join(",")} WHERE id=$${i} AND project_id=$${i + 1}`,
    vals,
  );

  const conn = await ctx.queryOne(
    `SELECT id, project_id, name, db_type, is_virtual, host, port, username,
            database AS db_name, description, schema_config, extra_config,
            business_rules, created_at, updated_at
       FROM database_connections WHERE id=$1`,
    [cid],
  );
  return { data: conn, message: "更新数据库连接成功" };
}

// DELETE /api/projects/:pid/databases/:cid — 软删除数据库连接
export async function deleteDatabase(ctx, input) {
  const { pid, cid } = input.params;
  const existing = await ctx.queryOne(
    `SELECT id FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [cid, pid],
  );
  if (!existing) throw new ApiError("数据库连接不存在", 404);
  await ctx.query(
    `UPDATE database_connections SET deleted_at=now() WHERE id=$1 AND project_id=$2`,
    [cid, pid],
  );
  return { data: null, message: "删除数据库连接成功" };
}

// ════════════════════════════════════════════
// 外部库连接 / Schema 内省(plugin 适配层:PostgreSQL / MySQL …)
// ════════════════════════════════════════════

// POST .../meta/test-connection — 真实测试外部库连接
export async function testConnection(ctx, input) {
  const { db_type, host, port, username, password, database } = input.body || {};
  if (!db_type || !database) {
    return { data: { success: false, message: "db_type, database 为必填项" }, message: "测试连接" };
  }
  const plugin = PluginRegistry.get(db_type);
  if (!plugin) {
    return { data: { success: false, message: `暂不支持的数据库类型: ${db_type}(已支持: ${PluginRegistry.allTypes().join(", ")})` }, message: "测试连接" };
  }
  const cfg = pluginConfig({ db_type, host, port, username, password, database });
  const result = await plugin.testConnection(cfg);
  // 多 schema 库:成功时附带可选 schema 列表,前端可直接选
  if (result.success && plugin.metadata.multiple_schema) {
    try { result.schemas = await plugin.getSchemas(cfg); } catch { /* 不阻断 */ }
  }
  return { data: result, message: "测试连接" };
}

// POST .../meta/schemas/discover — 发现外部库 schema 列表
export async function discoverSchemas(ctx, input) {
  const { db_type, host, port, username, password, database } = input.body || {};
  const plugin = PluginRegistry.get(db_type);
  const supports = !!plugin?.metadata.multiple_schema;
  if (!plugin) {
    return { data: { schemas: [], default_schema: "default", supports_multiple_schemas: false, warnings: [], errors: [`暂不支持的数据库类型: ${db_type}`] }, message: "发现 Schema" };
  }
  try {
    const schemas = await plugin.getSchemas(pluginConfig({ db_type, host, port, username, password, database }));
    const default_schema = supports ? (schemas.includes("public") ? "public" : schemas[0] || null) : "default";
    return { data: { schemas, default_schema, supports_multiple_schemas: supports, warnings: [], errors: [] }, message: "发现 Schema 成功" };
  } catch (e) {
    return { data: { schemas: [], default_schema: null, supports_multiple_schemas: supports, warnings: [], errors: [String(e?.message || e)] }, message: "发现 Schema" };
  }
}

// ── Schema 写入 table_metadata / column_metadata(PRAGMA 探列,容忍库结构差异)──
// 注:翻译版 query() 不支持 PRAGMA(返回空),探列必须走 raw sqlite。
const _colCache = {};
function tableCols(tbl) {
  if (!_colCache[tbl]) {
    _colCache[tbl] = new Set(sqlite.prepare(`PRAGMA table_info(${tbl})`).all().map((r) => r.name));
  }
  return _colCache[tbl];
}

async function syncColumns(ctx, tableId, columns, cmCols) {
  const existing = await ctx.query(
    `SELECT id, column_name FROM column_metadata WHERE table_id=$1` + (cmCols.has("deleted_at") ? " AND deleted_at IS NULL" : ""),
    [tableId],
  );
  const byName = new Map(existing.map((c) => [c.column_name, c.id]));
  const incoming = new Set();
  for (const col of columns) {
    incoming.add(col.column_name);
    const structural = {
      data_type: col.data_type, is_nullable: !!col.is_nullable, default_value: col.default_value ?? null,
      is_primary_key: !!col.is_primary_key, is_foreign_key: !!col.is_foreign_key,
      is_unique: !!col.is_unique, is_indexed: !!col.is_indexed,
      max_length: col.max_length ?? null, numeric_precision: col.numeric_precision ?? null, numeric_scale: col.numeric_scale ?? null,
    };
    const colId = byName.get(col.column_name);
    if (colId) {
      // 已有列:只更新结构字段,保留用户编辑的 description/is_high_recall/example_values
      const sets = [], vals = []; let i = 1;
      for (const [k, v] of Object.entries(structural)) if (cmCols.has(k)) { sets.push(`${k}=$${i++}`); vals.push(v); }
      if (cmCols.has("updated_at")) sets.push("updated_at=now()");
      if (sets.length) { vals.push(colId); await ctx.query(`UPDATE column_metadata SET ${sets.join(",")} WHERE id=$${i}`, vals); }
    } else {
      const cols = ["id", "table_id", "column_name"], vals = [crypto.randomUUID(), tableId, col.column_name];
      for (const [k, v] of Object.entries(structural)) if (cmCols.has(k)) { cols.push(k); vals.push(v); }
      if (cmCols.has("description")) { cols.push("description"); vals.push(col.description || ""); }
      const ph = vals.map((_, k) => `$${k + 1}`);
      if (cmCols.has("created_at")) { cols.push("created_at"); ph.push("now()"); }
      if (cmCols.has("updated_at")) { cols.push("updated_at"); ph.push("now()"); }
      await ctx.query(`INSERT INTO column_metadata (${cols.join(",")}) VALUES (${ph.join(",")})`, vals);
    }
  }
  if (cmCols.has("deleted_at")) {
    for (const [name, id] of byName) if (!incoming.has(name)) await ctx.query(`UPDATE column_metadata SET deleted_at=now() WHERE id=$1`, [id]);
  }
}

async function upsertSchema(ctx, cid, tables, onlyTableNames) {
  const tmCols = await tableCols("table_metadata");
  const cmCols = await tableCols("column_metadata");
  const filter = onlyTableNames && onlyTableNames.length
    ? new Set(
        onlyTableNames
          .map((name) => {
            if (!name) return null;
            if (typeof name === "string") {
              if (name.includes("::")) return name;
              if (name.includes(".")) {
                const [schemaName, ...tableParts] = name.split(".");
                return `${schemaName || "default"}::${tableParts.join(".")}`;
              }
              return name;
            }
            const tableName = name.table_name || name.name;
            if (!tableName) return null;
            return `${name.schema_name || "default"}::${tableName}`;
          })
          .filter(Boolean),
      )
    : null;
  const incoming = filter
    ? tables.filter((t) => filter.has(t.table_name) || filter.has(`${t.schema_name || "default"}::${t.table_name}`))
    : tables;

  const existingRows = await ctx.query(
    `SELECT id, schema_name, table_name FROM table_metadata WHERE database_connection_id=$1 AND deleted_at IS NULL`,
    [cid],
  );
  const existingByKey = new Map(existingRows.map((t) => [`${t.schema_name}::${t.table_name}`, t.id]));
  const incomingKeys = new Set();
  let added = 0, updated = 0;

  for (const tbl of incoming) {
    const schemaName = tbl.schema_name || "default";
    const key = `${schemaName}::${tbl.table_name}`;
    incomingKeys.add(key);
    const fields = { table_type: tbl.table_type || "TABLE", description: tbl.description || "", is_view: !!tbl.is_view, row_count: tbl.row_count ?? null };
    let tableId = existingByKey.get(key);
    if (tableId) {
      const sets = [], vals = []; let i = 1;
      for (const [k, v] of Object.entries(fields)) if (tmCols.has(k)) { sets.push(`${k}=$${i++}`); vals.push(v); }
      if (tmCols.has("updated_at")) sets.push("updated_at=now()");
      if (sets.length) { vals.push(tableId); await ctx.query(`UPDATE table_metadata SET ${sets.join(",")} WHERE id=$${i}`, vals); }
      updated++;
    } else {
      tableId = crypto.randomUUID();
      const cols = ["id", "database_connection_id", "schema_name", "table_name"], vals = [tableId, cid, schemaName, tbl.table_name];
      for (const [k, v] of Object.entries(fields)) if (tmCols.has(k)) { cols.push(k); vals.push(v); }
      const ph = vals.map((_, k) => `$${k + 1}`);
      if (tmCols.has("created_at")) { cols.push("created_at"); ph.push("now()"); }
      if (tmCols.has("updated_at")) { cols.push("updated_at"); ph.push("now()"); }
      await ctx.query(`INSERT INTO table_metadata (${cols.join(",")}) VALUES (${ph.join(",")})`, vals);
      added++;
    }
    await syncColumns(ctx, tableId, tbl.columns || [], cmCols);
  }

  // 全量同步(无 filter)时,对不在本次结果里的旧表软删
  let removed = 0;
  if (!filter) {
    for (const [key, id] of existingByKey) {
      if (!incomingKeys.has(key)) { await ctx.query(`UPDATE table_metadata SET deleted_at=now() WHERE id=$1`, [id]); removed++; }
    }
  }
  return { added_tables: added, updated_tables: updated, removed_tables: removed, total_tables: incoming.length };
}

// 读连接(含密码)→ getSchemaInfo → 写元数据
export async function runSync(ctx, pid, cid, syncType, onlyTableNames, sessionId = null) {
  const conn = await ctx.queryOne(
    `SELECT id, db_type, host, port, username, password, database, schema_config
       FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [cid, pid],
  );
  if (!conn) throw new ApiError("数据库连接不存在", 404);
  const plugin = PluginRegistry.get(conn.db_type);
  if (!plugin) throw new ApiError(`暂不支持的数据库类型: ${conn.db_type}`, 400);

  let selectedSchemas;
  if (conn.schema_config) {
    try {
      const sc = typeof conn.schema_config === "string" ? JSON.parse(conn.schema_config) : conn.schema_config;
      selectedSchemas = sc?.selected_schemas || sc?.available_schemas;
    } catch { /* ignore */ }
  }

  const info = await plugin.getSchemaInfo(
    { db_type: conn.db_type, host: conn.host, port: conn.port, username: conn.username, password: conn.password, database: conn.database },
    { selectedSchemas: Array.isArray(selectedSchemas) ? selectedSchemas : undefined },
  );
  if (info.error) throw new ApiError("Schema 内省失败: " + info.error, 500);

  const counts = await upsertSchema(ctx, cid, info.tables || [], onlyTableNames);
  // 同步后台富化(不阻塞响应):示例值→去重/枚举→列描述→表描述→向量(统一编排,与结构化导入共用)。
  // 就绪前 NL2SQL 无描述/示例值、向量召回走关键词兜底,均不影响可用性。
  // DB 连接:后台只做采样+向量(descriptions:false),LLM 描述交给随后的显式
  // generate-columns-descriptions 调用(带 knowledge.md extra_notes),避免并发重复跑 LLM。
  // 火后即返回:用 queueMicrotask 保留「先返回后台跑」语义。
  const enrichmentJob = createBackgroundJob({
    projectId: pid,
    sessionId,
    userId: ctx.userId || null,
    kind: 'database_schema_enrichment',
    resourceType: 'database_connection',
    resourceId: cid,
  });
  queueMicrotask(() => {
    updateBackgroundJob(enrichmentJob.id, { status: 'running', progress: 5, started_at: new Date().toISOString(), incrementAttempt: true });
    enrichConnection(cid, { projectId: pid, descriptions: false })
      .then((result) => updateBackgroundJob(enrichmentJob.id, {
        status: 'completed', progress: 100, result_json: result || { connection_id: cid }, finished_at: new Date().toISOString(),
      }))
      .catch((e) => {
        console.warn(`[schema enrich] 连接 ${cid} 富化失败: ${e?.message ?? e}`);
        updateBackgroundJob(enrichmentJob.id, { status: 'failed', error_code: 'schema_enrichment_failed', error_message: String(e?.message ?? e), finished_at: new Date().toISOString() });
      });
  });
  return { data: { ...counts, sync_type: syncType, job: enrichmentJob, message: "同步完成" }, message: "同步 Schema" };
}

// POST .../:cid/sync-schema — 真实同步全部 schema
export async function syncSchema(ctx, input) {
  return runSync(ctx, input.params.pid, input.params.cid, "schema", null, input.body?.session_id || null);
}

// POST .../:cid/sync-tables — 真实同步指定表(body.table_names 可选)
export async function syncTables(ctx, input) {
  const names = input.body?.table_names || input.body?.tables;
  return runSync(ctx, input.params.pid, input.params.cid, "tables", Array.isArray(names) ? names : null, input.body?.session_id || null);
}

// GET /api/projects/:pid/databases/:cid/source-tables — 可同步表列表(来自缓存)
export async function listSourceTables(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, database_connection_id, schema_name, table_name, table_type,
            description, is_view, row_count, created_at, updated_at
       FROM table_metadata WHERE database_connection_id=$1 AND deleted_at IS NULL
      ORDER BY schema_name, table_name`,
    [input.params.cid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取可同步表列表成功" };
}

// ════════════════════════════════════════════
// 数据导入:上传 DB 文件(本地路径直读 / base64 兜底落盘;无 multer)
// ════════════════════════════════════════════

// POST .../databases/upload-db-file — 登记本地 SQLite/DuckDB 文件供建连接。
// 桌面版约定(与结构化/非结构化一致):文件已在本地磁盘,后端直读本地路径,不复制不上传——
// SQLite/DuckDB plugin 以 config.database=<本地路径> 原地打开。
//   主模式: body { file_path | path } → 校验扩展名+存在性 → { path, filename, file_size }
//   兜底:   body { filename, content_base64 } → 落盘 ~/.yiw/uploads/<pid>/ → { path }
export async function uploadDbFile(ctx, input) {
  const { pid } = input.params;
  const { filename, content_base64, content, file_path, path: bodyPath } = input.body || {};
  const ALLOWED = new Set([".db", ".sqlite", ".sqlite3", ".duckdb"]);
  try {
    // 主模式:本地路径直读(桌面原生选择器 / eval 传绝对路径)
    const localPath = file_path || bodyPath;
    if (localPath) {
      const abs = String(localPath);
      const ext = extname(abs).toLowerCase();
      if (!ALLOWED.has(ext)) throw new ApiError(`不支持的文件格式: ${ext},支持: ${[...ALLOWED].join(", ")}`, 400);
      if (!existsSync(abs)) throw new ApiError(`文件不存在: ${abs}`, 400);
      return {
        data: {
          path: abs, filename: basename(abs), original_filename: basename(abs),
          file_size: statSync(abs).size,
        },
        message: "文件就绪",
      };
    }
    // 兜底:base64 落盘
    const b64 = content_base64 || content;
    if (filename && b64) {
      const ext = extname(filename).toLowerCase();
      if (!ALLOWED.has(ext)) throw new ApiError(`不支持的文件格式: ${ext},支持: ${[...ALLOWED].join(", ")}`, 400);
      const dir = join(homedir(), ".yiw", "uploads", String(pid));
      mkdirSync(dir, { recursive: true });
      const safe = String(filename).replace(/[^A-Za-z0-9._一-龥-]/g, "_");
      const path = join(dir, safe);
      writeFileSync(path, Buffer.from(b64, "base64"));
      return { data: { path, filename: safe, original_filename: filename, file_size: statSync(path).size }, message: "上传成功" };
    }
    throw new ApiError("需提供 file_path(本地绝对路径)或 filename+content_base64", 400);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("上传失败: " + (e?.message || String(e)), 500);
  }
}
