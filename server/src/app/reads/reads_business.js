// L1 用例层 — 业务详情 / 业务绑定数据源 / 业务语义(指标·实体·指标视图·示例)只读端点。
// 抽自 index.js 的 GET handler,逻辑逐行对齐。签名恒为 async fn(ctx, input) -> { data, message }。
// 不碰 req/res:req.params.* → input.params.*;query( → ctx.query(;okList → {items,total};fail → throw ApiError。
import { ApiError } from "../../errors.js";

// GET /api/projects/:pid/businesses — 业务列表(带数据源计数)
export async function listBusinesses(ctx, input) {
  const rows = await ctx.query(
    `SELECT b.id, b.project_id, b.name, b.description, b.created_at, b.updated_at,
            COALESCE(c.cnt, 0)::int AS data_source_count
       FROM businesses b
       LEFT JOIN (SELECT project_id, COUNT(*) AS cnt FROM business_data_sources WHERE deleted_at IS NULL GROUP BY project_id) c
         ON c.project_id = b.id
      WHERE b.project_id=$1 AND b.deleted_at IS NULL ORDER BY b.created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取业务列表成功" };
}

// GET /api/projects/:pid/business — 项目业务详情(去业务层:项目即业务,不抛 404)
// 查 businesses 表取该项目的业务行;无行则返回基于 project_id 构造的虚拟业务对象(保证前端永远拿到 business 上下文)。
export async function getBusiness(ctx, input) {
  const { pid } = input.params;
  const b = await ctx.queryOne(
    `SELECT id, project_id, name, description, created_at, updated_at
       FROM businesses WHERE project_id=$1 AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
    [pid],
  );
  // 项目即业务:无 business 行时用 project_id 构造虚拟对象,前端照常使用(不报错)
  const data = b || { id: pid, project_id: pid, name: "", description: null, created_at: null, updated_at: null };
  return { data, message: "获取业务成功" };
}

// GET /api/projects/:pid/businesses/:bid/data-sources — 业务绑定的数据源(分类返回)
export async function getBusinessDataSources(ctx, input) {
  const bindings = await ctx.query(
    `SELECT id, source_type, source_id FROM business_data_sources WHERE project_id=$1 AND deleted_at IS NULL`,
    [input.params.pid],
  );
  const out = { database_connections: [], unstructured_data_sources: [], structured_data_sources: [], web_search_models: [] };
  const idsOf = (t) => bindings.filter((b) => b.source_type === t).map((b) => b.source_id);
  // 对齐生产契约:每个 item 必须带 source_id = business_data_sources.id(metric_view.source_id 引用它);
  // 底层 source_id → bds.id 映射。
  const bdsIdBy = (t) => {
    const m = {};
    for (const b of bindings) if (b.source_type === t) m[b.source_id] = b.id;
    return m;
  };

  const dbIds = idsOf("database_connection");
  if (dbIds.length) {
    const map = bdsIdBy("database_connection");
    const conns = await ctx.query(
      `SELECT id, name, db_type, is_virtual, host, port, database AS db_name, description
         FROM database_connections WHERE id = ANY($1) AND deleted_at IS NULL`,
      [dbIds],
    );
    out.database_connections = conns.map((c) => ({
      ...c, source_id: map[c.id] || c.id, database_connection_id: c.id, source_type: "database",
    }));
  }
  const usIds = idsOf("unstructured_data_source");
  if (usIds.length) {
    const map = bdsIdBy("unstructured_data_source");
    const rows = await ctx.query(
      `SELECT id, name, description, folder_path, is_active FROM unstructured_data_sources
        WHERE id = ANY($1) AND deleted_at IS NULL`,
      [usIds],
    );
    out.unstructured_data_sources = rows.map((r) => ({ ...r, source_id: map[r.id] || r.id, source_type: "unstructured" }));
  }
  const sdIds = idsOf("structured_data_source");
  if (sdIds.length) {
    const map = bdsIdBy("structured_data_source");
    const rows = await ctx.query(
      `SELECT id, name, description, folder_path, is_active, database_connection_id FROM structured_data_sources
        WHERE id = ANY($1) AND deleted_at IS NULL`,
      [sdIds],
    );
    // 结构化源补 database_connection_id(虚拟 DuckDB 连接,metric_view 解析表依赖它)
    out.structured_data_sources = rows.map((r) => ({ ...r, source_id: map[r.id] || r.id, source_type: "structured" }));
  }
  const wsIds = idsOf("web_search_model");
  if (wsIds.length) {
    const map = bdsIdBy("web_search_model");
    const rows = await ctx.query(
      `SELECT id, name, model, api FROM web_search_models WHERE id = ANY($1) AND deleted_at IS NULL`,
      [wsIds],
    );
    out.web_search_models = rows.map((r) => ({ ...r, source_id: map[r.id] || r.id }));
  }
  return { data: out, message: "获取数据源列表成功" };
}

// GET /api/projects/:pid/businesses/:bid/metrics — 指标列表
export async function listMetrics(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, name, description, aliases, sql_template, related_tables, related_columns,
            source_id, source_type, is_active, created_at, updated_at
       FROM metric_definitions WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取指标列表成功" };
}

// GET /api/projects/:pid/businesses/:bid/metrics/embedding_pending_count
export async function getMetricsEmbeddingPendingCount(_ctx, _input) {
  return { data: { count: 0 }, message: "ok" };
}

// GET /api/projects/:pid/businesses/:bid/entity_configs — 实体配置列表
export async function listEntityConfigs(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, entity_config_id, is_active, created_at, updated_at
       FROM business_entity_configs WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取实体配置成功" };
}

// GET /api/projects/:pid/businesses/:bid/entities — 实体列表
export async function listEntities(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, name, source_id, source_type, entity_type, config_id, meta_data, created_at, updated_at
       FROM entity_mappings WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取实体列表成功" };
}

// GET /api/projects/:pid/businesses/:bid/metric-views — 指标视图列表
export async function listMetricViews(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, source_id, name, description, aliases, tables, fixed_predicates,
            query_dimensions, time_dimension, projections, group_by, sort_spec, status, created_at, updated_at
       FROM metric_view_definitions WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取指标视图成功" };
}

// GET /api/projects/:pid/businesses/:bid/metric-views/:mvid — 指标视图详情
export async function getMetricView(ctx, input) {
  const mv = await ctx.queryOne(
    `SELECT id, project_id, source_id, name, description, aliases, tables, fixed_predicates,
            query_dimensions, time_dimension, projections, group_by, sort_spec, status, created_at, updated_at
       FROM metric_view_definitions WHERE id=$1 AND deleted_at IS NULL`,
    [input.params.mvid],
  );
  if (!mv) throw new ApiError("指标视图不存在", 404);
  return { data: mv, message: "获取指标视图成功" };
}

// GET /api/projects/:pid/businesses/:bid/examples — 示例列表(去向量列)
export async function listExamples(ctx, input) {
  const rows = await ctx.query(
    `SELECT * FROM examples WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
    [input.params.pid],
  ).catch(() => []);
  // 去掉可能存在的向量列
  rows.forEach((r) => { delete r.embedding; delete r.question_embedding; });
  return { data: { items: rows, total: rows.length }, message: "获取示例成功" };
}

// GET /api/projects/:pid/businesses/:bid/examples/stats
export async function getExamplesStats(_ctx, _input) {
  return { data: { total: 0, by_type: {} }, message: "ok" };
}
