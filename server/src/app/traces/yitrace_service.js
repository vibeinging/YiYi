import { execFileSync, fork } from "node:child_process";
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeTokenUsage } from "../../engine/core/token_usage.js";
import { StreamEventType } from "../../engine/stream/agent_stream_protocol.js";
import { activeTraceSpanId } from "../../engine/trace/trace_context.js";

const DEFAULT_TENANT_ID = 1;
const TRACE_ROOT_SPAN_ID = "yiw-run";
const LLM_SPAN_PREFIX = "yiw-llm";
const AGENT_SPAN_PREFIX = "yiw-agent";
const TRACE_TEXT_MAX = Math.max(0, Number(process.env.YIW_TRACE_TEXT_MAX || 0));
const TRACE_READ_TIMEOUT_MS = Math.max(500, Number(process.env.YIW_TRACE_READ_TIMEOUT_MS || 2500));
const TRACE_WORKER_TIMEOUT_MS = Math.max(500, Number(process.env.YIW_TRACE_WORKER_TIMEOUT_MS || TRACE_READ_TIMEOUT_MS));
const TRACE_WARMUP_TIMEOUT_MS = Math.max(1000, Number(process.env.YIW_TRACE_WARMUP_TIMEOUT_MS || 60000));
const STALE_LOCK_RETENTION_MS = Math.max(0, Number(process.env.YIW_TRACE_STALE_LOCK_RETENTION_MS || 7 * 24 * 60 * 60 * 1000));
const STALE_LOCK_MAX_FILES = Math.max(0, Number(process.env.YIW_TRACE_STALE_LOCK_MAX_FILES || 20));
const MAX_SPAN_DETAILS = Math.max(0, Number(process.env.YIW_TRACE_MAX_SPAN_DETAILS || 0));
const TRACE_TIMEOUT = Symbol("trace-timeout");

let modulePromise = null;
let dbPromise = null;
let loadErrorLogged = false;
let openErrorLogged = false;
let dbOverride = undefined;
const timeoutWarnings = new Set();
const traceWorkerPath = join(dirname(fileURLToPath(import.meta.url)), "yitrace_worker.js");
let traceWorker = null;
let traceWorkerSeq = 0;
let traceWorkerWarmupStarted = false;
let traceWorkerReady = false;
const traceWorkerPending = new Map();

function traceEnabled() {
  return process.env.YIW_TRACE !== "0";
}

function warnTraceTimeout(label) {
  if (timeoutWarnings.has(label)) return;
  timeoutWarnings.add(label);
  console.warn(`[yitrace] ${label} 超过 ${TRACE_READ_TIMEOUT_MS}ms,本次 Trace 读取降级`);
}

async function traceRead(label, fn) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      warnTraceTimeout(label);
      resolve(TRACE_TIMEOUT);
    }, TRACE_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(fn).catch(() => null),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function dataDir() {
  return process.env.YIW_YITRACE_DIR || join(homedir(), ".yiw", "yitrace");
}

function lockPath(dir = dataDir()) {
  return join(dir, ".yitrace.lock");
}

function staleLockPath(dir = dataDir()) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return join(dir, `.yitrace.lock.stale-${stamp}-${process.pid}`);
}

function isLockError(error) {
  const message = String(error?.message || error || "");
  return message.includes(".yitrace.lock") || message.includes("already open or locked");
}

