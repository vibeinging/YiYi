// L1 应用/用例层 — 业务(Business)CRUD + 数据源绑定。抽自 routes/business_crud.js,逻辑逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
//
// 覆盖:
//   Business CRUD   POST/PUT/DELETE /api/projects/:pid/businesses[/:bid]
//   Data Sources    POST/DELETE     /api/projects/:pid/businesses/:bid/data-sources
//
// 注:app/business/ 比 routes/ 深一层 → engine/db 用 ../../。
import { ApiError } from "../../errors.js";

// ─────────────────────────────────────────────
// Helper(原 routes 里的闭包 helper,提升到模块顶部)
// ─────────────────────────────────────────────

/** 去业务层:scope = project。bid 即项目 scope(前端传 projectId);不再要求 businesses 行存在。
 *  仍兼容旧调用方(eval 传真实 business id):一律放行,数据按各表 scope 列(business_id=该值)自洽读写。 */
export async function assertBusiness(_pid, bid) {
  return bid ? { id: bid } : null;
}

// ════════════════════════════════════════════
// Business CRUD
// ════════════════════════════════════════════

// POST /api/projects/:pid/businesses — 创建业务
export async function createBusiness(ctx, input) {
  const { pid } = input.params;
  const { name, description } = input.body || {};
  if (!name || !name.trim()) throw new ApiError("业务名称不能为空", 400);
  const id = crypto.randomUUID();
  await ctx.query(
    `INSERT INTO businesses (id, project_id, name, description, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,now(),now())`,
    [id, pid, name.trim(), description || null, ctx.userId],
  );
  const b = await ctx.queryOne(`SELECT * FROM businesses WHERE id=$1`, [id]);
  return { data: b, message: "创建业务成功" };
}

// PUT /api/projects/:pid/businesses/:bid — 更新业务
export async function updateBusiness(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  const { name, description } = input.body || {};
  const updates = [];
  const vals = [];
  if (name !== undefined) { updates.push(`name=$${vals.length + 1}`); vals.push(name); }
  if (description !== undefined) { updates.push(`description=$${vals.length + 1}`); vals.push(description); }
  if (!updates.length) throw new ApiError("没有可更新的字段", 400);
  updates.push("updated_at=now()");
  vals.push(bid);
  await ctx.query(`UPDATE businesses SET ${updates.join(",")} WHERE id=$${vals.length}`, vals);
  const updated = await ctx.queryOne(`SELECT * FROM businesses WHERE id=$1`, [bid]);
  return { data: updated, message: "更新业务成功" };
}

// DELETE /api/projects/:pid/businesses/:bid — 软删除业务
export async function deleteBusiness(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  await ctx.query(
    `UPDATE businesses SET deleted_at=now(), updated_at=now() WHERE id=$1`,
    [bid],
  );
  return { data: null, message: "删除业务成功" };
}

// ════════════════════════════════════════════
// Data Sources binding
// ════════════════════════════════════════════

// POST /api/projects/:pid/data-sources — 绑定数据源(去业务层:scope=project,不需要 bid)
export async function bindDataSource(ctx, input) {
  const { pid } = input.params;
  const { source_type, source_id } = input.body || {};
  if (!source_type || !source_id) throw new ApiError("source_type 和 source_id 不能为空", 400);

  // 检查是否已存在(去业务层:按 project_id 判重)
  const existing = await ctx.queryOne(
    `SELECT id FROM business_data_sources
      WHERE project_id=$1 AND source_type=$2 AND source_id=$3 AND deleted_at IS NULL`,
    [pid, source_type, source_id],
  );
  if (existing) return { data: null, message: "数据源已绑定" };

  const id = crypto.randomUUID();
  // 去业务层:business_data_sources 表不再写 business_id 列(scope 恒为 project_id)
  await ctx.query(
    `INSERT INTO business_data_sources (id, project_id, source_type, source_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,now(),now())`,
    [id, pid, source_type, source_id],
  );
  return { data: null, message: "添加数据源成功" };
}

// DELETE /api/projects/:pid/businesses/:bid/data-sources — 移除数据源
export async function unbindDataSource(ctx, input) {
  const { pid } = input.params;
  const { source_type, source_id } = input.body || {};
  if (!source_type || !source_id) throw new ApiError("source_type 和 source_id 不能为空", 400);
  await ctx.query(
    `UPDATE business_data_sources SET deleted_at=now(), updated_at=now()
      WHERE project_id=$1 AND source_type=$2 AND source_id=$3 AND deleted_at IS NULL`,
    [pid, source_type, source_id],
  );
  return { data: null, message: "移除数据源成功" };
}
