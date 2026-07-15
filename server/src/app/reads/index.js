// L1 用例层 — 项目级只读端点:成员/邀请链接 · 看板/Panel · 报告/报告模板 · 集成配置(飞书/企微)· MCP Provider。
// 抽自 index.js 的 GET handler,逻辑逐行对齐。签名恒为 async fn(ctx, input) -> { data, message }。
// req.params.* → input.params.*;query( → ctx.query(;ok(裸数组) → {data:rows};fail → throw ApiError。
import { ApiError } from "../../errors.js";
import { listProjectMcpProviders } from "../integrations/mcp.js";

// ════════════════════════════════════════════
// 成员管理 / 邀请链接
// ════════════════════════════════════════════

// GET /api/projects/:pid/members — 成员列表(嵌套 user/role 结构)
export async function listMembers(ctx, input) {
  const { pid } = input.params;
  const rows = await ctx.query(
    `SELECT pm.id, pm.user_id, pm.role_id, pm.is_owner, pm.created_at,
            u.username, u.email, u.avatar_url, u.full_name,
            r.name AS role_name, r.code AS role_code, r.permissions AS role_permissions
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       LEFT JOIN roles r ON r.id = pm.role_id
      WHERE pm.project_id=$1 AND pm.deleted_at IS NULL
      ORDER BY pm.is_owner DESC, pm.created_at`,
    [pid],
  );
  // 前端读 m.user.username / m.role.* / m.is_removed(嵌套结构)
  const items = rows.map((r) => ({
    id: r.id,
    project_id: pid,
    user_id: r.user_id,
    role_id: r.role_id,
    role_name: r.role_name,
    role_code: r.role_code,
    is_owner: r.is_owner,
    is_removed: false,
    deleted_at: null,
    created_at: r.created_at,
    user: { id: r.user_id, username: r.username, email: r.email, avatar_url: r.avatar_url, full_name: r.full_name },
    role: { id: r.role_id, name: r.role_name, code: r.role_code, permissions: r.role_permissions },
  }));
  return { data: { items, total: items.length }, message: "获取成员列表成功" };
}

// GET /api/projects/:pid/invite-links — 邀请链接列表(数组,带计算的 status)
export async function listInviteLinks(ctx, input) {
  const rows = await ctx.query(
    `SELECT il.id, il.code, il.role_id, il.max_uses, il.used_count, il.expires_at, il.is_active,
            il.created_by, il.created_at, r.name AS role_name
       FROM project_invite_links il LEFT JOIN roles r ON r.id = il.role_id
      WHERE il.project_id=$1 AND il.deleted_at IS NULL ORDER BY il.created_at DESC`,
    [input.params.pid],
  ).catch(() => []);
  const now = Date.now();
  const out = rows.map((l) => {
    let status = "active";
    if (!l.is_active) status = "revoked";
    else if (l.expires_at && new Date(l.expires_at).getTime() < now) status = "expired";
    else if (l.max_uses && l.used_count >= l.max_uses) status = "exhausted";
    return { ...l, status };
  });
  return { data: out, message: "获取邀请链接成功" };
}

// ════════════════════════════════════════════
// 报告 / 报告模板
// ════════════════════════════════════════════

// GET /api/projects/:pid/report-templates-v1 — 报告模板列表
export async function listReportTemplates(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, name, report_type, description, status, is_default, version, spec_version,
            created_at, updated_at
       FROM report_templates WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取报告模板成功" };
}

// GET /api/projects/:pid/report-templates-v1/:tid — 报告模板详情
export async function getReportTemplate(ctx, input) {
  const t = await ctx.queryOne(
    `SELECT id, project_id, name, report_type, description, yaml_spec, status, is_default, version,
            spec_version, config, created_at, updated_at
       FROM report_templates WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [input.params.tid, input.params.pid],
  );
  if (!t) throw new ApiError("报告模板不存在", 404);
  return { data: t, message: "获取报告模板成功" };
}

// GET /api/projects/:pid/reports-v1 — 报告列表
export async function listReports(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, report_type, template_id, title, summary, status, created_at, updated_at
       FROM generated_reports WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取报告列表成功" };
}

// GET /api/projects/:pid/reports-v1/:rid — 报告详情
export async function getReport(ctx, input) {
  const r = await ctx.queryOne(
    `SELECT id, project_id, report_type, template_id, title, summary, sections, html,
            payload_json, metadata_json, template_snapshot_yaml, status, created_at, updated_at
       FROM generated_reports WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [input.params.rid, input.params.pid],
  );
  if (!r) throw new ApiError("报告不存在", 404);
  return { data: r, message: "获取报告成功" };
}

// ════════════════════════════════════════════
// Dashboard / Panel(看板)
// ════════════════════════════════════════════

// GET /api/projects/:pid/dashboards — 看板列表(前端读 data.dashboards)
export async function listDashboards(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, created_by, title, description, layout, refresh_interval, created_at, updated_at
       FROM dashboards WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  // 前端读 res.data.dashboards(非 items)
  return { data: { dashboards: rows, total: rows.length, page: 1, per_page: rows.length, pages: 1 }, message: "获取看板列表成功" };
}

// GET /api/projects/:pid/panels — Panel 库列表(前端读 data.panels)
export async function listPanels(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, created_by, title, tags, content_type, content, display_type, display_config,
            execute_type, execute, source_type, source_id, created_at, updated_at
       FROM panels WHERE project_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
    [input.params.pid],
  );
  // 前端读 res.data.panels(非 items)
  return { data: { panels: rows, total: rows.length, page: 1, per_page: rows.length, pages: 1 }, message: "获取 Panel 列表成功" };
}

// GET /api/projects/:pid/panels/:panelId — Panel 详情
export async function getPanel(ctx, input) {
  const p = await ctx.queryOne(
    `SELECT id, project_id, title, tags, content_type, content, display_type, display_config,
            execute_type, execute, source_type, source_id, created_at, updated_at
       FROM panels WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [input.params.panelId, input.params.pid],
  );
  if (!p) throw new ApiError("Panel 不存在", 404);
  return { data: p, message: "获取 Panel 成功" };
}

// GET /api/projects/:pid/dashboards/:did/panels — 看板内 Panel(前端读 data 数组)
export async function listDashboardPanels(ctx, input) {
  // 前端读 res.data 为数组(非 items),来自 dashboard_panels(含 x/y/w/h 布局)
  const rows = await ctx.query(
    `SELECT id, dashboard_id, title, tags, content_type, content, display_type, display_config,
            execute_type, execute, source_type, source_id, x, y, w, h, created_at, updated_at
       FROM dashboard_panels WHERE dashboard_id=$1 AND deleted_at IS NULL ORDER BY y ASC, x ASC`,
    [input.params.did],
  ).catch(() => []);
  return { data: rows, message: "获取看板 Panel 成功" };
}

// ════════════════════════════════════════════
// MCP Provider
// ════════════════════════════════════════════

// GET /api/projects/:pid/mcp_providers — MCP Provider 列表(前端读 data 数组)
export async function listMcpProviders(ctx, input) {
  return listProjectMcpProviders(ctx, input);
}