function isFileOpen(path) {
  try {
    execFileSync("lsof", [path], { stdio: ["ignore", "pipe", "ignore"], timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleLocks(dir = dataDir()) {
  if (STALE_LOCK_RETENTION_MS === 0 && STALE_LOCK_MAX_FILES === 0) return;
  let entries = [];
  try {
    entries = readdirSync(dir)
      .filter((name) => name.startsWith(".yitrace.lock.stale"))
      .map((name) => {
        const path = join(dir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(path).mtimeMs || 0;
        } catch {
          mtimeMs = 0;
        }
        return { name, path, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return;
  }
  const now = Date.now();
  let removed = 0;
  for (const [index, entry] of entries.entries()) {
    const expired = STALE_LOCK_RETENTION_MS > 0 && entry.mtimeMs > 0 && now - entry.mtimeMs > STALE_LOCK_RETENTION_MS;
    const overflow = STALE_LOCK_MAX_FILES > 0 && index >= STALE_LOCK_MAX_FILES;
    if (!expired && !overflow) continue;
    try {
      unlinkSync(entry.path);
      removed += 1;
    } catch {
      // best effort cleanup
    }
  }
  if (removed) console.info(`[yitrace] 已清理 ${removed} 个历史 stale lock 标记`);
}

function stopTraceWorkerPending(value) {
  for (const pending of traceWorkerPending.values()) {
    clearTimeout(pending.timer);
    pending.resolve(value);
  }
  traceWorkerPending.clear();
}

function ensureTraceWorker() {
  if (traceWorker?.connected) return traceWorker;
  cleanupStaleLocks(dataDir());
  traceWorker = fork(traceWorkerPath, [], {
    env: {
      ...process.env,
      YIW_YITRACE_DIR: dataDir(),
      YIW_YITRACE_TENANT_ID: String(DEFAULT_TENANT_ID),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  traceWorker.stdout?.on("data", (chunk) => process.stdout.write(String(chunk)));
  traceWorker.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)));
  traceWorker.on("message", (message = {}) => {
    const pending = traceWorkerPending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    traceWorkerPending.delete(message.id);
    pending.resolve(message.ok ? message.data : null);
  });
  traceWorker.on("exit", () => {
    traceWorker = null;
    traceWorkerWarmupStarted = false;
    traceWorkerReady = false;
    stopTraceWorkerPending(null);
  });
  traceWorker.on("error", (error) => {
    console.warn("[yitrace] trace worker 异常:", error?.message || error);
  });
  return traceWorker;
}

async function traceWorkerCall(action, payload = {}, timeoutMs = TRACE_WORKER_TIMEOUT_MS) {
  if (!traceEnabled()) return null;
  const worker = ensureTraceWorker();
  if (!worker?.connected) return null;
  const id = `ytw-${++traceWorkerSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      traceWorkerPending.delete(id);
      warnTraceTimeout(`trace worker ${action}`);
      resolve(TRACE_TIMEOUT);
    }, timeoutMs);
    traceWorkerPending.set(id, { resolve, timer });
    try {
      worker.send({ id, action, ...payload });
    } catch {
      clearTimeout(timer);
      traceWorkerPending.delete(id);
      resolve(null);
    }
  });
}

export function warmupYiTraceDb() {
  if (!traceEnabled() || dbOverride !== undefined) return;
  if (traceWorkerWarmupStarted) return;
  traceWorkerWarmupStarted = true;
  void traceWorkerCall("warmup", {}, TRACE_WARMUP_TIMEOUT_MS)
    .then((result) => {
      if (result === true) traceWorkerReady = true;
      else traceWorkerWarmupStarted = false;
    });
}

async function closeTraceWorker() {
  const worker = traceWorker;
  if (!worker?.connected) return;
  const id = `ytw-close-${++traceWorkerSeq}`;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      traceWorkerPending.delete(id);
      resolve();
    }, 1500);
    traceWorkerPending.set(id, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      timer,
    });
    try {
      worker.send({ id, action: "close" });
    } catch {
      clearTimeout(timer);
      traceWorkerPending.delete(id);
      resolve();
    }
  });
  if (traceWorker === worker) traceWorker = null;
  traceWorkerWarmupStarted = false;
  traceWorkerReady = false;
}

function recoverStaleLock(error, dir = dataDir()) {
  if (process.env.YIW_YITRACE_STALE_LOCK_RECOVERY === "0") return false;
  if (!isLockError(error)) return false;
  const currentLock = lockPath(dir);
  if (!existsSync(currentLock)) return false;
  if (isFileOpen(currentLock)) {
    console.warn("[yitrace] trace DB lock 当前仍被进程持有,不自动恢复:", currentLock);
    return false;
  }
  const stale = staleLockPath(dir);
  try {
    renameSync(currentLock, stale);
    console.warn("[yitrace] 检测到遗留 trace DB lock,已改名并重试:", stale);
    cleanupStaleLocks(dir);
    return true;
  } catch (renameError) {
    console.warn("[yitrace] trace DB lock 恢复失败:", renameError?.message || renameError);
    return false;
  }
}

function clip(value, max = TRACE_TEXT_MAX) {
  const text = value == null ? "" : String(value);
  const limit = Math.max(0, Number(max || 0));
  return limit > 0 && text.length > limit ? `${text.slice(0, limit).trimEnd()}...` : text;
}

function jsonText(value, max = TRACE_TEXT_MAX) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return clip(value, max);
  try {
    return clip(JSON.stringify(value), max);
  } catch {
    return clip(String(value), max);
  }
}

function parseMaybeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function textFromContentItems(value) {
  const items = parseMaybeJson(value, []);
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if (item.type === "text" || item.display_type === "text") return String(item.content || "");
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function traceText(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return clip(value);
  try {
    return clip(JSON.stringify(value));
  } catch {
    return clip(String(value));
  }
}

function toolInputFromPayload(payload = {}) {
  return traceText(payload.input || payload.trace_input || payload.traceInput || payload.args || payload.args_preview);
}

function toolOutputFromPayload(payload = {}) {
  return traceText(payload.output || payload.trace_output || payload.traceOutput || payload.result || payload.result_preview);
}

function contentItemText(item) {
  if (!item || typeof item !== "object") return "";
  const title = String(item.title || "").trim();
  const content = item.content;
  let body = "";
  if (typeof content === "string") {
    body = content;
  } else if (content && typeof content === "object") {
    try {
      body = JSON.stringify(content);
    } catch {
      body = String(content);
    }
  }
  const text = [title, body].filter(Boolean).join("\n");
  return clip(text);
}

function isTraceTextItem(item) {
  if (!item || typeof item !== "object") return false;
  if (!["thinking", "markdown", "text", "json"].includes(String(item.type || ""))) return false;
  const meta = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  return meta.display !== false;
}

function llmSnapshotName(item) {
  if (item?.type === "thinking") return "LLM 思考";
  const meta = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
  if (meta.msg_category === "final_answer" || item?.title === "回答") return "LLM 返回";
  return "LLM 输出";
}

function safeSpanToken(value) {
  return String(value || "span").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "span";
}

function traceSnapshotsFromMessages(rows = []) {
  const snapshots = new Map();
  const llmByQuestionNo = new Map();
  let questionNo = 0;
  let questionText = "";
  for (const row of rows) {
    const items = parseMaybeJson(row.content_items, []);
    if (!Array.isArray(items)) continue;
    if (row.role === "user") {
      questionNo += 1;
      questionText = textFromContentItems(row.content_items);
      continue;
    }
    if (row.role !== "assistant" || questionNo <= 0) continue;
    const toolStack = [];
    const currentToolId = () => toolStack[toolStack.length - 1] || "";
    const activateTool = (toolId) => {
      if (!toolId) return;
      const index = toolStack.lastIndexOf(toolId);
      if (index >= 0) toolStack.splice(index, 1);
      toolStack.push(toolId);
    };
    const finishCurrentTool = () => {
      if (toolStack.length) toolStack.pop();
    };
    let order = 0;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const meta = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
      if (item.type === "tool") {
        order += 1;
        const toolId = String(item.id || "").trim();
        const parentToolId = meta.msg_category === "tool_detail" ? currentToolId() : "";
        if (toolId) {
          const prev = snapshots.get(toolId) || {};
          snapshots.set(toolId, {
            ...prev,
            order: prev.order ?? order,
            parentToolId: prev.parentToolId || parentToolId || "",
            input: prev.input || contentItemText(item),
          });
          if (meta.msg_category === "tool_detail") activateTool(toolId);
          else {
            toolStack.length = 0;
            activateTool(toolId);
          }
        }
        continue;
      }
      if (item.type === "plan" || item.type === "skill_invocation" || item.type === "tool") continue;
      if (isTraceTextItem(item)) {
        order += 1;
        const text = contentItemText(item);
        if (text) {
          const list = llmByQuestionNo.get(questionNo) || [];
          const parentToolId = meta.msg_category === "tool_detail" ? currentToolId() : "";
          list.push({
            id: `${LLM_SPAN_PREFIX}:history:${questionNo}:${order}:${item.id || list.length}`,
            name: llmSnapshotName(item),
            parentToolId,
            input: questionText,
            output: text,
            order,
            attrs: {
              channel: item.type,
              title: item.title || "",
              msg_category: meta.msg_category || "",
              parent_tool_call_id: parentToolId,
            },
          });
          llmByQuestionNo.set(questionNo, list);
        }
      }
      const activeToolId = currentToolId();
      if (!activeToolId) continue;
      if (meta.msg_category === "final_answer") {
        toolStack.length = 0;
        continue;
      }
      const canBackfillToolOutput = item.type === "table" || item.type === "tool_result" || meta.msg_category === "intermediate_result";
      if (!canBackfillToolOutput) continue;
      const text = contentItemText(item);
      if (!text) continue;
      const prev = snapshots.get(activeToolId) || {};
      snapshots.set(activeToolId, {
        ...prev,
        output: prev.output ? `${prev.output}\n\n${text}` : text,
      });
      if (item.type === "table" || meta.msg_category === "intermediate_result") finishCurrentTool();
    }
  }
  return { toolSnapshots: snapshots, llmByQuestionNo };
}

function messagesFromLogEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.flatMap((event) => {
    if (!event || typeof event !== "object") return [];
    if (Array.isArray(event.messages)) return event.messages;
    if (Array.isArray(event.logs)) return event.logs;
    if (event.message != null) return [event.message];
    return [];
  });
}

function uniqueClippedLogs(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = clip(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function runTimeMs(run) {
  const candidates = [run?.created_at, run?.updated_at, run?.finished_at]
    .map((value) => new Date(value || "").getTime())
    .filter((value) => Number.isFinite(value));
  return candidates.length ? Math.max(...candidates) : 0;
}

function traceQuestionText(trace) {
  const spans = Array.isArray(trace?.spans) ? trace.spans : [];
  const root = spans.find((span) => Number(span?.depth || 0) === 0) || spans[0];
  return compactText(root?.input);
}

function fallbackQuestionFromTrace(trace) {
  const questionText = traceQuestionText(trace);
  if (!questionText) return null;
  return {
    questionNo: 0,
    questionMessageId: null,
    questionText,
    sequenceNumber: null,
    createdAt: null,
  };
}

function questionForRun(run, questions = [], trace = null) {
  const traceText = traceQuestionText(trace);
  if (traceText && questions.length) {
    const matched = questions.find((question) => {
      const candidate = compactText(question.questionText);
      return candidate === traceText || candidate.includes(traceText) || traceText.includes(candidate);
    });
    if (matched) return matched;
  }
  if (!questions.length) return fallbackQuestionFromTrace(trace);
  const marker = runTimeMs(run);
  if (!marker) return questions[questions.length - 1];
  const before = questions.filter((question) => question.timeMs && question.timeMs <= marker);
  return before[before.length - 1] || questions[questions.length - 1];
}

function nowNs() {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function msToNs(ms) {
  return (BigInt(Math.max(0, Math.floor(Number(ms) || 0))) * 1_000_000n).toString();
}

function durationNsSince(startMs) {
  return (BigInt(Math.max(0, Date.now() - startMs)) * 1_000_000n).toString();
}

function safeStatus(status) {
  return status === "completed" || status === "ok" || status === "suspended" || status === 0 ? 0 : 1;
}

function numberFrom(...values) {
  for (const value of values) {
    const n = Number(value || 0);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function traceUsageFrom(usage = null) {
  const normalized = normalizeTokenUsage(usage);
  if (!normalized) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
  }
  return {
    inputTokens: normalized.prompt_tokens,
    outputTokens: normalized.completion_tokens,
    totalTokens: normalized.total_tokens,
    cachedTokens: normalized.cached_tokens,
    cacheWriteTokens: normalized.cache_write_tokens,
    costUsd: normalized.cost_usd,
  };
}

function hasTraceUsage(usage) {
  return Boolean(
    usage
      && (usage.inputTokens || usage.outputTokens || usage.totalTokens || usage.cachedTokens || usage.cacheWriteTokens || usage.costUsd)
  );
}

async function loadYiTraceModule() {
  if (!traceEnabled()) return null;
  if (!modulePromise) {
    modulePromise = import("@yitrace/db").catch((error) => {
      if (!loadErrorLogged) {
        console.warn("[yitrace] @yitrace/db 不可用,trace 已禁用:", error?.message || error);
        loadErrorLogged = true;
      }
      return null;
    });
  }
  return modulePromise;
}

export async function getYiTraceDb() {
  if (dbOverride !== undefined) return dbOverride;
  const mod = await loadYiTraceModule();
  if (!mod?.YiTraceDB) return null;
  if (!dbPromise) {
    const dir = dataDir();
    dbPromise = (async () => {
      try {
        cleanupStaleLocks(dir);
        return await mod.YiTraceDB.open({ dataDir: dir, tenantId: DEFAULT_TENANT_ID });
      } catch (error) {
        if (recoverStaleLock(error, dir)) {
          try {
            return await mod.YiTraceDB.open({ dataDir: dir, tenantId: DEFAULT_TENANT_ID });
          } catch (retryError) {
            error = retryError;
          }
        }
        if (!openErrorLogged) {
          console.warn("[yitrace] 打开本地 trace DB 失败,trace 已禁用:", error?.message || error);
          openErrorLogged = true;
        }
        dbPromise = null;
        return null;
      }
    })();
  }
  return dbPromise;
}

export function __setYiTraceDbForTest(db) {
  dbOverride = db;
}

export function __resetYiTraceDbForTest() {
  dbOverride = undefined;
  if (traceWorker) {
    try {
      traceWorker.kill();
    } catch {
      // ignore test cleanup
    }
    traceWorker = null;
  }
  stopTraceWorkerPending(null);
}

export async function closeYiTraceDb() {
  const pending = dbPromise;
  dbPromise = null;
  if (!pending) {
    await closeTraceWorker();
    return;
  }
  try {
    const db = await pending;
    await db?.close?.();
  } catch (error) {
    console.warn("[yitrace] 关闭本地 trace DB 失败:", error?.message || error);
  }
  await closeTraceWorker();
}

function noopRecorder(rawEmit) {
  return {
    emit: rawEmit,
    finish: async () => {},
  };
}

export async function createTraceRecorder({
  emit,
  projectId,
  sessionId,
  runId,
  userId = "",
  mode = "agent",
  skill = null,
  question = "",
  callSite = "agent_chat",
} = {}) {
  if (typeof emit !== "function" || !projectId || !sessionId || !runId) return noopRecorder(emit);
  const mod = await loadYiTraceModule();
  if (!mod?.createSpanEventBuilder) return noopRecorder(emit);

  const startedAt = Date.now();
  const rootAttrs = {
    project_id: String(projectId),
    skill: skill || "",
    mode: mode || "agent",
    call_site: callSite,
    external_run_id: String(runId),
    user_id: userId ? String(userId) : "",
  };
  const builder = mod.createSpanEventBuilder({
    traceId: String(runId),
    sessionId: String(sessionId),
    tenantId: DEFAULT_TENANT_ID,
    attrs: rootAttrs,
  });
  const startedSpans = new Set([TRACE_ROOT_SPAN_ID]);
  const endedSpans = new Set();
  const spanStartedAt = new Map([[TRACE_ROOT_SPAN_ID, startedAt]]);
  const spanKinds = new Map([[TRACE_ROOT_SPAN_ID, "agent"]]);
  const spanNames = new Map([[TRACE_ROOT_SPAN_ID, "YiW"]]);
  const toolOutputs = new Map();
  const agentOutputs = new Map();
  const llmOutputs = new Map();
  const llmParents = new Map();
  const llmAttrs = new Map();
  const llmUsages = new Map();
  const activeLlmSpans = new Set();
  let internalLlmSeq = 0;
  let internalAgentSeq = 0;
  let finished = false;
  let lastAnswer = "";

  const logEvent = (spanId, message, attrs = undefined) => {
    builder.log({
      spanId,
      message,
      attrs,
      ts: nowNs(),
    });
  };

  builder.startSpan({
    spanId: TRACE_ROOT_SPAN_ID,
    name: mode === "smart_query" ? "Smart Query" : "Agent Run",
    agentName: "YiW",
    inputText: clip(question),
    ts: nowNs(),
  });

  const currentTraceParentSpanId = () => {
    const spanId = activeTraceSpanId();
    return spanId && startedSpans.has(spanId) ? spanId : TRACE_ROOT_SPAN_ID;
  };

  const traceSpanInfo = (spanId = "") => {
    const id = spanId && startedSpans.has(spanId) ? spanId : currentTraceParentSpanId();
    return {
      spanId: id,
      kind: spanKinds.get(id) || "span",
      name: spanNames.get(id) || "",
    };
  };

  const currentTraceSpanInfo = () => traceSpanInfo();

  const resolveParentSpanId = (spanId, preferredParentSpanId = "") => {
    const parentSpanId = preferredParentSpanId || currentTraceParentSpanId();
    if (parentSpanId && parentSpanId !== spanId && startedSpans.has(parentSpanId)) return parentSpanId;
    return TRACE_ROOT_SPAN_ID;
  };

  const ensureToolSpan = (payload = {}, parentSpanId = "") => {
    const spanId = String(payload.tool_call_id || payload.id || "").trim();
    if (!spanId || startedSpans.has(spanId)) return spanId;
    const resolvedParentSpanId = resolveParentSpanId(spanId, parentSpanId);
    startedSpans.add(spanId);
    spanKinds.set(spanId, "tool");
    spanNames.set(spanId, payload.name || "tool");
    spanStartedAt.set(spanId, Date.now());
    builder.startSpan({
      spanId,
      parentSpanId: resolvedParentSpanId,
      name: payload.name || "tool",
      toolName: payload.name || "",
      inputText: toolInputFromPayload(payload),
      attrs: {
        ...(payload.attrs && typeof payload.attrs === "object" ? payload.attrs : {}),
        ...(payload.skill ? { skill: String(payload.skill) } : {}),
        parent_tool_call_id: resolvedParentSpanId === TRACE_ROOT_SPAN_ID ? "" : resolvedParentSpanId,
      },
      ts: nowNs(),
    });
    return spanId;
  };

  const ensureAgentSpan = (payload = {}, parentSpanId = "") => {
    const name = payload.name || payload.agentName || "agent";
    const spanId = String(payload.spanId || payload.agent_span_id || payload.id || `${AGENT_SPAN_PREFIX}:${safeSpanToken(name)}:${Date.now()}:${++internalAgentSeq}`).trim();
    if (!spanId || startedSpans.has(spanId)) return spanId;
    const resolvedParentSpanId = resolveParentSpanId(spanId, parentSpanId);
    startedSpans.add(spanId);
    spanKinds.set(spanId, "agent");
    spanNames.set(spanId, name);
    spanStartedAt.set(spanId, Date.now());
    builder.startSpan({
      spanId,
      parentSpanId: resolvedParentSpanId,
      name,
      agentName: name,
      inputText: traceText(payload.input || payload.trace_input || payload.traceInput),
      attrs: {
        ...(payload.attrs && typeof payload.attrs === "object" ? payload.attrs : {}),
        parent_span_id: resolvedParentSpanId === TRACE_ROOT_SPAN_ID ? "" : resolvedParentSpanId,
      },
      ts: nowNs(),
    });
    return spanId;
  };

  const ensureLlmSpan = (payload = {}, visibility = "") => {
    const blockId = String(payload.block_id || payload.id || "message").trim() || "message";
    const meta = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
    const msgCategory = payload.msg_category || meta.msg_category || "";
    const parentSpanId = msgCategory === "final_answer" ? TRACE_ROOT_SPAN_ID : currentTraceParentSpanId();
    const spanId = `${LLM_SPAN_PREFIX}:${safeSpanToken(parentSpanId)}:${safeSpanToken(blockId)}`;
    const usage = traceUsageFrom(payload.usage || meta.usage || meta.trace_usage);
    if (hasTraceUsage(usage)) llmUsages.set(spanId, usage);
    if (!startedSpans.has(spanId)) {
      const attrs = {
        channel: payload.channel || "",
        format: payload.format || "",
        visibility: visibility || "",
        msg_category: msgCategory,
        task_group: meta.task_group || "",
        parent_tool_call_id: parentSpanId === TRACE_ROOT_SPAN_ID ? "" : parentSpanId,
      };
      startedSpans.add(spanId);
      spanKinds.set(spanId, "llm");
      spanNames.set(spanId, payload.channel === "thinking" ? "LLM 思考" : msgCategory === "final_answer" || payload.title === "回答" ? "LLM 返回" : payload.title || "LLM 输出");
      spanStartedAt.set(spanId, Date.now());
      activeLlmSpans.add(spanId);
      llmParents.set(spanId, parentSpanId);
      llmAttrs.set(spanId, attrs);
      builder.startSpan({
        spanId,
        parentSpanId,
        name: payload.channel === "thinking" ? "LLM 思考" : msgCategory === "final_answer" || payload.title === "回答" ? "LLM 返回" : payload.title || "LLM 输出",
        model: payload.model || meta.model || meta.model_id || null,
        inputText: clip(question),
        attrs,
        ts: nowNs(),
      });
    }
    activeLlmSpans.add(spanId);
    return spanId;
  };

  const endLlmSpan = (spanId, status = 0) => {
    if (!spanId || endedSpans.has(spanId)) return;
    const usage = llmUsages.get(spanId) || traceUsageFrom();
    const attrs = {
      ...(llmAttrs.get(spanId) || {}),
      ...(hasTraceUsage(usage) ? {
        trace_input_tokens: usage.inputTokens || null,
        trace_output_tokens: usage.outputTokens || null,
        trace_total_tokens: usage.totalTokens || null,
        trace_cached_tokens: usage.cachedTokens || null,
        trace_cache_write_tokens: usage.cacheWriteTokens || null,
        trace_cost_usd: usage.costUsd || null,
      } : {}),
    };
    builder.endSpan({
      spanId,
      status,
      outputText: llmOutputs.get(spanId) || "",
      inputTokens: usage.inputTokens || null,
      outputTokens: usage.outputTokens || null,
      durationNs: durationNsSince(spanStartedAt.get(spanId) || Date.now()),
      ts: nowNs(),
      attrs,
    });
    endedSpans.add(spanId);
    activeLlmSpans.delete(spanId);
  };

  const endActiveLlmSpans = () => {
    for (const spanId of [...activeLlmSpans]) endLlmSpan(spanId);
  };

  const recordLlmCall = ({
    callSite = "",
    model = "",
    modelId = "",
    input = "",
    output = "",
    status = 0,
    error = null,
    durationMs = 0,
    usage = null,
    attrs = {},
  } = {}) => {
    if (finished) return;
    const parentSpanId = currentTraceParentSpanId();
    const startMs = Date.now() - Math.max(0, Number(durationMs || 0));
    const spanId = `${LLM_SPAN_PREFIX}:${safeSpanToken(parentSpanId)}:call:${Date.now()}:${++internalLlmSeq}`;
    const normalizedStatus = error || status === "error" || status === 1 ? 1 : 0;
    const usageMetrics = traceUsageFrom(usage);
    const { inputTokens, outputTokens, totalTokens, cachedTokens, cacheWriteTokens, costUsd } = usageMetrics;
    startedSpans.add(spanId);
    endedSpans.add(spanId);
    spanKinds.set(spanId, "llm");
    spanStartedAt.set(spanId, startMs);
    const llmAttrs = {
      llm_call_site: callSite || "",
      model_id: modelId || "",
      parent_tool_call_id: parentSpanId === TRACE_ROOT_SPAN_ID ? "" : parentSpanId,
      ...(attrs && typeof attrs === "object" ? attrs : {}),
    };
    builder.startSpan({
      spanId,
      parentSpanId,
      name: callSite ? `LLM ${callSite}` : "LLM Call",
      model: model || modelId || "primary",
      inputText: traceText(input),
      attrs: llmAttrs,
      ts: msToNs(startMs),
    });
    builder.endSpan({
      spanId,
      status: normalizedStatus,
      outputText: error ? traceText(error?.message || error) : traceText(output),
      inputTokens: inputTokens || null,
      outputTokens: outputTokens || null,
      durationNs: msToNs(durationMs),
      ts: nowNs(),
      attrs: {
        ...llmAttrs,
        trace_input_tokens: inputTokens || null,
        trace_output_tokens: outputTokens || null,
        trace_total_tokens: totalTokens || null,
        trace_cached_tokens: cachedTokens || null,
        trace_cache_write_tokens: cacheWriteTokens || null,
        trace_cost_usd: costUsd || null,
      },
    });
  };

  const recordToolStart = ({
    toolCallId = "",
    name = "",
    input = "",
    attrs = {},
    parentSpanId = "",
  } = {}) => {
    if (finished) return "";
    const spanId = ensureToolSpan({
      tool_call_id: toolCallId,
      id: toolCallId,
      name,
      input,
      trace_input: input,
      attrs,
    }, parentSpanId);
    return spanId;
  };

  const recordToolEnd = ({
    toolCallId = "",
    name = "",
    input = "",
    output = "",
    status = 0,
    error = null,
    durationMs = 0,
    attrs = {},
  } = {}) => {
    if (finished) return;
    const spanId = ensureToolSpan({
      tool_call_id: toolCallId,
      id: toolCallId,
      name,
      input,
      trace_input: input,
      attrs,
    });
    if (!spanId) return;
    const normalizedStatus = error || status === "error" || status === 1 ? 1 : 0;
    const outputText = error ? traceText(error?.message || error) : traceText(output);
    if (!endedSpans.has(spanId)) {
      builder.endSpan({
        spanId,
        status: normalizedStatus,
        outputText,
        durationNs: durationMs ? msToNs(durationMs) : durationNsSince(spanStartedAt.get(spanId) || Date.now()),
        ts: nowNs(),
        attrs: attrs && typeof attrs === "object" ? attrs : {},
      });
      endedSpans.add(spanId);
    } else if (outputText) {
      logEvent(spanId, outputText, { trace_tool_output: true });
    }
  };

  const recordAgentStart = ({
    name = "",
    input = "",
    attrs = {},
    parentSpanId = "",
  } = {}) => {
    if (finished) return "";
    const spanId = ensureAgentSpan({
      name,
      input,
      trace_input: input,
      attrs,
    }, parentSpanId);
    return spanId;
  };

  const recordAgentEnd = ({
    spanId = "",
    name = "",
    input = "",
    output = "",
    status = 0,
    error = null,
    durationMs = 0,
    attrs = {},
  } = {}) => {
    if (finished) return;
    const id = String(spanId || "").trim() || ensureAgentSpan({
      name,
      input,
      trace_input: input,
      attrs,
    });
    if (!id) return;
    endActiveLlmSpans();
    const normalizedStatus = error || status === "error" || status === 1 ? 1 : 0;
    const outputText = error ? traceText(error?.message || error) : traceText(output);
    if (outputText) agentOutputs.set(id, outputText);
    if (!endedSpans.has(id)) {
      builder.endSpan({
        spanId: id,
        status: normalizedStatus,
        outputText,
        durationNs: durationMs ? msToNs(durationMs) : durationNsSince(spanStartedAt.get(id) || Date.now()),
        ts: nowNs(),
        attrs: attrs && typeof attrs === "object" ? attrs : {},
      });
      endedSpans.add(id);
    } else if (outputText) {
      logEvent(id, outputText, { trace_agent_output: true });
    }
  };

  const recordEvent = (event) => {
    const type = event?.type;
    const payload = event?.payload || {};
    if (!type) return;

    if (type === StreamEventType.SKILL_SELECTED) {
      logEvent(
        TRACE_ROOT_SPAN_ID,
        `skill ${payload.name || ""} ${payload.status || ""}`.trim(),
        payload.name ? { skill: String(payload.name) } : undefined,
      );
      return;
    }

    if (type === StreamEventType.PLAN_UPDATED) {
      logEvent(TRACE_ROOT_SPAN_ID, `plan ${Array.isArray(payload.steps) ? payload.steps.length : 0} steps`);
      return;
    }

    if (type === StreamEventType.TOOL_STARTED) {
      endActiveLlmSpans();
      const parentSpanId = currentTraceParentSpanId();
      ensureToolSpan(payload, parentSpanId);
      return;
    }

    if (type === StreamEventType.TOOL_OUTPUT) {
      const spanId = ensureToolSpan(payload);
      if (!spanId) return;
      const output = toolOutputFromPayload(payload);
      if (output) toolOutputs.set(spanId, output);
      logEvent(spanId, output || jsonText(payload.result_preview || payload.result));
      return;
    }

    if (type === StreamEventType.TOOL_COMPLETED || type === StreamEventType.TOOL_FAILED) {
      endActiveLlmSpans();
      const spanId = ensureToolSpan(payload);
      if (!spanId) return;
      const output = toolOutputFromPayload(payload) || toolOutputs.get(spanId) || "";
      if (!endedSpans.has(spanId)) {
        builder.endSpan({
          spanId,
          status: type === StreamEventType.TOOL_FAILED || payload.status === "error" ? 1 : 0,
          outputText: output,
          durationNs: payload.duration_ns || payload.durationNs || durationNsSince(spanStartedAt.get(spanId) || Date.now()),
          ts: nowNs(),
        });
        endedSpans.add(spanId);
      }
      return;
    }

    if (type === StreamEventType.MESSAGE_DELTA) {
      const content = traceText(payload.content);
      if (!content) return;
      const spanId = ensureLlmSpan(payload, event.visibility);
      llmOutputs.set(spanId, content);
      if (payload.channel === "thinking") {
        logEvent(spanId, content, { channel: "thinking" });
      }
      const parentSpanId = llmParents.get(spanId) || TRACE_ROOT_SPAN_ID;
      if (event.visibility === "primary" && spanKinds.get(parentSpanId) !== "tool") lastAnswer = content;
      return;
    }

    if (type === StreamEventType.APPROVAL_REQUESTED || type === StreamEventType.USER_INPUT_REQUESTED) {
      logEvent(TRACE_ROOT_SPAN_ID, jsonText(payload.prompt || payload.summary || payload.name || type));
    }
  };

  const tracedEmit = (event) => {
    emit(event);
    try {
      recordEvent(event);
    } catch (error) {
      console.warn("[yitrace] trace event 记录失败:", error?.message || error);
    }
  };

  const finish = async ({ status = "completed", error = null } = {}) => {
    if (finished) return;
    finished = true;
    endActiveLlmSpans();
    for (const spanId of startedSpans) {
      if (spanId === TRACE_ROOT_SPAN_ID || endedSpans.has(spanId)) continue;
      builder.endSpan({
        spanId,
        status: 0,
        outputText: toolOutputs.get(spanId) || agentOutputs.get(spanId) || llmOutputs.get(spanId) || "",
        durationNs: durationNsSince(spanStartedAt.get(spanId) || Date.now()),
        ts: nowNs(),
      });
      endedSpans.add(spanId);
    }
    builder.endSpan({
      spanId: TRACE_ROOT_SPAN_ID,
      status: safeStatus(status),
      durationNs: durationNsSince(startedAt),
      outputText: error ? clip(error?.message || error) : lastAnswer,
      ts: nowNs(),
    });
    if (dbOverride !== undefined) {
      const db = await getYiTraceDb();
      if (!db) return;
      try {
        await builder.ingest(db);
        await db.flush();
      } catch (ingestError) {
        console.warn("[yitrace] trace 写入失败:", ingestError?.message || ingestError);
      }
      return;
    }
    const result = await traceWorkerCall("ingest", { events: builder.events() });
    if (result === TRACE_TIMEOUT) {
      console.warn("[yitrace] trace 写入仍在后台执行,本轮不等待");
    }
  };

  return {
    emit: tracedEmit,
    finish,
    recordLlmCall,
    recordToolStart,
    recordToolEnd,
    recordAgentStart,
    recordAgentEnd,
    traceSpanInfo,
    currentTraceSpanInfo,
  };
}

function normalizeSpan(span, detail = null, snapshot = null) {
  const logs = uniqueClippedLogs([
    ...(Array.isArray(span?.logs) ? span.logs : []),
    ...(Array.isArray(detail?.logs) ? detail.logs : []),
    ...messagesFromLogEvents(span?.logEvents),
    ...messagesFromLogEvents(detail?.logEvents),
  ]);
  const input = detail?.input || detail?.inputText || detail?.input_text || span?.input || span?.inputText || span?.input_text || snapshot?.input || "";
  const rawOutput = detail?.output || detail?.outputText || detail?.output_text || span?.output || span?.outputText || span?.output_text || "";
  const output = snapshot?.output && (!rawOutput || rawOutput === input) ? snapshot.output : rawOutput === input ? "" : rawOutput;
  const attrs = {
    ...(span?.attrs && typeof span.attrs === "object" ? span.attrs : {}),
    ...(detail?.attrs && typeof detail.attrs === "object" ? detail.attrs : {}),
  };
  const kind = span?.kind || "span";
  const externalSpanId = span?.externalSpanId || span?.external_span_id || null;
  let name = span?.name || span?.externalSpanId || span?.id || "span";
  if (kind === "llm") {
    if (attrs.llm_call_site) name = `LLM ${attrs.llm_call_site}`;
    else if (attrs.channel === "thinking") name = "LLM 思考";
    else if (attrs.msg_category === "final_answer" || name === "回答") name = "LLM 返回";
    else if (attrs.channel || attrs.format || String(externalSpanId || "").startsWith(LLM_SPAN_PREFIX)) name = "LLM 输出";
  }
  const externalParentSpanId =
    span?.externalParentSpanId ||
    span?.external_parent_span_id ||
    attrs.parent_tool_call_id ||
    attrs.parent_span_id ||
    attrs.trace_parent_span_id ||
    null;
  return {
    id: String(span?.id || ""),
    parentId: span?.parentId == null ? null : String(span.parentId),
    externalTraceId: span?.externalTraceId || span?.external_trace_id || null,
    externalSpanId,
    externalParentSpanId,
    externalSessionId: span?.externalSessionId || span?.external_session_id || null,
    kind,
    name,
    status: span?.status || "ok",
    depth: Number(span?.depth || 0),
    startMs: Number(span?.startMs || span?.start_ms || 0),
    durMs: numberFrom(span?.durMs, span?.duration_ms, detail?.durMs, detail?.duration_ms),
    cost: numberFrom(
      span?.cost,
      span?.cost_usd,
      span?.costUsd,
      detail?.cost,
      detail?.cost_usd,
      detail?.costUsd,
      attrs.cost_usd,
      attrs.trace_cost_usd,
    ),
    inTok: numberFrom(
      span?.inTok,
      span?.input_tokens,
      span?.inputTokens,
      detail?.inTok,
      detail?.input_tokens,
      detail?.inputTokens,
      attrs.trace_input_tokens,
      attrs.input_tokens,
    ),
    outTok: numberFrom(
      span?.outTok,
      span?.output_tokens,
      span?.outputTokens,
      detail?.outTok,
      detail?.output_tokens,
      detail?.outputTokens,
      attrs.trace_output_tokens,
      attrs.output_tokens,
    ),
    model: span?.model || detail?.model || null,
    attrs,
    order: snapshot?.order || null,
    input,
    output,
    logs,
  };
}

async function normalizeTrace(spanReader, runId, trace, runStatus = null, toolSnapshots = new Map(), llmSnapshots = []) {
  if (!trace) return null;
  const summary = trace.summary || {};
  const spans = Array.isArray(trace.spans) ? trace.spans : [];
  const detailPairs = await Promise.all(
    spans.slice(0, MAX_SPAN_DETAILS).map(async (span) => {
      const spanId = span?.externalSpanId || span?.external_span_id || span?.id;
      if (!spanId) return [span, null];
      const detail = await traceRead("读取 Trace span 详情", () => spanReader(runId, spanId));
      return [span, detail === TRACE_TIMEOUT ? null : detail];
    }),
  );
  const detailById = new Map(detailPairs.map(([span, detail]) => [span, detail]));
  const normalizedSpans = spans.map((span) => {
    const externalSpanId = span?.externalSpanId || span?.external_span_id || span?.id;
    const normalized = normalizeSpan(span, detailById.get(span), toolSnapshots.get(String(externalSpanId || "")));
    if (Number(normalized.depth || 0) === 0) {
      normalized.startMs = 0;
      normalized.durMs = Math.max(
        Number(normalized.durMs || 0),
        Number(summary.durMs || summary.duration_ms || 0),
        ...spans.map((item) => Number(item?.startMs || item?.start_ms || 0) + Number(item?.durMs || item?.duration_ms || 0)),
      );
    }
    return normalized;
  });
  const rootSpan = normalizedSpans.find((span) => Number(span.depth || 0) === 0) || null;
  const spanByExternalId = new Map();
  for (const span of normalizedSpans) {
    const externalSpanId = String(span.externalSpanId || span.id || "");
    if (externalSpanId) spanByExternalId.set(externalSpanId, span);
  }
  for (let pass = 0; pass < 3; pass += 1) {
    for (const span of normalizedSpans) {
      const externalSpanId = String(span.externalSpanId || span.id || "");
      const parentToolId = String(toolSnapshots.get(externalSpanId)?.parentToolId || "");
      if (!parentToolId) continue;
      const parent = spanByExternalId.get(parentToolId);
      if (!parent) continue;
      span.parentId = parent.id || parent.externalSpanId || null;
      span.externalParentSpanId = parent.externalSpanId || parent.id || parentToolId;
      span.depth = Number(parent.depth || 0) + 1;
      span.attrs = { ...(span.attrs || {}), parent_tool_call_id: parentToolId };
    }
  }
  const hasRecordedLlmSpans = normalizedSpans.some(
    (span) => span.kind === "llm" && !String(span.externalSpanId || "").startsWith(`${LLM_SPAN_PREFIX}:history:`),
  );
  const existingExternalIds = new Set(normalizedSpans.map((span) => String(span.externalSpanId || span.id || "")));
  if (!hasRecordedLlmSpans) {
    for (const snapshot of llmSnapshots) {
      if (!snapshot?.id || existingExternalIds.has(String(snapshot.id))) continue;
      const parentToolId = String(snapshot.parentToolId || "");
      const parentSpan = (parentToolId && spanByExternalId.get(parentToolId)) || rootSpan;
      normalizedSpans.push({
        id: String(snapshot.id),
        parentId: parentSpan?.id || null,
        externalTraceId: runId,
        externalSpanId: String(snapshot.id),
        externalParentSpanId: parentSpan?.externalSpanId || TRACE_ROOT_SPAN_ID,
        externalSessionId: null,
        kind: "llm",
        name: snapshot.name || "LLM 输出",
        status: "ok",
        depth: parentSpan ? Number(parentSpan.depth || 0) + 1 : 1,
        startMs: 0,
        durMs: 1,
        cost: 0,
        inTok: 0,
        outTok: 0,
        model: "primary",
        attrs: { ...(snapshot.attrs || {}), parent_tool_call_id: parentToolId },
        order: snapshot.order || null,
        input: snapshot.input || "",
        output: snapshot.output || "",
        logs: [],
      });
      existingExternalIds.add(String(snapshot.id));
    }
  }
  normalizedSpans.sort((a, b) => {
    const ar = Number(a.depth || 0) === 0 ? 0 : 1;
    const br = Number(b.depth || 0) === 0 ? 0 : 1;
    const ao = Number(a.order || 0);
    const bo = Number(b.order || 0);
    if (ar !== br) return ar - br;
    if (ao > 0 && bo > 0 && ao !== bo) return ao - bo;
    if (ao > 0 && bo <= 0) return -1;
    if (ao <= 0 && bo > 0) return 1;
    return a.startMs - b.startMs || a.depth - b.depth || a.name.localeCompare(b.name);
  });
  let cursorMs = 0;
  for (const span of normalizedSpans) {
    if (Number(span.depth || 0) === 0 || !span.order) continue;
    span.startMs = cursorMs;
    cursorMs += Math.max(1, Number(span.durMs || 0));
  }

  return {
    traceId: String(summary.traceId || summary.trace_id || ""),
    externalTraceId: summary.externalTraceId || summary.external_trace_id || runId,
    name: summary.name || "Trace",
    status: runStatus || summary.status || "ok",
    durMs: Number(summary.durMs || summary.duration_ms || 0),
    cost: Number(summary.cost || 0),
    spanCount: normalizedSpans.length || Number(summary.spanCount || summary.span_count || 0),
    spans: normalizedSpans,
  };
}

export async function listSessionTraces(ctx, input) {
  const { pid, sid } = input.params || {};
  const limit = Math.max(1, Math.min(50, Number(input.query?.limit || 20)));
  const resolveTrace = input.query?.resolve_trace === "1" || input.query?.resolveTrace === "1" || input.query?.resolveTrace === true;
  const runs = await ctx.query(
    `SELECT id, session_id, project_id, user_id, status, skill_name, mode, created_at, updated_at, finished_at
       FROM agent_runs
      WHERE session_id=$1
        AND deleted_at IS NULL
        AND (project_id=$2 OR project_id IS NULL OR $2 IS NULL)
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT $3`,
    [sid, pid, limit],
  ).catch(() => []);
  const messageRows = await ctx.query(
    `SELECT id, role, content_items, sequence_number, created_at
       FROM session_messages
      WHERE session_id=$1
        AND deleted_at IS NULL
      ORDER BY sequence_number ASC, created_at ASC`,
    [sid],
  ).catch(() => []);
  const questionRows = messageRows.filter((row) => row.role === "user");
  const { toolSnapshots, llmByQuestionNo } = traceSnapshotsFromMessages(messageRows);
  const questions = questionRows
    .map((row, index) => ({
      questionNo: index + 1,
      questionMessageId: row.id,
      questionText: textFromContentItems(row.content_items),
      sequenceNumber: Number(row.sequence_number || 0),
      createdAt: row.created_at,
      timeMs: new Date(row.created_at || "").getTime(),
    }))
    .filter((row) => row.questionText);

  const fallbackItem = (run) => ({
    runId: run.id,
    sessionId: run.session_id,
    projectId: run.project_id,
    userId: run.user_id,
    status: run.status,
    skill: run.skill_name,
    mode: run.mode,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    finishedAt: run.finished_at,
    question: questionForRun(run, questions),
    trace: null,
  });
  const fallbackItems = () => runs.map(fallbackItem);
  if (!runs.length) {
    return {
      data: {
        enabled: traceEnabled(),
        dataDir: dataDir(),
        session: null,
        items: [],
      },
    };
  }

  if (!traceEnabled()) {
    return {
      data: {
        enabled: false,
        dataDir: dataDir(),
        session: null,
        items: fallbackItems(),
      },
    };
  }

  const dir = dataDir();
  if (!resolveTrace && dbOverride === undefined) {
    cleanupStaleLocks(dir);
    warmupYiTraceDb();
    const traceWarmupPending = !traceWorkerReady;
    return {
      data: {
        enabled: true,
        dataDir: dir,
        session: null,
        traceResolveDeferred: true,
        traceReadTimeout: traceWarmupPending,
        traceWarmupPending,
        items: fallbackItems(),
      },
    };
  }

  let traceReader;
  let spanReader;
  if (dbOverride !== undefined) {
    const db = await traceRead("打开 Trace DB", () => getYiTraceDb());
    if (db === TRACE_TIMEOUT) {
      return {
        data: {
          enabled: true,
          dataDir: dir,
          traceReadTimeout: true,
          traceWarmupPending: true,
          items: fallbackItems(),
        },
      };
    }
    if (!db) {
      return {
        data: {
          enabled: false,
          dataDir: dir,
          items: fallbackItems(),
        },
      };
    }
    traceReader = (runId) => db.trace(runId);
    spanReader = (runId, spanId) => db.span(runId, spanId);
  } else {
    cleanupStaleLocks(dir);
    traceReader = (runId, run = {}) => traceWorkerCall("trace", { runId, projectId: run.project_id || pid || "" });
    spanReader = (runId, spanId) => traceWorkerCall("span", { runId, spanId });
  }

  const items = [];
  let traceReadTimeout = false;
  for (const run of runs) {
    const trace = traceReadTimeout ? null : await traceRead("读取 Trace run", () => traceReader(run.id, run));
    if (trace === TRACE_TIMEOUT) traceReadTimeout = true;
    const baseTrace = trace === TRACE_TIMEOUT ? null : trace;
    const question = questionForRun(run, questions, baseTrace);
    const normalizedTrace = baseTrace
      ? await normalizeTrace(
        spanReader,
        run.id,
        baseTrace,
        run.status,
        toolSnapshots,
        llmByQuestionNo.get(question?.questionNo || 0) || [],
      )
      : null;
    items.push({
      runId: run.id,
      sessionId: run.session_id,
      projectId: run.project_id,
      userId: run.user_id,
      status: run.status,
      skill: run.skill_name,
      mode: run.mode,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      finishedAt: run.finished_at,
      question,
      trace: normalizedTrace,
    });
  }

  return {
    data: {
      enabled: true,
      dataDir: dir,
      session: null,
      traceReadTimeout,
      traceWarmupPending: traceReadTimeout,
      items,
    },
  };
}
