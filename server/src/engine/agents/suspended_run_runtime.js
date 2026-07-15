import { randomUUID } from "node:crypto";
import { replaceToolResultText } from "./sessionStore.js";

export const DEFAULT_RESUME_VALIDITY_DAYS = 30;
export const DEFAULT_PENDING_RECORD_DAYS = 3650;

function nowIso() {
  return new Date().toISOString();
}

function addDays(days) {
  const n = Number(days);
  const safeDays = Number.isFinite(n) && n > 0 ? n : DEFAULT_RESUME_VALIDITY_DAYS;
  return new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000).toISOString();
}

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value && typeof value === "object" ? value : fallback;
}

function normalizeId(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

export function createResumeHandle({ runId, sessionId, requestId } = {}) {
  const run_id = normalizeId(runId);
  const session_id = normalizeId(sessionId);
  const request_id = normalizeId(requestId);
  if (!(run_id && session_id && request_id)) return null;
  return {
    type: "user_input_resume",
    run_id,
    session_id,
    request_id,
    version: 1,
  };
}

export async function createAgentRun(ctx, {
  runId,
  sessionId,
  projectId,
  userId = null,
  status = "running",
  skill = null,
  mode = "agent",
  checkpoint = {},
  metadata = {},
} = {}) {
  if (!(ctx?.query && runId && sessionId)) return null;
  await ctx.query(
    `INSERT INTO agent_runs (
        id, session_id, project_id, user_id, status, skill_name, mode,
        checkpoint_json, metadata_json, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        skill_name=excluded.skill_name,
        mode=excluded.mode,
        checkpoint_json=excluded.checkpoint_json,
        metadata_json=excluded.metadata_json,
        updated_at=now()`,
    [
      runId,
      sessionId,
      projectId || null,
      userId || null,
      status,
      skill,
      mode,
      JSON.stringify(checkpoint || {}),
      JSON.stringify(metadata || {}),
    ],
  ).catch((error) => {
    console.error("[agent_runs create]", error?.message || error);
    return null;
  });
  return { run_id: runId, status };
}

export async function updateAgentRunStatus(ctx, {
  runId,
  status,
  checkpoint = undefined,
  metadata = undefined,
  finished = false,
} = {}) {
  if (!(ctx?.query && runId && status)) return null;
  const sets = ["status=$2", "updated_at=now()"];
  const params = [runId, status];
  if (checkpoint !== undefined) {
    params.push(JSON.stringify(checkpoint || {}));
    sets.push(`checkpoint_json=$${params.length}`);
  }
  if (metadata !== undefined) {
    params.push(JSON.stringify(metadata || {}));
    sets.push(`metadata_json=$${params.length}`);
  }
  if (finished) sets.push("finished_at=now()");
  await ctx.query(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id=$1`, params).catch((error) => {
    console.error("[agent_runs update]", error?.message || error);
    return null;
  });
  return { run_id: runId, status };
}

export async function suspendRunForUserInput(ctx, {
  runId,
  sessionId,
  projectId,
  userId = null,
  requestId,
  payload = {},
  checkpoint = {},
  resumeValidityDays = DEFAULT_RESUME_VALIDITY_DAYS,
  recordRetentionDays = DEFAULT_PENDING_RECORD_DAYS,
} = {}) {
  if (!(ctx?.query && runId && sessionId && requestId)) return null;
  const resumeHandle = createResumeHandle({ runId, sessionId, requestId });
  const payloadWithHandle = {
    ...payload,
    request_id: requestId,
    run_id: runId,
    resume_handle: resumeHandle,
  };
  const resumeExpiresAt = addDays(resumeValidityDays);
  const recordExpiresAt = addDays(recordRetentionDays);
  await ctx.query(
    `INSERT INTO agent_pending_inputs (
        id, run_id, session_id, project_id, user_id, request_id,
        input_type, status, payload_json, response_json, resume_handle_json,
        resume_expires_at, record_expires_at, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,'user_input','pending',$7,NULL,$8,$9,$10,now(),now())
      ON CONFLICT(request_id) DO UPDATE SET
        status='pending',
        payload_json=excluded.payload_json,
        resume_handle_json=excluded.resume_handle_json,
        resume_expires_at=excluded.resume_expires_at,
        record_expires_at=excluded.record_expires_at,
        updated_at=now()`,
    [
      randomUUID(),
      runId,
      sessionId,
      projectId || null,
      userId || null,
      requestId,
      JSON.stringify(payloadWithHandle),
      JSON.stringify(resumeHandle),
      resumeExpiresAt,
      recordExpiresAt,
    ],
  ).catch(() => null);
  await updateAgentRunStatus(ctx, {
    runId,
    status: "suspended",
    checkpoint: {
      ...checkpoint,
      suspended_at: nowIso(),
      waiting_for: { type: "user_input", request_id: requestId },
    },
  });
  return {
    request_id: requestId,
    run_id: runId,
    session_id: sessionId,
    status: "pending",
    payload: payloadWithHandle,
    resume_handle: resumeHandle,
    resume_expires_at: resumeExpiresAt,
  };
}

export async function resolvePendingUserInput(ctx, {
  sessionId,
  requestId,
  runId = null,
  value,
  userId = null,
} = {}) {
  if (!(ctx?.query && ctx?.queryOne && sessionId && requestId)) {
    return { status: "missing", recorded: false };
  }
  const row = await ctx.queryOne(
    `SELECT * FROM agent_pending_inputs
      WHERE request_id=$1 AND session_id=$2 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [requestId, sessionId],
  ).catch(() => null);
  if (!row) return { status: "missing", recorded: false };
  if (runId && row.run_id && String(row.run_id) !== String(runId)) {
    return { status: "mismatched", recorded: false, pending: row };
  }

  const currentStatus = String(row.status || "pending");
  const response = safeJson(row.response_json, null);
  if (currentStatus === "answered") {
    return {
      status: "answered",
      recorded: false,
      idempotent: true,
      chosen_value: response?.value ?? value,
      pending: row,
      payload: safeJson(row.payload_json),
      resume_handle: safeJson(row.resume_handle_json, null),
    };
  }

  const resumeExpiresAt = row.resume_expires_at ? new Date(row.resume_expires_at).getTime() : null;
  const isExpired = Number.isFinite(resumeExpiresAt) && resumeExpiresAt > 0 && resumeExpiresAt < Date.now();
  if (isExpired) {
    await ctx.query(
      `UPDATE agent_pending_inputs
          SET status='expired', response_json=$3, responded_by=$4, responded_at=now(), updated_at=now()
        WHERE id=$1 AND request_id=$2`,
      [
        row.id,
        requestId,
        JSON.stringify({ value, expired: true, responded_at: nowIso() }),
        userId || null,
      ],
    ).catch(() => null);
    await updateAgentRunStatus(ctx, { runId: row.run_id, status: "expired" });
    return {
      status: "expired",
      recorded: false,
      chosen_value: value,
      pending: row,
      payload: safeJson(row.payload_json),
      resume_handle: safeJson(row.resume_handle_json, null),
    };
  }

  const responseJson = {
    value,
    responded_at: nowIso(),
    resume_mode: "handle",
  };
  const run = await ctx.queryOne(
    `SELECT * FROM agent_runs WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
    [row.run_id],
  ).catch(() => null);
  const checkpoint = safeJson(run?.checkpoint_json, {});
  await ctx.query(
    `UPDATE agent_pending_inputs
        SET status='answered', response_json=$3, responded_by=$4, responded_at=now(), updated_at=now()
      WHERE id=$1 AND request_id=$2`,
    [row.id, requestId, JSON.stringify(responseJson), userId || null],
  ).catch(() => null);
  await updateAgentRunStatus(ctx, {
    runId: row.run_id,
    status: "resumed",
    checkpoint: {
      ...checkpoint,
      resumed_at: nowIso(),
      resumed_from: { request_id: requestId, value },
    },
  });
  return {
    status: "answered",
    recorded: true,
    chosen_value: value,
    pending: row,
    run,
    checkpoint,
    payload: safeJson(row.payload_json),
    resume_handle: safeJson(row.resume_handle_json, null),
    run_id: row.run_id,
  };
}

export function buildUserInputContinuationMessage({
  originalMessage = "",
  selectedValue = "",
  askPrompt = "",
  mode = "replayed",
} = {}) {
  const original = String(originalMessage || "").trim();
  const selected = String(selectedValue || "").trim();
  const prompt = String(askPrompt || "").trim();
  const lines = [
    "继续上一轮已挂起的任务。",
    mode === "handle" ? "用户已通过 resume handle 回复了等待中的确认。" : "用户已回复等待中的确认,请重新加载上下文后继续。",
    selected ? `用户选择: ${selected}` : "",
    prompt ? `当时的问题: ${prompt}` : "",
    original ? `原始任务: ${original}` : "",
    "请基于该选择继续完成原始任务,不要再次把该候选当作新的独立问题。",
  ].filter(Boolean);
  return lines.join("\n");
}

export function applyUserInputToolResultResume({
  sessionId,
  toolCallId,
  value,
  requestId = "",
} = {}) {
  if (!(sessionId && toolCallId)) return false;
  const selected = String(value || "").trim();
  return replaceToolResultText(
    sessionId,
    toolCallId,
    selected ? `用户已选择: ${selected}` : "用户已完成选择。",
    {
      resumed_user_input: true,
      request_id: requestId || null,
      value: selected,
    },
  );
}

export function createAgentRuntime({
  ctx,
  stream,
  runId,
  sessionId,
  projectId,
  userId = null,
  skill = null,
  mode = "agent",
} = {}) {
  const dbctx = ctx?.query ? ctx : ctx?.db;
  return {
    runId,
    sessionId,
    projectId,
    userId,
    createRun: () => createAgentRun(dbctx, { runId, sessionId, projectId, userId, skill, mode }),
    completeRun: (status = "completed") => updateAgentRunStatus(dbctx, {
      runId,
      status,
      finished: status === "completed" || status === "failed",
    }),
    async requestUserInput(payload = {}, { requestId, checkpoint = {} } = {}) {
      const reqId = normalizeId(requestId || payload.request_id, `q_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
      const suspended = await suspendRunForUserInput(dbctx, {
        runId,
        sessionId,
        projectId,
        userId,
        requestId: reqId,
        payload: { ...payload, request_id: reqId },
        checkpoint,
      });
      stream?.runSuspended?.({
        reason: "user_input",
        request_id: reqId,
        resumable: true,
        resume_handle: suspended?.resume_handle || createResumeHandle({ runId, sessionId, requestId: reqId }),
        resume_expires_at: suspended?.resume_expires_at || null,
      });
      return suspended?.payload || { ...payload, request_id: reqId };
    },
  };
}

export default {
  DEFAULT_RESUME_VALIDITY_DAYS,
  createResumeHandle,
  createAgentRun,
  updateAgentRunStatus,
  suspendRunForUserInput,
  resolvePendingUserInput,
  createAgentRuntime,
};
