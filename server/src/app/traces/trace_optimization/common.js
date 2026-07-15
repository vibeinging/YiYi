import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "../../../errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_EVAL_DIR = join(__dirname, "../../../../../eval");

const REVIEW_STATUSES = new Set([
  "needs_review",
  "correct",
  "incorrect",
  "incomplete",
  "tool_error",
  "routing_error",
  "data_issue",
]);
const SEVERITIES = new Set(["low", "medium", "high", "blocker"]);
const ASSERTION_TYPES = new Set([
  "manual",
  "text_contains",
  "number_approx",
  "table_shape",
  "table_cell",
  "sql_result",
  "llm_judge",
]);
const GOLD_STATUSES = new Set(["missing", "drafted", "verified", "rejected"]);
const BENCHMARK_ANSWER_TYPES = new Set(["text", "number", "boolean", "list", "table", "json", "manual"]);
const BENCHMARK_ASSERTION_TYPES = new Set([
  "exact",
  "text_contains",
  "number_approx",
  "list_match",
  "table_match",
  "json_match",
  "sql_result",
  "llm_judge",
  "manual",
]);
const BENCHMARK_CASE_STATUSES = new Set(["draft", "reviewable", "ready", "invalid", "converted", "rejected"]);
const BENCHMARK_RUN_STATUSES = new Set(["running", "passed", "failed", "error", "blocked"]);
const BENCHMARK_SOURCE_TYPES = new Set(["manual", "ai_import", "trace_draft", "json_import", "csv_import", "folder_import"]);
const ATTEMPT_STATUSES = new Set(["planned", "running", "passed", "failed", "blocked", "abandoned"]);
const ATTEMPT_SOURCES = new Set(["manual", "diagnosis", "benchmark", "replay", "regression"]);
const MAX_BENCHMARK_IMPORT_CHARS = 60000;
const BENCHMARK_NORMALIZER_SKILL = "benchmark_case_normalizer";
const GOLD_SOLVE_DRAFTER_SKILL = "gold_solve_drafter";
const TRACE_FAILURE_DIAGNOSER_SKILL = "trace_failure_diagnoser";
const TRACE_TUNING_PROPOSER_SKILL = "trace_tuning_proposer";
const BENCHMARK_TASK_MATERIALIZER_SKILL = "benchmark_task_materializer";
const GENERATED_TRACE_BENCHMARK_DIR = join(APP_EVAL_DIR, "generated", "trace-benchmark");
const GENERATED_TASKS_DIR = join(APP_EVAL_DIR, "generated", "tasks");

function text(value, fallback = "") {
  if (value == null) return fallback;
  return String(value);
}

function nullableText(value) {
  const v = text(value).trim();
  return v ? v : null;
}

function json(value, fallback = null) {
  if (value == null) return fallback == null ? null : JSON.stringify(fallback);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback == null ? null : JSON.stringify(fallback);
  }
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function object(value) {
  const parsed = typeof value === "string" ? parseJson(value, value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function array(value) {
  const parsed = typeof value === "string" ? parseJson(value, value) : value;
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "string") {
    return parsed.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function bool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const v = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "是", "允许"].includes(v)) return true;
  if (["false", "0", "no", "n", "否", "不允许"].includes(v)) return false;
  return fallback;
}

function normalizeAnswerType(value) {
  const v = String(value || "").trim().toLowerCase();
  const aliases = {
    str: "text",
    string: "text",
    文本: "text",
    数值: "number",
    numeric: "number",
    integer: "number",
    float: "number",
    bool: "boolean",
    布尔: "boolean",
    是否: "boolean",
    array: "list",
    列表: "list",
    表: "table",
    表格: "table",
    object: "json",
    struct: "json",
    结构化: "json",
    人工: "manual",
  };
  const normalized = aliases[v] || v;
  return BENCHMARK_ANSWER_TYPES.has(normalized) ? normalized : "text";
}

function defaultAssertionType(answerType) {
  if (answerType === "number") return "number_approx";
  if (answerType === "list") return "list_match";
  if (answerType === "table") return "table_match";
  if (answerType === "json") return "json_match";
  if (answerType === "manual") return "manual";
  return "text_contains";
}

function normalizeAssertionType(value, answerType) {
  const v = String(value || "").trim().toLowerCase();
  const aliases = {
    contains: "text_contains",
    include: "text_contains",
    approx: "number_approx",
    number: "number_approx",
    list: "list_match",
    table: "table_match",
    json: "json_match",
    sql: "sql_result",
    llm: "llm_judge",
    人工: "manual",
    精确: "exact",
    包含: "text_contains",
  };
  const normalized = aliases[v] || v || defaultAssertionType(answerType);
  return BENCHMARK_ASSERTION_TYPES.has(normalized) ? normalized : defaultAssertionType(answerType);
}

