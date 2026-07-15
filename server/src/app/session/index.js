// L1 应用/用例层 — 会话与消息操作(含会话分享)。抽自 routes/session_actions.js,逻辑逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
import { randomUUID, randomBytes } from "crypto";
import { existsSync, mkdirSync, readdirSync, copyFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ApiError } from "../../errors.js";

// ─────────────────────────────────────────────
// 辅助:把 session 行塑形成前端期望的字典
// ─────────────────────────────────────────────
function sessionShape(s) {
  return {
    id: s.id,
    project_id: s.project_id,
    title: s.title,
    description: s.description,
    source_type: s.source_type,
    source_id: s.source_id,
    action_type: s.action_type,
    status: s.status,
    created_by: s.created_by,
    message_count: s.message_count,
    session_config: s.session_config,
    session_summary: s.session_summary,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

// ─────────────────────────────────────────────
// 私有辅助
// ─────────────────────────────────────────────
function shareShape(share) {
  const snapshot =
    typeof share.snapshot === "string"
      ? (() => { try { return JSON.parse(share.snapshot); } catch { return {}; } })()
      : (share.snapshot || {});
  const messages = snapshot.messages || [];
  return {
    share_token: share.share_token,
    share_path: `/share/${share.share_token}`,
    is_active: share.is_active,
    view_count: share.view_count,
    message_ids: messages.map((m) => m.id).filter(Boolean),
    created_at: share.created_at,
    updated_at: share.updated_at,
  };
}

function generateToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function chatWorkspaceDir(sessionId) {
  return join(homedir(), ".yiw", "projects", "__chat__", String(sessionId));
}

function projectWorkspaceDir(projectId) {
  return join(homedir(), ".yiw", "projects", String(projectId));
}

function uniqueTargetPath(dir, name) {
  const target = join(dir, name);
  if (!existsSync(target)) return target;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dir, `${name}.${stamp}`);
}

function copyWorkspaceContents(fromDir, toDir) {
  const result = { copied_files: 0, copied_dirs: 0, skipped_files: 0 };
  if (!existsSync(fromDir)) return { ...result, source_exists: false };
  mkdirSync(toDir, { recursive: true });

  const copyEntry = (src, destParent) => {
    const stat = lstatSync(src);
    const dest = uniqueTargetPath(destParent, basename(src));
    if (stat.isSymbolicLink()) {
      result.skipped_files += 1;
      return;
    }
    if (stat.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      result.copied_dirs += 1;
      for (const child of readdirSync(src)) copyEntry(join(src, child), dest);
      return;
    }
    if (stat.isFile()) {
      copyFileSync(src, dest);
      result.copied_files += 1;
    }
  };

  for (const entry of readdirSync(fromDir)) copyEntry(join(fromDir, entry), toDir);
  return { ...result, source_exists: true };
}

async function targetProjectForUser(ctx, projectId) {
  return ctx.queryOne(
    `SELECT p.id, p.name
       FROM projects p
       JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$2 AND pm.deleted_at IS NULL
      WHERE p.id=$1 AND p.deleted_at IS NULL
      LIMIT 1`,
    [projectId, ctx.userId],
  );
}

async function updateSessionScopedProjectIds(ctx, sessionId, projectId) {
  const tables = [
    "agent_runs",
    "agent_pending_inputs",
    "llm_call_logs",
    "message_feedbacks",
    "session_shares",
    "tasks",
  ];
  for (const table of tables) {
    await ctx.query(
      `UPDATE ${table} SET project_id=$1, updated_at=now() WHERE session_id=$2 AND (deleted_at IS NULL OR deleted_at='')`,
      [projectId, sessionId],
    ).catch(() => null);
  }
}

async function setSessionAutoApplyMemoryFlag(sessionId, enabled) {
  const mod = await import("../../engine/semantic/disambiguation_service.js");
  return mod.set_session_auto_apply_memory(sessionId, enabled);
}

// ─────────────────────────────────────────────
// POST /api/projects/:pid/sessions/:sid/memory/auto_apply
// 会话级"自动应用记忆"开关:enabled=true → 本 session 后续 align_value 记忆命中
// 直接 short-circuit 不再 ask_user;false → 恢复每次 ask_user。
// 状态走内存化 Redis(redis_manager),桌面单机重启即清零(符合 session 临时态语义)。
// ─────────────────────────────────────────────
export async function setSessionAutoApplyMemory(ctx, input) {
  const { pid, sid } = input.params;
  const { enabled } = input.body || {};
  if (typeof enabled !== "boolean") throw new ApiError("enabled 必须为布尔值", 400);

  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  await setSessionAutoApplyMemoryFlag(sid, enabled);
  return {
    data: { session_id: sid, enabled },
    message: enabled ? "已开启本会话自动使用记忆" : "已关闭本会话自动使用记忆",
  };
}

// ─────────────────────────────────────────────
// POST /api/projects/:pid/sessions  创建会话
// index.js 已有 GET；此 POST 补写变更端点
// ─────────────────────────────────────────────
export async function createSession(ctx, input) {
  const { pid } = input.params;
  const {
    title = "新建对话",
    source_type,
    source_id,
    action_type = null,
    description = null,
    skill_names = null,
    report_template_id = null,
  } = input.body || {};

  if (!source_type || !source_id) {
    throw new ApiError("source_type 和 source_id 为必填项", 400);
  }

  const id = randomUUID();
  let session_config = null;
  const configObj = {};
  if (skill_names && skill_names.length) configObj.skill_names = skill_names;
  if (action_type === "report" && report_template_id) configObj.report_template_id = report_template_id;
  if (Object.keys(configObj).length) session_config = JSON.stringify(configObj);

  await ctx.query(
    `INSERT INTO sessions
       (id, project_id, created_by, title, description, source_type, source_id,
        action_type, status, message_count, session_config, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',0,$9,now(),now())`,
    [id, pid, ctx.userId, title, description, source_type, source_id, action_type, session_config],
  );

  const s = await ctx.queryOne(
    `SELECT id, project_id, title, description, source_type, source_id, action_type,
            status, created_by, message_count, session_config, session_summary, created_at, updated_at
       FROM sessions WHERE id=$1`,
    [id],
  );

  return { data: sessionShape(s), message: "创建会话成功" };
}

// ─────────────────────────────────────────────
// PUT /api/projects/:pid/sessions/:sid  重命名/更新会话
// ─────────────────────────────────────────────
export async function updateSession(ctx, input) {
  const { pid, sid } = input.params;
  const { title, description, status } = input.body || {};

  if (status !== undefined && !["active", "archived"].includes(status)) {
    throw new ApiError("会话状态不合法", 400);
  }

  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  const setClauses = ["updated_at=now()"];
  const params = [];
  let idx = 1;
  if (title !== undefined)       { setClauses.push(`title=$${idx}`);       params.push(title);       idx++; }
  if (description !== undefined) { setClauses.push(`description=$${idx}`); params.push(description); idx++; }
  if (status !== undefined)      { setClauses.push(`status=$${idx}`);      params.push(status);      idx++; }

  params.push(sid);
  await ctx.query(
    `UPDATE sessions SET ${setClauses.join(",")} WHERE id=$${idx}`,
    params,
  );

  const updated = await ctx.queryOne(
    `SELECT id, project_id, title, description, source_type, source_id, action_type,
            status, created_by, message_count, session_config, session_summary, created_at, updated_at
       FROM sessions WHERE id=$1`,
    [sid],
  );
  return { data: sessionShape(updated), message: "更新会话成功" };
}

// ─────────────────────────────────────────────
// POST /api/projects/:pid/sessions/:sid/move  把普通聊天会话迁移到问数项目
// ─────────────────────────────────────────────
export async function moveSession(ctx, input) {
  const { pid, sid } = input.params;
  const targetProjectId = String(input.body?.target_project_id || input.body?.project_id || "").trim();
  if (!targetProjectId) throw new ApiError("target_project_id 为必填项", 400);
  if (targetProjectId === pid) {
    const existing = await ctx.queryOne(
      `SELECT id, project_id, title, description, source_type, source_id, action_type,
              status, created_by, message_count, session_config, session_summary, created_at, updated_at
         FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
      [sid, pid, ctx.userId],
    );
    if (!existing) throw new ApiError("会话不存在或无权限", 404);
    return { data: { session: sessionShape(existing), migrated: false, workspace: null }, message: "会话已在目标项目中" };
  }

  const target = await targetProjectForUser(ctx, targetProjectId);
  if (!target) throw new ApiError("目标项目不存在或无权限", 404);

  const session = await ctx.queryOne(
    `SELECT id, project_id, title, description, source_type, source_id, action_type,
            status, created_by, message_count, session_config, session_summary, created_at, updated_at
       FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!session) throw new ApiError("会话不存在或无权限", 404);
  if (session.action_type && session.action_type !== "agentic_chat") {
    throw new ApiError("仅支持迁移 Agent 对话会话", 400);
  }

  await ctx.query(
    `UPDATE sessions
        SET project_id=$1, source_type='agent', source_id=$1, updated_at=now()
      WHERE id=$2`,
    [targetProjectId, sid],
  );
  await updateSessionScopedProjectIds(ctx, sid, targetProjectId);

  let workspace = null;
  if (pid === "__chat__") {
    try {
      workspace = copyWorkspaceContents(chatWorkspaceDir(sid), projectWorkspaceDir(targetProjectId));
    } catch (e) {
      workspace = { source_exists: true, copied_files: 0, copied_dirs: 0, skipped_files: 0, error: String(e?.message || e) };
    }
  }
  const updated = await ctx.queryOne(
    `SELECT id, project_id, title, description, source_type, source_id, action_type,
            status, created_by, message_count, session_config, session_summary, created_at, updated_at
       FROM sessions WHERE id=$1`,
    [sid],
  );
  return {
    data: {
      session: sessionShape(updated),
      migrated: true,
      from_project_id: pid,
      target_project_id: targetProjectId,
      workspace,
    },
    message: "会话已迁移到问数项目",
  };
}

// ─────────────────────────────────────────────
// DELETE /api/projects/:pid/sessions/:sid  删除会话(软删)
// ─────────────────────────────────────────────
export async function deleteSession(ctx, input) {
  const { pid, sid } = input.params;
  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  await ctx.query(
    `UPDATE sessions SET deleted_at=now(), deleted_by=$1 WHERE id=$2`,
    [ctx.userId, sid],
  );
  return { data: null, message: "会话删除成功" };
}

// ─────────────────────────────────────────────
// DELETE /api/projects/:pid/sessions/:sid/messages/:mid  删除消息(软删)
// ─────────────────────────────────────────────
export async function deleteMessage(ctx, input) {
  const { pid, sid, mid } = input.params;

  // 验证会话归属
  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  const msg = await ctx.queryOne(
    `SELECT id FROM session_messages WHERE id=$1 AND session_id=$2 AND deleted_at IS NULL`,
    [mid, sid],
  );
  if (!msg) throw new ApiError("消息不存在", 404);

  await ctx.query(
    `UPDATE session_messages SET deleted_at=now(), deleted_by=$1 WHERE id=$2`,
    [ctx.userId, mid],
  );
  return { data: null, message: "消息删除成功" };
}

// ─────────────────────────────────────────────
// POST /api/projects/:pid/sessions/:sid/messages/:mid/feedback  提交/更新反馈
// ─────────────────────────────────────────────
export async function createMessageFeedback(ctx, input) {
  const { pid, sid, mid } = input.params;
  const { feedback_type, feedback_reason = null } = input.body || {};

  if (!["like", "dislike"].includes(feedback_type)) {
    throw new ApiError("feedback_type 必须为 like 或 dislike", 400);
  }

  // 解析 message_id（兼容 streaming- 临时 ID）
  let resolvedMid = mid;
  const msgCheck = await ctx.queryOne(
    `SELECT id FROM session_messages WHERE id=$1 AND session_id=$2 AND deleted_at IS NULL`,
    [mid, sid],
  );
  if (!msgCheck) {
    if (typeof mid === "string" && mid.startsWith("streaming-")) {
      // fallback 到最新 assistant 消息
      const fallback = await ctx.queryOne(
        `SELECT id FROM session_messages WHERE session_id=$1 AND role='assistant' AND deleted_at IS NULL
         ORDER BY sequence_number DESC LIMIT 1`,
        [sid],
      );
      if (!fallback) throw new ApiError(`消息不存在或尚未持久化: ${mid}`, 400);
      resolvedMid = fallback.id;
    } else {
      throw new ApiError(`消息不存在或尚未持久化: ${mid}`, 400);
    }
  }

  // 查找已有反馈(非软删)
  const existing = await ctx.queryOne(
    `SELECT id, feedback_type FROM message_feedbacks
      WHERE message_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [resolvedMid, ctx.userId],
  );

  if (existing) {
    if (existing.feedback_type === feedback_type) {
      // 相同类型→取消
      await ctx.query(
        `UPDATE message_feedbacks SET deleted_at=now(), deleted_by=$1 WHERE id=$2`,
        [ctx.userId, existing.id],
      );
      return { data: { action: "cancelled", feedback_type: null, message_id: resolvedMid }, message: "操作成功" };
    }
    // 切换类型
    await ctx.query(
      `UPDATE message_feedbacks SET feedback_type=$1, feedback_reason=$2, updated_at=now() WHERE id=$3`,
      [feedback_type, feedback_type === "dislike" ? feedback_reason : null, existing.id],
    );
    return { data: { action: "updated", feedback_type, id: existing.id, message_id: resolvedMid }, message: "操作成功" };
  }

  // 快照上下文(尽力)
  let userQuestion = "";
  let aiResponse = "";
  try {
    const aiMsg = await ctx.queryOne(
      `SELECT content_items, sequence_number FROM session_messages WHERE id=$1 AND deleted_at IS NULL`,
      [resolvedMid],
    );
    if (aiMsg) {
      const items = Array.isArray(aiMsg.content_items) ? aiMsg.content_items : [];
      const textTypes = new Set(["text", "markdown", "result"]);
      aiResponse = items
        .filter((i) => i && textTypes.has(i.type) && typeof i.content === "string")
        .map((i) => i.content)
        .join("\n")
        .slice(0, 2000);

      const userMsg = await ctx.queryOne(
        `SELECT content_items FROM session_messages
          WHERE session_id=$1 AND role='user' AND sequence_number<$2 AND deleted_at IS NULL
         ORDER BY sequence_number DESC LIMIT 1`,
        [sid, aiMsg.sequence_number],
      );
      if (userMsg) {
        const uItems = Array.isArray(userMsg.content_items) ? userMsg.content_items : [];
        const textItem = uItems.find((i) => i && i.type === "text" && typeof i.content === "string");
        if (textItem) userQuestion = textItem.content;
      }
    }
  } catch (_) { /* 快照失败不阻断 */ }

  const fbId = randomUUID();
  await ctx.query(
    `INSERT INTO message_feedbacks
       (id, message_id, session_id, project_id, user_id, feedback_type, feedback_reason,
        user_question, ai_response, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())`,
    [
      fbId, resolvedMid, sid, pid, ctx.userId, feedback_type,
      feedback_type === "dislike" ? feedback_reason : null,
      userQuestion, aiResponse,
    ],
  );
  return { data: { action: "created", feedback_type, id: fbId, message_id: resolvedMid }, message: "操作成功" };
}

// ─────────────────────────────────────────────
// GET /api/projects/:pid/sessions/:sid/share   获取分享状态
// ─────────────────────────────────────────────
export async function getSessionShare(ctx, input) {
  const { sid } = input.params;
  const share = await ctx.queryOne(
    `SELECT id, share_token, is_active, view_count, snapshot, created_at, updated_at
       FROM session_shares
      WHERE session_id=$1 AND is_active=true AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [sid],
  );
  return { data: share ? shareShape(share) : null, message: "获取分享状态成功" };
}

// ─────────────────────────────────────────────
// POST /api/projects/:pid/sessions/:sid/share  创建/刷新分享
// ─────────────────────────────────────────────
export async function createSessionShare(ctx, input) {
  const { pid, sid } = input.params;
  const refresh = (input.query || {}).refresh === "true" || (input.query || {}).refresh === "1";
  const { message_ids = null } = input.body || {};

  // 验证会话归属
  const session = await ctx.queryOne(
    `SELECT id, project_id, title, description, source_type, action_type, created_at
       FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!session) throw new ApiError("会话不存在或无权限", 404);

  // 查找当前有效分享
  const existing = await ctx.queryOne(
    `SELECT id, share_token, is_active, view_count, snapshot, created_at, updated_at
       FROM session_shares
      WHERE session_id=$1 AND is_active=true AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [sid],
  );

  // 构建快照(消息列表)
  const buildSnapshot = async () => {
    let msgRows = await ctx.query(
      `SELECT id, session_id, role, content_items, message_metadata, sequence_number,
              parent_message_id, reply_to_message_id, created_at, updated_at
         FROM session_messages WHERE session_id=$1 AND deleted_at IS NULL
        ORDER BY sequence_number ASC, created_at ASC`,
      [sid],
    );
    const messages = msgRows.map((m) => ({ ...m, timestamp: m.created_at }));
    const filtered = message_ids && message_ids.length
      ? messages.filter((m) => message_ids.includes(m.id))
      : messages;
    return {
      session: {
        id: session.id,
        title: session.title,
        description: session.description,
        source_type: session.source_type,
        action_type: session.action_type,
        created_at: session.created_at,
      },
      messages: filtered,
    };
  };

  // 复用已有分享(无需刷新且未指定部分消息)
  if (existing && !refresh && !message_ids) {
    return { data: shareShape(existing), message: "创建分享成功" };
  }

  const snapshot = await buildSnapshot();

  if (existing) {
    // 刷新快照(保持 token)
    await ctx.query(
      `UPDATE session_shares SET snapshot=$1, updated_at=now() WHERE id=$2`,
      [JSON.stringify(snapshot), existing.id],
    );
    const refreshed = await ctx.queryOne(
      `SELECT id, share_token, is_active, view_count, snapshot, created_at, updated_at
         FROM session_shares WHERE id=$1`,
      [existing.id],
    );
    return { data: shareShape(refreshed), message: "创建分享成功" };
  }

  // 新建分享
  const newId = randomUUID();
  const token = generateToken(32);
  await ctx.query(
    `INSERT INTO session_shares
       (id, session_id, project_id, created_by, share_token, snapshot, is_active, view_count, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,true,0,now(),now())`,
    [newId, sid, pid, ctx.userId, token, JSON.stringify(snapshot)],
  );
  const created = await ctx.queryOne(
    `SELECT id, share_token, is_active, view_count, snapshot, created_at, updated_at
       FROM session_shares WHERE id=$1`,
    [newId],
  );
  return { data: shareShape(created), message: "创建分享成功" };
}

// ─────────────────────────────────────────────
// DELETE /api/projects/:pid/sessions/:sid/share  撤销分享
// ─────────────────────────────────────────────
export async function deleteSessionShare(ctx, input) {
  const { pid, sid } = input.params;
  // 验证归属
  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  await ctx.query(
    `UPDATE session_shares SET is_active=false, deleted_at=now(), deleted_by=$1
      WHERE session_id=$2 AND is_active=true AND deleted_at IS NULL`,
    [ctx.userId, sid],
  );
  return { data: null, message: "已取消分享" };
}

// ─────────────────────────────────────────────
// GET /api/public/v1/shared-sessions/:token  公开只读(免登录)
// 凭 token 免鉴权;view_count+1 用 queueMicrotask 不阻塞返回。
// ─────────────────────────────────────────────
export async function getSharedSession(ctx, input) {
  const { token } = input.params;
  const share = await ctx.queryOne(
    `SELECT id, snapshot, view_count, created_at
       FROM session_shares
      WHERE share_token=$1 AND is_active=true AND deleted_at IS NULL`,
    [token],
  );
  if (!share) {
    throw new ApiError("分享链接不存在或已失效", 404);
  }
  // 异步递增浏览数(失败不影响正常响应)
  queueMicrotask(() => {
    ctx.query(
      `UPDATE session_shares SET view_count=view_count+1 WHERE id=$1`,
      [share.id],
    ).catch(() => {});
  });

  const snapshot = (typeof share.snapshot === "string"
    ? JSON.parse(share.snapshot)
    : share.snapshot) || {};

  return {
    data: {
      session: snapshot.session || {},
      messages: snapshot.messages || [],
      view_count: (share.view_count || 0) + 1,
      shared_at: share.created_at,
    },
    message: "操作成功",
  };
}

// ─────────────────────────────────────────────
// POST /api/projects/:pid/sessions/:sid/stop-task  停止任务
// ─────────────────────────────────────────────
export async function stopSessionTask(ctx, input) {
  const { pid, sid } = input.params;

  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  const task = await ctx.queryOne(
    `SELECT id FROM tasks WHERE session_id=$1 AND status IN ('pending','running') AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [sid],
  );
  if (!task) throw new ApiError("没有正在运行的任务", 400);

  await ctx.query(
    `UPDATE tasks SET status='cancelled', updated_at=now() WHERE id=$1`,
    [task.id],
  );
  return { data: null, message: "任务已停止" };
}

// ─────────────────────────────────────────────
// GET /api/projects/:pid/sessions/:sid/task-status  任务状态
// ─────────────────────────────────────────────
export async function getSessionTaskStatus(ctx, input) {
  const { pid, sid } = input.params;

  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  const task = await ctx.queryOne(
    `SELECT id, status, progress, error_message, created_at, updated_at
       FROM tasks WHERE session_id=$1 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [sid],
  );
  if (!task) {
    return { data: { has_task: false, status: null }, message: "无任务" };
  }
  return {
    data: {
      has_task: true,
      task_id: task.id,
      status: task.status,
      progress: task.progress,
      error_message: task.error_message,
      created_at: task.created_at,
      updated_at: task.updated_at,
    },
    message: "获取任务状态成功",
  };
}

// ─────────────────────────────────────────────
// POST .../persist-intermediate  (stub — 依赖 DuckDB 文件系统,桌面版暂不实现)
// ─────────────────────────────────────────────
export async function persistIntermediate(ctx, input) {
  throw new ApiError("桌面版暂不支持持久化中间结果", 501);
}
