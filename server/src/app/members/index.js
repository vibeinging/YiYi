// L1 应用/用例层 — 成员与邀请 CRUD。抽自 routes/members_crud.js,逻辑逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
import crypto from "crypto";
import { ApiError } from "../../errors.js";

/** 组装成员行嵌套结构 */
function formatMember(r, projectId, isRemoved = false) {
  return {
    id: r.id,
    project_id: projectId,
    user_id: r.user_id,
    role_id: r.role_id,
    role_name: r.role_name,
    role_code: r.role_code,
    is_owner: !!r.is_owner,
    is_removed: isRemoved,
    deleted_at: isRemoved ? r.deleted_at : null,
    created_at: r.created_at,
    user: {
      id: r.user_id,
      username: r.username,
      email: r.email,
      avatar_url: r.avatar_url,
      full_name: r.full_name,
    },
    role: {
      id: r.role_id,
      name: r.role_name,
      code: r.role_code,
      permissions: r.role_permissions,
    },
  };
}

/** 查单条成员(含已删除),含 user + role 信息 */
async function getMemberRow(query, projectId, userId) {
  return query(
    `SELECT pm.id, pm.user_id, pm.role_id, pm.is_owner, pm.created_at, pm.deleted_at,
            u.username, u.email, u.avatar_url, u.full_name,
            r.name AS role_name, r.code AS role_code, r.permissions AS role_permissions
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       LEFT JOIN roles r ON r.id = pm.role_id
      WHERE pm.project_id=$1 AND pm.user_id=$2
      ORDER BY pm.deleted_at DESC NULLS FIRST
      LIMIT 1`,
    [projectId, userId],
  ).then((rows) => rows[0] || null);
}

// ─────────────────────────────────────────
// POST /api/projects/:pid/members
//   body: { user_id, role_id }
//   如已存在软删成员则恢复;否则新增。
// ─────────────────────────────────────────
export async function addMember(ctx, input) {
  const { pid } = input.params;
  const { user_id, role_id } = input.body || {};

  if (!user_id) throw new ApiError("缺少 user_id", 400);
  if (!role_id) throw new ApiError("缺少 role_id", 400);

  // 验证项目存在
  const project = await ctx.queryOne(
    `SELECT id FROM projects WHERE id=$1 AND deleted_at IS NULL`,
    [pid],
  );
  if (!project) throw new ApiError("项目不存在", 404);

  // 验证角色存在
  const role = await ctx.queryOne(
    `SELECT id FROM roles WHERE id=$1 AND deleted_at IS NULL`,
    [role_id],
  );
  if (!role) throw new ApiError("角色不存在", 404);

  // 验证目标用户存在
  const targetUser = await ctx.queryOne(
    `SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL`,
    [user_id],
  );
  if (!targetUser) throw new ApiError("用户不存在", 404);

  // 检查是否已有记录(含软删)
  const existing = await ctx.queryOne(
    `SELECT id, deleted_at FROM project_members WHERE project_id=$1 AND user_id=$2 ORDER BY deleted_at DESC NULLS FIRST LIMIT 1`,
    [pid, user_id],
  );

  if (existing) {
    if (!existing.deleted_at) {
      // 已是活跃成员,更新角色
      await ctx.query(
        `UPDATE project_members SET role_id=$1, updated_at=now() WHERE id=$2`,
        [role_id, existing.id],
      );
    } else {
      // 软删成员 → 恢复
      await ctx.query(
        `UPDATE project_members SET deleted_at=NULL, role_id=$1, updated_at=now() WHERE id=$2`,
        [role_id, existing.id],
      );
    }
  } else {
    // 新增
    const newId = crypto.randomUUID();
    await ctx.query(
      `INSERT INTO project_members (id, project_id, user_id, role_id, is_owner, created_at, updated_at)
       VALUES ($1, $2, $3, $4, false, now(), now())`,
      [newId, pid, user_id, role_id],
    );
  }

  const row = await getMemberRow(ctx.query, pid, user_id);
  return { data: formatMember(row, pid, false), message: "成员已添加" };
}