function normalizeOrder(value, fallback = "unordered") {
  const v = String(value || "").trim().toLowerCase();
  if (["ordered", "order", "strict", "ranked", "ranking", "top", "topn", "sequence", "有序", "排序"].includes(v)) return "ordered";
  if (["unordered", "any", "set", "ignore", "无序", "集合"].includes(v)) return "unordered";
  return fallback;
}

function normalizeTolerance(value) {
  const src = object(value);
  const type = ["absolute", "relative", "round"].includes(src.type) ? src.type : "absolute";
  const n = Number(src.value);
  return {
    type,
    value: Number.isFinite(n) ? n : type === "relative" ? 0.001 : 0.01,
  };
}

function normalizeColumn(value, index) {
  if (typeof value === "string") return { name: value, type: "string" };
  const src = object(value);
  const name = nullableText(src.name || src.key || src.field || src.id) || `col_${index + 1}`;
  return {
    name,
    type: nullableText(src.type) || "string",
    ...(src.unit ? { unit: String(src.unit) } : {}),
  };
}

function hasGold(answerType, gold) {
  if (gold == null) return false;
  if (answerType === "number") return Number.isFinite(Number(gold.value));
  if (answerType === "boolean") return typeof gold.value === "boolean";
  if (answerType === "list") return Array.isArray(gold.items) && gold.items.length > 0;
  if (answerType === "table") return Array.isArray(gold.rows) && gold.rows.length > 0;
  if (answerType === "json") return Array.isArray(gold) ? gold.length > 0 : Boolean(Object.keys(object(gold)).length);
  if (answerType === "text") return Boolean(nullableText(gold.value));
  return false;
}

function normalizeGold(answerType, rawGold, warnings, caseKey) {
  const parsed = typeof rawGold === "string" ? parseJson(rawGold, rawGold) : rawGold;
  if (parsed == null || parsed === "") {
    warnings.push(`${caseKey}: 缺少 gold，不能直接进入 ready`);
    return null;
  }

  if (answerType === "number") {
    const src = object(parsed);
    const value = src.value !== undefined ? src.value : parsed;
    const n = Number(String(value).replace(/,/g, ""));
    if (!Number.isFinite(n)) warnings.push(`${caseKey}: 数值 gold 无法解析`);
    return { value: Number.isFinite(n) ? n : value, ...(src.unit ? { unit: String(src.unit) } : {}) };
  }

  if (answerType === "boolean") {
    const src = object(parsed);
    const value = src.value !== undefined ? src.value : parsed;
    return { value: bool(value, Boolean(value)) };
  }

  if (answerType === "list") {
    const src = object(parsed);
    const items = Array.isArray(parsed) ? parsed : array(src.items ?? src.values ?? src.value);
    return {
      items,
      order: normalizeOrder(src.order || src.row_order || src.rowOrder, "unordered"),
    };
  }

  if (answerType === "table") {
    const src = object(parsed);
    const rows = Array.isArray(src.rows) ? src.rows : Array.isArray(parsed) ? parsed : [];
    let columns = Array.isArray(src.columns) ? src.columns.map((col, index) => normalizeColumn(col, index)) : [];
    if (!columns.length && rows.length && rows[0] && typeof rows[0] === "object" && !Array.isArray(rows[0])) {
      columns = Object.keys(rows[0]).map((name) => ({ name, type: "string" }));
    }
    if (!rows.length) warnings.push(`${caseKey}: 表格 gold 缺少 rows`);
    return {
      columns,
      rows,
      row_order: normalizeOrder(src.row_order || src.rowOrder, "unordered"),
      column_order: normalizeOrder(src.column_order || src.columnOrder, "unordered"),
      match_by: array(src.match_by || src.matchBy || src.key_columns || src.keyColumns).map(String),
    };
  }

  if (answerType === "json") {
    return parsed;
  }

  return { value: typeof parsed === "string" ? parsed : JSON.stringify(parsed) };
}

