import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TENANT_ID = process.env.YIW_YITRACE_TENANT_ID || "1";
const STALE_LOCK_RETENTION_MS = Math.max(0, Number(process.env.YIW_TRACE_STALE_LOCK_RETENTION_MS || 7 * 24 * 60 * 60 * 1000));
const STALE_LOCK_MAX_FILES = Math.max(0, Number(process.env.YIW_TRACE_STALE_LOCK_MAX_FILES || 20));
const STARTUP_DELAY_MS = Math.max(0, Number(process.env.YIW_TRACE_WORKER_STARTUP_DELAY_MS || 0));

let dbPromise = null;

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
        return { path, mtimeMs };
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
  if (removed) console.info(`[yitrace-worker] 已清理 ${removed} 个历史 stale lock 标记`);
}

function recoverStaleLock(error, dir = dataDir()) {
  if (process.env.YIW_YITRACE_STALE_LOCK_RECOVERY === "0") return false;
  if (!isLockError(error)) return false;
  const currentLock = lockPath(dir);
  if (!existsSync(currentLock)) return false;
  if (isFileOpen(currentLock)) return false;
  try {
    const stale = staleLockPath(dir);
    renameSync(currentLock, stale);
    cleanupStaleLocks(dir);
    console.warn("[yitrace-worker] 检测到遗留 trace DB lock,已改名并重试:", stale);
    return true;
  } catch {
    return false;
  }
}

function nsToMs(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n / 1_000_000 : 0;
}

