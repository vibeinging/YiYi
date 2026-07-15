// L1 应用/用例层 — 指标视图(Metric Views)CRUD + 向量。抽自 routes/business_crud.js,逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
//
// 覆盖(已实现):
//   POST embeddings                       — 生成指标视图向量
//   GET  recommendations/latest           — 暂无推荐任务(返回 null 200)
//   PATCH /:mvid/status                    — 切换视图状态
//   POST/PUT/DELETE /metric-views[/:mvid]  — CRUD
//   (preview / column-distinct-values / recommendations(POST) / recommendations/:taskId /
//    recommendations/:taskId/apply 是 stub,见 registry.business.js)
//
// 注:app/business/ 比 routes/ 深一层 → engine/db 用 ../../。
import { ApiError } from "../../errors.js";
import { MetricViewService } from "../../engine/semantic/metric_view_service.js";
import { assertBusiness } from "./business.js";

// ════════════════════════════════════════════
// Metric Views CRUD
// ════════════════════════════════════════════

// POST /api/projects/:pid/businesses/:bid/metric-views/embeddings — 生成指标视图向量
export async function generateMetricViewEmbeddings(ctx, input) {
  const { pid } = input.params;
  const r = await MetricViewService.generate_embeddings(
    { query: ctx.query, queryOne: ctx.queryOne }, { project_id: pid },
  );
  return { data: r, message: "指标视图向量生成" };
}

// GET /api/projects/:pid/businesses/:bid/metric-views/recommendations/latest — 暂无推荐任务
export async function getLatestMetricViewRecommendation(_ctx, _input) {
  return { data: null, message: "暂无推荐任务" };
}

// PATCH /api/projects/:pid/businesses/:bid/metric-views/:mvid/status — 切换视图状态
export async function updateMetricViewStatus(ctx, input) {
  const { mvid } = input.params;
  const { status } = input.body || {};
  if (!status) throw new ApiError("status 不能为空", 400);
  const allowed = ["draft", "active", "inactive"];
  if (!allowed.includes(status)) throw new ApiError(`status 必须是 ${allowed.join("/")} 之一`, 400);
  const check = await ctx.queryOne(
    `SELECT id FROM metric_view_definitions WHERE id=$1 AND deleted_at IS NULL`,
    [mvid],
  );
  if (!check) throw new ApiError("指标视图不存在", 404);
  await ctx.query(
    `UPDATE metric_view_definitions SET status=$1, updated_at=now() WHERE id=$2 AND deleted_at IS NULL`,
    [status, mvid],
  );
  return { data: { updated: true, status }, message: "状态已更新" };
}

// POST /api/projects/:pid/businesses/:bid/metric-views — 创建指标视图
export async function createMetricView(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  const {
    name, description, aliases, source_id, tables, fixed_predicates,
    query_dimensions, time_dimension, projections, group_by, sort_spec, status,
  } = input.body || {};
  if (!name || !name.trim()) throw new ApiError("名称不能为空", 400);
  if (!source_id) throw new ApiError("source_id 不能为空", 400);
  if (!Array.isArray(tables)) throw new ApiError("tables 不能为空", 400);
  if (!Array.isArray(projections)) throw new ApiError("projections 不能为空", 400);

  const id = crypto.randomUUID();
  await ctx.query(
    `INSERT INTO metric_view_definitions
       (id, project_id, source_id, name, description, aliases, tables, fixed_predicates,
        query_dimensions, time_dimension, projections, group_by, sort_spec, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())`,
    [
      id, pid, source_id, name.trim(), description || null,
      aliases ? JSON.stringify(aliases) : null,
      JSON.stringify(tables),
      fixed_predicates ? JSON.stringify(fixed_predicates) : null,
      query_dimensions ? JSON.stringify(query_dimensions) : null,
      time_dimension ? JSON.stringify(time_dimension) : null,
      JSON.stringify(projections),
      group_by ? JSON.stringify(group_by) : null,
      sort_spec ? JSON.stringify(sort_spec) : null,
      status || "active",
    ],
  );
  const row = await ctx.queryOne(`SELECT * FROM metric_view_definitions WHERE id=$1`, [id]);
  return { data: row, message: "创建指标视图成功" };
}

// PUT /api/projects/:pid/businesses/:bid/metric-views/:mvid — 更新指标视图
export async function updateMetricView(ctx, input) {
  const { bid, mvid } = input.params;
  const existing = await ctx.queryOne(
    `SELECT id FROM metric_view_definitions WHERE id=$1 AND deleted_at IS NULL`,
    [mvid],
  );
  if (!existing) throw new ApiError("指标视图不存在", 404);

  const {
    name, description, aliases, source_id, tables, fixed_predicates,
    query_dimensions, time_dimension, projections, group_by, sort_spec, status,
  } = input.body || {};

  const sets = ["updated_at=now()"];
  const vals = [];
  const add = (col, val) => { sets.push(`${col}=$${vals.length + 1}`); vals.push(val); };

  if (name !== undefined) add("name", name);
  if (description !== undefined) add("description", description);
  if (aliases !== undefined) add("aliases", JSON.stringify(aliases));
  if (source_id !== undefined) add("source_id", source_id);
  if (tables !== undefined) add("tables", JSON.stringify(tables));
  if (fixed_predicates !== undefined) add("fixed_predicates", JSON.stringify(fixed_predicates));
  if (query_dimensions !== undefined) add("query_dimensions", JSON.stringify(query_dimensions));
  if (time_dimension !== undefined) add("time_dimension", JSON.stringify(time_dimension));
  if (projections !== undefined) add("projections", JSON.stringify(projections));
  if (group_by !== undefined) add("group_by", JSON.stringify(group_by));
  if (sort_spec !== undefined) add("sort_spec", JSON.stringify(sort_spec));
  if (status !== undefined) add("status", status);

  vals.push(mvid);
  await ctx.query(`UPDATE metric_view_definitions SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
  const row = await ctx.queryOne(`SELECT * FROM metric_view_definitions WHERE id=$1`, [mvid]);
  return { data: row, message: "更新指标视图成功" };
}

// DELETE /api/projects/:pid/businesses/:bid/metric-views/:mvid — 删除指标视图
export async function deleteMetricView(ctx, input) {
  const { mvid } = input.params;
  const check = await ctx.queryOne(
    `SELECT id FROM metric_view_definitions WHERE id=$1 AND deleted_at IS NULL`,
    [mvid],
  );
  if (!check) throw new ApiError("指标视图不存在", 404);
  await ctx.query(
    `UPDATE metric_view_definitions SET deleted_at=now(), updated_at=now() WHERE id=$1`,
    [mvid],
  );
  return { data: null, message: "删除指标视图成功" };
}