function normalizeBenchmarkAssertion(answerType, rawAssertion, warnings, caseKey) {
  const src = object(rawAssertion);
  const type = normalizeAssertionType(src.type, answerType);
  const out = { type };
  if (type === "number_approx" || answerType === "number") {
    out.numeric_tolerance = normalizeTolerance(src.numeric_tolerance || src.numericTolerance);
    if (src.round !== undefined) out.round = Number(src.round);
    if (src.unit) out.unit = String(src.unit);
  }
  if (type === "list_match" || answerType === "list") {
    out.order = normalizeOrder(src.order, "unordered");
    out.dedupe = bool(src.dedupe, false);
    out.case_sensitive = bool(src.case_sensitive || src.caseSensitive, false);
  }
  if (type === "table_match" || answerType === "table") {
    out.row_order = normalizeOrder(src.row_order || src.rowOrder, "unordered");
    out.column_order = normalizeOrder(src.column_order || src.columnOrder, "unordered");
    out.match_by = array(src.match_by || src.matchBy || src.key_columns || src.keyColumns).map(String);
    out.numeric_tolerance = normalizeTolerance(src.numeric_tolerance || src.numericTolerance);
    out.allow_extra_columns = bool(src.allow_extra_columns || src.allowExtraColumns, false);
    out.allow_extra_rows = bool(src.allow_extra_rows || src.allowExtraRows, false);
  }
  if (type === "text_contains" || type === "exact" || answerType === "text") {
    out.case_sensitive = bool(src.case_sensitive || src.caseSensitive, false);
    out.trim_string = src.trim_string === undefined && src.trimString === undefined ? true : bool(src.trim_string || src.trimString, true);
    if (src.keywords !== undefined) out.keywords = array(src.keywords).map(String);
  }
  if (type === "manual") warnings.push(`${caseKey}: 断言类型为 manual，需要人工复核`);
  return out;
}

function benchmarkCaseStatus({ question, expectedBehavior, answerType, assertion, gold, rawStatus }) {
  const requested = nullableText(rawStatus);
  if (requested && ["converted", "rejected"].includes(requested)) return requested;
  if (!nullableText(question)) return "invalid";
  if (answerType === "manual" || assertion?.type === "manual") return expectedBehavior ? "reviewable" : "draft";
  if (hasGold(answerType, gold)) return "ready";
  if (nullableText(expectedBehavior)) return "reviewable";
  return BENCHMARK_CASE_STATUSES.has(requested) ? requested : "draft";
}

function normalizeBenchmarkCase(value, index = 0) {
  const src = object(value);
  const warnings = [];
  const metadata = object(src.metadata);
  const caseKey = nullableText(src.id || src.case_key || src.caseKey || src.key) || `case_${index + 1}`;
  const answerType = normalizeAnswerType(src.answer_type || src.answerType || metadata.answer_type || metadata.answerType);
  const question = text(src.question || src.input || src.prompt).trim();
  const expectedBehavior = text(src.expected_behavior || src.expectedBehavior || src.expected || src.expectation).trim();
  const rawGold = src.gold ?? src.expected_answer ?? src.expectedAnswer ?? src.answer ?? src.value;
  const gold = normalizeGold(answerType, rawGold, warnings, caseKey);
  const assertion = normalizeBenchmarkAssertion(answerType, src.assertion || src.assert, warnings, caseKey);
  const tags = normalizeTags(src.tags?.length ? src.tags : metadata.tags);
  if (!question) warnings.push(`${caseKey}: 缺少 question`);
  const status = benchmarkCaseStatus({
    question,
    expectedBehavior,
    answerType,
    assertion,
    gold,
    rawStatus: src.status,
  });
  return {
    case_key: caseKey,
    title: nullableText(src.title || src.name) || question.slice(0, 60) || caseKey,
    question,
    expected_behavior: expectedBehavior,
    answer_type: answerType,
    assertion_type: assertion.type,
    assertion,
    gold,
    metadata,
    tags,
    gold_solve: object(src.gold_solve || src.goldSolve),
    status,
    warnings,
    source_index: Number(src.source_index ?? index),
  };
}

function normalizeBenchmarkPayload(payload) {
  const root = typeof payload === "string" ? parseJson(payload, {}) : payload;
  const src = object(root);
  const rawCases = Array.isArray(root)
    ? root
    : Array.isArray(src.cases)
      ? src.cases
      : Array.isArray(src.items)
        ? src.items
        : src.question
          ? [src]
          : [];
  const cases = rawCases.map((item, index) => normalizeBenchmarkCase(item, index));
  const warnings = [
    ...array(src.warnings).map(String),
    ...cases.flatMap((item) => item.warnings || []),
  ];
  const assumptions = array(src.assumptions).map(String);
  const unparsed = array(src.unparsed).map(String);
  const invalidCount = cases.filter((item) => item.status === "invalid").length;
  return {
    cases,
    warnings: [...new Set(warnings)],
    assumptions,
    unparsed,
    valid_count: cases.length - invalidCount,
    invalid_count: invalidCount,
  };
}

function slugify(value, fallback = "case") {
  const ascii = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const slug = ascii || fallback;
  return slug.slice(0, 72).replace(/-$/g, "") || fallback;
}

