// L1 应用/用例层 — 指标(Metrics)CRUD。抽自 routes/business_crud.js,逻辑逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
//
// 覆盖:
//   PATCH batch_update_status / :mid/status
//   POST  generate_embeddings
//   POST/PUT/DELETE /metrics[/:mid]  (含批量 DELETE)
//   (bulk_import / search / code_values import|export 是 stub,见 registry.business.js)
//
// 注:app/business/ 比 routes/ 深一层 → engine/db 用 ../../。
import { ApiError } from "../../errors.js";
import { MetricService } from "../../engine/semantic/metric_service.js";
import { assertBusiness } from "./business.js";

// ════════════════════════════════════════════
// Metrics CRUD
// ════════════════════════════════════════════

// POST /api/projects/:pid/businesses/:bid/metrics/generate_embeddings — 批量生成指标向量
export async function generateMetricEmbeddings(ctx, input) {
  const { pid } = input.params;
  const r = await MetricService.batch_generate_all_metric_embeddings(
    { query: ctx.query, queryOne: ctx.queryOne }, { project_id: pid },
  );
  return { data: r, message: "指标向量生成" };
}

// PATCH /api/projects/:pid/businesses/:bid/metrics/batch_update_status — 批量更新状态
export async function batchUpdateMetricStatus(ctx, input) {
  const { pid } = input.params;
  const { metric_ids, is_active } = input.body || {};
  if (!Array.isArray(metric_ids) || !metric_ids.length)
    throw new ApiError("metric_ids 不能为空", 400);
  if (is_active === undefined) throw new ApiError("is_active 不能为空", 400);
  // 先查出有效 id 数量，再更新
  const existing = await ctx.query(
    `SELECT id FROM metric_definitions WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
    [pid, metric_ids],
  );
  if (existing.length) {
    await ctx.query(
      `UPDATE metric_definitions SET is_active=$1, updated_at=now()
        WHERE project_id=$2 AND id::text = ANY($3::text[]) AND deleted_at IS NULL`,
      [!!is_active, pid, metric_ids],
    );
  }
  const updated_count = existing.length;
  return { data: { updated_count }, message: `成功${is_active ? "启用" : "禁用"} ${updated_count} 个指标` };
}

// PATCH /api/projects/:pid/businesses/:bid/metrics/:mid/status — 单个指标状态
export async function updateMetricStatus(ctx, input) {
  const { pid, mid } = input.params;
  const { is_active } = input.body || {};
  if (is_active === undefined) throw new ApiError("is_active 不能为空", 400);
  const check = await ctx.queryOne(
    `SELECT id FROM metric_definitions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [mid, pid],
  );
  if (!check) throw new ApiError("指标不存在", 404);
  await ctx.query(
    `UPDATE metric_definitions SET is_active=$1, updated_at=now()
      WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL`,
    [!!is_active, mid, pid],
  );
  return { data: { updated: true }, message: is_active ? "已启用" : "已禁用" };
}

// POST /api/projects/:pid/businesses/:bid/metrics — 创建指标
export async function createMetric(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  const {
    name, sql_template, description, related_tables, related_columns,
    source_id, source_type, aliases, code_knowledge,
  } = input.body || {};
  if (!name || !name.trim()) throw new ApiError("指标名称不能为空", 400);
  if (!sql_template) throw new ApiError("sql_template 不能为空", 400);

  const id = crypto.randomUUID();
  await ctx.query(
    `INSERT INTO metric_definitions
       (id, project_id, name, sql_template, description, related_tables, related_columns,
        source_id, source_type, aliases, code_knowledge, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,now(),now())`,
    [
      id, pid, name.trim(), sql_template, description || null,
      JSON.stringify(related_tables || []),
      JSON.stringify(related_columns || {}),
      source_id || null, source_type || null,
      JSON.stringify(aliases || []),
      code_knowledge ? JSON.stringify(code_knowledge) : null,
    ],
  );
  const row = await ctx.queryOne(`SELECT * FROM metric_definitions WHERE id=$1`, [id]);
  // 后台生成该指标向量(不阻塞创建响应;就绪前 search_metrics 走关键词兜底)
  // 火后即返回:用 queueMicrotask 保留「先返回后台跑」语义。
  queueMicrotask(() => {
    MetricService.generate_metric_embeddings(
      { query: ctx.query, queryOne: ctx.queryOne }, { project_id: pid, metric_id: id },
    ).catch((e) => console.warn(`[metric embed] ${e?.message ?? e}`));
  });
  return { data: row, message: "创建指标成功" };
}

