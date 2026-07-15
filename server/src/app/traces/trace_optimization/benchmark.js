import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { runWorkflowSkill, workflowSkillMeta } from "../../../engine/skills/workflow_skill_runner.js";
import { ApiError } from "../../../errors.js";
import { listSessionTraces } from "../yitrace_service.js";
import { buildTraceEvidencePack } from "./trace_evidence.js";
import { runTraceDebugger } from "./trace_debugger.js";
import {
  APP_EVAL_DIR,
  BENCHMARK_CASE_STATUSES,
  BENCHMARK_RUN_STATUSES,
  BENCHMARK_SOURCE_TYPES,
  MAX_BENCHMARK_IMPORT_CHARS,
  BENCHMARK_NORMALIZER_SKILL,
  BENCHMARK_TASK_MATERIALIZER_SKILL,
  TRACE_FAILURE_DIAGNOSER_SKILL,
  text,
  nullableText,
  json,
  parseJson,
  object,
  array,
  bool,
  flattenBenchmarkGold,
  normalizeBenchmarkCase,
  normalizeBenchmarkPayload,
  normalizeMaterializerPayload,
  defaultMaterializerPlan,
  materializedTaskSource,
  materializedPayload,
  isMaterializedTaskRunnable,
  writeMaterializedTask,
  evalTaskInventory,
  evalResultReports,
  safeReadJson,
  requireProjectAccess,
  benchmarkCaseShape,
  benchmarkCaseRows,
  benchmarkCaseById
} from "./common.js";
import { benchmarkRunRows, benchmarkRunShape } from "./benchmark_runs.js";

const APP_DIR = join(APP_EVAL_DIR, "..");
const EVAL_RUN_STDIO_MAX = 60000;
const BENCHMARK_FOLDER_MAX_FILES = 80;
const BENCHMARK_FOLDER_MAX_DEPTH = 5;
const BENCHMARK_FOLDER_FILE_CHARS = 18000;
const BENCHMARK_FOLDER_EXTENSIONS = new Set([".json", ".jsonl", ".csv", ".tsv", ".md", ".markdown", ".txt", ".yaml", ".yml"]);
const BENCHMARK_FOLDER_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".vite", "__pycache__", "_parsed"]);

function nowIso() {
  return new Date().toISOString();
}