// ─────────────────────────────────────────
// PUT /api/projects/:pid/members/:userId
//   body: { role_id, is_owner? }
// ─────────────────────────────────────────
export async function updateMember(ctx, input) {
  const { pid, userId } = input.params;
  const { role_id, is_owner } = input.body || {};

  if (!role_id) throw new ApiError("缺少 role_id", 400);

  // 检查成员存在且活跃
  const member = await ctx.queryOne(
    `SELECT id, is_owner FROM project_members WHERE project_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [pid, userId],
  );
  if (!member) throw new ApiError("成员不存在", 404);

  // 禁止降权 owner(is_owner 为 true 时不允许通过此接口改角色,防误操作)
  if (member.is_owner) throw new ApiError("不能修改项目负责人的角色", 403);

  // 验证新角色存在
  const role = await ctx.queryOne(
    `SELECT id FROM roles WHERE id=$1 AND deleted_at IS NULL`,
    [role_id],
  );
  if (!role) throw new ApiError("角色不存在", 404);

  const updates = ["role_id=$1", "updated_at=now()"];
  const params = [role_id];
  if (typeof is_owner === "boolean") {
    params.push(is_owner);
    updates.push(`is_owner=$${params.length}`);
  }
  params.push(pid, userId);
  await ctx.query(
    `UPDATE project_members SET ${updates.join(", ")} WHERE project_id=$${params.length - 1} AND user_id=$${params.length} AND deleted_at IS NULL`,
    params,
  );

  const row = await getMemberRow(ctx.query, pid, userId);
  return { data: formatMember(row, pid, false), message: "角色已更新" };
}

// ─────────────────────────────────────────
// DELETE /api/projects/:pid/members/:userId
//   软删除;禁止删除 owner。
// ─────────────────────────────────────────
export async function deleteMember(ctx, input) {
  const { pid, userId } = input.params;

  const member = await ctx.queryOne(
    `SELECT id, is_owner FROM project_members WHERE project_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [pid, userId],
  );
  if (!member) throw new ApiError("成员不存在", 404);
  if (member.is_owner) throw new ApiError("不能移除项目负责人", 403);

  await ctx.query(
    `UPDATE project_members SET deleted_at=now(), updated_at=now() WHERE id=$1`,
    [member.id],
  );

  return { data: null, message: "成员已移除" };
}

// ─────────────────────────────────────────
// POST /api/projects/:pid/invite-links
//   body: { role_id, expires_at?, max_uses? }
//   返回邀请链接对象(前端读 res.data.code 拼完整 URL)
// ─────────────────────────────────────────
export async function createInviteLink(ctx, input) {
  const { pid } = input.params;
  const { role_id, expires_at, max_uses } = input.body || {};

  if (!role_id) throw new ApiError("缺少 role_id", 400);

  // 验证项目存在
  const project = await ctx.queryOne(
    `SELECT id FROM projects WHERE id=$1 AND deleted_at IS NULL`,
    [pid],
  );
  if (!project) throw new ApiError("项目不存在", 404);

  // 验证角色
  const role = await ctx.queryOne(
    `SELECT id, name FROM roles WHERE id=$1 AND deleted_at IS NULL`,
    [role_id],
  );
  if (!role) throw new ApiError("角色不存在", 404);

  // 生成唯一邀请码(16 字节 hex = 32 chars)
  const code = crypto.randomBytes(16).toString("hex");

  const linkId = crypto.randomUUID();
  const row = await ctx.queryOne(
    `INSERT INTO project_invite_links
       (id, project_id, role_id, code, max_uses, used_count, expires_at, is_active, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6, true, $7, now(), now())
     RETURNING id, code, role_id, max_uses, used_count, expires_at, is_active, created_by, created_at`,
    [linkId, pid, role_id, code, max_uses || null, expires_at || null, ctx.userId],
  );

  const result = {
    ...row,
    role_name: role.name,
    status: "active",
  };

  return { data: result, message: "邀请链接已创建" };
}

// ─────────────────────────────────────────
// POST /api/projects/:pid/invite-links/:id/revoke
//   将 is_active 置为 false
// ─────────────────────────────────────────
export async function revokeInviteLink(ctx, input) {
  const { pid, id } = input.params;

  const link = await ctx.queryOne(
    `SELECT id, is_active FROM project_invite_links WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [id, pid],
  );
  if (!link) throw new ApiError("邀请链接不存在", 404);
  if (!link.is_active) throw new ApiError("邀请链接已被撤销", 400);

  await ctx.query(
    `UPDATE project_invite_links SET is_active=false, updated_at=now() WHERE id=$1`,
    [id],
  );

  return { data: null, message: "邀请链接已撤销" };
}

// ─────────────────────────────────────────
// DELETE /api/projects/:pid/invite-links/:id
//   软删除邀请链接
// ─────────────────────────────────────────
export async function deleteInviteLink(ctx, input) {
  const { pid, id } = input.params;

  const link = await ctx.queryOne(
    `SELECT id FROM project_invite_links WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [id, pid],
  );
  if (!link) throw new ApiError("邀请链接不存在", 404);

  await ctx.query(
    `UPDATE project_invite_links SET deleted_at=now(), updated_at=now() WHERE id=$1`,
    [id],
  );

  return { data: null, message: "邀请链接已删除" };
}

