import request from '@/utils/axios-req'

// pid 可能是 sentinel(__chat__ / folder:base64url),编码进 URL 路径段
const pe = (s: string) => encodeURIComponent(s)

export type TraceReviewStatus =
  | 'needs_review'
  | 'correct'
  | 'incorrect'
  | 'incomplete'
  | 'tool_error'
  | 'routing_error'
  | 'data_issue'

export type TraceReviewSeverity = 'low' | 'medium' | 'high' | 'blocker'
export type TraceDraftStatus = 'draft' | 'reviewable' | 'ready' | 'converted' | 'discarded'
export type TraceBenchmarkStatus = 'candidate' | 'reviewable' | 'ready' | 'converted' | 'rejected'
export type TraceGoldSolveStatus = 'missing' | 'drafted' | 'verified' | 'rejected'
export type TraceOptimizationAttemptStatus = 'planned' | 'running' | 'passed' | 'failed' | 'blocked' | 'abandoned'
export type TraceOptimizationAttemptSource = 'manual' | 'diagnosis' | 'benchmark' | 'replay' | 'regression'

export interface TraceEvalDraftPreview {
  id: string
  review_id?: string
  project_id?: string
  session_id?: string | null
  run_id?: string
  trace_id?: string | null
  span_id?: string | null
  status: TraceDraftStatus
  benchmark_status: TraceBenchmarkStatus
}

export interface TraceReview {
  id: string
  project_id: string
  session_id?: string | null
  run_id: string
  trace_id?: string | null
  span_id?: string | null
  target_type: 'run' | 'span'
  question?: string
  actual_output?: string
  trace_snapshot?: Record<string, unknown>
  status: TraceReviewStatus
  severity: TraceReviewSeverity
  reason_code?: string | null
  reason_text?: string | null
  expected_behavior?: string | null
  source?: string | null
  score_type?: string | null
  score_value?: string | null
  risk_reason?: string | null
  version?: number
  created_at?: string | null
  updated_at?: string | null
  draft?: TraceEvalDraftPreview | null
}

export interface TraceGoldSolve {
  id: string
  draft_id: string
  project_id: string
  question: string
  expected_behavior: string
  expected_answer: string
  intent_summary: string
  data_sources: string[]
  filters: Record<string, unknown>
  metric_definition: string
  reference_steps: string[]
  reference_sql: string
  intermediate_expectations: unknown[]
  final_answer_contract: string
  trace_diff_summary: string
  status: TraceGoldSolveStatus
  version?: number
  created_at?: string | null
  updated_at?: string | null
}

export interface TraceEvalDraft {
  id: string
  review_id: string
  project_id: string
  session_id?: string | null
  run_id: string
  trace_id?: string | null
  span_id?: string | null
  source_object_id?: string | null
  source_object_type?: string | null
  question: string
  actual_output: string
  expected_behavior: string
  expected_answer: string
  assertion_type: string
  status: TraceDraftStatus
  benchmark_status: TraceBenchmarkStatus
  gold_solve_status?: TraceGoldSolveStatus
  tags: string[]
  failure_category: string
  tuning_notes: string
  replay_requirements: Record<string, unknown>
  trace_snapshot: Record<string, unknown>
  gold_solve?: TraceGoldSolve | null
  version?: number
  created_at?: string | null
  updated_at?: string | null
}

export interface TraceOptimizationSummary {
  reviews: { total: number; pending: number; issues: number }
  drafts: { total: number; draft: number; reviewable: number; ready: number }
  gold_solves: { total: number; unverified: number }
  benchmark_cases?: { total: number; ready: number; invalid: number }
  benchmark_runs?: { total: number; running: number; passed: number; failed: number }
  attempts?: { total: number; open: number; passed: number; failed: number }
  latest_activity?: {
    type: 'attempt' | 'benchmark_run' | 'draft' | 'review'
    id: string
    draft_id?: string | null
    review_id?: string | null
    benchmark_case_id?: string | null
    task_id?: string
    status?: string
    source?: string
    title?: string
    run_id?: string | null
    trace_id?: string | null
    session_id?: string | null
    span_id?: string | null
    eval_run_id?: string
    report_file?: string
    report?: Record<string, unknown> | null
    result?: Record<string, unknown> | null
    metrics?: Record<string, unknown>
    diagnosis?: Record<string, unknown> | null
    updated_at?: string | null
  } | null
}

export interface TraceBenchmarkTask {
  id: string
  file: string
  group: string
  desc?: string
  filter: string
}

export interface TraceBenchmarkReport {
  file: string
  run_id: string
  status: string
  filter?: string
  started_at?: string
  updated_at?: string
  completed_tasks: number
  total_loaded_tasks: number
  pass_rate: number
  passed: number
  failed: number
  total: number
  avg_score: number
  avg_recall: number
  gold_coverage_rate: number
  perfect_rate: number
  error?: string | null
}

