import { runWorkflowSkill } from "../../../engine/skills/workflow_skill_runner.js";
import { array, object, text } from "./common.js";
import { traceTools } from "./trace_evidence.js";

const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_MAX_ACTIONS = 3;

function clip(value, max = 2400) {
  const textValue = typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
  if (textValue.length <= max) return textValue;
  return `${textValue.slice(0, max)}\n...[truncated ${textValue.length - max} chars]`;
}

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeActionName(value) {
  const raw = compact(value).replace(/^trace[.:]/i, "").toLowerCase();
  const aliases = {
    getspan: "get_span",
    span: "get_span",
    get: "get_span",
    child: "children",
    get_children: "children",
    get_parent: "parent",
    get_siblings: "siblings",
    find: "search",
    payload_page: "payload",
    read_payload: "payload",
  };
  return aliases[raw] || raw;
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value, { min, max, fallback }) {
  return Math.max(min, Math.min(max, safeNumber(value, fallback)));
}

function summarizeSpan(span) {
  if (!span) return null;
  return {
    span_id: span.span_id,
    parent_span_id: span.parent_span_id || "",
    kind: span.kind,
    name: span.name,
    status: span.status,
    duration_ms: span.duration_ms,
    input_preview: clip(span.input || "", 900),
    output_preview: clip(span.output || "", 900),
    logs_preview: array(span.logs).slice(0, 4).map((item) => clip(item, 500)),
    attrs: object(span.attrs),
  };
}

function summarizeResult(result) {
  if (Array.isArray(result)) return result.slice(0, 8).map(summarizeSpan).filter(Boolean);
  if (result && typeof result === "object" && ("span_id" in result || "kind" in result || "name" in result)) {
    return summarizeSpan(result);
  }
  return result;
}

export function normalizeTraceActions(payload, maxActions = DEFAULT_MAX_ACTIONS) {
  const src = object(payload);
  const raw =
    src.next_trace_actions ||
    src.nextTraceActions ||
    src.trace_actions ||
    src.traceActions ||
    src.actions ||
    src.next_trace_action ||
    src.nextTraceAction;
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return rows
    .map((item) => {
      const action = object(item);
      const type = normalizeActionName(action.type || action.action || action.tool || action.name);
      return {
        type,
        span_id: text(action.span_id || action.spanId),
        query: text(action.query),
        kind: text(action.kind),
        status: text(action.status),
        field: text(action.field || "input") || "input",
        offset: safeNumber(action.offset, 0),
        limit: safeNumber(action.limit, 1600),
        reason: text(action.reason),
      };
    })
    .filter((action) => action.type)
    .slice(0, Math.max(1, Math.min(DEFAULT_MAX_ACTIONS, Number(maxActions || DEFAULT_MAX_ACTIONS))));
}

export function executeTraceAction(traceSnapshot, action) {
  const type = normalizeActionName(action?.type);
  const safeAction = { ...action, type };
  let result;
  if (type === "overview") {
    result = traceTools.overview(traceSnapshot);
  } else if (type === "get_span") {
    result = traceTools.get_span(traceSnapshot, action.span_id);
  } else if (type === "children") {
    result = traceTools.children(traceSnapshot, action.span_id);
  } else if (type === "parent") {
    result = traceTools.parent(traceSnapshot, action.span_id);
  } else if (type === "siblings") {
    result = traceTools.siblings(traceSnapshot, action.span_id);
  } else if (type === "search") {
    result = traceTools.search(traceSnapshot, {
      query: action.query,
      kind: action.kind,
      status: action.status,
      limit: clampNumber(action.limit, { min: 1, max: 8, fallback: 8 }),
    });
  } else if (type === "payload") {
    result = traceTools.payload(traceSnapshot, {
      span_id: action.span_id,
      field: action.field,
      offset: clampNumber(action.offset, { min: 0, max: 200000, fallback: 0 }),
      limit: clampNumber(action.limit, { min: 1, max: 3000, fallback: 1600 }),
    });
  } else {
    return {
      ok: false,
      action: safeAction,
      observation: `不支持的 Trace 动作: ${type || "unknown"}`,
      result: null,
    };
  }
  const summarized = summarizeResult(result);
  return {
    ok: Boolean(Array.isArray(result) ? result.length : result),
    action: safeAction,
    observation: `${type}${action.span_id ? ` ${action.span_id}` : ""}${action.query ? ` query=${action.query}` : ""}`,
    result: summarized,
  };
}