function normalizeMaterializerPayload(payload, benchmarkCase) {
  const src = object(payload);
  const caseKey = slugify(benchmarkCase.case_key || benchmarkCase.id, "case");
  const rawTaskId = nullableText(src.task_id || src.taskId) || `trace-benchmark-${caseKey}`;
  const taskId = slugify(rawTaskId, `trace-benchmark-${caseKey}`);
  const prefixedTaskId = taskId.startsWith("trace-benchmark-") ? taskId : `trace-benchmark-${taskId}`;
  return {
    task_id: prefixedTaskId,
    title: nullableText(src.title) || benchmarkCase.title || benchmarkCase.question?.slice(0, 60) || prefixedTaskId,
    assertions: array(src.assertions).map((item) => object(item)).filter((item) => Object.keys(item).length),
    context_requirements: array(src.context_requirements || src.contextRequirements).map(String),
    warnings: array(src.warnings).map(String),
    runnable_notes: array(src.runnable_notes || src.runnableNotes).map(String),
  };
}

function defaultMaterializerPlan(benchmarkCase) {
  const answerType = benchmarkCase.answer_type || "text";
  const assertionType = benchmarkCase.assertion_type || defaultAssertionType(answerType);
  const expected = flattenBenchmarkGold(benchmarkCase.gold);
  const warnings = [];
  const contextRequirements = [];
  const metadata = object(benchmarkCase.metadata);
  const hasReplayContext = Boolean(metadata.connection_id || metadata.conn_id || metadata.project_name || metadata.eval_context);
  if (!hasReplayContext) {
    contextRequirements.push("缺少可重放数据源上下文：需要 generated context 文件或 metadata.connection_id/project_name。");
  }
  if (!expected.length && assertionType !== "manual") {
    warnings.push("缺少可自动断言的 gold，生成任务只能人工复核或先补 gold。");
  }
  return normalizeMaterializerPayload({
    task_id: `trace-benchmark-${benchmarkCase.case_key || benchmarkCase.id}`,
    title: benchmarkCase.title,
    assertions: [{
      type: assertionType,
      expected,
      order: benchmarkCase.gold?.order || benchmarkCase.gold?.row_order || benchmarkCase.assertion?.order || "unordered",
      notes: "deterministic fallback",
    }],
    context_requirements: contextRequirements,
    warnings,
    runnable_notes: hasReplayContext
      ? ["可尝试运行生成任务；稳定性取决于 connection_id/project_name 是否在当前 app 数据库中仍有效。"]
      : ["已生成 task 草稿，但缺少可重放上下文时运行会失败。"],
  }, benchmarkCase);
}

function flattenBenchmarkGold(gold) {
  if (gold == null) return [];
  if (Array.isArray(gold)) return gold.flatMap(flattenBenchmarkGold);
  if (typeof gold !== "object") return [gold];
  if (Array.isArray(gold.items)) return gold.items.flatMap(flattenBenchmarkGold);
  if (Array.isArray(gold.rows)) {
    return gold.rows.flatMap((row) => {
      if (Array.isArray(row)) return row.flatMap(flattenBenchmarkGold);
      if (row && typeof row === "object") return Object.values(row).flatMap(flattenBenchmarkGold);
      return flattenBenchmarkGold(row);
    });
  }
  if (gold.value !== undefined) return [gold.value];
  return Object.values(gold).flatMap(flattenBenchmarkGold);
}

function materializedTaskSource(taskId) {
  return [
    "import { makeTraceBenchmarkTask } from '../../lib/trace-benchmark-task.mjs';",
    `export default makeTraceBenchmarkTask(${JSON.stringify(taskId)});`,
    "",
  ].join("\n");
}

function materializedPayload({ plan, benchmarkCase, projectId }) {
  const metadata = object(benchmarkCase.metadata);
  const execution = object(metadata.execution || metadata.eval_execution || metadata.evalExecution);
  const runnable = isMaterializedTaskRunnable(plan);
  return {
    task_id: plan.task_id,
    title: plan.title,
    project_id: projectId,
    generated_at: new Date().toISOString(),
    generator: "trace-optimization",
    runnable,
    case: {
      id: benchmarkCase.id,
      case_key: benchmarkCase.case_key,
      title: benchmarkCase.title,
      question: benchmarkCase.question,
      expected_behavior: benchmarkCase.expected_behavior,
      answer_type: benchmarkCase.answer_type,
      assertion_type: benchmarkCase.assertion_type,
      assertion: benchmarkCase.assertion,
      gold: benchmarkCase.gold,
      tags: benchmarkCase.tags,
      gold_solve: benchmarkCase.gold_solve,
    },
    materializer: {
      assertions: plan.assertions,
      warnings: plan.warnings,
      context_requirements: plan.context_requirements,
      runnable_notes: plan.runnable_notes,
      runnable,
    },
    execution: {
      project_name: execution.project_name || metadata.project_name || "",
      connection_id: execution.connection_id || execution.conn_id || metadata.connection_id || metadata.conn_id || "",
    },
  };
}

