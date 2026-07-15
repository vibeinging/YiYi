import { randomUUID } from "node:crypto";
import { runWorkflowSkill, workflowSkillMeta } from "../../../engine/skills/workflow_skill_runner.js";
import { ApiError } from "../../../errors.js";
import { buildTraceEvidencePack } from "./trace_evidence.js";
import { runTraceDebugger } from "./trace_debugger.js";
import {
  GOLD_STATUSES,
  GOLD_SOLVE_DRAFTER_SKILL,
  TRACE_FAILURE_DIAGNOSER_SKILL,
  TRACE_TUNING_PROPOSER_SKILL,
  text,
  nullableText,
  json,
  parseJson,
  object,
  array,
  bool,
  requireProjectAccess,
  goldSolveShape,
  draftShape,
  attemptShape,
  goldSolveForDraft,
  insertAttempt,
  refreshDraftReadiness
} from "./common.js";

function goldSolveDraftInput(draft, overrides = {}) {
  const traceSnapshot = parseJson(draft.trace_snapshot_json, {});
  return {
    question: text(overrides.question ?? draft.question),
    expected_behavior: text(overrides.expected_behavior ?? overrides.expectedBehavior ?? draft.expected_behavior),
    expected_answer: text(overrides.expected_answer ?? overrides.expectedAnswer ?? draft.expected_answer),
    assertion_type: text(overrides.assertion_type ?? overrides.assertionType ?? draft.assertion_type),
    actual_output: text(draft.actual_output),
    tags: parseJson(draft.tags, []),
    failure_category: draft.failure_category || "",
    tuning_notes: draft.tuning_notes || "",
    replay_requirements: parseJson(draft.replay_requirements_json, {}),
    trace_evidence_pack: buildTraceEvidencePack({
      traceSnapshot,
      question: overrides.question ?? draft.question,
      expectedBehavior: overrides.expected_behavior ?? overrides.expectedBehavior ?? draft.expected_behavior,
      expectedAnswer: overrides.expected_answer ?? overrides.expectedAnswer ?? draft.expected_answer,
      actualOutput: draft.actual_output,
      assertionType: overrides.assertion_type ?? overrides.assertionType ?? draft.assertion_type,
      mode: "gold_solve",
    }),
  };
}

function normalizeGoldSolveDraftPayload(payload, draft, overrides = {}) {
  const src = object(payload);
  const warnings = array(src.warnings).map(String);
  const assumptions = array(src.assumptions).map(String);
  const traceDiff = text(src.trace_diff_summary || src.traceDiffSummary);
  const suffix = [
    warnings.length ? `Warnings: ${warnings.join("；")}` : "",
    assumptions.length ? `Assumptions: ${assumptions.join("；")}` : "",
  ].filter(Boolean).join("\n");
  return {
    question: text(overrides.question ?? draft.question),
    expected_behavior: text(overrides.expected_behavior ?? overrides.expectedBehavior ?? draft.expected_behavior),
    expected_answer: text(overrides.expected_answer ?? overrides.expectedAnswer ?? draft.expected_answer),
    intent_summary: text(src.intent_summary || src.intentSummary),
    data_sources: array(src.data_sources || src.dataSources).map(String),
    filters: object(src.filters),
    metric_definition: text(src.metric_definition || src.metricDefinition),
    reference_steps: array(src.reference_steps || src.referenceSteps).map(String),
    reference_sql: text(src.reference_sql || src.referenceSql),
    intermediate_expectations: array(src.intermediate_expectations || src.intermediateExpectations),
    final_answer_contract: text(src.final_answer_contract || src.finalAnswerContract),
    trace_diff_summary: [traceDiff, suffix].filter(Boolean).join("\n\n"),
    status: "drafted",
  };
}