// ─────────────────────────────────────────
// GET /api/projects/join/:code/verify
//   验证邀请码有效性,返回项目信息 + 角色
// ─────────────────────────────────────────
export async function verifyInviteCode(ctx, input) {
  const { code } = input.params;

  const link = await ctx.queryOne(
    `SELECT il.id, il.code, il.project_id, il.role_id, il.max_uses, il.used_count,
            il.expires_at, il.is_active,
            p.name AS project_name, p.description AS project_description,
            r.name AS role_name
       FROM project_invite_links il
       JOIN projects p ON p.id = il.project_id AND p.deleted_at IS NULL
       LEFT JOIN roles r ON r.id = il.role_id
      WHERE il.code=$1 AND il.deleted_at IS NULL`,
    [code],
  );

  if (!link) throw new ApiError("邀请链接无效", 404);
  if (!link.is_active) throw new ApiError("邀请链接已被撤销", 400);
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    throw new ApiError("邀请链接已过期", 400);
  }
  if (link.max_uses && link.used_count >= link.max_uses) {
    throw new ApiError("邀请链接使用次数已达上限", 400);
  }

  return {
    data: {
      project_id: link.project_id,
      project_name: link.project_name,
      project_description: link.project_description,
      role_id: link.role_id,
      role_name: link.role_name,
      code: link.code,
    },
    message: "邀请码有效",
  };
}

// ─────────────────────────────────────────
// POST /api/projects/join/:code
//   通过邀请码加入项目
// ─────────────────────────────────────────
export async function joinProject(ctx, input) {
  const { code } = input.params;

  const link = await ctx.queryOne(
    `SELECT id, project_id, role_id, max_uses, used_count, expires_at, is_active
       FROM project_invite_links WHERE code=$1 AND deleted_at IS NULL`,
    [code],
  );

  if (!link) throw new ApiError("邀请链接无效", 404);
  if (!link.is_active) throw new ApiError("邀请链接已被撤销", 400);
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    throw new ApiError("邀请链接已过期", 400);
  }
  if (link.max_uses && link.used_count >= link.max_uses) {
    throw new ApiError("邀请链接使用次数已达上限", 400);
  }

  const { project_id, role_id } = link;

  // 检查是否已是成员
  const existing = await ctx.queryOne(
    `SELECT id, deleted_at FROM project_members WHERE project_id=$1 AND user_id=$2 ORDER BY deleted_at DESC NULLS FIRST LIMIT 1`,
    [project_id, ctx.userId],
  );

  if (existing && !existing.deleted_at) {
    throw new ApiError("您已经是该项目的成员", 400);
  }

  if (existing && existing.deleted_at) {
    // 恢复已移除的成员
    await ctx.query(
      `UPDATE project_members SET deleted_at=NULL, role_id=$1, updated_at=now() WHERE id=$2`,
      [role_id, existing.id],
    );
  } else {
    // 新增成员
    const joinId = crypto.randomUUID();
    await ctx.query(
      `INSERT INTO project_members (id, project_id, user_id, role_id, is_owner, created_at, updated_at)
       VALUES ($1, $2, $3, $4, false, now(), now())`,
      [joinId, project_id, ctx.userId, role_id],
    );
  }

  // 更新邀请链接使用次数
  await ctx.query(
    `UPDATE project_invite_links SET used_count=used_count+1, updated_at=now() WHERE id=$1`,
    [link.id],
  );

  const row = await getMemberRow(ctx.query, project_id, ctx.userId);
  return { data: formatMember(row, project_id, false), message: "已成功加入项目" };
}

// ─────────────────────────────────────────
// POST /api/projects/:pid/transfer-ownership
//   body: { user_id }
//   转移项目所有权:旧 owner is_owner=false,新 owner is_owner=true
// ─────────────────────────────────────────
export async function transferOwnership(ctx, input) {
  const { pid } = input.params;
  const { user_id: newOwnerId } = input.body || {};

  if (!newOwnerId) throw new ApiError("缺少 user_id", 400);

  // 当前用户必须是 owner
  const currentOwner = await ctx.queryOne(
    `SELECT id FROM project_members WHERE project_id=$1 AND user_id=$2 AND is_owner=true AND deleted_at IS NULL`,
    [pid, ctx.userId],
  );
  if (!currentOwner) throw new ApiError("只有项目负责人才能转移所有权", 403);

  // 新 owner 必须是活跃成员
  const newOwnerMember = await ctx.queryOne(
    `SELECT id FROM project_members WHERE project_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [pid, newOwnerId],
  );
  if (!newOwnerMember) throw new ApiError("目标用户不是该项目的成员", 400);

  // 执行转移
  await ctx.query(
    `UPDATE project_members SET is_owner=false, updated_at=now()
      WHERE project_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [pid, ctx.userId],
  );
  await ctx.query(
    `UPDATE project_members SET is_owner=true, updated_at=now()
      WHERE project_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [pid, newOwnerId],
  );
  // 同步更新 projects.owner_id(如列存在)
  await ctx.query(
    `UPDATE projects SET owner_id=$1, updated_at=now() WHERE id=$2`,
    [newOwnerId, pid],
  ).catch(() => {/* 字段可能不存在,忽略 */});

  return { data: null, message: "项目所有权已转移" };
}
