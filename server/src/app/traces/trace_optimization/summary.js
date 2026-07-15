import { parseJson, requireProjectAccess } from "./common.js";

function latestTime(row) {
  if (!row) return 0;
  const value = row.latest_at || row.updated_at || row.created_at || row.finished_at || row.started_at;
  const time = value ? Date.parse(value) : 0;
  return Number.isFinite(time) ? time : 0;
}

function pickLatestActivity(items) {
  return items
    .filter((item) => item?.row)
    .sort((a, b) => latestTime(b.row) - latestTime(a.row))[0] || null;
}

export async function summary(ctx, input) {
  const { pid } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const reviews = await ctx.queryOne(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status IN ('needs_review','incorrect','incomplete','tool_error','routing_error','data_issue') THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status IN ('incorrect','incomplete','tool_error','routing_error','data_issue') THEN 1 ELSE 0 END) AS issues
     FROM trace_run_reviews
     WHERE project_id=$1 AND deleted_at IS NULL`,
    [pid],
  );
  const drafts = await ctx.queryOne(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS draft,
       SUM(CASE WHEN status='reviewable' THEN 1 ELSE 0 END) AS reviewable,
       SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready
     FROM trace_eval_drafts
     WHERE project_id=$1 AND deleted_at IS NULL`,
    [pid],
  );
  const gold = await ctx.queryOne(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status IS NULL OR status!='verified' THEN 1 ELSE 0 END) AS unverified
     FROM trace_gold_solves
     WHERE project_id=$1 AND deleted_at IS NULL`,
    [pid],
  );
  const benchmarkCases = await ctx.queryOne(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready,
       SUM(CASE WHEN status='invalid' THEN 1 ELSE 0 END) AS invalid
     FROM trace_benchmark_cases
     WHERE project_id=$1 AND deleted_at IS NULL`,
    [pid],
  );
  const attempts = await ctx.queryOne(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status IN ('planned','running','blocked') THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN status='passed' THEN 1 ELSE 0 END) AS passed,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
     FROM trace_optimization_attempts
     WHERE project_id=$1 AND deleted_at IS NULL`,
    [pid],
  );
  const benchmarkRuns = await ctx.queryOne(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN status='passed' THEN 1 ELSE 0 END) AS passed,
       SUM(CASE WHEN status IN ('failed','error','blocked') THEN 1 ELSE 0 END) AS failed
     FROM trace_benchmark_runs
     WHERE project_id=$1 AND deleted_at IS NULL`,
    [pid],
  );
  const latestAttempt = await ctx.queryOne(
    `SELECT a.*, d.question AS draft_question
       FROM trace_optimization_attempts a
       LEFT JOIN trace_eval_drafts d
         ON d.id=a.draft_id AND d.deleted_at IS NULL
      WHERE a.project_id=$1 AND a.deleted_at IS NULL
      ORDER BY COALESCE(a.updated_at, a.created_at) DESC
      LIMIT 1`,
    [pid],
  );
  const latestBenchmarkRun = await ctx.queryOne(
    `SELECT r.*, c.question AS case_question
       FROM trace_benchmark_runs r
       LEFT JOIN trace_benchmark_cases c
         ON c.id=r.benchmark_case_id AND c.deleted_at IS NULL
      WHERE r.project_id=$1 AND r.deleted_at IS NULL
      ORDER BY COALESCE(r.finished_at, r.updated_at, r.created_at) DESC
      LIMIT 1`,
    [pid],
  );
  const latestDraft = await ctx.queryOne(
    `SELECT *
       FROM trace_eval_drafts
      WHERE project_id=$1 AND deleted_at IS NULL
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT 1`,
    [pid],
  );
  const latestReview = await ctx.queryOne(
    `SELECT *
       FROM trace_run_reviews
      WHERE project_id=$1 AND deleted_at IS NULL
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT 1`,
    [pid],
  );
  const latest = pickLatestActivity([
    { type: "attempt", row: latestAttempt },
    { type: "benchmark_run", row: latestBenchmarkRun },
    { type: "draft", row: latestDraft },
    { type: "review", row: latestReview },
  ]);
  const latestActivity = latest ? (() => {
    const row = latest.row;
    if (latest.type === "attempt") {
      return {
        type: "attempt",
        id: row.id,
        draft_id: row.draft_id,
        benchmark_case_id: row.benchmark_case_id || null,
        status: row.status || "",
        source: row.source || "",
        title: row.draft_question || row.hypothesis || "",
        run_id: row.run_id || null,
        trace_id: row.trace_id || null,
        session_id: row.session_id || null,
        span_id: row.span_id || null,
        updated_at: row.updated_at || row.created_at || null,
      };
    }
    if (latest.type === "benchmark_run") {
      return {
        type: "benchmark_run",
        id: row.id,
        benchmark_case_id: row.benchmark_case_id,
        task_id: row.task_id || "",
        status: row.status || "",
        title: row.case_question || row.task_id || "",
        run_id: row.run_id || null,
        trace_id: row.trace_id || null,
        session_id: row.session_id || null,
        span_id: row.span_id || null,
        report_file: row.report_file || "",
        eval_run_id: row.eval_run_id || "",
        report: parseJson(row.report_json, null),
        result: parseJson(row.result_json, null),
        metrics: parseJson(row.metrics_json, {}),
        diagnosis: parseJson(row.diagnosis_json, null),
        updated_at: row.finished_at || row.updated_at || row.created_at || null,
      };
    }
    if (latest.type === "draft") {
      return {
        type: "draft",
        id: row.id,
        draft_id: row.id,
        status: row.status || "",
        title: row.question || row.run_id || "",
        run_id: row.run_id || null,
        trace_id: row.trace_id || null,
        session_id: row.session_id || null,
        span_id: row.span_id || null,
        updated_at: row.updated_at || row.created_at || null,
      };
    }
    return {
      type: "review",
      id: row.id,
      review_id: row.id,
      status: row.status || "",
      title: row.question || row.run_id || "",
      run_id: row.run_id || null,
      trace_id: row.trace_id || null,
      session_id: row.session_id || null,
      span_id: row.span_id || null,
      updated_at: row.updated_at || row.created_at || null,
    };
  })() : null;
  return {
    data: {
      reviews: {
        total: Number(reviews?.total || 0),
        pending: Number(reviews?.pending || 0),
        issues: Number(reviews?.issues || 0),
      },
      drafts: {
        total: Number(drafts?.total || 0),
        draft: Number(drafts?.draft || 0),
        reviewable: Number(drafts?.reviewable || 0),
        ready: Number(drafts?.ready || 0),
      },
      gold_solves: {
        total: Number(gold?.total || 0),
        unverified: Number(gold?.unverified || 0),
      },
      benchmark_cases: {
        total: Number(benchmarkCases?.total || 0),
        ready: Number(benchmarkCases?.ready || 0),
        invalid: Number(benchmarkCases?.invalid || 0),
      },
      attempts: {
        total: Number(attempts?.total || 0),
        open: Number(attempts?.open || 0),
        passed: Number(attempts?.passed || 0),
        failed: Number(attempts?.failed || 0),
      },
      benchmark_runs: {
        total: Number(benchmarkRuns?.total || 0),
        running: Number(benchmarkRuns?.running || 0),
        passed: Number(benchmarkRuns?.passed || 0),
        failed: Number(benchmarkRuns?.failed || 0),
      },
      latest_activity: latestActivity,
    },
  };
}