export type TraceBenchmarkAnswerType = 'text' | 'number' | 'boolean' | 'list' | 'table' | 'json' | 'manual'
export type TraceBenchmarkCaseStatus = 'draft' | 'reviewable' | 'ready' | 'invalid' | 'converted' | 'rejected'
export type TraceBenchmarkRunStatus = 'running' | 'passed' | 'failed' | 'error' | 'blocked'

export interface TraceBenchmarkRun {
  id: string
  project_id: string
  benchmark_case_id: string
  task_id: string
  status: TraceBenchmarkRunStatus
  eval_run_id?: string
  report_file?: string
  report?: Record<string, unknown> | null
  result?: Record<string, unknown> | null
  diagnosis?: Record<string, unknown> | null
  trace_id?: string | null
  run_id?: string | null
  session_id?: string | null
  span_id?: string | null
  trace_snapshot?: Record<string, unknown>
  metrics?: Record<string, unknown>
  stdout?: string
  stderr?: string
  exit_code?: number | null
  started_at?: string | null
  finished_at?: string | null
  updated_at?: string | null
}

export interface TraceBenchmarkCase {
  id?: string
  project_id?: string
  source_type?: string
  source_object_id?: string | null
  case_key: string
  title?: string
  question: string
  expected_behavior?: string
  answer_type: TraceBenchmarkAnswerType
  assertion_type: string
  assertion: Record<string, unknown>
  gold: unknown
  metadata: Record<string, unknown>
  tags: string[]
  gold_solve?: Record<string, unknown>
  status: TraceBenchmarkCaseStatus
  warnings: string[]
  latest_run?: Partial<TraceBenchmarkRun> | null
  source_index?: number
  version?: number
  created_at?: string | null
  updated_at?: string | null
}

export interface TraceBenchmarkNormalizeResult {
  cases: TraceBenchmarkCase[]
  warnings: string[]
  assumptions: string[]
  unparsed: string[]
  valid_count: number
  invalid_count: number
  source?: {
    type: string
    folder_path?: string
    folder_name?: string
    files?: Array<{ relative_path: string; size?: number; chars?: number }>
    total_files?: number
  } | null
  skill?: { name: string; runtime: string; handler?: string } | null
}

export interface TraceBenchmarkMaterializeResult {
  task_id: string
  title: string
  source: string
  payload: Record<string, unknown>
  warnings: string[]
  context_requirements: string[]
  runnable_notes: string[]
  command: string
  files?: { task_path: string; payload_path: string } | null
  skill?: { name: string; runtime: string; handler?: string } | null
  written: boolean
  runnable?: boolean
  formalized?: boolean
  case_status?: TraceBenchmarkCaseStatus
}

export interface TraceBenchmarkRunResult {
  run: TraceBenchmarkRun
  materialized: TraceBenchmarkMaterializeResult
}

export interface TraceOptimizationAttempt {
  id: string
  project_id: string
  draft_id: string
  benchmark_case_id?: string | null
  attempt_index: number
  source: TraceOptimizationAttemptSource
  status: TraceOptimizationAttemptStatus
  hypothesis: string
  change_summary: string
  diagnosis?: TraceFailureDiagnosis | Record<string, unknown> | null
  benchmark_result?: Record<string, unknown> | null
  trace_id?: string | null
  run_id?: string | null
  session_id?: string | null
  span_id?: string | null
  trace_snapshot?: Record<string, unknown>
  metrics?: Record<string, unknown>
  notes: string
  version?: number
  created_at?: string | null
  updated_at?: string | null
}

export interface TraceFailureDiagnosis {
  failure_stage: string
  confidence: number
  summary: string
  evidence: Array<{ source: string; observation: string }>
  evidence_path?: Array<{ span_id: string; observation: string }>
  trace_debugger?: {
    rounds?: number
    observations?: Array<{
      round?: number
      ok?: boolean
      observation?: string
      action?: {
        type?: string
        span_id?: string
        query?: string
        field?: string
        reason?: string
      }
      result?: unknown
    }>
  } | null
  trace_gaps: string[]
  recommended_actions: string[]
  next_benchmark_focus: string[]
  warnings: string[]
  skill?: { name: string; runtime: string; handler?: string } | null
  attempt?: TraceOptimizationAttempt | null
}

export interface TraceTuningProposal {
  hypothesis: string
  change_type: 'prompt_rule' | 'tool_schema' | 'operator_logic' | 'metadata' | 'benchmark_assertion' | 'trace_instrumentation' | 'manual_check'
  target: string
  proposal: string
  why: string
  risk: string
  validation_plan: string
  benchmark_focus: string[]
  manual_steps: string[]
  evidence_path: Array<{ span_id: string; observation: string }>
  warnings: string[]
  skill?: { name: string; runtime: string; handler?: string } | null
}

type TraceEvalDraftWorkflowPayload = Partial<Omit<TraceEvalDraft, 'gold_solve'>> & {
  gold_solve?: Partial<TraceGoldSolve>
}

export interface TraceBenchmarkOverview {
  eval_dir: string
  tasks_dir: string
  results_dir: string
  task_count: number
  groups: Record<string, number>
  tasks: TraceBenchmarkTask[]
  reports: TraceBenchmarkReport[]
  cases: TraceBenchmarkCase[]
  commands: Record<string, string>
}

