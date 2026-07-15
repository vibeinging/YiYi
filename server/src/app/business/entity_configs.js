// L1 应用/用例层 — 实体(Entity Refs / Entity Configs / Entity Mappings)。抽自 routes/business_crud.js,逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
//
// 覆盖(已实现):
//   Entity Refs    GET/GET available/POST/DELETE /entity_refs[/:refId]、PATCH /:refId/active
//   Entity Configs POST generate_embeddings、PUT/DELETE /entity_configs/:cid
//   Entity Mappings DELETE /entities
//   (entity_configs POST、entity_mappings column_names/test_agent/revert_auto_promoted、
//    entities search/import_excel 是 stub,见 registry.business.js)
//
// 注:app/business/ 比 routes/ 深一层 → engine/db 用 ../../。
import { ApiError } from "../../errors.js";
import { DatabaseEntityService } from "../../engine/semantic/entity_service.js";
import { assertBusiness } from "./business.js";

// ════════════════════════════════════════════
// Entity Refs (business_entity_configs)
// ════════════════════════════════════════════

// GET /api/projects/:pid/businesses/:bid/entity_refs — 已引用的实体配置
export async function listEntityRefs(ctx, input) {
  const { pid } = input.params;
  const rows = await ctx.query(
    `SELECT bec.id, bec.project_id, bec.entity_config_id, bec.is_active,
            bec.created_at, bec.updated_at,
            emc.config_name, emc.import_type, emc.source_id, emc.source_type,
            emc.table_name, emc.column_name, emc.entity_type, emc.rule,
            emc.is_active AS config_is_active
       FROM business_entity_configs bec
       JOIN entity_mapping_configs emc ON emc.id = bec.entity_config_id AND emc.deleted_at IS NULL
      WHERE bec.project_id=$1 AND bec.deleted_at IS NULL
      ORDER BY bec.created_at DESC`,
    [pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取实体引用成功" };
}

// GET /api/projects/:pid/businesses/:bid/entity_refs/available — 可引用的实体配置
export async function listAvailableEntityRefs(ctx, input) {
  const { pid } = input.params;
  // 获取业务绑定的数据库数据源下的实体配置,排除已引用的
  const alreadyReferenced = await ctx.query(
    `SELECT entity_config_id FROM business_entity_configs WHERE project_id=$1 AND deleted_at IS NULL`,
    [pid],
  );
  const refIds = alreadyReferenced.map((r) => r.entity_config_id);

  // 获取该业务下的数据库类型数据源
  const dbSources = await ctx.query(
    `SELECT source_id FROM business_data_sources
      WHERE project_id=$1 AND source_type='database_connection' AND deleted_at IS NULL`,
    [pid],
  );
  const dbIds = dbSources.map((r) => r.source_id);
  if (!dbIds.length) return { data: { items: [], total: 0 }, message: "无可用实体配置" };

  let sql = `SELECT id, config_name, import_type, source_id, source_type,
                    table_name, column_name, entity_type, rule, is_active, created_at
               FROM entity_mapping_configs
              WHERE database_connection_id::text = ANY($1::text[]) AND deleted_at IS NULL AND import_type != 'excel'`;
  const params = [dbIds];
  if (refIds.length) {
    sql += ` AND id != ALL($2)`;
    params.push(refIds);
  }
  sql += ` ORDER BY created_at DESC`;
  const rows = await ctx.query(sql, params);
  return { data: { items: rows, total: rows.length }, message: "获取可用实体配置成功" };
}

// POST /api/projects/:pid/businesses/:bid/entity_refs — 添加实体引用
export async function addEntityRefs(ctx, input) {
  const { pid } = input.params;
  const b = await assertBusiness(pid, pid);
  if (!b) throw new ApiError("业务不存在", 404);
  const { entity_config_ids } = input.body || {};
  if (!Array.isArray(entity_config_ids) || !entity_config_ids.length)
    throw new ApiError("entity_config_ids 不能为空", 400);

  let added = 0;
  for (const configId of entity_config_ids) {
    const existing = await ctx.queryOne(
      `SELECT id FROM business_entity_configs
        WHERE project_id=$1 AND entity_config_id=$2 AND deleted_at IS NULL`,
      [pid, configId],
    );
    if (existing) continue;
    // 检查是否软删除后重建
    const softDeleted = await ctx.queryOne(
      `SELECT id FROM business_entity_configs
        WHERE project_id=$1 AND entity_config_id=$2 AND deleted_at IS NOT NULL`,
      [pid, configId],
    );
    if (softDeleted) {
      await ctx.query(
        `UPDATE business_entity_configs SET deleted_at=NULL, is_active=true, updated_at=now() WHERE id=$1`,
        [softDeleted.id],
      );
    } else {
      const id = crypto.randomUUID();
      await ctx.query(
        `INSERT INTO business_entity_configs (id, project_id, entity_config_id, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,true,now(),now())`,
        [id, pid, configId],
      );
    }
    added++;
  }
  return { data: { added }, message: `成功添加 ${added} 个实体配置引用` };
}

// DELETE /api/projects/:pid/businesses/:bid/entity_refs/:refId — 移除引用
export async function removeEntityRef(ctx, input) {
  const { refId } = input.params;
  await ctx.query(
    `UPDATE business_entity_configs SET deleted_at=now(), updated_at=now() WHERE id=$1 AND deleted_at IS NULL`,
    [refId],
  );
  return { data: null, message: "移除实体配置引用成功" };
}

// PATCH /api/projects/:pid/businesses/:bid/entity_refs/:refId/active — 切换启用状态
export async function toggleEntityRefActive(ctx, input) {
  const { refId } = input.params;
  const { is_active } = input.body || {};
  if (is_active === undefined) throw new ApiError("is_active 不能为空", 400);
  await ctx.query(
    `UPDATE business_entity_configs SET is_active=$1, updated_at=now() WHERE id=$2 AND deleted_at IS NULL`,
    [!!is_active, refId],
  );
  return { data: { updated: true }, message: is_active ? "已启用" : "已禁用" };
}

// ════════════════════════════════════════════
// Entity Configs (entity_mapping_configs)
// ════════════════════════════════════════════

// POST /api/projects/:pid/businesses/:bid/entity_configs/generate_embeddings — 生成实体向量(按业务绑定的连接逐个)
export async function generateEntityConfigEmbeddings(ctx, input) {
  const { pid } = input.params;
  const svcCtx = { query: ctx.query, queryOne: ctx.queryOne };
  const conns = await ctx.query(
    `SELECT dc.id FROM business_data_sources bds JOIN database_connections dc ON dc.id = bds.source_id
      WHERE bds.project_id = $1 AND bds.source_type = 'database_connection'
        AND bds.deleted_at IS NULL AND dc.deleted_at IS NULL`,
    [pid],
  ).catch(() => []);
  let total = 0; let processed = 0;
  for (const c of conns) {
    const r = await DatabaseEntityService.generate_entity_embeddings(svcCtx, c.id, pid, {}).catch(() => ({}));
    total += r.total || 0; processed += r.processed || 0;
  }
  return { data: { total, processed, connections: conns.length }, message: "实体向量生成" };
}

// PUT /api/projects/:pid/businesses/:bid/entity_configs/:cid — 更新实体配置
export async function updateEntityConfig(ctx, input) {
  const { cid } = input.params;
  const { rule, is_active } = input.body || {};
  const sets = ["updated_at=now()"];
  const vals = [];
  if (rule !== undefined) { sets.push(`rule=$${vals.length + 1}`); vals.push(rule); }
  if (is_active !== undefined) { sets.push(`is_active=$${vals.length + 1}`); vals.push(!!is_active); }
  if (sets.length === 1) throw new ApiError("没有可更新的字段", 400);
  vals.push(cid);
  await ctx.query(`UPDATE entity_mapping_configs SET ${sets.join(",")} WHERE id=$${vals.length} AND deleted_at IS NULL`, vals);
  return { data: { updated: true }, message: "更新成功" };
}

// DELETE /api/projects/:pid/businesses/:bid/entity_configs/:cid — 删除实体配置
export async function deleteEntityConfig(ctx, input) {
  const { pid, cid } = input.params;
  // 删除 business_entity_configs 引用
  await ctx.query(
    `UPDATE business_entity_configs SET deleted_at=now(), updated_at=now()
      WHERE project_id=$1 AND entity_config_id=$2 AND deleted_at IS NULL`,
    [pid, cid],
  );
  // 软删除配置本身
  await ctx.query(
    `UPDATE entity_mapping_configs SET deleted_at=now(), updated_at=now() WHERE id=$1 AND deleted_at IS NULL`,
    [cid],
  );
  return { data: null, message: "删除配置成功" };
}

// ════════════════════════════════════════════
// Entity Mappings (entities)
// ════════════════════════════════════════════

// DELETE /api/projects/:pid/businesses/:bid/entities — 批量删除实体映射
export async function deleteEntities(ctx, input) {
  const { pid } = input.params;
  const { entity_ids } = input.body || {};
  if (!Array.isArray(entity_ids) || !entity_ids.length)
    throw new ApiError("entity_ids 不能为空", 400);
  const existing = await ctx.query(
    `SELECT id FROM entity_mappings WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
    [pid, entity_ids],
  );
  const deleted_count = existing.length;
  if (deleted_count) {
    await ctx.query(
      `UPDATE entity_mappings SET deleted_at=now(), updated_at=now()
        WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
      [pid, entity_ids],
    );
  }
  return { data: { deleted_count }, message: `成功删除 ${deleted_count} 个实体` };
}
