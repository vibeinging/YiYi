import { parseJson } from "./common.js";

export function benchmarkRunShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    benchmark_case_id: row.benchmark_case_id,
    task_id: row.task_id || "",
    status: row.status || "running",
    eval_run_id: row.eval_run_id || "",
    report_file: row.report_file || "",
    report: parseJson(row.report_json, null),
    result: parseJson(row.result_json, null),
    diagnosis: parseJson(row.diagnosis_json, null),
    trace_id: row.trace_id || null,
    run_id: row.run_id || null,
    session_id: row.session_id || null,
    span_id: row.span_id || null,
    trace_snapshot: parseJson(row.trace_snapshot_json, {}),
    metrics: parseJson(row.metrics_json, {}),
    stdout: row.stdout || "",
    stderr: row.stderr || "",
    exit_code: row.exit_code == null ? null : Number(row.exit_code),
    started_at: row.started_at,
    finished_at: row.finished_at,
    version: Number(row.version || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function benchmarkRunRows(ctx, projectId, { caseId = null, limit = 30 } = {}) {
  const where = ["project_id=$1", "deleted_at IS NULL"];
  const params = [projectId];
  let idx = 2;
  if (caseId) {
    where.push(`benchmark_case_id=$${idx}`);
    params.push(caseId);
    idx += 1;
  }
  params.push(Math.max(1, Math.min(100, Number(limit || 30))));
  return ctx.query(
    `SELECT *
       FROM trace_benchmark_runs
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(finished_at, updated_at, created_at) DESC
      LIMIT $${idx}`,
    params,
  );
}
