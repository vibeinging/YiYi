import type {
  AgentTraceRun,
  TraceEvalDraft,
  TraceBenchmarkMaterializeResult,
  TraceBenchmarkOverview,
  TraceBenchmarkRunResult,
  TraceOptimizationAttempt,
  TraceOptimizationSummary,
  TraceReview
} from '@/api/yiw'
import { compact, timeText } from './TraceOptimizationSettings.shared'
import type { TraceOptimizationMetric } from './TraceOptimizationTunerShell'

export interface TraceOptimizationLoopEvent {
  key: string
  tone: string
  title: string
  detail: string
}

const asRecord = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null

const asArray = (value: unknown): Record<string, any>[] =>
  Array.isArray(value) ? value.map(asRecord).filter(Boolean) as Record<string, any>[] : []

const pickText = (obj: Record<string, any>, keys: string[]) => {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && compact(value)) return compact(value)
    if (typeof value === 'number') return String(value)
  }
  return ''
}

const pickDuration = (obj: Record<string, any>) => {
  const value = obj.durMs ?? obj.duration_ms ?? obj.durationMs ?? obj.elapsed_ms ?? obj.elapsedMs ?? obj.ms
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)}s` : `${Math.round(ms)}ms`
}

const formatTokenCount = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)

const pickNumeric = (obj: Record<string, any>, keys: string[]) => {
  const attrs = asRecord(obj.attrs) || {}
  for (const key of keys) {
    const n = Number(obj[key] ?? attrs[key] ?? 0)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

const pickTokenDetail = (obj: Record<string, any>) => {
  const input = pickNumeric(obj, ['inTok', 'trace_input_tokens', 'input_tokens', 'prompt_tokens'])
  const output = pickNumeric(obj, ['outTok', 'trace_output_tokens', 'output_tokens', 'completion_tokens'])
  const total = input + output || pickNumeric(obj, ['trace_total_tokens', 'total_tokens'])
  const cached = pickNumeric(obj, [
    'trace_cached_tokens', 'cached_tokens', 'cachedTokens', 'cacheRead', 'cache_read',
    'cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens', 'cache_input_tokens',
    'prompt_cache_hit_tokens'
  ])
  const cacheWrite = pickNumeric(obj, [
    'trace_cache_write_tokens', 'cache_write_tokens', 'cacheWriteTokens', 'cacheWrite',
    'cache_write', 'cache_write_input_tokens', 'cacheWriteInputTokens', 'cache_creation_input_tokens'
  ])
  return [
    total ? `Token ${formatTokenCount(total)}` : '',
    cached ? `Cache ${formatTokenCount(cached)}` : '',
    cacheWrite ? `Cache写 ${formatTokenCount(cacheWrite)}` : ''
  ].filter(Boolean).join(' · ')
}

const clipText = (value: string, max = 120) => value.length > max ? `${value.slice(0, max)}...` : value

const spanTone = (span: Record<string, any>) => {
  const status = String(span.status || span.state || '').toLowerCase()
  if (['error', 'failed', 'fail'].includes(status)) return 'bad'
  if (['blocked', 'warning', 'warn', 'timeout'].includes(status)) return 'warn'
  if (['ok', 'success', 'completed', 'complete', 'passed'].includes(status)) return 'good'
  if (['running', 'pending'].includes(status)) return 'running'
  return 'trace'
}

const spanTitle = (span: Record<string, any>, index: number) => {
  const kind = pickText(span, ['kind', 'type', 'category']).toUpperCase()
  const name = pickText(span, ['name', 'label', 'title', 'tool_name', 'model', 'operation']) || `Span ${index + 1}`
  return kind ? `${kind} · ${name}` : name
}

const spanDetail = (span: Record<string, any>) => {
  const parts = [
    pickDuration(span),
    pickTokenDetail(span),
    pickText(span, ['status', 'state']),
    pickText(span, ['model']),
    clipText(pickText(span, ['input', 'prompt', 'question', 'output', 'result']))
  ].filter(Boolean)
  return compact(parts.join(' · ')) || 'Trace span'
}

const collectSpans = (source: unknown, seen = new WeakSet<object>()): Record<string, any>[] => {
  const obj = asRecord(source)
  if (!obj) return []
  if (seen.has(obj)) return []
  seen.add(obj)

  const direct = [
    ...asArray(obj.spans),
    ...asArray(obj.trace?.spans),
    ...asArray(obj.trace_detail?.spans),
    ...asArray(obj.traceDetail?.spans),
    ...asArray(obj.trace_snapshot?.spans),
    ...asArray(obj.traceSnapshot?.spans)
  ]
  if (direct.length) return direct

  const nestedKeys = ['trace', 'trace_detail', 'traceDetail', 'trace_snapshot', 'traceSnapshot', 'run', 'data', 'payload']
  for (const key of nestedKeys) {
    const nested = collectSpans(obj[key], seen)
    if (nested.length) return nested
  }
  return []
}

const traceEventsFromSource = (source: unknown, prefix: string): TraceOptimizationLoopEvent[] =>
  collectSpans(source)
    .slice(0, 18)
    .map((span, index) => ({
      key: `${prefix}-${span.id || span.span_id || span.externalSpanId || index}`,
      tone: spanTone(span),
      title: spanTitle(span, index),
      detail: spanDetail(span)
    }))

export function getTraceOptimizationMetrics(summary: TraceOptimizationSummary | null): TraceOptimizationMetric[] {
  const runTotal = summary?.benchmark_runs?.total || 0
  const runPassed = summary?.benchmark_runs?.passed || 0
  const accuracy = runTotal ? `${Math.round((runPassed / runTotal) * 100)}%` : '-'

  return [
    { label: '状态', value: (summary?.benchmark_runs?.running || 0) ? '运行中' : (summary?.drafts.ready || 0) ? '可运行' : '待准备' },
    { label: '准确率', value: accuracy },
    { label: '目标', value: '-' },
    { label: '轮次', value: summary?.attempts?.total || 0 }
  ]
}

export function getTraceOptimizationLoopEvents({
  selectedReview,
  selectedDraft,
  traceRuns,
  attempts,
  benchmarkReports,
  benchmarkBatchRunning,
  benchmarkMaterializeResult,
  benchmarkRunResult,
  benchmarkRunningId
}: {
  selectedReview?: TraceReview | null
  selectedDraft?: TraceEvalDraft | null
  traceRuns?: AgentTraceRun[]
  attempts: TraceOptimizationAttempt[]
  benchmarkReports?: TraceBenchmarkOverview['reports']
  benchmarkBatchRunning: boolean
  benchmarkMaterializeResult: TraceBenchmarkMaterializeResult | null
  benchmarkRunResult: TraceBenchmarkRunResult | null
  benchmarkRunningId: string
}): TraceOptimizationLoopEvent[] {
  const events: TraceOptimizationLoopEvent[] = []
  if (benchmarkBatchRunning || benchmarkRunningId) {
    events.push({
      key: 'running',
      tone: 'running',
      title: '当前步骤',
      detail: benchmarkBatchRunning ? '正在批量运行 Ready 用例' : `正在运行 ${benchmarkRunningId}`
    })
  }
  const traceEvents = [
    ...(traceRuns || []).flatMap((run) => traceEventsFromSource(run.trace || run, `app-trace-${run.runId}`)),
    ...traceEventsFromSource(benchmarkRunResult?.run?.trace_snapshot || benchmarkRunResult?.run, 'benchmark-run-trace'),
    ...traceEventsFromSource(selectedDraft?.trace_snapshot, 'draft-trace'),
    ...traceEventsFromSource(selectedReview?.trace_snapshot, 'review-trace'),
    ...attempts.flatMap((attempt) => traceEventsFromSource(attempt.trace_snapshot || attempt.diagnosis, `attempt-trace-${attempt.id}`))
  ]
  if (traceEvents.length) {
    return [...events, ...traceEvents].slice(0, 18)
  }
  if (benchmarkRunResult?.run) {
    events.push({
      key: `run-${benchmarkRunResult.run.id}`,
      tone: benchmarkRunResult.run.status === 'passed' ? 'good' : benchmarkRunResult.run.status === 'blocked' ? 'warn' : 'bad',
      title: '最近运行',
      detail: `${benchmarkRunResult.run.task_id} · ${benchmarkRunResult.run.status}`
    })
  }
  if (benchmarkMaterializeResult) {
    events.push({
      key: `materialize-${benchmarkMaterializeResult.task_id}`,
      tone: benchmarkMaterializeResult.formalized ? 'good' : 'default',
      title: '生成评测 task',
      detail: benchmarkMaterializeResult.runnable === false
        ? `${benchmarkMaterializeResult.task_id} · 仍缺上下文`
        : benchmarkMaterializeResult.task_id
    })
  }
  for (const attempt of attempts.slice(0, 6)) {
    events.push({
      key: `attempt-${attempt.id}`,
      tone: attempt.status === 'passed' ? 'good' : attempt.status === 'failed' ? 'bad' : attempt.status === 'blocked' ? 'warn' : 'default',
      title: `调试轮次 #${attempt.attempt_index || 1}`,
      detail: compact(attempt.hypothesis || attempt.change_summary || attempt.notes) || attempt.status
    })
  }
  for (const report of (benchmarkReports || []).slice(0, 6)) {
    events.push({
      key: `report-${report.file}`,
      tone: report.status === 'passed' ? 'good' : report.status === 'failed' ? 'bad' : 'default',
      title: report.filter || report.run_id || '运行报告',
      detail: `${report.status} · 通过 ${report.passed}/${report.total} · ${timeText(report.updated_at)}`
    })
  }
  if (!events.length) {
    events.push({ key: 'idle', tone: 'default', title: '等待运行', detail: '从用例库运行 Ready 用例后，这里会显示每一步进展。' })
  }
  return events.slice(0, 18)
}
