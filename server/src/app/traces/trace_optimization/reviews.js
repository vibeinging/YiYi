import { randomUUID } from "node:crypto";
import { ApiError } from "../../../errors.js";
import {
  REVIEW_STATUSES,
  SEVERITIES,
  ASSERTION_TYPES,
  text,
  nullableText,
  json,
  parseJson,
  normalizeTags,
  requireProjectAccess,
  reviewShape,
  draftShape,
  latestDraftForReview,
  goldSolveForDraft,
  draftState
} from "./common.js";

export async function listReviews(ctx, input) {
  const { pid } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const limit = Math.max(1, Math.min(200, Number(input.query?.limit || 80)));
  const sessionId = nullableText(input.query?.session_id);
  const status = nullableText(input.query?.status);
  const where = ["r.project_id=$1", "r.deleted_at IS NULL"];
  const params = [pid];
  let idx = 2;
  if (sessionId) {
    where.push(`r.session_id=$${idx}`);
    params.push(sessionId);
    idx += 1;
  }
  if (status) {
    where.push(`r.status=$${idx}`);
    params.push(status);
    idx += 1;
  }
  params.push(limit);
  const rows = await ctx.query(
    `SELECT r.*,
            d.id AS draft_id,
            d.status AS draft_status,
            d.benchmark_status AS draft_benchmark_status
       FROM trace_run_reviews r
       LEFT JOIN trace_eval_drafts d
         ON d.review_id=r.id AND d.deleted_at IS NULL
      WHERE ${where.join(" AND ")}
      ORDER BY r.updated_at DESC, r.created_at DESC
      LIMIT $${idx}`,
    params,
  );
  return {
    data: rows.map((row) => reviewShape(row, row.draft_id ? {
      id: row.draft_id,
      review_id: row.id,
      project_id: row.project_id,
      session_id: row.session_id,
      run_id: row.run_id,
      trace_id: row.trace_id,
      span_id: row.span_id,
      status: row.draft_status,
      benchmark_status: row.draft_benchmark_status,
    } : null)),
  };
}

export async function saveReview(ctx, input) {
  const { pid } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const body = input.body || {};
  const runId = nullableText(body.run_id || body.runId);
  if (!runId) throw new ApiError("run_id 为必填项", 400);
  const targetType = body.target_type === "span" ? "span" : "run";
  const spanId = targetType === "span" ? nullableText(body.span_id || body.spanId) : null;
  if (targetType === "span" && !spanId) throw new ApiError("span_id 为 span 标注必填项", 400);
  const status = REVIEW_STATUSES.has(body.status) ? body.status : "needs_review";
  const severity = SEVERITIES.has(body.severity) ? body.severity : "medium";

  const existing = await ctx.queryOne(
    `SELECT * FROM trace_run_reviews
      WHERE project_id=$1
        AND target_type=$2
        AND run_id=$3
        AND ((span_id IS NULL AND $4 IS NULL) OR span_id=$4)
        AND deleted_at IS NULL
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1`,
    [pid, targetType, runId, spanId],
  );

  let row;
  if (existing) {
    row = await ctx.queryOne(
      `UPDATE trace_run_reviews
          SET session_id=$1, trace_id=$2, question=$3, actual_output=$4, trace_snapshot_json=$5,
              status=$6, severity=$7, reason_code=$8, reason_text=$9, expected_behavior=$10,
              source=$11, score_type=$12, score_value=$13, risk_reason=$14,
              updated_by=$15, updated_at=now(),
              version=version+1
        WHERE id=$16
        RETURNING *`,
      [
        nullableText(body.session_id || body.sessionId),
        nullableText(body.trace_id || body.traceId),
        text(body.question),
        text(body.actual_output || body.actualOutput),
        json(body.trace_snapshot || body.traceSnapshot || {}),
        status,
        severity,
        nullableText(body.reason_code || body.reasonCode),
        nullableText(body.reason_text || body.reasonText),
        nullableText(body.expected_behavior || body.expectedBehavior),
        nullableText(body.source) || "human",
        nullableText(body.score_type || body.scoreType),
        nullableText(body.score_value || body.scoreValue),
        nullableText(body.risk_reason || body.riskReason),
        ctx.userId,
        existing.id,
      ],
    );
  } else {
    row = await ctx.queryOne(
      `INSERT INTO trace_run_reviews
         (id, project_id, session_id, run_id, trace_id, span_id, target_type,
          question, actual_output, trace_snapshot_json, status, severity, reason_code,
          reason_text, expected_behavior, source, score_type, score_value, risk_reason,
          created_by, updated_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20,now(),now())
       RETURNING *`,
      [
        randomUUID(),
        pid,
        nullableText(body.session_id || body.sessionId),
        runId,
        nullableText(body.trace_id || body.traceId),
        spanId,
        targetType,
        text(body.question),
        text(body.actual_output || body.actualOutput),
        json(body.trace_snapshot || body.traceSnapshot || {}),
        status,
        severity,
        nullableText(body.reason_code || body.reasonCode),
        nullableText(body.reason_text || body.reasonText),
        nullableText(body.expected_behavior || body.expectedBehavior),
        nullableText(body.source) || "human",
        nullableText(body.score_type || body.scoreType),
        nullableText(body.score_value || body.scoreValue),
        nullableText(body.risk_reason || body.riskReason),
        ctx.userId,
      ],
    );
  }
  const draft = await latestDraftForReview(ctx, row.id);
  return { data: reviewShape(row, draft), message: "标注已保存" };
}