function slugRunId(value) {
  return String(value || "trace-benchmark-run").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function clip(value, max = EVAL_RUN_STDIO_MAX) {
  const body = text(value);
  return body.length > max ? `${body.slice(0, max)}...` : body;
}

function nodeBin() {
  if (process.env.YIW_NODE_BIN) return process.env.YIW_NODE_BIN;
  if (process.versions?.electron) return "node";
  return process.execPath || "node";
}

function resultForTask(report, taskId) {
  const results = Array.isArray(report?.results) ? report.results : [];
  return results.find((item) => item.id === taskId) || results.find((item) => String(item.id || "").includes(taskId)) || null;
}

function resultMetrics(report, result, { cdpPort, exitCode, timedOut } = {}) {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  return {
    pass: Boolean(result?.pass),
    ms: Number(result?.ms || 0),
    checks_total: checks.length,
    checks_failed: checks.filter((item) => !item?.ok).length,
    report_status: report?.status || "",
    pass_rate: Number(report?.summary?.passRate || 0),
    cdp_port: Number(cdpPort || 0),
    exit_code: exitCode,
    timed_out: Boolean(timedOut),
  };
}

function runStatus({ report, result, exitCode, timedOut }) {
  if (timedOut) return "error";
  if (!report || exitCode !== 0 && !result) return "error";
  if (result?.pass) return "passed";
  return "failed";
}

function normalizeDiagnosisPayload(payload) {
  const src = object(payload);
  const traceDebugger = object(src.trace_debugger || src.traceDebugger);
  const stage = [
    "intent",
    "routing",
    "tool_selection",
    "tool_input",
    "sql_generation",
    "sql_execution",
    "tool_output_usage",
    "final_answer",
    "data_issue",
    "assertion_issue",
    "trace_incomplete",
    "unknown",
  ].includes(src.failure_stage) ? src.failure_stage : "unknown";
  const confidence = Number(src.confidence);
  return {
    failure_stage: stage,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    summary: text(src.summary),
    evidence: array(src.evidence).map((item) => {
      const row = object(item);
      return {
        source: text(row.source || "unknown"),
        observation: text(row.observation || item),
      };
    }),
    trace_gaps: array(src.trace_gaps || src.traceGaps).map(String),
    trace_debugger: Object.keys(traceDebugger).length ? traceDebugger : null,
    evidence_path: array(src.evidence_path || src.evidencePath).map((item) => {
      const row = object(item);
      return {
        span_id: text(row.span_id || row.spanId),
        observation: text(row.observation || item),
      };
    }).filter((item) => item.span_id || item.observation),
    recommended_actions: array(src.recommended_actions || src.recommendedActions).map(String),
    next_benchmark_focus: array(src.next_benchmark_focus || src.nextBenchmarkFocus).map(String),
    warnings: array(src.warnings).map(String),
  };
}

function blockedDiagnosis(reason) {
  return {
    failure_stage: "trace_incomplete",
    confidence: 1,
    summary: reason,
    evidence: [{ source: "benchmark_materializer", observation: reason }],
    trace_gaps: [reason],
    recommended_actions: ["补充 Benchmark Case metadata.connection_id/project_name，或提供 generated context 后再运行。"],
    next_benchmark_focus: [],
    warnings: [reason],
  };
}

function failedChecks(result) {
  return (Array.isArray(result?.checks) ? result.checks : [])
    .filter((item) => !item?.ok)
    .map((item) => item.msg || "")
    .filter(Boolean);
}

function benchmarkFolderFilePriority(file) {
  const rel = String(file?.relative_path || file?.relativePath || "").toLowerCase();
  const name = basename(rel);
  if (name === "benchmark.json" || name === "benchmarks.json" || name === "cases.json") return 0;
  if (name === "benchmark.jsonl" || name === "cases.jsonl") return 1;
  if (name === "task.json") return 2;
  if (/gold|expected|answer|reference/.test(name)) return 3;
  if (/benchmark|case|eval|task/.test(name)) return 4;
  if ([".json", ".jsonl", ".csv"].includes(extname(name))) return 5;
  return 8;
}

function scanBenchmarkFolder(folderPath) {
  const rawPath = text(folderPath).trim();
  if (!rawPath) throw new ApiError("请选择 Benchmark 文件夹", 400);
  const root = resolve(rawPath);
  let rootStat = null;
  try {
    rootStat = statSync(root);
  } catch {
    throw new ApiError("Benchmark 文件夹不存在", 404);
  }
  if (!rootStat.isDirectory()) throw new ApiError("Benchmark 导入路径必须是文件夹", 400);

  const warnings = [];
  const files = [];
  const walk = (dir, depth = 0) => {
    if (depth > BENCHMARK_FOLDER_MAX_DEPTH) {
      warnings.push(`跳过过深目录: ${relative(root, dir) || "."}`);
      return;
    }
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      warnings.push(`无法读取目录 ${relative(root, dir) || "."}: ${e?.message || e}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= BENCHMARK_FOLDER_MAX_FILES) return;
      if (!entry.name || entry.name === ".DS_Store" || entry.name.startsWith("._")) continue;
      const fp = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || BENCHMARK_FOLDER_SKIP_DIRS.has(entry.name)) continue;
        walk(fp, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!BENCHMARK_FOLDER_EXTENSIONS.has(ext)) continue;
      let st = null;
      try {
        st = statSync(fp);
      } catch {
        continue;
      }
      files.push({
        path: fp,
        relative_path: relative(root, fp) || entry.name,
        size: st.size,
        ext,
      });
    }
  };

  walk(root);
  if (files.length >= BENCHMARK_FOLDER_MAX_FILES) warnings.push(`文件数量超过 ${BENCHMARK_FOLDER_MAX_FILES}，已按优先级截断`);
  if (!files.length) throw new ApiError("文件夹中没有可导入的 Benchmark 文件（支持 json/jsonl/csv/tsv/md/txt/yaml）", 400);

  files.sort((a, b) => {
    const pa = benchmarkFolderFilePriority(a);
    const pb = benchmarkFolderFilePriority(b);
    if (pa !== pb) return pa - pb;
    return a.relative_path.localeCompare(b.relative_path);
  });

  let remaining = MAX_BENCHMARK_IMPORT_CHARS;
  const selected = [];
  const blocks = [
    "# Benchmark Folder Import",
    `Folder: ${root}`,
    "",
    "请把以下文件内容清洗成 YiW Benchmark Case。文件路径是 case 来源线索；如果一个目录代表一个 case，请合并同目录下的 task/gold/reference 信息。",
  ];

  for (const file of files) {
    if (remaining <= 0) break;
    let content = "";
    try {
      content = readFileSync(file.path, "utf-8");
    } catch (e) {
      warnings.push(`无法读取文件 ${file.relative_path}: ${e?.message || e}`);
      continue;
    }
    const limit = Math.min(BENCHMARK_FOLDER_FILE_CHARS, remaining);
    const clipped = content.slice(0, limit);
    if (content.length > clipped.length) warnings.push(`${file.relative_path}: 内容已截断到 ${clipped.length} 字符`);
    selected.push({ relative_path: file.relative_path, size: file.size, chars: clipped.length });
    blocks.push("", `## ${file.relative_path}`, "```" + file.ext.slice(1), clipped, "```");
    remaining -= clipped.length;
  }

  if (!selected.length) throw new ApiError("文件夹内容为空或无法读取", 400);
  if (files.length > selected.length) warnings.push(`总字符数超过 ${MAX_BENCHMARK_IMPORT_CHARS}，已读取 ${selected.length}/${files.length} 个文件`);

  return {
    folder_path: root,
    folder_name: basename(root),
    files: selected,
    total_files: files.length,
    warnings: [...new Set(warnings)],
    content: blocks.join("\n"),
  };
}

async function normalizeBenchmarkContent(ctx, {
  pid,
  content,
  formatHint = "auto",
  modelId = null,
  task,
  callSite = "trace_benchmark_normalize",
  extraInput = {},
}) {
  let skill;
  let parsed;
  try {
    const result = await runWorkflowSkill(ctx, {
      projectId: pid,
      skillName: BENCHMARK_NORMALIZER_SKILL,
      task,
      input: {
        format_hint: formatHint,
        content,
        ...extraInput,
      },
      responseContract: "必须只输出 {\"cases\":[],\"warnings\":[],\"assumptions\":[],\"unparsed\":[]} JSON object。",
      temperature: 0.1,
      maxTokens: 7000,
      modelId,
      callSite,
      inputMaxChars: 65000,
    });
    skill = result.skill;
    parsed = result.data;
  } catch (e) {
    throw new ApiError(`AI 清洗 Benchmark 失败: ${e?.message || e}`, 500);
  }

  return {
    normalized: normalizeBenchmarkPayload(parsed),
    skill,
  };
}

async function runEvalProcess({ taskId, cdpPort, timeoutMs, reportFile, runId }) {
  const child = spawn(nodeBin(), ["eval/run.mjs", taskId], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      YIW_EVAL_INCLUDE_GENERATED: "1",
      YIW_EVAL_RUN_ID: runId,
      YIW_EVAL_REPORT_FILE: reportFile,
      CDP_PORT: String(cdpPort || process.env.CDP_PORT || 9333),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout = clip(stdout + chunk.toString());
  });
  child.stderr?.on("data", (chunk) => {
    stderr = clip(stderr + chunk.toString());
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, Math.max(30000, Number(timeoutMs || 900000)));

  const exitCode = await new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 0));
  });
  clearTimeout(timeout);

  const report = existsSync(reportFile) ? safeReadJson(reportFile) : null;
  return { exitCode, timedOut, stdout, stderr, report };
}

