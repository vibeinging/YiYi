/**
 * L1 用例层 — 工作台 Agent 对话入口流式(抽自 routes/agent_chat.js 的 SSE chat 端点)。
 *
 * 流式签名:async fn(ctx, input, emit) —— emit(obj) 由 transport 加 `data:`+`\n\n` 帧。
 *   - 源里每个 sse(res, obj) → emit(obj)。
 *   - [DONE] / res.end() 由 transport 统一收尾,本文件不发。
 *   - 错误直接 throw(transport emit {type:'complete',status:'failed'} + [DONE] + end)。
 *   - 断连清理(原 res.on('close'))→ 监听 ctx.signal 的 'abort':abort agent + 释放待决 toolCallId。
 *
 * 命名空间:复用 sessions / session_messages,action_type='agentic_chat' 标记。
 * 契约:Agent Stream v1 events → "data: [DONE]"
 *
 * 治理确认共享态(pendingDecisions)抽到 agent_misc.js,与 /tool-decision 端点共用同一 Map。
 *
 * 注:app/chat/ 比 routes/ 深一层 → engine 用 ../../engine。
 */
import { randomUUID } from "node:crypto";
import { WorkspaceAgent } from "../../engine/agents/workspace_agent.js";
import { runAgent } from "../../engine/core/base_agent.js";
import { isSkillEnabledForWorkspace } from "../../engine/agents/pi_skill_registry.js";
import {
  applyUserInputToolResultResume,
  buildUserInputContinuationMessage,
  createAgentRuntime,
  resolvePendingUserInput,
} from "../../engine/agents/suspended_run_runtime.js";
import { isAskDataProjectWorkspaceId as isRegularProjectWorkspace } from "../../engine/agents/workspace_context.js";
import { createAgentStreamEmitter } from "../../engine/stream/agent_stream_emitter.js";
import { runWithTraceContext } from "../../engine/trace/trace_context.js";
import { on_round_start } from "../../engine/semantic/conversation_lifecycle.js";
import { createTraceRecorder } from "../traces/yitrace_service.js";
import { pendingDecisions } from "./agent_misc.js";
import { buildAttachmentContextMessage, buildUserContentItems, normalizeMessageAttachments } from "./message_blocks.js";

const LEGACY_SERVICE_SKILL_NAMES = new Set(["smart_query", "project_data_query", "query_project_data", "workspace"]);

function selectExplicitPromptSkill(body, question, { resume = false } = {}) {
  const requested = String(body?.skill || "").trim();
  const skillName = requested && !LEGACY_SERVICE_SKILL_NAMES.has(requested) ? requested : null;
  return {
    skill_name: skillName,
    runtime: skillName ? "prompt" : null,
    reason: skillName ? (resume ? "resume_user_input" : "explicit_skill") : "workspace_agent",
    normalized_message: question,
  };
}