export async function createDraftFromReview(ctx, input) {
  const { pid } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const body = input.body || {};
  const reviewId = nullableText(body.review_id || body.reviewId);
  if (!reviewId) throw new ApiError("review_id 为必填项", 400);
  const review = await ctx.queryOne(
    `SELECT * FROM trace_run_reviews
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [reviewId, pid],
  );
  if (!review) throw new ApiError("Review 不存在", 404);
  const existing = await latestDraftForReview(ctx, reviewId);
  if (existing) {
    const gold = await goldSolveForDraft(ctx, existing.id);
    return { data: draftShape(existing, gold), message: "评测草稿已存在" };
  }

  const assertionType = ASSERTION_TYPES.has(body.assertion_type) ? body.assertion_type : "manual";
  const expectedBehavior = nullableText(body.expected_behavior || body.expectedBehavior) || review.expected_behavior || "";
  const expectedAnswer = text(body.expected_answer || body.expectedAnswer);
  const state = draftState({
    question: body.question,
    expected_behavior: expectedBehavior,
    expected_answer: expectedAnswer,
    assertion_type: assertionType,
    trace_id: review.trace_id,
    run_id: review.run_id,
    gold_status: null,
  });
  const row = await ctx.queryOne(
    `INSERT INTO trace_eval_drafts
       (id, review_id, project_id, session_id, run_id, trace_id, span_id,
        source_object_id, source_object_type, question, actual_output, expected_behavior,
        expected_answer, assertion_type, status, benchmark_status, tags, failure_category,
        tuning_notes, replay_requirements_json, trace_snapshot_json, created_by, updated_by,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$2,'trace_review',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20,now(),now())
     RETURNING *`,
    [
      randomUUID(),
      reviewId,
      pid,
      review.session_id,
      review.run_id,
      review.trace_id,
      review.span_id,
      text(body.question || review.question),
      text(body.actual_output || body.actualOutput || review.actual_output),
      expectedBehavior,
      expectedAnswer,
      assertionType,
      state.status,
      state.benchmark_status,
      json(normalizeTags(body.tags)),
      nullableText(body.failure_category || body.failureCategory || review.reason_code),
      nullableText(body.tuning_notes || body.tuningNotes),
      json(body.replay_requirements || body.replayRequirements || {}),
      json(body.trace_snapshot || body.traceSnapshot || parseJson(review.trace_snapshot_json, {})),
      ctx.userId,
    ],
  );
  return { data: draftShape(row, null), message: "评测草稿已生成" };
}