function diagnosisInput(draft, gold, overrides = {}) {
  const traceSnapshot = parseJson(draft.trace_snapshot_json, {});
  const bodyGold = object(overrides.gold_solve || overrides.goldSolve);
  const baseGold = goldSolveShape(gold) || {};
  const mergedGold = {
    ...baseGold,
    ...bodyGold,
    data_sources: array(bodyGold.data_sources || bodyGold.dataSources || baseGold.data_sources).map(String),
    filters: object(bodyGold.filters || baseGold.filters),
    reference_steps: array(bodyGold.reference_steps || bodyGold.referenceSteps || baseGold.reference_steps).map(String),
    intermediate_expectations: array(bodyGold.intermediate_expectations || bodyGold.intermediateExpectations || baseGold.intermediate_expectations),
  };
  return {
    question: text(overrides.question ?? draft.question),
    expected_behavior: text(overrides.expected_behavior ?? overrides.expectedBehavior ?? draft.expected_behavior),
    expected_answer: text(overrides.expected_answer ?? overrides.expectedAnswer ?? draft.expected_answer),
    actual_output: text(draft.actual_output),
    assertion_type: text(overrides.assertion_type ?? overrides.assertionType ?? draft.assertion_type),
    failure_category: draft.failure_category || "",
    tuning_notes: draft.tuning_notes || "",
    gold_solve: mergedGold,
    replay_requirements: parseJson(draft.replay_requirements_json, {}),
    trace_evidence_pack: buildTraceEvidencePack({
      traceSnapshot,
      question: overrides.question ?? draft.question,
      expectedBehavior: overrides.expected_behavior ?? overrides.expectedBehavior ?? draft.expected_behavior,
      expectedAnswer: overrides.expected_answer ?? overrides.expectedAnswer ?? draft.expected_answer,
      actualOutput: draft.actual_output,
      assertionType: overrides.assertion_type ?? overrides.assertionType ?? draft.assertion_type,
      goldSolve: mergedGold,
      mode: "diagnosis",
    }),
  };
}

