import { ApiError } from "../../../errors.js";
import {
  ASSERTION_TYPES,
  text,
  nullableText,
  json,
  normalizeTags,
  requireProjectAccess,
  draftShape,
  normalizeAttemptStatus,
  normalizeAttemptSource,
  attemptShape,
  goldSolveForDraft,
  insertAttempt,
  draftState
} from "./common.js";

export async function listDrafts(ctx, input) {
  const { pid } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const limit = Math.max(1, Math.min(200, Number(input.query?.limit || 80)));
  const sessionId = nullableText(input.query?.session_id);
  const status = nullableText(input.query?.status);
  const where = ["d.project_id=$1", "d.deleted_at IS NULL"];
  const params = [pid];
  let idx = 2;
  if (sessionId) {
    where.push(`d.session_id=$${idx}`);
    params.push(sessionId);
    idx += 1;
  }
  if (status) {
    where.push(`d.status=$${idx}`);
    params.push(status);
    idx += 1;
  }
  params.push(limit);
  const rows = await ctx.query(
    `SELECT d.*, g.id AS gold_id, g.status AS gold_status
       FROM trace_eval_drafts d
       LEFT JOIN trace_gold_solves g
         ON g.draft_id=d.id AND g.deleted_at IS NULL
      WHERE ${where.join(" AND ")}
      ORDER BY d.updated_at DESC, d.created_at DESC
      LIMIT $${idx}`,
    params,
  );
  return {
    data: rows.map((row) => ({
      ...draftShape(row),
      gold_solve_status: row.gold_status || "missing",
    })),
  };
}

export async function getDraft(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const row = await ctx.queryOne(
    `SELECT * FROM trace_eval_drafts
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!row) throw new ApiError("评测草稿不存在", 404);
  const gold = await goldSolveForDraft(ctx, row.id);
  return { data: draftShape(row, gold) };
}

export async function updateDraft(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const existing = await ctx.queryOne(
    `SELECT * FROM trace_eval_drafts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!existing) throw new ApiError("评测草稿不存在", 404);
  const body = input.body || {};
  const assertionType = ASSERTION_TYPES.has(body.assertion_type) ? body.assertion_type : (existing.assertion_type || "manual");
  const gold = await goldSolveForDraft(ctx, draftId);
  const expectedBehavior = body.expected_behavior !== undefined ? text(body.expected_behavior) : existing.expected_behavior;
  const expectedAnswer = body.expected_answer !== undefined ? text(body.expected_answer) : existing.expected_answer;
  const question = body.question !== undefined ? text(body.question) : existing.question;
  const nextState = draftState({
    question,
    expected_behavior: expectedBehavior,
    expected_answer: expectedAnswer,
    assertion_type: assertionType,
    trace_id: existing.trace_id,
    run_id: existing.run_id,
    gold_status: gold?.status,
  });
  const row = await ctx.queryOne(
    `UPDATE trace_eval_drafts
        SET question=$1, expected_behavior=$2, expected_answer=$3, assertion_type=$4,
            status=$5, benchmark_status=$6, tags=$7, failure_category=$8,
            tuning_notes=$9, replay_requirements_json=$10, updated_by=$11,
            updated_at=now(), version=version+1
      WHERE id=$12
      RETURNING *`,
    [
      question,
      expectedBehavior,
      expectedAnswer,
      assertionType,
      nextState.status,
      nextState.benchmark_status,
      body.tags !== undefined ? json(normalizeTags(body.tags)) : existing.tags,
      body.failure_category !== undefined ? nullableText(body.failure_category) : existing.failure_category,
      body.tuning_notes !== undefined ? nullableText(body.tuning_notes) : existing.tuning_notes,
      body.replay_requirements !== undefined ? json(body.replay_requirements || {}) : existing.replay_requirements_json,
      ctx.userId,
      draftId,
    ],
  );
  return { data: draftShape(row, gold), message: "评测草稿已保存" };
}

