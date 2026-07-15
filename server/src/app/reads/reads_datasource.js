// L1 用例层 — 数据库连接列表/详情 · 表/字段 · 关系/待同步 · 结构化/非结构化数据源 · 支持类型 只读端点。
// 抽自 index.js 的 GET handler,逻辑逐行对齐。签名恒为 async fn(ctx, input) -> { data, message }。
// 注:app/reads/ 比 routes/ 深一层 → engine 用 ../../。okList → {items,total};fail → throw ApiError。
import { ApiError } from "../../errors.js";
import { PluginRegistry } from "../../engine/datasources/plugins/index.js";

// GET /api/projects/:pid/databases — 数据库连接列表(隐藏密码,只暴露 has_password)
export async function listDatabases(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, name, db_type, is_virtual, host, port, username, database AS db_name,
            description, created_at, updated_at,
            CASE WHEN password IS NULL OR password='' THEN false ELSE true END AS has_password
       FROM database_connections WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取数据库连接成功" };
}

// GET /api/projects/:pid/databases/meta/supported-types — 支持的数据库类型(从插件注册表派生)
// 前端 GuideStepSelectType 读 data.items[].{value,label,default_port,multiple_schema,description},
// 故必须包成 {items} 且 multiple_schema 为 'True'/'False' 字符串(已在 selectableTypes 内归一)。
export async function listSupportedDbTypes(_ctx, _input) {
  const items = PluginRegistry.selectableTypes();
  return { data: { items, total: items.length }, message: "获取支持的数据库类型成功" };
}

// GET /api/projects/:pid/structured-data-sources — 结构化数据源(连字符路径)
export async function listStructuredDataSourcesHyphen(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, name, description, folder_path, is_active, database_connection_id, created_at
       FROM structured_data_sources WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取结构化数据源成功" };
}

// GET /api/projects/:pid/unstructured-data-sources — 非结构化数据源(连字符路径)
export async function listUnstructuredDataSourcesHyphen(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, name, description, folder_path, is_active, created_at
       FROM unstructured_data_sources WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取非结构化数据源成功" };
}

// GET /api/projects/:pid/structured-datasources — 结构化数据源(后端实际路径,无连字符;带 embedding 模型名)
export async function listStructuredDatasources(ctx, input) {
  const rows = await ctx.query(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active, s.database_connection_id,
            s.embedding_model_id, m.display_name AS embedding_model_name, s.duckdb_path, s.created_at, s.updated_at
       FROM structured_data_sources s LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.project_id=$1 AND s.deleted_at IS NULL ORDER BY s.created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取结构化数据源成功" };
}

// GET /api/projects/:pid/unstructured-datasources — 非结构化数据源(后端实际路径,无连字符)
export async function listUnstructuredDatasources(ctx, input) {
  const rows = await ctx.query(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active, s.embedding_model_id,
            m.display_name AS embedding_model_name, s.created_at, s.updated_at
       FROM unstructured_data_sources s LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.project_id=$1 AND s.deleted_at IS NULL ORDER BY s.created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取非结构化数据源成功" };
}

// GET /api/projects/:pid/databases/:cid — 数据库连接详情
export async function getDatabase(ctx, input) {
  const c = await ctx.queryOne(
    `SELECT id, project_id, name, db_type, is_virtual, host, port, username, database AS db_name,
            description, schema_config, business_rules, created_at, updated_at
       FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [input.params.cid, input.params.pid],
  );
  if (!c) throw new ApiError("数据库连接不存在", 404);
  return { data: c, message: "获取连接成功" };
}

// GET /api/projects/:pid/databases/:cid/tables — 表列表
export async function listTables(ctx, input) {
  const rows = await ctx.query(
    `SELECT t.id, t.database_connection_id, t.schema_name, t.table_name, t.table_type,
            t.description, t.keywords, t.row_count, t.is_view, t.is_materialized,
            t.is_high_recall, t.structured_document_id, t.last_analyzed_at,
            t.created_at, t.updated_at,
            CASE WHEN t.embedding IS NOT NULL AND trim(t.embedding) <> '' THEN 1 ELSE 0 END AS has_embedding,
            count(c.id) AS column_count,
            sum(CASE WHEN c.description IS NOT NULL AND trim(c.description) <> '' THEN 1 ELSE 0 END) AS columns_with_description,
            sum(CASE WHEN c.embedding IS NOT NULL AND trim(c.embedding) <> '' THEN 1 ELSE 0 END) AS columns_with_vectors
       FROM table_metadata t
       LEFT JOIN column_metadata c ON c.table_id=t.id AND c.deleted_at IS NULL
      WHERE t.database_connection_id=$1 AND t.deleted_at IS NULL
      GROUP BY t.id, t.database_connection_id, t.schema_name, t.table_name, t.table_type,
               t.description, t.keywords, t.row_count, t.is_view, t.is_materialized,
               t.is_high_recall, t.structured_document_id, t.last_analyzed_at,
               t.created_at, t.updated_at, t.embedding
      ORDER BY t.schema_name, t.table_name`,
    [input.params.cid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取表列表成功" };
}

// GET /api/projects/:pid/databases/:cid/tables/:tid/columns — 字段列表
export async function listColumns(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, table_id, column_name, data_type, is_nullable, default_value, is_primary_key,
            is_foreign_key, is_unique, is_indexed, distinct_values, description, keywords,
            example_values, is_high_recall, created_at, updated_at
       FROM column_metadata WHERE table_id=$1 AND deleted_at IS NULL ORDER BY created_at`,
    [input.params.tid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取字段列表成功" };
}

// GET /api/projects/:pid/databases/:cid/relationships — 表关系
export async function listRelationships(ctx, input) {
  const rows = await ctx.query(
    `SELECT r.id, r.database_connection_id, r.source_table_id, r.target_table_id,
            r.source_column, r.target_column, r.relationship_type, r.constraint_name,
            r.description, r.created_at, r.updated_at,
            st.table_name AS source_table_name, st.schema_name AS source_schema_name,
            tt.table_name AS target_table_name, tt.schema_name AS target_schema_name
       FROM relationship_metadata r
       LEFT JOIN table_metadata st ON st.id = r.source_table_id
       LEFT JOIN table_metadata tt ON tt.id = r.target_table_id
      WHERE r.database_connection_id=$1 AND r.deleted_at IS NULL
      ORDER BY r.created_at DESC`,
    [input.params.cid],
  ).catch(() => []);
  return { data: { items: rows, total: rows.length }, message: "获取表关系成功" };
}

// GET /api/projects/:pid/databases/:cid/sync_pending — 待同步状态
export async function getSyncPending(_ctx, _input) {
  return { data: { pending: false, count: 0 }, message: "无待同步" };
}