function isFinalDiagnosis(payload) {
  const src = object(payload);
  if (src.final === true || src.status === "final") return true;
  if (src.failure_stage || src.failureStage) return true;
  if (src.root_cause || src.rootCause) return true;
  return false;
}

function debuggerInput(baseInput, { round, maxRounds, observations, lastActionResults }) {
  return {
    ...baseInput,
    trace_debugger: {
      round,
      max_rounds: maxRounds,
      allowed_actions: [
        "overview",
        "get_span",
        "children",
        "parent",
        "siblings",
        "search",
        "payload",
      ],
      instruction: [
        "如果当前证据不足，只输出 next_trace_actions，请说明 reason。",
        "如果证据足够，输出最终 failure_stage、summary、evidence、evidence_path、recommended_actions。",
        "每条 evidence_path 必须引用 span_id；不能引用未观察到的 span。",
      ].join("\n"),
      observations,
      last_action_results: lastActionResults,
    },
  };
}

export async function runTraceDebugger(ctx, {
  projectId,
  skillName,
  task,
  baseInput,
  traceSnapshot,
  responseContract = "",
  callSite,
  temperature = 0.1,
  maxTokens = 6000,
  modelId = null,
  inputMaxChars = 36000,
  maxRounds = DEFAULT_MAX_ROUNDS,
  maxActionsPerRound = DEFAULT_MAX_ACTIONS,
  runStep = runWorkflowSkill,
} = {}) {
  const observations = [];
  let lastActionResults = [];
  let lastResult = null;

  for (let round = 1; round <= Math.max(1, Number(maxRounds || DEFAULT_MAX_ROUNDS)); round += 1) {
    const result = await runStep(ctx, {
      projectId,
      skillName,
      task,
      input: debuggerInput(baseInput, { round, maxRounds, observations, lastActionResults }),
      responseContract: [
        responseContract,
        "如果需要继续下钻，可以只输出 {\"next_trace_actions\":[{\"type\":\"get_span|children|parent|siblings|search|payload|overview\",\"span_id\":\"\",\"query\":\"\",\"reason\":\"\"}]}。",
      ].filter(Boolean).join("\n"),
      callSite,
      temperature,
      maxTokens,
      modelId,
      inputMaxChars,
    });
    const data = object(result?.data || result);
    lastResult = { skill: result?.skill, data };
    const actions = normalizeTraceActions(data, maxActionsPerRound);

    if (!actions.length || isFinalDiagnosis(data)) {
      return {
        skill: result?.skill,
        data: {
          ...data,
          trace_debugger: {
            rounds: round,
            observations,
          },
        },
      };
    }

    lastActionResults = actions.map((action) => executeTraceAction(traceSnapshot, action));
    observations.push(...lastActionResults.map((item) => ({
      round,
      action: item.action,
      ok: item.ok,
      observation: item.observation,
      result: item.result,
    })));
  }

  return {
    skill: lastResult?.skill,
    data: {
      ...(lastResult?.data || {}),
      trace_gaps: [
        ...array(lastResult?.data?.trace_gaps || lastResult?.data?.traceGaps).map(String),
        "TraceDebugger 达到下钻轮数上限，诊断可能不完整。",
      ],
      warnings: [
        ...array(lastResult?.data?.warnings).map(String),
        "TraceDebugger 达到下钻轮数上限。",
      ],
      trace_debugger: {
        rounds: Math.max(1, Number(maxRounds || DEFAULT_MAX_ROUNDS)),
        observations,
      },
    },
  };
}