async function traceForSession(ctx, pid, sessionId) {
  if (!sessionId) return null;
  try {
    const res = await listSessionTraces(ctx, {
      params: { pid, sid: sessionId },
      query: { limit: 5, resolve_trace: "1" },
    });
    const items = res?.data?.items || [];
    return items[0] || null;
  } catch {
    return null;
  }
}

async function maybeDiagnoseBenchmarkRun(ctx, pid, benchmarkCase, result, traceItem, body = {}) {
  if (!result || result.pass || !bool(body.diagnose, true)) return null;
  const metadata = object(result.metadata);
  const expected = flattenBenchmarkGold(benchmarkCase.gold).map(String).join("\n");
  const traceEvidencePack = buildTraceEvidencePack({
    traceSnapshot: traceItem || {},
    question: benchmarkCase.question,
    expectedBehavior: benchmarkCase.expected_behavior,
    expectedAnswer: expected,
    actualOutput: metadata.output_text || result.error || failedChecks(result).join("\n"),
    assertionType: benchmarkCase.assertion_type,
    goldSolve: object(benchmarkCase.gold_solve),
    mode: "benchmark_failure",
    maxSpans: 14,
  });
  const diagnosisInput = {
    question: benchmarkCase.question,
    expected_behavior: benchmarkCase.expected_behavior,
    expected_answer: expected,
    actual_output: metadata.output_text || result.error || failedChecks(result).join("\n"),
    assertion_type: benchmarkCase.assertion_type,
    failure_category: "",
    tuning_notes: "",
    gold_solve: object(benchmarkCase.gold_solve),
    replay_requirements: object(benchmarkCase.metadata),
    trace_evidence_pack: traceEvidencePack,
    failed_checks: failedChecks(result),
  };
  try {
    const skillResult = await runTraceDebugger(ctx, {
      projectId: pid,
      skillName: TRACE_FAILURE_DIAGNOSER_SKILL,
      task: "对比 Benchmark Gold Solve、实际输出和 Trace 证据包，诊断失败发生在哪个 agent 流程阶段，并给出下一步调优建议。",
      baseInput: diagnosisInput,
      traceSnapshot: traceItem || {},
      responseContract: "必须只输出包含 failure_stage、confidence、summary、evidence、evidence_path、trace_gaps、recommended_actions、next_benchmark_focus、warnings 的 JSON object。",
      temperature: 0.1,
      maxTokens: 6000,
      modelId: nullableText(body.model_id || body.modelId),
      callSite: "trace_benchmark_run_diagnose",
      inputMaxChars: 42000,
      maxRounds: 5,
    });
    return {
      ...normalizeDiagnosisPayload(skillResult.data),
      skill: workflowSkillMeta(skillResult.skill),
    };
  } catch (e) {
    return {
      failure_stage: "unknown",
      confidence: 0,
      summary: `自动诊断失败: ${e?.message || e}`,
      evidence: [],
      trace_gaps: [],
      recommended_actions: ["打开关联 Trace 手工查看失败点。"],
      next_benchmark_focus: [],
      warnings: [`自动诊断失败: ${e?.message || e}`],
    };
  }
}

