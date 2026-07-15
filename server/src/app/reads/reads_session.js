// L1 用例层 — 会话列表 / 会话详情 / 历史消息 / 反馈状态 / 中间表 只读端点。
// 抽自 index.js 的 GET handler,逻辑逐行对齐。签名恒为 async fn(ctx, input) -> { data, message }。
// req.userId → ctx.userId;okList → {items,total};fail → throw ApiError。
import { ApiError } from "../../errors.js";

// GET /api/projects/:pid/sessions — 会话列表(排除 agentic_chat)
export async function listSessions(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, title, description, status, message_count, source_type, action_type,
            created_at, updated_at
       FROM sessions
      WHERE project_id=$1 AND created_by=$2 AND deleted_at IS NULL
        AND action_type IS DISTINCT FROM 'agentic_chat'
      ORDER BY updated_at DESC`,
    [input.params.pid, ctx.userId],
  );
  return { data: { items: rows, total: rows.length }, message: "获取会话列表成功" };
}

// GET /api/projects/:pid/sessions/:sid — 会话详情
export async function getSession(ctx, input) {
  const s = await ctx.queryOne(
    `SELECT id, project_id, title, description, status, message_count, source_type, action_type,
            session_config, session_summary, created_at, updated_at
       FROM sessions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [input.params.sid, input.params.pid],
  );
  if (!s) throw new ApiError("会话不存在", 404);
  return { data: s, message: "获取会话成功" };
}

// GET /api/projects/:pid/sessions/:sid/messages — 历史消息(前端读 data.messages)
export async function listSessionMessages(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, session_id, role, content_items, message_metadata, sequence_number,
            parent_message_id, reply_to_message_id, created_at, updated_at
       FROM session_messages WHERE session_id=$1 AND deleted_at IS NULL
      ORDER BY sequence_number ASC, created_at ASC`,
    [input.params.sid],
  );
  // 前端读 res.data.messages(非 items);每条加 timestamp
  const messages = rows.map((m) => ({ ...m, timestamp: m.created_at }));
  return { data: { messages }, message: "获取消息成功" };
}

// GET /api/projects/:pid/sessions/:sid/intermediate-tables — 中间表(空)
export async function listIntermediateTables(_ctx, _input) {
  return { data: { items: [], total: 0 }, message: "获取中间表成功" };
}

// GET /api/projects/:pid/sessions/:sid/feedback-status — 消息反馈状态映射
export async function getSessionFeedbackStatus(ctx, input) {
  const rows = await ctx.query(
    `SELECT message_id, feedback_type, feedback_reason FROM message_feedbacks
      WHERE session_id=$1 AND deleted_at IS NULL`,
    [input.params.sid],
  );
  // 前端读 {messageId: 'like'|'dislike'|null}(值为字符串)
  const map = {};
  rows.forEach((r) => { map[r.message_id] = r.feedback_type; });
  return { data: map, message: "获取反馈状态成功" };
}