function numberFrom(...values) {
  for (const value of values) {
    const n = Number(value || 0);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function normalizedStatus(value) {
  if (value === 0 || value === "0" || value === "ok" || value === "completed") return "ok";
  if (value == null || value === "") return "ok";
  return "error";
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function spanName(step = {}, detail = {}) {
  const attrs = detail?.attrs && typeof detail.attrs === "object" ? detail.attrs : {};
  if (step.kind === "tool") return step.toolName || step.name || "tool";
  if (step.kind === "agent") return step.agentName || step.name || "agent";
  if (step.kind === "llm") {
    if (attrs.channel === "thinking") return "LLM 思考";
    if (attrs.msg_category === "final_answer") return "LLM 返回";
    return step.model || detail.model || step.name || "LLM 输出";
  }
  return step.name || detail.name || step.externalSpanId || step.spanId || "span";
}

function depthForStep(step, stepById, depthById, visiting = new Set()) {
  const id = String(step?.spanId || step?.externalSpanId || "");
  if (!id) return 0;
  if (depthById.has(id)) return depthById.get(id);
  if (visiting.has(id)) return 0;
  visiting.add(id);
  const parentId = step?.parentSpanId == null ? "" : String(step.parentSpanId);
  const parent = parentId ? stepById.get(parentId) : null;
  const depth = parent ? depthForStep(parent, stepById, depthById, visiting) + 1 : 0;
  depthById.set(id, depth);
  visiting.delete(id);
  return depth;
}

function detailBySpanKey(items = []) {
  const map = new Map();
  for (const item of items) {
    const keys = [item?.externalSpanId, item?.external_span_id, item?.spanId, item?.span_id].filter(Boolean);
    for (const key of keys) map.set(String(key), item);
  }
  return map;
}

async function findTrajectory(db, runId, projectId) {
  const baseFilter = projectId ? { projectId } : {};
  const queries = [
    { filter: { ...baseFilter, attrs: { external_run_id: runId } }, limit: 1 },
    { filter: { ...baseFilter, external_trace_id: runId }, limit: 1 },
  ];
  if (!projectId) queries.push({ filter: { attrs: { external_run_id: runId } }, limit: 1 });
  for (const query of queries) {
    const page = await db.traceTrajectories(query);
    const items = Array.isArray(page?.items) ? page.items : [];
    const exact = items.find((item) => {
      const summary = item?.summary || {};
      return summary.externalTraceId === runId || summary.external_trace_id === runId || String(summary.traceId || summary.trace_id || "") === runId;
    });
    if (exact || items[0]) return exact || items[0];
  }
  return null;
}

async function readTraceFast(db, runId, projectId = "") {
  const traceId = String(runId || "");
  if (!traceId) return null;
  const trajectory = await findTrajectory(db, traceId, projectId);
  if (!trajectory) {
    if (process.env.YIW_TRACE_SLOW_FALLBACK === "1") return db.trace(traceId);
    return null;
  }

  const summary = trajectory.summary || {};
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  const searchLimit = Math.max(1, Math.min(500, steps.length + 8));
  let details = [];
  try {
    const page = await db.traceSearch({
      filter: {
        ...(projectId ? { projectId } : {}),
        attrs: { external_run_id: traceId },
      },
      limit: searchLimit,
    });
    details = Array.isArray(page?.items) ? page.items : [];
  } catch {
    details = [];
  }
  const detailsByKey = detailBySpanKey(details);
  const stepById = new Map();
  for (const step of steps) {
    const id = String(step?.spanId || "");
    if (id) stepById.set(id, step);
  }
  const depthById = new Map();

  const spans = steps.map((step, index) => {
    const id = String(step?.spanId || step?.externalSpanId || `span-${index}`);
    const externalSpanId = step?.externalSpanId || step?.external_span_id || "";
    const detail = detailsByKey.get(String(externalSpanId || "")) || detailsByKey.get(id) || {};
    const attrs = detail?.attrs && typeof detail.attrs === "object" ? detail.attrs : {};
    const parentId = step?.parentSpanId == null ? null : String(step.parentSpanId);
    const parent = parentId ? stepById.get(parentId) : null;
    const input = detail.inputText || detail.input_text || detail.input || "";
    const output = detail.outputText || detail.output_text || detail.output || "";
    return {
      id,
      parentId,
      externalTraceId: summary.externalTraceId || summary.external_trace_id || traceId,
      externalSpanId: externalSpanId || detail.externalSpanId || detail.external_span_id || null,
      externalParentSpanId: parent?.externalSpanId || attrs.parent_tool_call_id || attrs.parent_span_id || null,
      externalSessionId: summary.externalSessionId || summary.external_session_id || detail.externalSessionId || detail.external_session_id || null,
      kind: step.kind || "span",
      name: spanName(step, detail),
      status: normalizedStatus(step.status ?? detail.status),
      depth: depthForStep(step, stepById, depthById),
      startMs: 0,
      durMs: nsToMs(step.durationNs ?? step.duration_ns ?? detail.durationNs ?? detail.duration_ns),
      cost: numberFrom(detail.cost, detail.costUsd, detail.cost_usd),
      inTok: numberFrom(detail.inputTokens, detail.input_tokens),
      outTok: numberFrom(detail.outputTokens, detail.output_tokens),
      model: step.model || detail.model || null,
      attrs,
      order: Number(step.index || index) + 1,
      input: compactText(input),
      output: compactText(output),
      logs: Array.isArray(detail.logs) ? detail.logs : [],
    };
  });

  return {
    summary: {
      traceId: String(summary.traceId || summary.trace_id || ""),
      externalTraceId: summary.externalTraceId || summary.external_trace_id || traceId,
      name: "Trace",
      status: normalizedStatus(summary.status),
      durMs: nsToMs(summary.durationNs || summary.duration_ns),
      cost: Number(summary.cost || summary.costUsd || summary.cost_usd || 0),
      spanCount: spans.length || Number(summary.spanCount || summary.span_count || 0),
    },
    spans,
  };
}

async function openDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      if (STARTUP_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, STARTUP_DELAY_MS));
      const { YiTraceDB } = await import("@yitrace/db");
      const dir = dataDir();
      cleanupStaleLocks(dir);
      try {
        return await YiTraceDB.open({ dataDir: dir, tenantId: DEFAULT_TENANT_ID });
      } catch (error) {
        if (recoverStaleLock(error, dir)) return YiTraceDB.open({ dataDir: dir, tenantId: DEFAULT_TENANT_ID });
        throw error;
      }
    })();
  }
  return dbPromise;
}

async function handleMessage(message = {}) {
  const db = message.action === "close" ? await dbPromise : await openDb();
  if (message.action === "warmup") return true;
  if (message.action === "trace") return readTraceFast(db, String(message.runId || ""), String(message.projectId || ""));
  if (message.action === "span") return db.span(String(message.runId || ""), String(message.spanId || ""));
  if (message.action === "ingest") {
    const events = Array.isArray(message.events) ? message.events : [];
    const result = await db.ingest(events, { tenantId: DEFAULT_TENANT_ID });
    await db.flush();
    return result;
  }
  if (message.action === "close") {
    await db?.close?.();
    dbPromise = null;
    return true;
  }
  throw new Error(`unknown action: ${message.action || ""}`);
}

process.on("message", (message = {}) => {
  const id = message.id;
  void handleMessage(message)
    .then((data) => {
      if (process.connected) process.send({ id, ok: true, data });
      if (message.action === "close") process.exit(0);
    })
    .catch((error) => {
      if (process.connected) process.send({ id, ok: false, error: error?.message || String(error) });
    });
});