export async function benchmarkOverview(ctx, input) {
  const { pid } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const taskLimit = Math.max(1, Math.min(500, Number(input.query?.task_limit || 240)));
  const reportLimit = Math.max(1, Math.min(100, Number(input.query?.report_limit || 30)));
  const caseLimit = Math.max(1, Math.min(200, Number(input.query?.case_limit || 80)));
  const tasks = evalTaskInventory(taskLimit);
  const reports = evalResultReports(reportLimit);
  const cases = await benchmarkCaseRows(ctx, pid, caseLimit);
  const groups = tasks.reduce((acc, task) => {
    acc[task.group] = (acc[task.group] || 0) + 1;
    return acc;
  }, {});
  return {
    data: {
      eval_dir: APP_EVAL_DIR,
      tasks_dir: join(APP_EVAL_DIR, "tasks"),
      results_dir: join(APP_EVAL_DIR, "results"),
      task_count: tasks.length,
      groups,
      tasks,
      reports,
      cases: cases.map(benchmarkCaseShape),
      commands: {
        all: "cd app && node eval/run.mjs",
        kdd: "cd app && node eval/run.mjs kdd",
        trace: "cd app && node eval/run.mjs trace",
        zszq: "cd app && node eval/run.mjs zszq",
        generated: "cd app && node eval/run.mjs trace-benchmark",
        remote: "cd app && CDP_PORT=9223 node eval/run.mjs <filter>",
      },
    },
  };
}