export async function listAttempts(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const draft = await ctx.queryOne(
    `SELECT id FROM trace_eval_drafts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!draft) throw new ApiError("评测草稿不存在", 404);
  const limit = Math.max(1, Math.min(100, Number(input.query?.limit || 30)));
  const status = nullableText(input.query?.status);
  const where = ["draft_id=$1", "project_id=$2", "deleted_at IS NULL"];
  const params = [draftId, pid];
  let idx = 3;
  if (status) {
    where.push(`status=$${idx}`);
    params.push(status);
    idx += 1;
  }
  params.push(limit);
  const rows = await ctx.query(
    `SELECT *
       FROM trace_optimization_attempts
      WHERE ${where.join(" AND ")}
      ORDER BY attempt_index DESC, updated_at DESC, created_at DESC
      LIMIT $${idx}`,
    params,
  );
  return { data: rows.map(attemptShape) };
}

export async function createAttempt(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const draft = await ctx.queryOne(
    `SELECT * FROM trace_eval_drafts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!draft) throw new ApiError("评测草稿不存在", 404);
  const row = await insertAttempt(ctx, pid, draft, input.body || {});
  return { data: attemptShape(row), message: "调试轮次已记录" };
}

export async function updateAttempt(ctx, input) {
  const { pid, attemptId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const existing = await ctx.queryOne(
    `SELECT *
       FROM trace_optimization_attempts
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [attemptId, pid],
  );
  if (!existing) throw new ApiError("调试轮次不存在", 404);
  const body = input.body || {};
  const status = body.status !== undefined ? normalizeAttemptStatus(body.status, existing.status) : existing.status;
  const source = body.source !== undefined ? normalizeAttemptSource(body.source, existing.source) : existing.source;
  const row = await ctx.queryOne(
    `UPDATE trace_optimization_attempts
        SET benchmark_case_id=$1, source=$2, status=$3, hypothesis=$4,
            change_summary=$5, diagnosis_json=$6, benchmark_result_json=$7,
            trace_id=$8, run_id=$9, session_id=$10, span_id=$11,
            trace_snapshot_json=$12, metrics_json=$13, notes=$14,
            updated_by=$15, updated_at=now(), version=version+1
      WHERE id=$16
      RETURNING *`,
    [
      body.benchmark_case_id !== undefined || body.benchmarkCaseId !== undefined
        ? nullableText(body.benchmark_case_id || body.benchmarkCaseId)
        : existing.benchmark_case_id,
      source,
      status,
      body.hypothesis !== undefined ? text(body.hypothesis) : existing.hypothesis,
      body.change_summary !== undefined || body.changeSummary !== undefined
        ? text(body.change_summary || body.changeSummary)
        : existing.change_summary,
      body.diagnosis !== undefined || body.diagnosis_json !== undefined || body.diagnosisJson !== undefined
        ? json(body.diagnosis || body.diagnosis_json || body.diagnosisJson)
        : existing.diagnosis_json,
      body.benchmark_result !== undefined || body.benchmarkResult !== undefined || body.benchmark_result_json !== undefined || body.benchmarkResultJson !== undefined
        ? json(body.benchmark_result || body.benchmarkResult || body.benchmark_result_json || body.benchmarkResultJson)
        : existing.benchmark_result_json,
      body.trace_id !== undefined || body.traceId !== undefined ? nullableText(body.trace_id || body.traceId) : existing.trace_id,
      body.run_id !== undefined || body.runId !== undefined ? nullableText(body.run_id || body.runId) : existing.run_id,
      body.session_id !== undefined || body.sessionId !== undefined ? nullableText(body.session_id || body.sessionId) : existing.session_id,
      body.span_id !== undefined || body.spanId !== undefined ? nullableText(body.span_id || body.spanId) : existing.span_id,
      body.trace_snapshot !== undefined || body.traceSnapshot !== undefined ? json(body.trace_snapshot || body.traceSnapshot || {}) : existing.trace_snapshot_json,
      body.metrics !== undefined || body.metrics_json !== undefined || body.metricsJson !== undefined
        ? json(body.metrics || body.metrics_json || body.metricsJson || {})
        : existing.metrics_json,
      body.notes !== undefined ? text(body.notes) : existing.notes,
      ctx.userId,
      attemptId,
    ],
  );
  return { data: attemptShape(row), message: "调试轮次已保存" };
}
