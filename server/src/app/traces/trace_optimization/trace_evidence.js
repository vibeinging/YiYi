import { array, object, text } from "./common.js";

const DEFAULT_PREVIEW_CHARS = 1200;
const DEFAULT_MAX_SPANS = 12;

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function jsonPreview(value, maxChars = DEFAULT_PREVIEW_CHARS) {
  if (value == null || value === "") return "";
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n...[truncated ${raw.length - maxChars} chars]`;
}

function spanId(span, index = 0) {
  return text(span.externalSpanId || span.external_span_id || span.span_id || span.id || `span-${index + 1}`);
}

function parentId(span) {
  return text(
    span.parentId ||
    span.parent_id ||
    span.externalParentSpanId ||
    span.external_parent_span_id ||
    span.attrs?.parent_tool_call_id ||
    span.attrs?.parent_span_id ||
    span.attrs?.trace_parent_span_id
  );
}

function spanInput(span) {
  return span.input ?? span.inputText ?? span.input_text ?? span.trace_input ?? span.attrs?.trace_input ?? span.attrs?.input ?? "";
}

function spanOutput(span) {
  return span.output ?? span.outputText ?? span.output_text ?? span.trace_output ?? span.result ?? span.attrs?.trace_output ?? span.attrs?.output ?? "";
}

function spanLogs(span) {
  return array(span.logs || span.logEvents || span.events)
    .map((item) => typeof item === "string" ? item : jsonPreview(item, 400))
    .filter(Boolean);
}

function traceRoot(source) {
  const src = object(source);
  if (src.trace) return object(src.trace);
  if (src.trace_detail || src.traceDetail) return object(src.trace_detail || src.traceDetail);
  if (src.trace_snapshot || src.traceSnapshot) return traceRoot(src.trace_snapshot || src.traceSnapshot);
  return src;
}

function traceSpans(source) {
  const src = object(source);
  const candidates = [
    src.spans,
    src.trace?.spans,
    src.trace_detail?.spans,
    src.traceDetail?.spans,
    src.trace_snapshot?.spans,
    src.traceSnapshot?.spans,
  ];
  for (const item of candidates) {
    const spans = array(item).map(object).filter((span) => Object.keys(span).length);
    if (spans.length) return spans;
  }
  return [];
}

function traceRef(source) {
  const src = object(source);
  const trace = traceRoot(source);
  const run = object(src.run);
  return {
    trace_id: text(trace.traceId || trace.trace_id || src.traceId || src.trace_id || run.traceId || run.trace_id),
    run_id: text(src.runId || src.run_id || run.runId || run.run_id || run.id),
    session_id: text(src.sessionId || src.session_id || run.sessionId || run.session_id),
  };
}

function normalizeSpan(span, index) {
  const attrs = object(span.attrs || span.attributes || span.metadata);
  const id = spanId({ ...span, attrs }, index);
  return {
    span_id: id,
    parent_span_id: parentId({ ...span, attrs }),
    kind: text(span.kind || span.type || span.category || "span").toLowerCase(),
    name: text(span.name || span.label || span.title || span.tool_name || span.model || id),
    status: text(span.status || span.state || "unknown"),
    depth: Number(span.depth || span.level || 0),
    order: Number(span.order || span.index || index),
    duration_ms: Number(span.durMs || span.duration_ms || span.durationMs || span.elapsed_ms || span.ms || 0),
    input: spanInput({ ...span, attrs }),
    output: spanOutput({ ...span, attrs }),
    logs: spanLogs(span),
    attrs,
  };
}

function statusIsError(status) {
  const value = String(status || "").toLowerCase();
  return ["failed", "fail", "error", "timeout", "blocked"].includes(value);
}

function tokenText(...values) {
  return values.map((value) => compact(typeof value === "string" ? value : jsonPreview(value, 2000))).filter(Boolean).join(" ");
}

function textMatches(span, query) {
  const q = compact(query).toLowerCase();
  if (!q) return false;
  const haystack = tokenText(span.name, span.kind, span.status, span.input, span.output, span.logs, span.attrs).toLowerCase();
  return haystack.includes(q);
}

function keywordsFrom(...values) {
  const raw = tokenText(...values).toLowerCase();
  return [...new Set(raw.split(/[^\p{L}\p{N}_]+/u).map((item) => item.trim()).filter((item) => item.length >= 2))]
    .slice(0, 30);
}

function selectedReason(span, context) {
  if (context.rootIds.has(span.span_id)) return "root span，提供整体运行入口";
  if (context.finalIds.has(span.span_id)) return "最终回答 span，用于对比 actual output";
  if (statusIsError(span.status)) return "状态异常，优先诊断";
  if (context.sqlIds.has(span.span_id)) return "SQL / scan 相关 span，和数据查询失败高度相关";
  if (context.keywordIds.has(span.span_id)) return "输入输出命中问题或 expected 关键词";
  if (context.familyIds.has(span.span_id)) return "关键 span 的父子调用，帮助定位丢失步骤";
  return "补充上下文";
}

export function buildTraceIndex(traceSnapshot) {
  const spans = traceSpans(traceSnapshot).map(normalizeSpan);
  const byId = new Map();
  for (const span of spans) {
    if (span.span_id) byId.set(span.span_id, span);
  }
  const childrenByParent = new Map();
  for (const span of spans) {
    if (!span.parent_span_id) continue;
    if (!childrenByParent.has(span.parent_span_id)) childrenByParent.set(span.parent_span_id, []);
    childrenByParent.get(span.parent_span_id).push(span);
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.order - b.order);
  }
  const roots = spans.filter((span) => !span.parent_span_id || !byId.has(span.parent_span_id) || Number(span.depth || 0) === 0);
  return {
    trace_ref: traceRef(traceSnapshot),
    spans,
    byId,
    childrenByParent,
    roots: roots.length ? roots : spans.slice(0, 1),
  };
}

export function traceOverview(traceSnapshot) {
  const index = buildTraceIndex(traceSnapshot);
  const spans = index.spans;
  return {
    ...index.trace_ref,
    total_spans: spans.length,
    root_spans: index.roots.map((span) => span.span_id),
    error_spans: spans.filter((span) => statusIsError(span.status)).length,
    tool_spans: spans.filter((span) => span.kind === "tool").length,
    llm_spans: spans.filter((span) => span.kind === "llm").length,
    agent_spans: spans.filter((span) => span.kind === "agent").length,
  };
}

export function traceGetSpan(traceSnapshot, span_id) {
  const index = buildTraceIndex(traceSnapshot);
  return index.byId.get(text(span_id)) || null;
}

export function traceChildren(traceSnapshot, span_id) {
  const index = buildTraceIndex(traceSnapshot);
  return index.childrenByParent.get(text(span_id)) || [];
}

export function traceParent(traceSnapshot, span_id) {
  const index = buildTraceIndex(traceSnapshot);
  const span = index.byId.get(text(span_id));
  return span?.parent_span_id ? index.byId.get(span.parent_span_id) || null : null;
}

export function traceSiblings(traceSnapshot, span_id) {
  const index = buildTraceIndex(traceSnapshot);
  const span = index.byId.get(text(span_id));
  if (!span) return [];
  if (!span.parent_span_id) return index.roots.filter((item) => item.span_id !== span.span_id);
  return (index.childrenByParent.get(span.parent_span_id) || []).filter((item) => item.span_id !== span.span_id);
}

export function traceSearch(traceSnapshot, { query = "", kind = "", status = "", limit = 20 } = {}) {
  const index = buildTraceIndex(traceSnapshot);
  const q = compact(query);
  const k = compact(kind).toLowerCase();
  const s = compact(status).toLowerCase();
  return index.spans.filter((span) => {
    if (k && span.kind !== k) return false;
    if (s && String(span.status || "").toLowerCase() !== s) return false;
    if (q && !textMatches(span, q)) return false;
    return true;
  }).slice(0, Math.max(1, Math.min(100, Number(limit || 20))));
}

export function tracePayload(traceSnapshot, { span_id, field = "input", offset = 0, limit = 4000 } = {}) {
  const span = traceGetSpan(traceSnapshot, span_id);
  if (!span) return { span_id: text(span_id), field, text: "", total: 0, offset: 0, next_offset: null };
  const raw = field === "output" ? span.output : field === "logs" ? span.logs.join("\n") : field === "attrs" ? JSON.stringify(span.attrs, null, 2) : span.input;
  const value = String(raw || "");
  const start = Math.max(0, Number(offset || 0));
  const size = Math.max(1, Math.min(20000, Number(limit || 4000)));
  const end = Math.min(value.length, start + size);
  return {
    span_id: span.span_id,
    field,
    text: value.slice(start, end),
    total: value.length,
    offset: start,
    next_offset: end < value.length ? end : null,
  };
}

function addWithFamily(selected, index, span) {
  if (!span) return;
  selected.set(span.span_id, span);
  const parent = span.parent_span_id ? index.byId.get(span.parent_span_id) : null;
  if (parent) selected.set(parent.span_id, parent);
  for (const child of (index.childrenByParent.get(span.span_id) || []).slice(0, 3)) {
    selected.set(child.span_id, child);
  }
}

function evidenceSpan(span, reason, previewChars) {
  const input = String(span.input || "");
  const output = String(span.output || "");
  return {
    span_id: span.span_id,
    parent_span_id: span.parent_span_id || "",
    kind: span.kind,
    name: span.name,
    status: span.status,
    duration_ms: span.duration_ms,
    why_selected: reason,
    input_preview: jsonPreview(input, previewChars),
    output_preview: jsonPreview(output, previewChars),
    logs_preview: span.logs.slice(0, 5).map((item) => jsonPreview(item, 600)),
    attrs: span.attrs,
    payload_ref: {
      input: input.length > previewChars ? `trace://span/${encodeURIComponent(span.span_id)}/input` : "",
      output: output.length > previewChars ? `trace://span/${encodeURIComponent(span.span_id)}/output` : "",
    },
  };
}