export async function normalizeBenchmark(ctx, input) {
  const { pid } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const body = input.body || {};
  const content = text(body.content || body.raw_input || body.rawInput).trim();
  if (!content) throw new ApiError("请先粘贴 Benchmark 内容", 400);
  if (content.length > MAX_BENCHMARK_IMPORT_CHARS) {
    throw new ApiError(`Benchmark 内容过长，请分批导入（当前 ${content.length} 字符，上限 ${MAX_BENCHMARK_IMPORT_CHARS}）`, 400);
  }

  const { normalized, skill } = await normalizeBenchmarkContent(ctx, {
    pid,
    content,
    formatHint: nullableText(body.format_hint || body.formatHint) || "auto",
    modelId: nullableText(body.model_id || body.modelId),
    task: "将用户粘贴的非标准 Benchmark 内容清洗成 YiW 统一 Benchmark Case JSON。",
  });
  return {
    data: {
      ...normalized,
      skill: workflowSkillMeta(skill),
    },
  };
}

export async function normalizeBenchmarkFolder(ctx, input) {
  const { pid } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const body = input.body || {};
  const folder = scanBenchmarkFolder(body.folder_path || body.folderPath || body.path);
  const { normalized, skill } = await normalizeBenchmarkContent(ctx, {
    pid,
    content: folder.content,
    formatHint: nullableText(body.format_hint || body.formatHint) || "folder",
    modelId: nullableText(body.model_id || body.modelId),
    task: "将用户选择的本地 Benchmark 文件夹清洗成 YiW 统一 Benchmark Case JSON。",
    callSite: "trace_benchmark_normalize_folder",
    extraInput: {
      folder_path: folder.folder_path,
      files: folder.files,
    },
  });
  return {
    data: {
      ...normalized,
      warnings: [...new Set([...(folder.warnings || []), ...(normalized.warnings || [])])],
      source: {
        type: "folder_import",
        folder_path: folder.folder_path,
        folder_name: folder.folder_name,
        files: folder.files,
        total_files: folder.total_files,
      },
      skill: workflowSkillMeta(skill),
    },
  };
}

export async function importBenchmarkCases(ctx, input) {
  const { pid } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const body = input.body || {};
  const rawCases = Array.isArray(body.cases) ? body.cases : [];
  if (!rawCases.length) throw new ApiError("没有可导入的 Benchmark case", 400);
  const requestedSourceType = body.source_type || body.sourceType;
  const sourceType = BENCHMARK_SOURCE_TYPES.has(requestedSourceType) ? requestedSourceType : "ai_import";
  const rawInput = text(body.raw_input || body.rawInput).slice(0, 20000);
  const normalized = rawCases.map((item, index) => normalizeBenchmarkCase(item, index));
  const importable = normalized.filter((item) => item.status !== "invalid" && nullableText(item.question));
  if (!importable.length) throw new ApiError("没有通过校验的 Benchmark case", 400);

  const rows = [];
  for (const item of importable) {
    const row = await ctx.queryOne(
      `INSERT INTO trace_benchmark_cases
         (id, project_id, source_type, source_object_id, case_key, title, question,
          expected_behavior, answer_type, assertion_type, assertion_json, gold_json,
          metadata_json, tags, gold_solve_json, status, warnings_json, raw_input,
          created_by, updated_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,now(),now())
       RETURNING *`,
      [
        randomUUID(),
        pid,
        sourceType,
        nullableText(body.source_object_id || body.sourceObjectId),
        item.case_key,
        item.title,
        item.question,
        item.expected_behavior,
        item.answer_type,
        item.assertion_type,
        json(item.assertion || {}),
        json(item.gold),
        json(item.metadata || {}),
        json(item.tags || []),
        json(item.gold_solve || {}),
        BENCHMARK_CASE_STATUSES.has(item.status) ? item.status : "draft",
        json(item.warnings || []),
        rawInput,
        ctx.userId,
      ],
    );
    rows.push(row);
  }
  return {
    data: {
      imported_count: rows.length,
      skipped_count: normalized.length - rows.length,
      cases: rows.map(benchmarkCaseShape),
    },
    message: `已导入 ${rows.length} 条 Benchmark`,
  };
}