// POST /api/agent/projects/:pid/sessions/:sid/chat — 工作台 Agent 对话(流式)
export async function agentChat(ctx, input, emit) {
  if (ctx.signal?.aborted) return;
  const { query, queryOne } = ctx;
  const { pid, sid } = input.params;
  const body = input.body || {};
  const rawQuestion = body.message || body.question || body.content || "";
  const attachments = normalizeMessageAttachments(body.attachments);
  const controlPlane = input.controlPlaneAction?.type === "pending_action";
  const userInputResponse = input.pendingUserInputResponse && typeof input.pendingUserInputResponse === "object"
    ? input.pendingUserInputResponse
    : null;
  const resumeHandle = userInputResponse?.resume_handle && typeof userInputResponse.resume_handle === "object"
    ? userInputResponse.resume_handle
    : null;
  const responseRequestId = String(userInputResponse?.request_id || resumeHandle?.request_id || "").trim();
  const responseRunId = String(userInputResponse?.run_id || resumeHandle?.run_id || "").trim();
  const question = userInputResponse ? String(userInputResponse.value || rawQuestion || "") : rawQuestion;
  const displayQuestion = typeof body.display_message === "string" ? body.display_message : question;
  const userId = ctx.userId || "";
  const recordPendingDisambiguationChoice = async () => {
    if (!isRegularProjectWorkspace(pid)) return;
    return on_round_start(
      { query, queryOne },
      {
        session_id: sid,
        user_message: question,
        project_id: pid,
        user_id: userId,
      },
    );
  };
  const persistSimpleTurn = async (items = []) => {
    try {
      const seqRow = await queryOne(
        `SELECT COALESCE(MAX(sequence_number),0) AS m FROM session_messages WHERE session_id=$1`,
        [sid],
      ).catch(() => ({ m: 0 }));
      let seq = Number(seqRow?.m || 0);
      if (!controlPlane) {
        await query(
          `INSERT INTO session_messages (id,session_id,role,content_items,sequence_number,created_at,updated_at)
           VALUES ($1,$2,'user',$3,$4,now(),now())`,
          [randomUUID(), sid, JSON.stringify(buildUserContentItems(displayQuestion, attachments)), ++seq],
        ).catch(() => {});
      }
      await query(
        `INSERT INTO session_messages (id,session_id,role,content_items,sequence_number,created_at,updated_at)
         VALUES ($1,$2,'assistant',$3,$4,now(),now())`,
        [randomUUID(), sid, JSON.stringify(items), ++seq],
      ).catch(() => {});
      await query(
        `UPDATE sessions SET updated_at=now(), message_count=COALESCE(message_count,0)+$2 WHERE id=$1`,
        [sid, controlPlane ? 1 : 2],
      ).catch(() => {});
    } catch {
      /* 持久化失败不阻断本轮返回 */
    }
  };
  const emitDisambiguationAck = async (choice, resolvedInput = null, { complete = true } = {}) => {
    const runId = resolvedInput?.run_id || responseRunId || randomUUID();
    const stream = createAgentStreamEmitter({ emit, runId, sessionId: sid });
    stream.runStarted({ mode: "agent", skill: null, content: "正在记录选择…" });
    const chosen = String(choice?.chosen_value || question || "").trim();
    if (resolvedInput?.status === "expired") {
      stream.runExpired({ request_id: responseRequestId, value: chosen });
      const pushed = stream.content(`这个确认已过期，已收到「${chosen}」，请重新发起或继续原问题。`, {
        content_id: randomUUID(),
        content_type: "markdown",
        title: "确认已过期",
        display: true,
      });
      stream.runCompleted({ status: "failed", message: "确认已过期" });
      await persistSimpleTurn([pushed.item]);
      return;
    }
    stream.runResumed({
      request_id: responseRequestId,
      mode: resolvedInput?.recorded ? "handle" : "stateless",
      resume_handle: resolvedInput?.resume_handle || resumeHandle || null,
    });
    stream.userInputResolved({
      request_id: responseRequestId,
      value: chosen,
      status: "answered",
      run_id: runId,
    });
    if (!complete) return;
    const pushed = stream.content(`已选择「${chosen}」。`, {
      content_id: randomUUID(),
      content_type: "markdown",
      title: "选择已记录",
      display: true,
    });
    stream.runCompleted({ status: "completed", message: "选择已记录" });
    await persistSimpleTurn([pushed.item]);
  };

  const emitPendingActionFailure = async (resolvedInput, chosen) => {
    const runId = resolvedInput?.run_id || responseRunId || randomUUID();
    const stream = createAgentStreamEmitter({ emit, runId, sessionId: sid });
    const status = String(resolvedInput?.status || "missing");
    stream.runStarted({ mode: "agent", skill: null, content: "确认无法恢复" });
    if (status === "expired") {
      stream.runExpired({ request_id: responseRequestId, value: chosen });
    }
    stream.userInputResolved({
      request_id: responseRequestId,
      value: chosen,
      status: status === "expired" ? "expired" : "failed",
      run_id: runId,
    });
    const message =
      status === "expired"
        ? `这个确认已过期，已收到「${chosen}」，请重新发起或继续原问题。`
        : status === "mismatched"
          ? "这个确认不属于当前挂起任务，请刷新会话后重试。"
          : "这个确认已失效或不存在，请重新发起任务。";
    const pushed = stream.content(`⚠️ ${message}`, {
      content_id: randomUUID(),
      content_type: "markdown",
      title: "确认失败",
      display: true,
    });
    stream.runCompleted({ status: "failed", message: "确认无法恢复" });
    await persistSimpleTurn([pushed.item]);
  };

  const continueResolvedUserInput = async (resolvedInput, choice) => {
    if (resolvedInput?.status !== "answered" || !resolvedInput?.recorded) return false;
    const checkpoint = resolvedInput.checkpoint || {};
    const originalMessage = checkpoint.original_user_message || checkpoint.enhanced_user_query || "";
    if (!String(originalMessage || "").trim()) return false;
    const payload = resolvedInput.payload || {};
    const selected = String(choice?.chosen_value || question || "").trim();
    const continuation = buildUserInputContinuationMessage({
      originalMessage,
      selectedValue: selected,
      askPrompt: payload.prompt || checkpoint.params?.prompt || "",
      mode: "handle",
    });
    await emitDisambiguationAck(choice, resolvedInput, { complete: false });
    const runtime = String(checkpoint.runtime || "").trim();
    const skillName = runtime === "prompt" ? String(checkpoint.skill || "").trim() : "";
    const toolResultReplaced = applyUserInputToolResultResume({
      sessionId: sid,
      toolCallId: checkpoint.tool_call_id,
      value: selected,
      requestId: responseRequestId,
    });
    return agentChat(
      ctx,
      {
        ...input,
        controlPlaneAction: input.controlPlaneAction,
        pendingUserInputResponse: undefined,
        resumeIntent: { continueFromTranscript: toolResultReplaced },
        body: {
          ...body,
          message: toolResultReplaced ? selected : continuation,
          question: toolResultReplaced ? selected : continuation,
          content: toolResultReplaced ? selected : continuation,
          display_message: selected,
          skill: skillName || undefined,
          resume_run_id: resolvedInput.run_id || responseRunId || undefined,
        },
      },
      emit,
    ).then(() => true);
  };

  const emitSkillDisabled = ({ skillName, message }) => {
    const stream = createAgentStreamEmitter({ emit, runId: randomUUID(), sessionId: sid });
    stream.runStarted({ mode: "agent", skill: skillName, content: "Skill 已禁用" });
    stream.content(`⚠️ ${message}`, {
      content_id: randomUUID(),
      content_type: "markdown",
      title: "提示",
      display: true,
    });
    stream.runCompleted({ status: "failed", message: "Skill 已禁用" });
  };

  if (question.trim() && userInputResponse && controlPlane) {
    const resolvedInput = responseRequestId
      ? await resolvePendingUserInput(
        { query, queryOne },
        {
          sessionId: sid,
          requestId: responseRequestId,
          runId: responseRunId || null,
          value: question,
          userId,
        },
      )
      : { status: "missing", recorded: false };
    if (resolvedInput?.status !== "answered") {
      await emitPendingActionFailure(resolvedInput, question);
      return;
    }
    const choice = resolvedInput.recorded ? await recordPendingDisambiguationChoice() : null;
    const normalizedChoice = choice?.recorded ? choice : { chosen_value: resolvedInput.chosen_value || question };
    if (await continueResolvedUserInput(resolvedInput, normalizedChoice)) return;
    await emitDisambiguationAck(normalizedChoice, resolvedInput);
    return;
  }

  const resumeRequested = Boolean(input.resumeIntent?.continueFromTranscript);
  // 正常消息统一交给 WorkspaceAgent。body.mode 和旧 smart_query/workspace 值仅作兼容输入,不再参与分流。
  const skillDecision = selectExplicitPromptSkill(body, question, { resume: resumeRequested });
  const routedQuestion = skillDecision.normalized_message || question;
  const agentQuestion = buildAttachmentContextMessage(routedQuestion, attachments);

  if (
    question.trim() &&
    skillDecision.skill_name &&
    skillDecision.runtime === "prompt"
  ) {
    const enabled = await isSkillEnabledForWorkspace(ctx, pid, skillDecision.skill_name).catch(() => false);
    if (!enabled) {
      emitSkillDisabled({
        skillName: skillDecision.skill_name,
        message: isRegularProjectWorkspace(pid)
          ? `Skill「${skillDecision.skill_name}」不存在或已禁用,请在项目设置 → 技能中启用后再使用。`
          : `Skill「${skillDecision.skill_name}」不存在或已禁用,请在 App 设置 → 技能中启用后再使用。`,
      });
      return;
    }
  }

  const taskId = body.resume_run_id || randomUUID();
  const runMode = isRegularProjectWorkspace(pid) ? "agent" : "chat";
  const trace = await createTraceRecorder({
    emit,
    projectId: pid,
    sessionId: sid,
    runId: taskId,
    userId,
    mode: runMode,
    skill: skillDecision.skill_name || null,
    question: routedQuestion,
    callSite: "agent_chat",
  });
  const stream = createAgentStreamEmitter({
    emit: trace.emit,
    runId: taskId,
    sessionId: sid,
  });
  stream.runStarted({
    mode: runMode,
    skill: skillDecision.skill_name || null,
    content: "Agent 正在处理…",
  });
  if (skillDecision.skill_name) {
    stream.skillSelected({
      name: skillDecision.skill_name,
      runtime: skillDecision.runtime,
      status: "selected",
      reason: skillDecision.reason,
    });
  }

  // 累积 assistant 内容用于持久化(同 content_id 视为更新)。本轮只有这一处负责会话消息落库。
  const items = [];
  const upsertItem = (it) => {
    const e = items.find((x) => x.id === it.id);
    if (e) Object.assign(e, it);
    else items.push(it);
  };

  const stream_callback = async (content, opts = {}) => {
    const pushed = stream.content(content, opts);
    upsertItem(pushed.item);
    return pushed.contentId;
  };

  async function persist() {
    try {
      const seqRow = await queryOne(
        `SELECT COALESCE(MAX(sequence_number),0) AS m FROM session_messages WHERE session_id=$1`,
        [sid],
      ).catch(() => ({ m: 0 }));
      let seq = Number(seqRow?.m || 0);
      if (!controlPlane) {
        await query(
          `INSERT INTO session_messages (id,session_id,role,content_items,sequence_number,created_at,updated_at)
           VALUES ($1,$2,'user',$3,$4,now(),now())`,
          [randomUUID(), sid, JSON.stringify(buildUserContentItems(displayQuestion, attachments)), ++seq],
        ).catch(() => {});
      }
      await query(
        `INSERT INTO session_messages (id,session_id,role,content_items,sequence_number,created_at,updated_at)
         VALUES ($1,$2,'assistant',$3,$4,now(),now())`,
        [randomUUID(), sid, JSON.stringify(items), ++seq],
      ).catch(() => {});
      await query(
        `UPDATE sessions SET updated_at=now(), message_count=COALESCE(message_count,0)+$2 WHERE id=$1`,
        [sid, controlPlane ? 1 : 2],
      ).catch(() => {});
    } catch {
      /* 持久化失败不阻断本轮返回 */
    }
  }

  if (!question.trim()) {
    stream.runCompleted({ status: "failed", message: "请输入内容" });
    await trace.finish({ status: "failed", error: "请输入内容" });
    return;
  }

  // 本请求登记的待决 toolCallId(断连时统一拒绝,避免 beforeToolCall 永挂)
  const decisionIds = [];
  const activeAgents = new Set(); // 根 Agent + service 子 Agent,供「停止」统一 abort
  // 客户端断开(用户点「停止」=abort fetch)→ abort agent + 释放待决。原 res.on('close') → ctx.signal 'abort'。
  const onAbort = () => {
    try {
      for (const agent of activeAgents) agent?.abort?.();
    } catch {
      /* ignore */
    }
    for (const id of decisionIds) {
      const r = pendingDecisions.get(id);
      if (r) {
        pendingDecisions.delete(id);
        r(false);
      }
    }
  };
  ctx.signal?.addEventListener("abort", onAbort);

  // 历史回退源:仅当 JSONL 转写缺失(老会话)时,Agent 才调用它从 SQL 重建上下文。
  // 懒加载 —— 常规路径(有 JSONL)零 SQL 查询。取最近 40 条,按时序。
  const loadHistory = async () => {
    const rows = await query(
      `SELECT role, content_items, sequence_number
         FROM session_messages
        WHERE session_id=$1
        ORDER BY sequence_number DESC
        LIMIT 40`,
      [sid],
    ).catch(() => []);
    return Array.isArray(rows) ? rows.reverse() : [];
  };

  const agentContext = {
    task_id: taskId,
    user_id: userId,
    project_id: pid,
    session_id: sid,
    // 权限模式:ask=写/执行都确认 / auto=仅命令执行确认 / full=全放行
    approval: ["ask", "auto", "full"].includes(body.approval) ? body.approval : "ask",
    // 运行设置(来自设置页):网络超时 + 是否自动压缩上下文
    settings: body.settings && typeof body.settings === "object" ? body.settings : {},
    signal: ctx.signal || null,
    loadHistory, // JSONL 缺失时的 SQL 重建源(懒调用)
    db: { query, queryOne },
    input_data: { user_message: agentQuestion, session_id: sid, attachments },
    skillDecision,
    resume: resumeRequested ? { continueFromTranscript: true } : null,
    // 治理确认:返回一个 Promise,由 /tool-decision 端点 resolve(approved)
    awaitDecision: (id) => {
      decisionIds.push(id);
      return new Promise((resolve) => pendingDecisions.set(id, resolve));
    },
    // Agent 创建后回调,登记给停止用
    onAgent: (a) => {
      if (a) activeAgents.add(a);
    },
    offAgent: (a) => activeAgents.delete(a),
    onChildAgent: (a) => {
      if (a) activeAgents.add(a);
    },
    offChildAgent: (a) => activeAgents.delete(a),
  };
  const runtime = createAgentRuntime({
    ctx: { query, queryOne },
    stream,
    runId: taskId,
    sessionId: sid,
    projectId: pid,
    userId,
    skill: skillDecision.skill_name || null,
    mode: isRegularProjectWorkspace(pid) ? "agent" : "chat",
  });
  agentContext.runtime = runtime;
  await runtime.createRun();

  try {
    const workspaceAgent = await WorkspaceAgent.create({ projectId: pid });
    await recordPendingDisambiguationChoice();
    const result = await runWithTraceContext(trace, () => runAgent(workspaceAgent, agentContext, stream_callback, { method: "execute" }));
    const ok = result && result.success !== false;
    const suspended = Boolean(agentContext?.data?._suspended_by_ask_user);

    if (!suspended) {
      stream.runCompleted({ status: ok ? "completed" : "failed", message: "处理完成" });
      await runtime.completeRun(ok ? "completed" : "failed");
    }
    await persist();
    await trace.finish({
      status: suspended ? "suspended" : ok ? "completed" : "failed",
      error: ok ? null : result?.error || result?.message || null,
    });
  } catch (error) {
    await trace.finish({ status: "failed", error });
    throw error;
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    activeAgents.clear();
  }
}