export function buildTraceEvidencePack({
  traceSnapshot,
  question = "",
  expectedBehavior = "",
  expectedAnswer = "",
  actualOutput = "",
  assertionType = "",
  goldSolve = {},
  mode = "diagnosis",
  maxSpans = DEFAULT_MAX_SPANS,
  previewChars = DEFAULT_PREVIEW_CHARS,
} = {}) {
  const index = buildTraceIndex(traceSnapshot);
  const selected = new Map();
  const keywords = keywordsFrom(question, expectedBehavior, expectedAnswer, actualOutput, goldSolve);
  const context = {
    rootIds: new Set(),
    finalIds: new Set(),
    sqlIds: new Set(),
    keywordIds: new Set(),
    familyIds: new Set(),
  };

  for (const span of index.roots.slice(0, 2)) {
    context.rootIds.add(span.span_id);
    selected.set(span.span_id, span);
  }

  const reversed = [...index.spans].reverse();
  const finalSpan = reversed.find((span) => String(span.attrs?.msg_category || "").toLowerCase() === "final_answer") ||
    reversed.find((span) => span.kind === "llm" && compact(span.output)) ||
    reversed.find((span) => compact(span.output));
  if (finalSpan) {
    context.finalIds.add(finalSpan.span_id);
    addWithFamily(selected, index, finalSpan);
  }

  for (const span of index.spans.filter((item) => statusIsError(item.status)).slice(0, 4)) {
    addWithFamily(selected, index, span);
  }

  const sqlHints = ["sql", "scan", "query", "database", "schema", "表", "字段"];
  const wantsSql = ["sql_result", "table_match", "number_approx"].includes(assertionType) ||
    sqlHints.some((hint) => tokenText(question, expectedBehavior, actualOutput, goldSolve).toLowerCase().includes(hint));
  if (wantsSql || mode !== "gold_solve") {
    for (const span of index.spans.filter((item) => {
      const haystack = tokenText(item.name, item.input, item.output, item.attrs).toLowerCase();
      return item.name === "sql_scan_operator" || haystack.includes("sql") || haystack.includes("select ");
    }).slice(0, 4)) {
      context.sqlIds.add(span.span_id);
      addWithFamily(selected, index, span);
    }
  }

  for (const span of index.spans) {
    if ([...keywords].some((kw) => textMatches(span, kw))) {
      context.keywordIds.add(span.span_id);
      addWithFamily(selected, index, span);
    }
    if (selected.size >= maxSpans * 2) break;
  }

  for (const span of [...selected.values()]) {
    const parent = span.parent_span_id ? index.byId.get(span.parent_span_id) : null;
    if (parent && selected.has(parent.span_id)) context.familyIds.add(span.span_id);
    if ((index.childrenByParent.get(span.span_id) || []).some((child) => selected.has(child.span_id))) context.familyIds.add(span.span_id);
  }

  const ordered = [...selected.values()]
    .sort((a, b) => a.depth - b.depth || a.order - b.order)
    .slice(0, Math.max(1, Math.min(30, Number(maxSpans || DEFAULT_MAX_SPANS))));

  return {
    version: 1,
    mode,
    trace_ref: index.trace_ref,
    trace_overview: {
      ...traceOverview(traceSnapshot),
      selected_spans: ordered.length,
    },
    evidence_spans: ordered.map((span) => evidenceSpan(span, selectedReason(span, context), previewChars)),
    omitted: {
      span_count: Math.max(0, index.spans.length - ordered.length),
      reason: index.spans.length > ordered.length ? "无关 span 已省略，可按 span_id 继续下钻" : "",
    },
  };
}

export const traceTools = {
  overview: traceOverview,
  get_span: traceGetSpan,
  children: traceChildren,
  parent: traceParent,
  siblings: traceSiblings,
  search: traceSearch,
  payload: tracePayload,
  build_evidence_pack: buildTraceEvidencePack,
};