function isMaterializedTaskRunnable(plan) {
  return !array(plan.context_requirements).map((item) => String(item).trim()).filter(Boolean).length;
}

function writeMaterializedTask({ taskId, payload, source }) {
  mkdirSync(GENERATED_TRACE_BENCHMARK_DIR, { recursive: true });
  mkdirSync(GENERATED_TASKS_DIR, { recursive: true });
  const payloadPath = join(GENERATED_TRACE_BENCHMARK_DIR, `${taskId}.json`);
  const taskPath = join(GENERATED_TASKS_DIR, `70-${taskId}.task.mjs`);
  writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
  writeFileSync(taskPath, source);
  return { payload_path: payloadPath, task_path: taskPath };
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function taskGroup(id, fileName) {
  const text = `${id} ${fileName}`.toLowerCase();
  if (text.includes("kdd")) return "KDD";
  if (text.includes("func")) return "Functional";
  if (text.includes("trace")) return "Trace";
  if (text.includes("skill") || text.includes("mcp")) return "Runtime";
  if (text.includes("im-")) return "Integration";
  if (text.includes("app-")) return "App";
  return "General";
}

function parseEvalTask(fileName) {
  const tasksDir = join(APP_EVAL_DIR, "tasks");
  const filePath = join(tasksDir, fileName);
  const textBody = readFileSync(filePath, "utf8");
  const kdd = textBody.match(/makeKddTask\(['"]([^'"]+)['"]/);
  const func = textBody.match(/makeFunctionalTask\(['"]([^'"]+)['"]/);
  const idMatch = textBody.match(/\bid\s*:\s*['"]([^'"]+)['"]/);
  const descMatch = textBody.match(/\bdesc\s*:\s*['"]([^'"]*)['"]/);
  const base = fileName.replace(/\.task\.mjs$/, "").replace(/^\d+-/, "");
  const id = kdd ? `kdd-${kdd[1]}` : func ? `func-${func[1]}` : idMatch ? idMatch[1] : base;
  return {
    id,
    file: fileName,
    group: taskGroup(id, fileName),
    desc: descMatch?.[1] || (kdd ? `KDD ${kdd[1]}` : func ? `Functional ${func[1]}` : ""),
    filter: id,
  };
}

function evalTaskInventory(limit = 240) {
  const tasksDir = join(APP_EVAL_DIR, "tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((fileName) => fileName.endsWith(".task.mjs"))
    .sort()
    .slice(0, limit)
    .map((fileName) => {
      try {
        return parseEvalTask(fileName);
      } catch {
        const id = fileName.replace(/\.task\.mjs$/, "").replace(/^\d+-/, "");
        return { id, file: fileName, group: taskGroup(id, fileName), desc: "", filter: id };
      }
    });
}

function evalResultReports(limit = 30) {
  const resultsDir = join(APP_EVAL_DIR, "results");
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const filePath = join(resultsDir, fileName);
      const stat = statSync(filePath);
      return { fileName, filePath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map(({ fileName, mtimeMs }) => {
      const payload = safeReadJson(join(resultsDir, fileName)) || {};
      const summary = payload.summary || {};
      const column = summary.columnChecks || {};
      return {
        file: fileName,
        run_id: payload.runId || fileName.replace(/\.json$/, ""),
        status: payload.status || "unknown",
        filter: payload.filter || "",
        started_at: payload.startedAt || "",
        updated_at: payload.updatedAt || new Date(mtimeMs).toISOString(),
        completed_tasks: Number(payload.completedTasks || summary.total || 0),
        total_loaded_tasks: Number(payload.totalLoadedTasks || 0),
        pass_rate: Number(summary.passRate || 0),
        passed: Number(summary.passed || 0),
        failed: Number(summary.failed || 0),
        total: Number(summary.total || 0),
        avg_score: Number(column.avgScore || 0),
        avg_recall: Number(column.avgRecall || 0),
        gold_coverage_rate: Number(column.goldCoverageRate || 0),
        perfect_rate: Number(column.perfectRate || 0),
        error: payload.error || null,
      };
    });
}

async function requireProjectAccess(ctx, projectId) {
  if (!projectId) throw new ApiError("project_id 不能为空", 400);
  if (String(projectId).startsWith("__") || String(projectId).startsWith("folder:")) return;
  const row = await ctx.queryOne(
    `SELECT p.id
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$2 AND pm.deleted_at IS NULL
      WHERE p.id=$1
        AND p.deleted_at IS NULL
        AND (pm.id IS NOT NULL OR $2 IS NULL)
      LIMIT 1`,
    [projectId, ctx.userId],
  );
  if (!row) throw new ApiError("项目不存在或无权限", 404);
}

function reviewShape(row, draft = null) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    session_id: row.session_id,
    run_id: row.run_id,
    trace_id: row.trace_id,
    span_id: row.span_id,
    target_type: row.target_type,
    question: row.question || "",
    actual_output: row.actual_output || "",
    trace_snapshot: parseJson(row.trace_snapshot_json, {}),
    status: row.status,
    severity: row.severity,
    reason_code: row.reason_code,
    reason_text: row.reason_text,
    expected_behavior: row.expected_behavior,
    source: row.source,
    score_type: row.score_type,
    score_value: row.score_value,
    risk_reason: row.risk_reason,
    version: Number(row.version || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
    draft: draft ? draftShape(draft) : null,
  };
}

function goldSolveShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    draft_id: row.draft_id,
    project_id: row.project_id,
    question: row.question || "",
    expected_behavior: row.expected_behavior || "",
    expected_answer: row.expected_answer || "",
    intent_summary: row.intent_summary || "",
    data_sources: parseJson(row.data_sources, []),
    filters: parseJson(row.filters_json, {}),
    metric_definition: row.metric_definition || "",
    reference_steps: parseJson(row.reference_steps_json, []),
    reference_sql: row.reference_sql || "",
    intermediate_expectations: parseJson(row.intermediate_expectations_json, []),
    final_answer_contract: row.final_answer_contract || "",
    trace_diff_summary: row.trace_diff_summary || "",
    status: row.status,
    created_by: row.created_by,
    verified_by: row.verified_by,
    version: Number(row.version || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function draftShape(row, goldSolve = undefined) {
  if (!row) return null;
  return {
    id: row.id,
    review_id: row.review_id,
    project_id: row.project_id,
    session_id: row.session_id,
    run_id: row.run_id,
    trace_id: row.trace_id,
    span_id: row.span_id,
    source_object_id: row.source_object_id,
    source_object_type: row.source_object_type,
    question: row.question || "",
    actual_output: row.actual_output || "",
    expected_behavior: row.expected_behavior || "",
    expected_answer: row.expected_answer || "",
    assertion_type: row.assertion_type || "manual",
    status: row.status,
    benchmark_status: row.benchmark_status,
    tags: parseJson(row.tags, []),
    failure_category: row.failure_category || "",
    tuning_notes: row.tuning_notes || "",
    replay_requirements: parseJson(row.replay_requirements_json, {}),
    trace_snapshot: parseJson(row.trace_snapshot_json, {}),
    version: Number(row.version || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(goldSolve !== undefined ? { gold_solve: goldSolveShape(goldSolve) } : {}),
  };
}

function benchmarkCaseShape(row) {
  if (!row) return null;
  const latestRun = row.latest_run_json ? parseJson(row.latest_run_json, null) : null;
  if (latestRun && typeof latestRun === "object") {
    latestRun.metrics = parseJson(latestRun.metrics, latestRun.metrics || {});
    latestRun.diagnosis = parseJson(latestRun.diagnosis, latestRun.diagnosis || null);
  }
  return {
    id: row.id,
    project_id: row.project_id,
    source_type: row.source_type || "manual",
    source_object_id: row.source_object_id || null,
    case_key: row.case_key || row.id,
    title: row.title || "",
    question: row.question || "",
    expected_behavior: row.expected_behavior || "",
    answer_type: row.answer_type || "text",
    assertion_type: row.assertion_type || "manual",
    assertion: parseJson(row.assertion_json, {}),
    gold: parseJson(row.gold_json, null),
    metadata: parseJson(row.metadata_json, {}),
    tags: parseJson(row.tags, []),
    gold_solve: parseJson(row.gold_solve_json, {}),
    status: row.status || "draft",
    warnings: parseJson(row.warnings_json, []),
    latest_run: latestRun,
    version: Number(row.version || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeAttemptStatus(value, fallback = "planned") {
  const v = String(value || "").trim().toLowerCase();
  return ATTEMPT_STATUSES.has(v) ? v : fallback;
}

function normalizeAttemptSource(value, fallback = "manual") {
  const v = String(value || "").trim().toLowerCase();
  return ATTEMPT_SOURCES.has(v) ? v : fallback;
}

function attemptShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    draft_id: row.draft_id,
    benchmark_case_id: row.benchmark_case_id || null,
    attempt_index: Number(row.attempt_index || 1),
    source: row.source || "manual",
    status: row.status || "planned",
    hypothesis: row.hypothesis || "",
    change_summary: row.change_summary || "",
    diagnosis: parseJson(row.diagnosis_json, null),
    benchmark_result: parseJson(row.benchmark_result_json, null),
    trace_id: row.trace_id || null,
    run_id: row.run_id || null,
    session_id: row.session_id || null,
    span_id: row.span_id || null,
    trace_snapshot: parseJson(row.trace_snapshot_json, {}),
    metrics: parseJson(row.metrics_json, {}),
    notes: row.notes || "",
    version: Number(row.version || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function benchmarkCaseRows(ctx, projectId, limit = 80) {
  return ctx.query(
    `SELECT c.*,
            (
              SELECT json_object(
                'id', r.id,
                'status', r.status,
                'task_id', r.task_id,
                'eval_run_id', r.eval_run_id,
                'report_file', r.report_file,
                'trace_id', r.trace_id,
                'run_id', r.run_id,
                'session_id', r.session_id,
                'metrics', r.metrics_json,
                'diagnosis', r.diagnosis_json,
                'started_at', r.started_at,
                'finished_at', r.finished_at,
                'updated_at', r.updated_at
              )
              FROM trace_benchmark_runs r
              WHERE r.benchmark_case_id=c.id AND r.deleted_at IS NULL
              ORDER BY COALESCE(r.finished_at, r.updated_at, r.created_at) DESC
              LIMIT 1
            ) AS latest_run_json
       FROM trace_benchmark_cases c
      WHERE c.project_id=$1 AND c.deleted_at IS NULL
      ORDER BY c.updated_at DESC, c.created_at DESC
      LIMIT $2`,
    [projectId, limit],
  );
}

async function benchmarkCaseById(ctx, projectId, caseId) {
  return ctx.queryOne(
    `SELECT c.*,
            (
              SELECT json_object(
                'id', r.id,
                'status', r.status,
                'task_id', r.task_id,
                'eval_run_id', r.eval_run_id,
                'report_file', r.report_file,
                'trace_id', r.trace_id,
                'run_id', r.run_id,
                'session_id', r.session_id,
                'metrics', r.metrics_json,
                'diagnosis', r.diagnosis_json,
                'started_at', r.started_at,
                'finished_at', r.finished_at,
                'updated_at', r.updated_at
              )
              FROM trace_benchmark_runs r
              WHERE r.benchmark_case_id=c.id AND r.deleted_at IS NULL
              ORDER BY COALESCE(r.finished_at, r.updated_at, r.created_at) DESC
              LIMIT 1
            ) AS latest_run_json
       FROM trace_benchmark_cases c
      WHERE c.id=$1 AND c.project_id=$2 AND c.deleted_at IS NULL`,
    [caseId, projectId],
  );
}

async function latestDraftForReview(ctx, reviewId) {
  return ctx.queryOne(
    `SELECT * FROM trace_eval_drafts
      WHERE review_id=$1 AND deleted_at IS NULL
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1`,
    [reviewId],
  );
}

async function goldSolveForDraft(ctx, draftId) {
  return ctx.queryOne(
    `SELECT * FROM trace_gold_solves
      WHERE draft_id=$1 AND deleted_at IS NULL
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1`,
    [draftId],
  );
}

async function nextAttemptIndex(ctx, draftId) {
  const row = await ctx.queryOne(
    `SELECT COALESCE(MAX(attempt_index), 0) + 1 AS next_index
       FROM trace_optimization_attempts
      WHERE draft_id=$1 AND deleted_at IS NULL`,
    [draftId],
  );
  return Number(row?.next_index || 1);
}

async function insertAttempt(ctx, pid, draft, body = {}) {
  const attemptIndex = await nextAttemptIndex(ctx, draft.id);
  const status = normalizeAttemptStatus(body.status);
  const source = normalizeAttemptSource(body.source);
  const row = await ctx.queryOne(
    `INSERT INTO trace_optimization_attempts
       (id, project_id, draft_id, benchmark_case_id, attempt_index, source, status,
        hypothesis, change_summary, diagnosis_json, benchmark_result_json,
        trace_id, run_id, session_id, span_id, trace_snapshot_json, metrics_json,
        notes, created_by, updated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,now(),now())
     RETURNING *`,
    [
      randomUUID(),
      pid,
      draft.id,
      nullableText(body.benchmark_case_id || body.benchmarkCaseId),
      attemptIndex,
      source,
      status,
      text(body.hypothesis),
      text(body.change_summary || body.changeSummary),
      json(body.diagnosis || body.diagnosis_json || body.diagnosisJson),
      json(body.benchmark_result || body.benchmarkResult || body.benchmark_result_json || body.benchmarkResultJson),
      nullableText(body.trace_id || body.traceId || draft.trace_id),
      nullableText(body.run_id || body.runId || draft.run_id),
      nullableText(body.session_id || body.sessionId || draft.session_id),
      nullableText(body.span_id || body.spanId || draft.span_id),
      json(body.trace_snapshot || body.traceSnapshot || parseJson(draft.trace_snapshot_json, {})),
      json(body.metrics || body.metrics_json || body.metricsJson || {}),
      text(body.notes),
      ctx.userId,
    ],
  );
  return row;
}

function draftState({ question, expected_behavior, expected_answer, assertion_type, trace_id, run_id, gold_status }) {
  const hasExpected = Boolean(nullableText(expected_behavior) || nullableText(expected_answer));
  const hasAssertion = Boolean(assertion_type && ASSERTION_TYPES.has(assertion_type));
  const hasSource = Boolean(nullableText(trace_id) || nullableText(run_id));
  if (hasExpected && hasAssertion && hasSource && gold_status === "verified") {
    return { status: "ready", benchmark_status: "ready" };
  }
  if (hasExpected && hasAssertion && nullableText(question)) {
    return { status: "reviewable", benchmark_status: "reviewable" };
  }
  return { status: "draft", benchmark_status: "candidate" };
}

async function refreshDraftReadiness(ctx, draftId) {
  const draft = await ctx.queryOne(`SELECT * FROM trace_eval_drafts WHERE id=$1 AND deleted_at IS NULL`, [draftId]);
  if (!draft) return null;
  const gold = await goldSolveForDraft(ctx, draftId);
  const next = draftState({
    question: draft.question,
    expected_behavior: draft.expected_behavior,
    expected_answer: draft.expected_answer,
    assertion_type: draft.assertion_type,
    trace_id: draft.trace_id,
    run_id: draft.run_id,
    gold_status: gold?.status,
  });
  if (next.status !== draft.status || next.benchmark_status !== draft.benchmark_status) {
    await ctx.query(
      `UPDATE trace_eval_drafts
          SET status=$1, benchmark_status=$2, updated_at=now(), version=version+1
        WHERE id=$3`,
      [next.status, next.benchmark_status, draftId],
    );
  }
  return ctx.queryOne(`SELECT * FROM trace_eval_drafts WHERE id=$1 AND deleted_at IS NULL`, [draftId]);
}

export {
  APP_EVAL_DIR, REVIEW_STATUSES, SEVERITIES, ASSERTION_TYPES, GOLD_STATUSES,
  BENCHMARK_ANSWER_TYPES, BENCHMARK_ASSERTION_TYPES, BENCHMARK_CASE_STATUSES, BENCHMARK_RUN_STATUSES, BENCHMARK_SOURCE_TYPES,
  ATTEMPT_STATUSES, ATTEMPT_SOURCES, MAX_BENCHMARK_IMPORT_CHARS,
  BENCHMARK_NORMALIZER_SKILL, GOLD_SOLVE_DRAFTER_SKILL, TRACE_FAILURE_DIAGNOSER_SKILL, TRACE_TUNING_PROPOSER_SKILL, BENCHMARK_TASK_MATERIALIZER_SKILL,
  GENERATED_TRACE_BENCHMARK_DIR, GENERATED_TASKS_DIR,
  text, nullableText, json, parseJson, normalizeTags, object, array, bool,
  normalizeAnswerType, defaultAssertionType, normalizeAssertionType, normalizeOrder, normalizeTolerance, normalizeColumn,
  hasGold, normalizeGold, normalizeBenchmarkAssertion, benchmarkCaseStatus, normalizeBenchmarkCase, normalizeBenchmarkPayload,
  slugify, normalizeMaterializerPayload, defaultMaterializerPlan, flattenBenchmarkGold,
  materializedTaskSource, materializedPayload, isMaterializedTaskRunnable, writeMaterializedTask,
  safeReadJson, taskGroup, parseEvalTask, evalTaskInventory, evalResultReports, requireProjectAccess,
  reviewShape, goldSolveShape, draftShape, benchmarkCaseShape, normalizeAttemptStatus, normalizeAttemptSource, attemptShape,
  benchmarkCaseRows, benchmarkCaseById, latestDraftForReview, goldSolveForDraft, nextAttemptIndex, insertAttempt, draftState,
  refreshDraftReadiness
};