export async function materializeBenchmarkCase(ctx, input) {
  const { pid, caseId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const row = await benchmarkCaseById(ctx, pid, caseId);
  if (!row) throw new ApiError("Benchmark case 不存在", 404);
  const benchmarkCase = benchmarkCaseShape(row);
  const body = input.body || {};

  let skill = null;
  let plan = defaultMaterializerPlan(benchmarkCase);
  if (!bool(body.skip_ai || body.skipAi, false)) {
    try {
      const result = await runWorkflowSkill(ctx, {
        projectId: pid,
        skillName: BENCHMARK_TASK_MATERIALIZER_SKILL,
        task: "将 Benchmark Case 规划成 app/eval generated trace-benchmark 任务草稿。",
        input: {
          case: benchmarkCase,
          gold_solve: benchmarkCase.gold_solve || {},
          source: {
            source_type: benchmarkCase.source_type,
            source_object_id: benchmarkCase.source_object_id,
          },
          target_runtime: "app/eval generated trace-benchmark",
        },
        responseContract: "必须只输出包含 task_id、title、assertions、context_requirements、warnings、runnable_notes 的 JSON object。",
        temperature: 0.1,
        maxTokens: 4000,
        modelId: nullableText(body.model_id || body.modelId),
        callSite: "trace_benchmark_materialize",
        inputMaxChars: 26000,
      });
      skill = result.skill;
      const skillPlan = normalizeMaterializerPayload(result.data, benchmarkCase);
      plan = {
        ...plan,
        ...skillPlan,
        warnings: [...new Set([...(plan.warnings || []), ...(skillPlan.warnings || [])])],
        context_requirements: [...new Set([...(plan.context_requirements || []), ...(skillPlan.context_requirements || [])])],
        runnable_notes: [...new Set([...(plan.runnable_notes || []), ...(skillPlan.runnable_notes || [])])],
      };
    } catch (e) {
      plan.warnings = [...new Set([...(plan.warnings || []), `workflow materializer 不可用，已使用确定性草稿: ${e?.message || e}`])];
    }
  }

  const payload = materializedPayload({ plan, benchmarkCase, projectId: pid });
  const source = materializedTaskSource(plan.task_id);
  const command = `cd app && node eval/run.mjs ${plan.task_id}`;
  const runnable = isMaterializedTaskRunnable(plan);
  let files = null;
  let caseStatus = benchmarkCase.status;

  if (bool(body.write, false)) {
    files = writeMaterializedTask({ taskId: plan.task_id, payload, source });
    const generatedStatus = runnable ? "converted" : "generated_draft";
    const nextMetadata = {
      ...object(benchmarkCase.metadata),
      materialized_task: {
        task_id: plan.task_id,
        task_path: files.task_path,
        payload_path: files.payload_path,
        command,
        generated_at: payload.generated_at,
        status: generatedStatus,
        runnable,
        context_requirements: plan.context_requirements || [],
      },
    };
    caseStatus = runnable ? "converted" : benchmarkCase.status;
    await ctx.query(
      `UPDATE trace_benchmark_cases
          SET status=$1, metadata_json=$2, updated_by=$3, updated_at=now(), version=version+1
        WHERE id=$4`,
      [caseStatus, json(nextMetadata), ctx.userId, caseId],
    );
  }

  return {
    data: {
      task_id: plan.task_id,
      title: plan.title,
      source,
      payload,
      warnings: plan.warnings || [],
      context_requirements: plan.context_requirements || [],
      runnable_notes: plan.runnable_notes || [],
      command,
      files,
      skill: workflowSkillMeta(skill),
      written: Boolean(files),
      runnable,
      formalized: Boolean(files && runnable),
      case_status: caseStatus,
    },
    message: files
      ? runnable
        ? "Benchmark task 已生成并进入正式评测"
        : "Benchmark task 草稿已生成，补齐上下文后才能进入正式评测"
      : "Benchmark task 草稿已预览",
  };
}

export async function listBenchmarkRuns(ctx, input) {
  const { pid, caseId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  if (caseId) {
    const row = await benchmarkCaseById(ctx, pid, caseId);
    if (!row) throw new ApiError("Benchmark case 不存在", 404);
  }
  const limit = Math.max(1, Math.min(100, Number(input.query?.limit || 30)));
  const rows = await benchmarkRunRows(ctx, pid, { caseId: nullableText(caseId), limit });
  return { data: rows.map(benchmarkRunShape) };
}

export async function runBenchmarkCase(ctx, input) {
  const { pid, caseId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const row = await benchmarkCaseById(ctx, pid, caseId);
  if (!row) throw new ApiError("Benchmark case 不存在", 404);
  const benchmarkCase = benchmarkCaseShape(row);
  const body = input.body || {};

  const materialized = await materializeBenchmarkCase(ctx, {
    params: { pid, caseId },
    body: {
      ...body,
      write: true,
      skip_ai: true,
    },
  });
  const materializedData = materialized.data || {};
  const taskId = materializedData.task_id;
  const startedAt = nowIso();
  const runId = slugRunId(`trace-benchmark-${benchmarkCase.case_key || caseId}-${Date.now()}`);
  const reportFile = join(APP_EVAL_DIR, "results", `${runId}.json`);
  const cdpPort = Number(body.cdp_port || body.cdpPort || process.env.CDP_PORT || 9333);

  const insertRun = async (status, extra = {}) => ctx.queryOne(
    `INSERT INTO trace_benchmark_runs
       (id, project_id, benchmark_case_id, task_id, status, eval_run_id, report_file,
        report_json, result_json, diagnosis_json, trace_id, run_id, session_id,
        span_id, trace_snapshot_json, metrics_json, stdout, stderr, exit_code,
        started_at, finished_at, created_by, updated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22,now(),now())
     RETURNING *`,
    [
      randomUUID(),
      pid,
      caseId,
      taskId,
      BENCHMARK_RUN_STATUSES.has(status) ? status : "error",
      extra.eval_run_id || runId,
      extra.report_file || reportFile,
      json(extra.report || null),
      json(extra.result || null),
      json(extra.diagnosis || null),
      nullableText(extra.trace_id),
      nullableText(extra.run_id),
      nullableText(extra.session_id),
      nullableText(extra.span_id),
      json(extra.trace_snapshot || {}),
      json(extra.metrics || {}),
      clip(extra.stdout || ""),
      clip(extra.stderr || ""),
      extra.exit_code == null ? null : Number(extra.exit_code),
      extra.started_at || startedAt,
      extra.finished_at === undefined ? nowIso() : extra.finished_at,
      ctx.userId,
    ],
  );

  if (!materializedData.runnable && !bool(body.force, false)) {
    const reason = (materializedData.context_requirements || []).join("；") || "Benchmark Case 缺少可运行上下文";
    const diagnosis = blockedDiagnosis(reason);
    const metrics = {
      runnable: false,
      context_requirements: materializedData.context_requirements || [],
      warnings: materializedData.warnings || [],
    };
    const runRow = await insertRun("blocked", {
      result: materializedData,
      diagnosis,
      metrics,
    });
    await ctx.query(
      `UPDATE trace_benchmark_cases
          SET metadata_json=$1, updated_by=$2, updated_at=now(), version=version+1
        WHERE id=$3`,
      [
        json({
          ...object(benchmarkCase.metadata),
          last_benchmark_run: {
            id: runRow.id,
            status: "blocked",
            task_id: taskId,
            finished_at: runRow.finished_at,
          },
        }),
        ctx.userId,
        caseId,
      ],
    );
    return {
      data: {
        run: benchmarkRunShape(runRow),
        materialized: materializedData,
      },
      message: "Benchmark 缺少可运行上下文，已记录为阻塞",
    };
  }

  const running = await insertRun("running", {
    metrics: {
      runnable: true,
      cdp_port: cdpPort,
    },
    finished_at: null,
  });

  const evalResult = await runEvalProcess({
    taskId,
    cdpPort,
    timeoutMs: Number(body.timeout_ms || body.timeoutMs || 900000),
    reportFile,
    runId,
  });
  const report = evalResult.report || (existsSync(reportFile) ? parseJson(readFileSync(reportFile, "utf8"), null) : null);
  const result = resultForTask(report, taskId);
  const traceItem = await traceForSession(ctx, pid, nullableText(result?.metadata?.session_id));
  const diagnosis = await maybeDiagnoseBenchmarkRun(ctx, pid, benchmarkCase, result, traceItem, body);
  const status = runStatus({
    report,
    result,
    exitCode: evalResult.exitCode,
    timedOut: evalResult.timedOut,
  });
  const metrics = resultMetrics(report, result, {
    cdpPort,
    exitCode: evalResult.exitCode,
    timedOut: evalResult.timedOut,
  });

  const updatedRun = await ctx.queryOne(
    `UPDATE trace_benchmark_runs
        SET status=$1, eval_run_id=$2, report_file=$3, report_json=$4,
            result_json=$5, diagnosis_json=$6, trace_id=$7, run_id=$8,
            session_id=$9, span_id=$10, trace_snapshot_json=$11, metrics_json=$12,
            stdout=$13, stderr=$14, exit_code=$15, finished_at=$16,
            updated_by=$17, updated_at=now(), version=version+1
      WHERE id=$18
      RETURNING *`,
    [
      status,
      report?.runId || runId,
      reportFile,
      json(report || null),
      json(result || null),
      json(diagnosis || null),
      nullableText(traceItem?.trace?.traceId || traceItem?.trace?.externalTraceId),
      nullableText(traceItem?.runId),
      nullableText(result?.metadata?.session_id || traceItem?.sessionId),
      null,
      json(traceItem || {}),
      json(metrics),
      clip(evalResult.stdout),
      clip(evalResult.stderr),
      Number(evalResult.exitCode),
      nowIso(),
      ctx.userId,
      running.id,
    ],
  );

  await ctx.query(
    `UPDATE trace_benchmark_cases
        SET metadata_json=$1, updated_by=$2, updated_at=now(), version=version+1
      WHERE id=$3`,
    [
      json({
        ...object(benchmarkCase.metadata),
        last_benchmark_run: {
          id: updatedRun.id,
          status,
          task_id: taskId,
          eval_run_id: report?.runId || runId,
          report_file: reportFile,
          trace_id: updatedRun.trace_id,
          run_id: updatedRun.run_id,
          session_id: updatedRun.session_id,
          metrics,
          finished_at: updatedRun.finished_at,
        },
      }),
      ctx.userId,
      caseId,
    ],
  );

  return {
    data: {
      run: benchmarkRunShape(updatedRun),
      materialized: materializedData,
    },
    message: status === "passed" ? "Benchmark 运行通过" : "Benchmark 运行完成，存在失败项",
  };
}