function normalizeDiagnosisPayload(payload) {
  const src = object(payload);
  const traceDebugger = object(src.trace_debugger || src.traceDebugger);
  const stages = new Set([
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
  ]);
  const stage = stages.has(src.failure_stage) ? src.failure_stage : "unknown";
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

function normalizeTuningProposalPayload(payload, diagnosis = {}) {
  const src = object(payload);
  const allowedTypes = new Set([
    "prompt_rule",
    "tool_schema",
    "operator_logic",
    "metadata",
    "benchmark_assertion",
    "trace_instrumentation",
    "manual_check",
  ]);
  const changeType = allowedTypes.has(src.change_type) ? src.change_type : "manual_check";
  const evidencePath = array(src.evidence_path || src.evidencePath || diagnosis.evidence_path || diagnosis.evidencePath).map((item) => {
    const row = object(item);
    return {
      span_id: text(row.span_id || row.spanId),
      observation: text(row.observation || item),
    };
  }).filter((item) => item.span_id || item.observation);
  return {
    hypothesis: text(src.hypothesis || diagnosis.summary),
    change_type: changeType,
    target: text(src.target || diagnosis.failure_stage || "unknown"),
    proposal: text(src.proposal),
    why: text(src.why || src.reason),
    risk: text(src.risk),
    validation_plan: text(src.validation_plan || src.validationPlan),
    benchmark_focus: array(src.benchmark_focus || src.benchmarkFocus || diagnosis.next_benchmark_focus || diagnosis.nextBenchmarkFocus).map(String),
    manual_steps: array(src.manual_steps || src.manualSteps).map(String),
    evidence_path: evidencePath,
    warnings: array(src.warnings).map(String),
  };
}

function tuningProposalInput(draft, gold, body = {}) {
  const diagnosis = object(body.diagnosis);
  const base = diagnosisInput(draft, gold, body);
  return {
    draft: {
      id: draft.id,
      question: text(body.question ?? draft.question),
      expected_behavior: text(body.expected_behavior ?? body.expectedBehavior ?? draft.expected_behavior),
      expected_answer: text(body.expected_answer ?? body.expectedAnswer ?? draft.expected_answer),
      actual_output: text(draft.actual_output),
      assertion_type: text(body.assertion_type ?? body.assertionType ?? draft.assertion_type),
      failure_category: draft.failure_category || "",
      tuning_notes: draft.tuning_notes || "",
    },
    gold_solve: base.gold_solve,
    diagnosis,
    trace_evidence_pack: base.trace_evidence_pack,
    recent_attempts: array(body.recent_attempts || body.recentAttempts).slice(0, 5),
  };
}

export async function runTuningProposalWorkflow(ctx, {
  projectId,
  draft,
  gold,
  body = {},
  recentAttempts = [],
  runStep = runWorkflowSkill,
} = {}) {
  const diagnosis = object(body.diagnosis);
  const result = await runStep(ctx, {
    projectId,
    skillName: TRACE_TUNING_PROPOSER_SKILL,
    task: "基于当前 Trace 诊断、Gold Solve 和证据路径，生成下一轮可人工确认的调优方案。不要自动修改系统。",
    input: tuningProposalInput(draft, gold, { ...body, recent_attempts: recentAttempts }),
    responseContract: "必须只输出包含 hypothesis、change_type、target、proposal、why、risk、validation_plan、benchmark_focus、manual_steps、evidence_path、warnings 的 JSON object。",
    temperature: 0.12,
    maxTokens: 5000,
    modelId: nullableText(body.model_id || body.modelId),
    callSite: "trace_tuning_propose",
    inputMaxChars: 32000,
  });
  return {
    skill: result.skill,
    data: normalizeTuningProposalPayload(result.data, diagnosis),
  };
}

export async function generateGoldSolve(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const draft = await ctx.queryOne(
    `SELECT * FROM trace_eval_drafts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!draft) throw new ApiError("评测草稿不存在", 404);
  const body = input.body || {};
  const question = nullableText(body.question ?? draft.question);
  const expectedBehavior = nullableText(body.expected_behavior ?? body.expectedBehavior ?? draft.expected_behavior);
  const expectedAnswer = nullableText(body.expected_answer ?? body.expectedAnswer ?? draft.expected_answer);
  if (!question) throw new ApiError("缺少用户问题，无法生成参考解", 400);
  if (!expectedBehavior && !expectedAnswer) throw new ApiError("缺少 expected，无法生成可靠参考解", 400);

  let skill;
  let parsed;
  try {
    const result = await runWorkflowSkill(ctx, {
      projectId: pid,
      skillName: GOLD_SOLVE_DRAFTER_SKILL,
      task: "为下面 Eval Draft 生成 Step 0 参考解草稿。不要把 actual_output 当作正确答案。",
      input: goldSolveDraftInput(draft, body),
      responseContract: "必须只输出包含 intent_summary、data_sources、filters、metric_definition、reference_steps、reference_sql、intermediate_expectations、final_answer_contract、trace_diff_summary、warnings、assumptions 的 JSON object。",
      temperature: 0.15,
      maxTokens: 7000,
      modelId: nullableText(body.model_id || body.modelId),
      callSite: "trace_gold_solve_draft",
      inputMaxChars: 30000,
    });
    skill = result.skill;
    parsed = result.data;
  } catch (e) {
    throw new ApiError(`生成参考解失败: ${e?.message || e}`, 500);
  }

  const generated = normalizeGoldSolveDraftPayload(parsed, draft, body);
  const saved = await saveGoldSolve(ctx, {
    params: { pid, draftId },
    body: generated,
  });
  return {
    ...saved,
    data: {
      ...(saved.data || {}),
      skill: workflowSkillMeta(skill),
    },
    message: "参考解草稿已生成",
  };
}

export async function diagnoseDraft(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const draft = await ctx.queryOne(
    `SELECT * FROM trace_eval_drafts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!draft) throw new ApiError("评测草稿不存在", 404);
  const gold = await goldSolveForDraft(ctx, draftId);
  const body = input.body || {};
  const payload = diagnosisInput(draft, gold, body);
  const traceSnapshot = parseJson(draft.trace_snapshot_json, {});
  if (!nullableText(payload.question)) throw new ApiError("缺少用户问题，无法诊断", 400);
  if (!nullableText(payload.expected_behavior) && !nullableText(payload.expected_answer)) {
    throw new ApiError("缺少 expected，无法诊断", 400);
  }

  let skill;
  let parsed;
  try {
    const result = await runTraceDebugger(ctx, {
      projectId: pid,
      skillName: TRACE_FAILURE_DIAGNOSER_SKILL,
      task: "对比 Gold Solve、actual output 和 Trace 证据包，诊断失败发生在哪个 agent 流程阶段，并给出下一步调优建议。",
      baseInput: payload,
      traceSnapshot,
      responseContract: "必须只输出包含 failure_stage、confidence、summary、evidence、evidence_path、trace_gaps、recommended_actions、next_benchmark_focus、warnings 的 JSON object。",
      temperature: 0.1,
      maxTokens: 6000,
      modelId: nullableText(body.model_id || body.modelId),
      callSite: "trace_failure_diagnose",
      inputMaxChars: 36000,
      maxRounds: 5,
    });
    skill = result.skill;
    parsed = result.data;
  } catch (e) {
    throw new ApiError(`Trace 诊断失败: ${e?.message || e}`, 500);
  }

  const diagnosis = normalizeDiagnosisPayload(parsed);
  let attempt = null;
  if (bool(body.persist_attempt || body.persistAttempt, false)) {
    const attemptRow = await insertAttempt(ctx, pid, draft, {
      ...(body.attempt || {}),
      source: "diagnosis",
      status: body.attempt?.status || "planned",
      hypothesis: body.attempt?.hypothesis || diagnosis.summary,
      diagnosis,
    });
    attempt = attemptShape(attemptRow);
  }

  return {
    data: {
      ...diagnosis,
      skill: workflowSkillMeta(skill),
      ...(attempt ? { attempt } : {}),
    },
    message: attempt ? "Trace 诊断已生成并记录为调试轮次" : "Trace 诊断已生成",
  };
}

export async function generateTuningProposal(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const draft = await ctx.queryOne(
    `SELECT * FROM trace_eval_drafts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!draft) throw new ApiError("评测草稿不存在", 404);
  const gold = await goldSolveForDraft(ctx, draftId);
  const body = input.body || {};
  const diagnosis = object(body.diagnosis);
  if (!nullableText(diagnosis.summary) && !nullableText(diagnosis.failure_stage || diagnosis.failureStage)) {
    throw new ApiError("缺少 Trace 诊断结果，无法生成调优方案", 400);
  }
  let recentAttempts = array(body.recent_attempts || body.recentAttempts);
  if (!recentAttempts.length) {
    const rows = await ctx.query(
      `SELECT *
         FROM trace_optimization_attempts
        WHERE draft_id=$1 AND project_id=$2 AND deleted_at IS NULL
        ORDER BY attempt_index DESC, updated_at DESC, created_at DESC
        LIMIT 5`,
      [draftId, pid],
    );
    recentAttempts = rows.map(attemptShape);
  }

  let skill;
  let parsed;
  try {
    const result = await runTuningProposalWorkflow(ctx, {
      projectId: pid,
      draft,
      gold,
      body,
      recentAttempts,
    });
    skill = result.skill;
    parsed = result.data;
  } catch (e) {
    throw new ApiError(`生成调优方案失败: ${e?.message || e}`, 500);
  }

  return {
    data: {
      ...parsed,
      skill: workflowSkillMeta(skill),
    },
    message: "调优方案已生成",
  };
}

export async function saveGoldSolve(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const draft = await ctx.queryOne(
    `SELECT * FROM trace_eval_drafts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!draft) throw new ApiError("评测草稿不存在", 404);
  const body = input.body || {};
  const status = GOLD_STATUSES.has(body.status) && body.status !== "missing" ? body.status : "drafted";
  const existing = await goldSolveForDraft(ctx, draftId);
  let row;
  if (existing) {
    row = await ctx.queryOne(
      `UPDATE trace_gold_solves
          SET question=$1, expected_behavior=$2, expected_answer=$3, intent_summary=$4,
              data_sources=$5, filters_json=$6, metric_definition=$7, reference_steps_json=$8,
              reference_sql=$9, intermediate_expectations_json=$10, final_answer_contract=$11,
              trace_diff_summary=$12, status=$13,
              verified_by=CASE WHEN $13='verified' THEN $14 ELSE verified_by END,
              updated_at=now(), version=version+1
        WHERE id=$15
        RETURNING *`,
      [
        text(body.question ?? draft.question),
        text(body.expected_behavior ?? draft.expected_behavior),
        text(body.expected_answer ?? draft.expected_answer),
        text(body.intent_summary),
        json(body.data_sources || []),
        json(body.filters || {}),
        text(body.metric_definition),
        json(body.reference_steps || []),
        text(body.reference_sql),
        json(body.intermediate_expectations || []),
        text(body.final_answer_contract),
        text(body.trace_diff_summary),
        status,
        ctx.userId,
        existing.id,
      ],
    );
  } else {
    row = await ctx.queryOne(
      `INSERT INTO trace_gold_solves
         (id, draft_id, project_id, question, expected_behavior, expected_answer,
          intent_summary, data_sources, filters_json, metric_definition, reference_steps_json,
          reference_sql, intermediate_expectations_json, final_answer_contract, trace_diff_summary,
          status, created_by, verified_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,CASE WHEN $16='verified' THEN $17 ELSE NULL END,now(),now())
       RETURNING *`,
      [
        randomUUID(),
        draftId,
        pid,
        text(body.question ?? draft.question),
        text(body.expected_behavior ?? draft.expected_behavior),
        text(body.expected_answer ?? draft.expected_answer),
        text(body.intent_summary),
        json(body.data_sources || []),
        json(body.filters || {}),
        text(body.metric_definition),
        json(body.reference_steps || []),
        text(body.reference_sql),
        json(body.intermediate_expectations || []),
        text(body.final_answer_contract),
        text(body.trace_diff_summary),
        status,
        ctx.userId,
      ],
    );
  }
  const refreshedDraft = await refreshDraftReadiness(ctx, draftId);
  return { data: { gold_solve: goldSolveShape(row), draft: draftShape(refreshedDraft, row) }, message: "参考解已保存" };
}

export async function updateGoldSolve(ctx, input) {
  const { pid, goldSolveId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const existing = await ctx.queryOne(
    `SELECT * FROM trace_gold_solves WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [goldSolveId, pid],
  );
  if (!existing) throw new ApiError("参考解不存在", 404);
  return saveGoldSolve(ctx, {
    params: { pid, draftId: existing.draft_id },
    body: input.body || {},
  });
}