export interface SaveTraceReviewPayload {
  session_id?: string | null
  run_id: string
  trace_id?: string | null
  span_id?: string | null
  target_type?: 'run' | 'span'
  question?: string
  actual_output?: string
  trace_snapshot?: Record<string, unknown>
  status: TraceReviewStatus
  severity?: TraceReviewSeverity
  reason_code?: string
  reason_text?: string
  expected_behavior?: string
  source?: string
}

export interface CreateTraceDraftPayload {
  review_id: string
  question?: string
  actual_output?: string
  expected_behavior?: string
  expected_answer?: string
  assertion_type?: string
  tags?: string[]
  failure_category?: string
  tuning_notes?: string
  replay_requirements?: Record<string, unknown>
  trace_snapshot?: Record<string, unknown>
}

export const getTraceOptimizationSummary = (projectId: string) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/summary`, method: 'get' })

export const getTraceBenchmarkOverview = (projectId: string, params?: { task_limit?: number; report_limit?: number; case_limit?: number }) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/benchmark`, method: 'get', params, ignoreMsg: true })

export const normalizeTraceBenchmark = (projectId: string, data: { content: string; format_hint?: string }) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/benchmark/normalize`, method: 'post', data })

export const normalizeTraceBenchmarkFolder = (projectId: string, data: { folder_path: string; format_hint?: string }) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/benchmark/normalize-folder`, method: 'post', data })

export const importTraceBenchmarkCases = (projectId: string, data: { cases: TraceBenchmarkCase[]; source_type?: string; source_object_id?: string; raw_input?: string }) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/benchmark/cases/import`, method: 'post', data })

export const materializeTraceBenchmarkCase = (projectId: string, caseId: string, data?: { write?: boolean }) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/benchmark/cases/${pe(caseId)}/materialize`, method: 'post', data: data || {} })

export const listTraceBenchmarkRuns = (projectId: string, caseId: string, params?: { limit?: number }) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/benchmark/cases/${pe(caseId)}/runs`, method: 'get', params, ignoreMsg: true })

export const runTraceBenchmarkCase = (projectId: string, caseId: string, data?: { cdp_port?: number; timeout_ms?: number; diagnose?: boolean; force?: boolean }) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/benchmark/cases/${pe(caseId)}/run`, method: 'post', data: data || {} })

export const listTraceReviews = (projectId: string, params?: { session_id?: string; status?: string; limit?: number }) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/reviews`, method: 'get', params, ignoreMsg: true })

export const saveTraceReview = (projectId: string, data: SaveTraceReviewPayload) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/reviews`, method: 'post', data })

export const createTraceDraftFromReview = (projectId: string, data: CreateTraceDraftPayload) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/drafts/from-review`, method: 'post', data })

export const listTraceEvalDrafts = (projectId: string, params?: { session_id?: string; status?: string; limit?: number }) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/drafts`, method: 'get', params, ignoreMsg: true })

export const getTraceEvalDraft = (projectId: string, draftId: string) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/drafts/${pe(draftId)}`, method: 'get', ignoreMsg: true })

export const updateTraceEvalDraft = (projectId: string, draftId: string, data: Partial<TraceEvalDraft>) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/drafts/${pe(draftId)}`, method: 'put', data })

export const listTraceOptimizationAttempts = (projectId: string, draftId: string, params?: { status?: string; limit?: number }) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/drafts/${pe(draftId)}/attempts`, method: 'get', params, ignoreMsg: true })

export const createTraceOptimizationAttempt = (projectId: string, draftId: string, data: Partial<TraceOptimizationAttempt>) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/drafts/${pe(draftId)}/attempts`, method: 'post', data })

export const updateTraceOptimizationAttempt = (projectId: string, attemptId: string, data: Partial<TraceOptimizationAttempt>) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/attempts/${pe(attemptId)}`, method: 'put', data })

export const saveTraceGoldSolve = (projectId: string, draftId: string, data: Partial<TraceGoldSolve>) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/drafts/${pe(draftId)}/gold-solve`, method: 'post', data })

export const generateTraceGoldSolve = (projectId: string, draftId: string, data: Partial<TraceEvalDraft>) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/drafts/${pe(draftId)}/gold-solve/generate`, method: 'post', data })

export const diagnoseTraceEvalDraft = (projectId: string, draftId: string, data: TraceEvalDraftWorkflowPayload & { persist_attempt?: boolean; attempt?: Partial<TraceOptimizationAttempt> }) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/drafts/${pe(draftId)}/diagnose`, method: 'post', data })

export const generateTraceTuningProposal = (projectId: string, draftId: string, data: TraceEvalDraftWorkflowPayload & { diagnosis: TraceFailureDiagnosis; recent_attempts?: TraceOptimizationAttempt[] }) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/drafts/${pe(draftId)}/tuning-proposal`, method: 'post', data })

export const updateTraceGoldSolve = (projectId: string, goldSolveId: string, data: Partial<TraceGoldSolve>) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/trace-optimization/gold-solves/${pe(goldSolveId)}`, method: 'put', data })