// PUT /api/projects/:pid/businesses/:bid/metrics/:mid — 更新指标
export async function updateMetric(ctx, input) {
  const { pid, mid } = input.params;
  const existing = await ctx.queryOne(
    `SELECT id FROM metric_definitions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [mid, pid],
  );
  if (!existing) throw new ApiError("指标不存在", 404);

  const {
    name, sql_template, description, related_tables, related_columns,
    source_id, source_type, is_active, aliases, code_knowledge,
  } = input.body || {};

  const sets = ["updated_at=now()"];
  const vals = [];
  const add = (col, val) => { sets.push(`${col}=$${vals.length + 1}`); vals.push(val); };

  if (name !== undefined) add("name", name);
  if (sql_template !== undefined) add("sql_template", sql_template);
  if (description !== undefined) add("description", description);
  if (related_tables !== undefined) add("related_tables", JSON.stringify(related_tables));
  if (related_columns !== undefined) add("related_columns", JSON.stringify(related_columns));
  if (source_id !== undefined) add("source_id", source_id || null);
  if (source_type !== undefined) add("source_type", source_type || null);
  if (is_active !== undefined) add("is_active", !!is_active);
  if (aliases !== undefined) add("aliases", JSON.stringify(aliases));
  if (code_knowledge !== undefined) add("code_knowledge", JSON.stringify(code_knowledge));

  vals.push(mid);
  await ctx.query(`UPDATE metric_definitions SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
  const row = await ctx.queryOne(`SELECT * FROM metric_definitions WHERE id=$1`, [mid]);
  return { data: row, message: "更新指标成功" };
}

// DELETE /api/projects/:pid/businesses/:bid/metrics/:mid — 删除单个指标
export async function deleteMetric(ctx, input) {
  const { pid, mid } = input.params;
  const check = await ctx.queryOne(
    `SELECT id FROM metric_definitions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [mid, pid],
  );
  if (!check) throw new ApiError("指标不存在", 404);
  await ctx.query(
    `UPDATE metric_definitions SET deleted_at=now(), updated_at=now() WHERE id=$1`,
    [mid],
  );
  return { data: null, message: "删除指标成功" };
}

// DELETE /api/projects/:pid/businesses/:bid/metrics — 批量删除指标
export async function deleteMetrics(ctx, input) {
  const { pid } = input.params;
  const { metric_ids, delete_all } = input.body || {};
  let deleted_count = 0;
  if (delete_all) {
    const existing = await ctx.query(
      `SELECT id FROM metric_definitions WHERE project_id=$1 AND deleted_at IS NULL`,
      [pid],
    );
    deleted_count = existing.length;
    if (deleted_count) {
      await ctx.query(
        `UPDATE metric_definitions SET deleted_at=now(), updated_at=now()
          WHERE project_id=$1 AND deleted_at IS NULL`,
        [pid],
      );
    }
  } else {
    if (!Array.isArray(metric_ids) || !metric_ids.length)
      throw new ApiError("metric_ids 不能为空", 400);
    const existing = await ctx.query(
      `SELECT id FROM metric_definitions WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
      [pid, metric_ids],
    );
    deleted_count = existing.length;
    if (deleted_count) {
      await ctx.query(
        `UPDATE metric_definitions SET deleted_at=now(), updated_at=now()
          WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
        [pid, metric_ids],
      );
    }
  }
  return { data: { deleted_count }, message: `成功删除 ${deleted_count} 个指标` };
}
