import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Drawer } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  createTraceOptimizationAttempt,
  createTraceDraftFromReview,
  diagnoseTraceEvalDraft,
  generateTraceGoldSolve,
  getTraceBenchmarkOverview,
  getTraceEvalDraft,
  getTraceOptimizationSummary,
  generateTraceTuningProposal,
  importTraceBenchmarkCases,
  listTraceOptimizationAttempts,
  listTraceEvalDrafts,
  listTraceReviews,
  materializeTraceBenchmarkCase,
  normalizeTraceBenchmark,
  normalizeTraceBenchmarkFolder,
  runTraceBenchmarkCase,
  saveTraceReview,
  saveTraceGoldSolve,
  updateTraceEvalDraft,
  updateTraceOptimizationAttempt,
  type AgentTraceRun,
  type AgentTraceSpan,
  type TraceBenchmarkCase,
  type TraceBenchmarkMaterializeResult,
  type TraceBenchmarkNormalizeResult,
  type TraceBenchmarkOverview,
  type TraceBenchmarkReport,
  type TraceBenchmarkRun,
  type TraceBenchmarkRunStatus,
  type TraceBenchmarkRunResult,
  type TraceEvalDraft,
  type TraceFailureDiagnosis,
  type TraceGoldSolve,
  type TraceOptimizationAttempt,
  type TraceOptimizationAttemptStatus,
  type TraceOptimizationSummary,
  type TraceTuningProposal,
  type TraceReview
} from '@/api/yiw'
import { isDesktop, pickFolder } from '@/views/agent/folders'
import { EmptyPanel, compact, joinTags, percent, splitTags, timeText } from './TraceOptimizationSettings.shared'
import { TraceOptimizationBenchmarkWorkspace } from './TraceOptimizationBenchmarkWorkspace'
import { TraceOptimizationTunerShell, type TraceOptimizationMetric, type TraceOptimizationMode } from './TraceOptimizationTunerShell'
import { useTraceOptimizationTraceRuns } from './TraceOptimizationTraceRuns'
import { getTraceOptimizationLoopEvents, getTraceOptimizationMetrics } from './TraceOptimizationWorkbenchModel'
import { TraceOptimizationReviewPanel, TraceOptimizationRunPanel, TraceOptimizationSetupPanel } from './TraceOptimizationWorkbenchPanels'
import shellStyles from './TraceOptimizationTunerShell.module.scss'

type TraceOptimizationBuildSource = 'sessions' | 'drafts' | 'import'
type TraceOptimizationHistoryKind = 'draft' | 'review' | 'run'

interface TraceOptimizationSettingsProps {
  projectId?: string
}

interface TraceOptimizationHistoryItem {
  key: string
  kind: TraceOptimizationHistoryKind
  title: string
  subtitle: string
  meta: string
  status: string
  updatedAt?: string | null
  draftId?: string
  reviewId?: string
  report?: TraceBenchmarkReport
}

const HISTORY_KIND_LABEL: Record<TraceOptimizationHistoryKind, string> = {
  draft: '样本优化',
  review: '会话复盘',
  run: '回归运行'
}

const historyTimeValue = (value?: string | null) => {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

const historyStatusColor = (item: TraceOptimizationHistoryItem) => {
  if (['ready', 'converted', 'correct', 'passed', 'verified'].includes(item.status)) return 'teal'
  if (['failed', 'error', 'incorrect', 'tool_error', 'routing_error', 'blocked'].includes(item.status)) return 'red'
  if (['reviewable', 'needs_review', 'draft', 'candidate', 'missing'].includes(item.status)) return 'yellow'
  return 'gray'
}

const normalizeBenchmarkReportStatus = (report: TraceBenchmarkReport): TraceBenchmarkRunStatus => {
  const status = String(report.status || '').toLowerCase()
  if (['running', 'passed', 'failed', 'error', 'blocked'].includes(status)) return status as TraceBenchmarkRunStatus
  if (['success', 'completed', 'complete', 'ok'].includes(status)) return report.failed > 0 ? 'failed' : 'passed'
  return report.failed > 0 ? 'failed' : 'passed'
}

function TraceOptimizationHistoryDrawer({
  opened,
  items,
  onClose,
  onOpenItem
}: {
  opened: boolean
  items: TraceOptimizationHistoryItem[]
  onClose: () => void
  onOpenItem: (item: TraceOptimizationHistoryItem) => void
}) {
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      withinPortal={false}
      position="right"
      size={460}
      title="历史优化"
      classNames={{
        content: shellStyles.historyDrawer,
        header: shellStyles.historyDrawerHeader,
        body: shellStyles.historyDrawerBody,
        title: shellStyles.historyDrawerTitle
      }}
    >
      <div className={shellStyles.historyDrawerIntro}>查看最近的样本、复盘和回归运行，点击后回到对应位置。</div>
      {items.length ? (
        <div className={shellStyles.historyScroll}>
          <div className={shellStyles.historyList}>
            {items.map((item) => (
              <button key={item.key} type="button" className={shellStyles.historyItem} onClick={() => onOpenItem(item)}>
                <div className={shellStyles.historyItemTop}>
                  <Badge size="xs" variant="light" color={item.kind === 'run' ? 'blue' : item.kind === 'review' ? 'yiw' : 'teal'}>
                    {HISTORY_KIND_LABEL[item.kind]}
                  </Badge>
                  <span>{timeText(item.updatedAt) || '暂无时间'}</span>
                </div>
                <strong className={shellStyles.historyItemTitle}>{item.title}</strong>
                {item.subtitle ? <span className={shellStyles.historyItemSubtitle}>{item.subtitle}</span> : null}
                <div className={shellStyles.historyItemFooter}>
                  <Badge size="xs" variant="light" color={historyStatusColor(item)}>
                    {item.status || 'unknown'}
                  </Badge>
                  {item.meta ? <span>{item.meta}</span> : null}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={shellStyles.historyEmpty}>
          <strong>还没有历史优化</strong>
          <span>运行复盘、沉淀样本或执行回归后会出现在这里。</span>
        </div>
      )}
    </Drawer>
  )
}

const materializedPlaceholder = (taskId = ''): TraceBenchmarkMaterializeResult => ({
  task_id: taskId,
  title: taskId || '最近运行',
  source: 'latest_activity',
  payload: {},
  warnings: [],
  context_requirements: [],
  runnable_notes: [],
  command: '',
  written: false
})

const asRecord = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null

const asArray = (value: unknown): any[] => Array.isArray(value) ? value : []

const firstString = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

const firstNumber = (...values: unknown[]) => {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return 0
}

const readSpans = (source: unknown): any[] => {
  const obj = asRecord(source)
  if (!obj) return []
  const nestedTrace = asRecord(obj.trace)
  const nestedDetail = asRecord(obj.trace_detail || obj.traceDetail)
  const nestedSnapshot = asRecord(obj.trace_snapshot || obj.traceSnapshot)
  return [
    asArray(obj.spans),
    asArray(nestedTrace?.spans),
    asArray(nestedDetail?.spans),
    asArray(nestedSnapshot?.spans)
  ].find((items) => items.length) || []
}

const normalizeSnapshotSpan = (value: unknown, index: number, traceId: string): AgentTraceSpan | null => {
  const span = asRecord(value)
  if (!span) return null
  const attrs = asRecord(span.attrs || span.attributes || span.metadata) || {}
  const id = firstString(span.id, span.span_id, span.externalSpanId, span.external_span_id, `snapshot-span-${index + 1}`)
  const parentId = firstString(span.parentId, span.parent_id, span.parent_span_id)
  const externalSpanId = firstString(span.externalSpanId, span.external_span_id, span.span_id)
  const externalParentSpanId = firstString(span.externalParentSpanId, span.external_parent_span_id, span.parent_span_id)
  const input = span.input ?? span.trace_input ?? span.inputs ?? attrs.trace_input ?? attrs.input
  const output = span.output ?? span.trace_output ?? span.outputs ?? span.result ?? attrs.trace_output ?? attrs.output

  return {
    id,
    parentId: parentId || null,
    externalTraceId: firstString(span.externalTraceId, span.external_trace_id, traceId) || null,
    externalSpanId: externalSpanId || id,
    externalParentSpanId: externalParentSpanId || parentId || null,
    externalSessionId: firstString(span.externalSessionId, span.external_session_id) || null,
    kind: firstString(span.kind, span.type, span.category) || 'span',
    name: firstString(span.name, span.label, span.title, span.tool_name, span.model, `Span ${index + 1}`),
    status: firstString(span.status, span.state) || 'completed',
    depth: firstNumber(span.depth, span.level, index ? 1 : 0),
    order: firstNumber(span.order, span.index, index),
    startMs: firstNumber(span.startMs, span.start_ms, span.relative_start_ms, span.offset_ms),
    durMs: firstNumber(span.durMs, span.duration_ms, span.durationMs, span.elapsed_ms, span.ms),
    cost: firstNumber(span.cost, attrs.cost),
    inTok: firstNumber(span.inTok, span.input_tokens, span.prompt_tokens, attrs.trace_input_tokens, attrs.input_tokens),
    outTok: firstNumber(span.outTok, span.output_tokens, span.completion_tokens, attrs.trace_output_tokens, attrs.output_tokens),
    model: firstString(span.model, span.model_id, attrs.model, attrs.model_id) || null,
    input: input as any,
    output: output as any,
    logs: asArray(span.logs || span.events),
    attrs
  }
}

const snapshotSpans = (source: unknown): AgentTraceSpan[] => {
  const obj = asRecord(source)
  if (!obj) return []
  const traceObj = asRecord(obj.trace) || asRecord(obj.trace_detail || obj.traceDetail) || obj
  const traceId = firstString(traceObj.traceId, traceObj.trace_id, obj.traceId, obj.trace_id, 'trace-snapshot')
  return readSpans(source)
    .map((span, index) => normalizeSnapshotSpan(span, index, traceId))
    .filter(Boolean) as AgentTraceSpan[]
}

const snapshotTraceRun = ({
  source,
  runId,
  sessionId,
  projectId,
  question,
  status,
  createdAt,
  updatedAt
}: {
  source: unknown
  runId?: unknown
  sessionId?: unknown
  projectId?: string
  question?: unknown
  status?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}): AgentTraceRun | null => {
  const obj = asRecord(source)
  const spans = snapshotSpans(source)
  if (!obj || !spans.length) return null
  const traceObj = asRecord(obj.trace) || asRecord(obj.trace_detail || obj.traceDetail) || obj
  const root = spans.find((span) => Number(span.depth || 0) === 0) || spans[0]
  const traceId = firstString(traceObj.traceId, traceObj.trace_id, obj.traceId, obj.trace_id, root.externalTraceId, runId, 'trace-snapshot')
  const runStatus = firstString(status, traceObj.status, root.status, 'completed')
  const questionText = firstString(question, root.input, traceObj.question, obj.question)

  return {
    runId: firstString(runId, obj.runId, obj.run_id, traceId),
    sessionId: firstString(sessionId, obj.sessionId, obj.session_id),
    projectId,
    status: runStatus,
    createdAt: firstString(createdAt, obj.createdAt, obj.created_at) || null,
    updatedAt: firstString(updatedAt, obj.updatedAt, obj.updated_at) || null,
    question: questionText ? {
      questionNo: firstNumber(traceObj.questionNo, traceObj.question_no, 1) || 1,
      questionText
    } : null,
    trace: {
      traceId,
      externalTraceId: firstString(traceObj.externalTraceId, traceObj.external_trace_id, traceId) || null,
      name: firstString(traceObj.name, root.name, 'Trace snapshot'),
      status: runStatus,
      durMs: firstNumber(traceObj.durMs, traceObj.duration_ms, traceObj.durationMs, root.durMs),
      cost: firstNumber(traceObj.cost),
      spanCount: firstNumber(traceObj.spanCount, traceObj.span_count, spans.length) || spans.length,
      spans
    }
  }
}

export default function TraceOptimizationSettings({
  projectId
}: TraceOptimizationSettingsProps) {
  const restoredProjectRef = useRef('')
  const [mode, setMode] = useState<TraceOptimizationMode>('setup')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [buildSource, setBuildSource] = useState<TraceOptimizationBuildSource>('drafts')
  const [summary, setSummary] = useState<TraceOptimizationSummary | null>(null)
  const [benchmark, setBenchmark] = useState<TraceBenchmarkOverview | null>(null)
  const [reviews, setReviews] = useState<TraceReview[]>([])
  const [drafts, setDrafts] = useState<TraceEvalDraft[]>([])
  const [selectedReviewId, setSelectedReviewId] = useState('')
  const [selectedDraftId, setSelectedDraftId] = useState('')
  const [draftDetail, setDraftDetail] = useState<TraceEvalDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [goldGenerating, setGoldGenerating] = useState(false)
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnosis, setDiagnosis] = useState<TraceFailureDiagnosis | null>(null)
  const [proposalGenerating, setProposalGenerating] = useState(false)
  const [tuningProposal, setTuningProposal] = useState<TraceTuningProposal | null>(null)
  const [attempts, setAttempts] = useState<TraceOptimizationAttempt[]>([])
  const [attemptSaving, setAttemptSaving] = useState(false)
  const [benchmarkInput, setBenchmarkInput] = useState('')
  const [benchmarkFormat, setBenchmarkFormat] = useState('auto')
  const [benchmarkNormalizeResult, setBenchmarkNormalizeResult] = useState<TraceBenchmarkNormalizeResult | null>(null)
  const [benchmarkNormalizing, setBenchmarkNormalizing] = useState(false)
  const [benchmarkFolderPath, setBenchmarkFolderPath] = useState('')
  const [benchmarkFolderNormalizing, setBenchmarkFolderNormalizing] = useState(false)
  const [benchmarkImporting, setBenchmarkImporting] = useState(false)
  const [benchmarkMaterializingId, setBenchmarkMaterializingId] = useState('')
  const [benchmarkMaterializeResult, setBenchmarkMaterializeResult] = useState<TraceBenchmarkMaterializeResult | null>(null)
  const [benchmarkRunningId, setBenchmarkRunningId] = useState('')
  const [benchmarkBatchRunning, setBenchmarkBatchRunning] = useState(false)
  const [benchmarkRunResult, setBenchmarkRunResult] = useState<TraceBenchmarkRunResult | null>(null)
  const [operatorNote, setOperatorNote] = useState('')
  const [operatorApplyMode, setOperatorApplyMode] = useState<'append_context' | 'pause_and_apply'>('append_context')
  const [operatorSaving, setOperatorSaving] = useState(false)
  const [expectedBehavior, setExpectedBehavior] = useState('')
  const [draftQuestion, setDraftQuestion] = useState('')
  const [expectedAnswer, setExpectedAnswer] = useState('')
  const [assertionType, setAssertionType] = useState('manual')
  const [tagsText, setTagsText] = useState('')
  const [failureCategory, setFailureCategory] = useState('')
  const [tuningNotes, setTuningNotes] = useState('')

  const [goldIntent, setGoldIntent] = useState('')
  const [goldSources, setGoldSources] = useState('')
  const [goldMetric, setGoldMetric] = useState('')
  const [goldSteps, setGoldSteps] = useState('')
  const [goldSql, setGoldSql] = useState('')
  const [goldFinal, setGoldFinal] = useState('')
  const [goldDiff, setGoldDiff] = useState('')
  const [attemptStatus, setAttemptStatus] = useState<TraceOptimizationAttemptStatus>('planned')
  const [attemptHypothesis, setAttemptHypothesis] = useState('')
  const [attemptChangeSummary, setAttemptChangeSummary] = useState('')
  const [attemptNotes, setAttemptNotes] = useState('')

  // 项目切换时清空「已恢复过最新动态」标记，让 load() 重新选择聚焦的样本/运行。
  useEffect(() => {
    restoredProjectRef.current = ''
  }, [projectId])

  const selectedReview = useMemo(
    () => reviews.find((item) => item.id === selectedReviewId) || reviews[0] || null,
    [reviews, selectedReviewId]
  )

  const selectedDraft = useMemo(
    () => drafts.find((item) => item.id === selectedDraftId) || drafts[0] || null,
    [drafts, selectedDraftId]
  )
  const traceSessionId = mode === 'run'
    ? benchmarkRunResult?.run?.session_id || (draftDetail || selectedDraft)?.session_id || selectedReview?.session_id || ''
    : buildSource === 'sessions' ? selectedReview?.session_id : (draftDetail || selectedDraft)?.session_id || selectedReview?.session_id || ''
  const traceRuns = useTraceOptimizationTraceRuns(projectId, traceSessionId)

  const benchmarkCandidates = useMemo(
    () => drafts.filter((draft) => ['reviewable', 'ready'].includes(draft.status) || ['reviewable', 'ready'].includes(draft.benchmark_status)),
    [drafts]
  )

  const importableBenchmarkCases = useMemo(
    () => (benchmarkNormalizeResult?.cases || []).filter((item) => item.status !== 'invalid' && compact(item.question)),
    [benchmarkNormalizeResult]
  )

  const benchmarkStats = useMemo<Array<[string, number]>>(
    () => [
      ['待确认', benchmarkCandidates.length],
      ['可运行', summary?.drafts.ready || 0],
      ['已导入', summary?.benchmark_cases?.total || benchmark?.cases?.length || 0],
      ['运行', summary?.benchmark_runs?.total || 0],
      ['报告', benchmark?.reports.length || 0]
    ],
    [benchmarkCandidates.length, benchmark?.cases?.length, benchmark?.reports.length, summary]
  )

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const [summaryRes, benchmarkRes, reviewRes, draftRes]: any[] = await Promise.all([
        getTraceOptimizationSummary(projectId),
        getTraceBenchmarkOverview(projectId, { task_limit: 240, report_limit: 120, case_limit: 300 }),
        listTraceReviews(projectId, { limit: 120 }),
        listTraceEvalDrafts(projectId, { limit: 120 })
      ])
      const nextSummary = summaryRes?.data || summaryRes || null
      const nextBenchmark = benchmarkRes?.data || benchmarkRes || null
      const nextReviews = (reviewRes?.data || reviewRes || []) as TraceReview[]
      const nextDrafts = (draftRes?.data || draftRes || []) as TraceEvalDraft[]
      setSummary(nextSummary)
      setBenchmark(nextBenchmark)
      setReviews(nextReviews)
      setDrafts(nextDrafts)
      const shouldRestoreLatest = restoredProjectRef.current !== projectId
      const latest = shouldRestoreLatest ? nextSummary?.latest_activity : null
      let restoredMode: TraceOptimizationMode | '' = ''
      let restoredBuildSource: TraceOptimizationBuildSource | '' = ''
      let restoredReviewId = ''
      let restoredDraftId = ''
      let restoredRunResult: TraceBenchmarkRunResult | null = null

      if (latest?.type === 'attempt' || latest?.type === 'draft') {
        const draftId = latest.draft_id || latest.id
        if (draftId && nextDrafts.some((item) => item.id === draftId)) {
          restoredMode = 'setup'
          restoredBuildSource = 'drafts'
          restoredDraftId = draftId
        }
      } else if (latest?.type === 'benchmark_run') {
        restoredMode = 'run'
        const run = {
          id: latest.id,
          project_id: projectId,
          benchmark_case_id: latest.benchmark_case_id || '',
          task_id: latest.task_id || '',
          status: latest.status || 'running',
          eval_run_id: latest.eval_run_id || '',
          report_file: latest.report_file || '',
          report: latest.report || null,
          result: latest.result || null,
          diagnosis: latest.diagnosis || null,
          trace_id: latest.trace_id || null,
          run_id: latest.run_id || null,
          session_id: latest.session_id || null,
          span_id: latest.span_id || null,
          metrics: latest.metrics || {},
          started_at: null,
          finished_at: latest.updated_at || null,
          updated_at: latest.updated_at || null
        } as TraceBenchmarkRun
        restoredRunResult = { run, materialized: materializedPlaceholder(latest.task_id || '') }
      } else if (latest?.type === 'review') {
        const reviewId = latest.review_id || latest.id
        if (reviewId && nextReviews.some((item) => item.id === reviewId)) {
          restoredMode = 'setup'
          restoredBuildSource = 'sessions'
          restoredReviewId = reviewId
        }
      }

      setSelectedReviewId((current) => restoredReviewId || (nextReviews.some((item) => item.id === current) ? current : nextReviews[0]?.id || ''))
      setSelectedDraftId((current) => restoredDraftId || (nextDrafts.some((item) => item.id === current) ? current : nextDrafts[0]?.id || ''))
      if (restoredMode) setMode(restoredMode)
      if (restoredBuildSource) setBuildSource(restoredBuildSource)
      if (restoredRunResult) setBenchmarkRunResult(restoredRunResult)
      else if (shouldRestoreLatest) setBenchmarkRunResult(null)
      if (shouldRestoreLatest) restoredProjectRef.current = projectId
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const loadDraftDetail = useCallback(async (draftId: string) => {
    if (!projectId || !draftId) {
      setDraftDetail(null)
      setAttempts([])
      return
    }
    const [res, attemptRes]: any[] = await Promise.all([
      getTraceEvalDraft(projectId, draftId),
      listTraceOptimizationAttempts(projectId, draftId, { limit: 30 })
    ])
    const draft = (res?.data || res) as TraceEvalDraft
    setDraftDetail(draft)
    setAttempts((attemptRes?.data || attemptRes || []) as TraceOptimizationAttempt[])
    setDiagnosis(null)
    setTuningProposal(null)
    setAttemptStatus('planned')
    setAttemptHypothesis('')
    setAttemptChangeSummary('')
    setAttemptNotes('')
    setDraftQuestion(draft.question || '')
    setExpectedBehavior(draft.expected_behavior || '')
    setExpectedAnswer(draft.expected_answer || '')
    setAssertionType(draft.assertion_type || 'manual')
    setTagsText(joinTags(draft.tags))
    setFailureCategory(draft.failure_category || '')
    setTuningNotes(draft.tuning_notes || '')
    const gold = draft.gold_solve
    setGoldIntent(gold?.intent_summary || '')
    setGoldSources(joinTags(gold?.data_sources || []))
    setGoldMetric(gold?.metric_definition || '')
    setGoldSteps((gold?.reference_steps || []).join('\n'))
    setGoldSql(gold?.reference_sql || '')
    setGoldFinal(gold?.final_answer_contract || '')
    setGoldDiff(gold?.trace_diff_summary || '')
  }, [projectId])

  const refreshAttempts = useCallback(async (draftId: string) => {
    if (!projectId || !draftId) return
    const res: any = await listTraceOptimizationAttempts(projectId, draftId, { limit: 30 })
    setAttempts((res?.data || res || []) as TraceOptimizationAttempt[])
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (mode === 'setup' && buildSource === 'drafts' && selectedDraft?.id) {
      void loadDraftDetail(selectedDraft.id)
    }
  }, [mode, buildSource, selectedDraft?.id, loadDraftDetail])

  const createDraft = async (review: TraceReview) => {
    if (!projectId) return
    setSaving(true)
    try {
      const res: any = await createTraceDraftFromReview(projectId, {
        review_id: review.id,
        question: review.question || '',
        actual_output: review.actual_output || '',
        expected_behavior: review.expected_behavior || '',
        assertion_type: 'manual',
        failure_category: review.reason_code || review.status,
        trace_snapshot: review.trace_snapshot || {}
      })
      const draft = (res?.data || res) as TraceEvalDraft
      notifications.show({ color: 'teal', message: '用例草稿已生成' })
      setMode('setup')
      setBuildSource('drafts')
      setSelectedDraftId(draft.id)
      await load()
      await loadDraftDetail(draft.id)
    } finally {
      setSaving(false)
    }
  }

  const createManualDraft = async ({
    question,
    expectedAnswer,
    assertionType,
    tuningNotes
  }: {
    question: string
    expectedAnswer: string
    assertionType: string
    tuningNotes: string
  }) => {
    if (!projectId) return
    if (!compact(question)) {
      notifications.show({ color: 'yellow', message: '请先填写自然语言问题' })
      return
    }
    setSaving(true)
    try {
      const runId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const reviewRes: any = await saveTraceReview(projectId, {
        run_id: runId,
        target_type: 'run',
        question,
        actual_output: '',
        trace_snapshot: { source: 'manual_sample' },
        status: 'needs_review',
        severity: 'medium',
        reason_code: 'manual_sample',
        reason_text: '手工添加的问题样本',
        expected_behavior: '',
        source: 'manual_sample'
      })
      const review = (reviewRes?.data || reviewRes) as TraceReview
      const draftRes: any = await createTraceDraftFromReview(projectId, {
        review_id: review.id,
        question,
        actual_output: '',
        expected_behavior: '',
        expected_answer: expectedAnswer,
        assertion_type: assertionType || 'text_contains',
        failure_category: 'manual_sample',
        tuning_notes: tuningNotes,
        replay_requirements: { source: 'manual_sample' },
        trace_snapshot: { source: 'manual_sample' }
      })
      const draft = (draftRes?.data || draftRes) as TraceEvalDraft
      notifications.show({ color: 'teal', message: '样本已保存' })
      setMode('setup')
      setBuildSource('drafts')
      setSelectedDraftId(draft.id)
      await load()
      await loadDraftDetail(draft.id)
    } finally {
      setSaving(false)
    }
  }

  const saveDraft = async () => {
    if (!projectId || !draftDetail) return
    setSaving(true)
    try {
      const res: any = await updateTraceEvalDraft(projectId, draftDetail.id, {
        question: draftQuestion || draftDetail.question,
        expected_behavior: expectedBehavior,
        expected_answer: expectedAnswer,
        assertion_type: assertionType,
        tags: splitTags(tagsText),
        failure_category: failureCategory,
        tuning_notes: tuningNotes,
        replay_requirements: draftDetail.replay_requirements
      } as any)
      const draft = (res?.data || res) as TraceEvalDraft
      notifications.show({ color: 'teal', message: '用例已保存' })
      await load()
      await loadDraftDetail(draft.id)
    } finally {
      setSaving(false)
    }
  }

  const generateGold = async () => {
    if (!projectId || !draftDetail) return
    if (!compact(expectedBehavior) && !compact(expectedAnswer)) {
      notifications.show({ color: 'yellow', message: '请先填写 Expected，再生成参考解' })
      return
    }
    setGoldGenerating(true)
    try {
      await updateTraceEvalDraft(projectId, draftDetail.id, {
        expected_behavior: expectedBehavior,
        expected_answer: expectedAnswer,
        assertion_type: assertionType,
        tags: splitTags(tagsText),
        failure_category: failureCategory,
        tuning_notes: tuningNotes,
        replay_requirements: draftDetail.replay_requirements
      } as any)
      const res: any = await generateTraceGoldSolve(projectId, draftDetail.id, {
        question: draftDetail.question,
        expected_behavior: expectedBehavior,
        expected_answer: expectedAnswer,
        assertion_type: assertionType
      } as Partial<TraceEvalDraft>)
      const skillName = (res?.data || res)?.skill?.name
      notifications.show({ color: 'teal', message: skillName ? `参考解草稿已生成：${skillName}` : '参考解草稿已生成' })
      await load()
      await loadDraftDetail(draftDetail.id)
    } finally {
      setGoldGenerating(false)
    }
  }

  const diagnoseDraft = async () => {
    if (!projectId || !draftDetail) return
    if (!compact(expectedBehavior) && !compact(expectedAnswer)) {
      notifications.show({ color: 'yellow', message: '请先填写 Expected，再诊断 Trace' })
      return
    }
    setDiagnosing(true)
    try {
      const res: any = await diagnoseTraceEvalDraft(projectId, draftDetail.id, {
        question: draftDetail.question,
        expected_behavior: expectedBehavior,
        expected_answer: expectedAnswer,
        assertion_type: assertionType,
        gold_solve: {
          question: draftDetail.question,
          expected_behavior: expectedBehavior,
          expected_answer: expectedAnswer,
          intent_summary: goldIntent,
          data_sources: splitTags(goldSources),
          metric_definition: goldMetric,
          reference_steps: goldSteps.split('\n').map((item) => item.trim()).filter(Boolean),
          reference_sql: goldSql,
          final_answer_contract: goldFinal,
          trace_diff_summary: goldDiff
        }
      } as Partial<TraceEvalDraft> & { gold_solve: Partial<TraceGoldSolve> })
      const next = (res?.data || res) as TraceFailureDiagnosis
      setDiagnosis(next)
      setTuningProposal(null)
      setAttemptHypothesis((current) => current || next.summary || '')
      notifications.show({ color: 'teal', message: next.skill?.name ? `Trace 诊断已生成：${next.skill.name}` : 'Trace 诊断已生成' })
    } finally {
      setDiagnosing(false)
    }
  }

  const generateProposal = async () => {
    if (!projectId || !draftDetail) return
    if (!diagnosis) {
      notifications.show({ color: 'yellow', message: '请先生成 Trace 诊断，再生成调优方案' })
      return
    }
    setProposalGenerating(true)
    try {
      const res: any = await generateTraceTuningProposal(projectId, draftDetail.id, {
        question: draftDetail.question,
        expected_behavior: expectedBehavior,
        expected_answer: expectedAnswer,
        assertion_type: assertionType,
        gold_solve: {
          question: draftDetail.question,
          expected_behavior: expectedBehavior,
          expected_answer: expectedAnswer,
          intent_summary: goldIntent,
          data_sources: splitTags(goldSources),
          metric_definition: goldMetric,
          reference_steps: goldSteps.split('\n').map((item) => item.trim()).filter(Boolean),
          reference_sql: goldSql,
          final_answer_contract: goldFinal,
          trace_diff_summary: goldDiff
        },
        diagnosis,
        recent_attempts: attempts.slice(0, 5)
      })
      const proposal = (res?.data || res) as TraceTuningProposal
      setTuningProposal(proposal)
      setAttemptHypothesis(proposal.hypothesis || diagnosis.summary || '')
      setAttemptChangeSummary([
        proposal.change_type ? `[${proposal.change_type}] ${proposal.target || ''}`.trim() : '',
        proposal.proposal
      ].filter(Boolean).join('\n'))
      setAttemptNotes([
        proposal.why ? `原因：${proposal.why}` : '',
        proposal.risk ? `风险：${proposal.risk}` : '',
        proposal.validation_plan ? `验证：${proposal.validation_plan}` : '',
        proposal.manual_steps?.length ? `操作步骤：\n${proposal.manual_steps.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '',
        proposal.benchmark_focus?.length ? `回归重点：${proposal.benchmark_focus.join('、')}` : '',
        proposal.warnings?.length ? `注意：${proposal.warnings.join('；')}` : ''
      ].filter(Boolean).join('\n\n'))
      notifications.show({ color: 'teal', message: proposal.skill?.name ? `调优方案已生成：${proposal.skill.name}` : '调优方案已生成' })
    } finally {
      setProposalGenerating(false)
    }
  }

  const saveAttempt = async () => {
    if (!projectId || !draftDetail) return
    if (!compact(attemptHypothesis) && !compact(attemptChangeSummary) && !diagnosis) {
      notifications.show({ color: 'yellow', message: '请先填写调试假设、计划改动，或先生成 Trace 诊断' })
      return
    }
    setAttemptSaving(true)
    try {
      const res: any = await createTraceOptimizationAttempt(projectId, draftDetail.id, {
        source: diagnosis ? 'diagnosis' : 'manual',
        status: attemptStatus,
        hypothesis: attemptHypothesis || diagnosis?.summary || '',
        change_summary: attemptChangeSummary,
        notes: attemptNotes,
        diagnosis: diagnosis || undefined,
        trace_id: draftDetail.trace_id,
        run_id: draftDetail.run_id,
        session_id: draftDetail.session_id,
        span_id: draftDetail.span_id,
        trace_snapshot: draftDetail.trace_snapshot || {}
      } as Partial<TraceOptimizationAttempt>)
      const created = (res?.data || res) as TraceOptimizationAttempt
      notifications.show({ color: 'teal', message: `已记录第 ${created.attempt_index || attempts.length + 1} 轮调试` })
      setAttemptStatus('planned')
      setAttemptHypothesis('')
      setAttemptChangeSummary('')
      setAttemptNotes('')
      await Promise.all([refreshAttempts(draftDetail.id), load()])
    } finally {
      setAttemptSaving(false)
    }
  }

  const updateAttemptStatus = async (attempt: TraceOptimizationAttempt, status: TraceOptimizationAttemptStatus) => {
    if (!projectId) return
    await updateTraceOptimizationAttempt(projectId, attempt.id, { status } as Partial<TraceOptimizationAttempt>)
    await Promise.all([refreshAttempts(attempt.draft_id), load()])
  }

  const saveGold = async (status: 'drafted' | 'verified' | 'rejected') => {
    if (!projectId || !draftDetail) return
    setSaving(true)
    try {
      await saveTraceGoldSolve(projectId, draftDetail.id, {
        question: draftDetail.question,
        expected_behavior: expectedBehavior,
        expected_answer: expectedAnswer,
        intent_summary: goldIntent,
        data_sources: splitTags(goldSources),
        metric_definition: goldMetric,
        reference_steps: goldSteps.split('\n').map((item) => item.trim()).filter(Boolean),
        reference_sql: goldSql,
        final_answer_contract: goldFinal,
        trace_diff_summary: goldDiff,
        status
      } as Partial<TraceGoldSolve>)
      notifications.show({ color: status === 'verified' ? 'teal' : 'gray', message: status === 'verified' ? '参考解已确认' : '参考解已保存' })
      await load()
      await loadDraftDetail(draftDetail.id)
    } finally {
      setSaving(false)
    }
  }

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard?.writeText(command)
      notifications.show({ color: 'teal', message: '命令已复制' })
    } catch {
      notifications.show({ color: 'red', message: '复制失败' })
    }
  }

  const exportBenchmarkTemplate = async () => {
    try {
      const XLSX = await import('xlsx')
      const rows = [
        {
          question: '截至2024年12月31日，浙江证券股份有限公司总盈亏、业务规模、资金成本、净盈亏、增值税后收入各是多少',
          answer_type: 'table',
          expected_answer: '指标名称 | 数值（万元）',
          gold_reference: '可填写查询语句、推导过程、业务口径或容易出错的点。',
          tags: 'finance, metric'
        }
      ]
      const guide = [
        { field: 'question', required: '是', desc: '自然语言问题。' },
        { field: 'answer_type', required: '否', desc: 'text / number / list / table / empty。' },
        { field: 'expected_answer', required: '建议', desc: '标准答案或可接受答案。' },
        { field: 'gold_reference', required: '否', desc: '参考解法、SQL、口径说明。' },
        { field: 'tags', required: '否', desc: '逗号分隔标签。' }
      ]
      const workbook = XLSX.utils.book_new()
      const templateSheet = XLSX.utils.json_to_sheet(rows)
      templateSheet['!cols'] = [{ wch: 56 }, { wch: 14 }, { wch: 38 }, { wch: 60 }, { wch: 24 }]
      XLSX.utils.book_append_sheet(workbook, templateSheet, '填写模板')
      const guideSheet = XLSX.utils.json_to_sheet(guide)
      guideSheet['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 72 }]
      XLSX.utils.book_append_sheet(workbook, guideSheet, '字段说明')
      XLSX.writeFile(workbook, '测试集导入格式.xlsx')
      notifications.show({ color: 'teal', message: '测试集格式已导出' })
    } catch (error: any) {
      notifications.show({ color: 'red', message: `导出失败：${error?.message || '未知错误'}` })
    }
  }

  const normalizeBenchmarkCases = async () => {
    if (!projectId) return
    if (!compact(benchmarkInput)) {
      notifications.show({ color: 'yellow', message: '请先粘贴用例内容' })
      return
    }
    setBenchmarkNormalizing(true)
    try {
      const res: any = await normalizeTraceBenchmark(projectId, {
        content: benchmarkInput,
        format_hint: benchmarkFormat
      })
      const result = (res?.data || res) as TraceBenchmarkNormalizeResult
      setBenchmarkNormalizeResult(result)
      setBenchmarkFolderPath('')
      notifications.show({
        color: result.invalid_count ? 'yellow' : 'teal',
        message: `已清洗 ${result.cases.length} 条，${result.valid_count} 条可导入`
      })
    } finally {
      setBenchmarkNormalizing(false)
    }
  }

  const normalizeBenchmarkFolderCases = async () => {
    if (!projectId) return
    if (!isDesktop()) {
      notifications.show({ color: 'yellow', message: '当前环境不支持选择本地文件夹' })
      return
    }
    const folder = await pickFolder()
    if (!folder) return
    setBenchmarkFolderPath(folder)
    setBenchmarkFolderNormalizing(true)
    try {
      const res: any = await normalizeTraceBenchmarkFolder(projectId, {
        folder_path: folder,
        format_hint: benchmarkFormat
      })
      const result = (res?.data || res) as TraceBenchmarkNormalizeResult
      setBenchmarkNormalizeResult(result)
      setBenchmarkInput('')
      notifications.show({
        color: result.invalid_count ? 'yellow' : 'teal',
        message: `已从文件夹清洗 ${result.cases.length} 条，${result.valid_count} 条可导入`
      })
    } finally {
      setBenchmarkFolderNormalizing(false)
    }
  }

  const importNormalizedBenchmarkCases = async () => {
    if (!projectId || !importableBenchmarkCases.length) return
    setBenchmarkImporting(true)
    try {
      const res: any = await importTraceBenchmarkCases(projectId, {
        cases: importableBenchmarkCases,
        source_type: benchmarkFolderPath ? 'folder_import' : 'ai_import',
        source_object_id: benchmarkFolderPath || undefined,
        raw_input: benchmarkFolderPath ? `folder:${benchmarkFolderPath}` : benchmarkInput
      })
      const imported = Number((res?.data || res)?.imported_count || importableBenchmarkCases.length)
      notifications.show({ color: 'teal', message: `已导入 ${imported} 条用例` })
      setBenchmarkNormalizeResult(null)
      setBenchmarkInput('')
      setBenchmarkFolderPath('')
      await load()
    } finally {
      setBenchmarkImporting(false)
    }
  }

  const materializeBenchmarkCase = async (item: TraceBenchmarkCase) => {
    if (!projectId || !item.id) return
    setBenchmarkMaterializingId(item.id)
    try {
      const res: any = await materializeTraceBenchmarkCase(projectId, item.id, { write: true })
      const result = (res?.data || res) as TraceBenchmarkMaterializeResult
      setBenchmarkMaterializeResult(result)
      notifications.show({
        color: result.formalized ? 'teal' : 'yellow',
        message: result.formalized ? `已生成正式评测 ${result.task_id}` : `已生成 task 草稿 ${result.task_id}`
      })
      await load()
    } finally {
      setBenchmarkMaterializingId('')
    }
  }

  const runBenchmarkCaseNow = async (item: TraceBenchmarkCase) => {
    if (!projectId || !item.id) return
    setBenchmarkRunningId(item.id)
    try {
      const res: any = await runTraceBenchmarkCase(projectId, item.id, { diagnose: true })
      const result = (res?.data || res) as TraceBenchmarkRunResult
      setBenchmarkRunResult(result)
      const status = result.run?.status
      notifications.show({
        color: status === 'passed' ? 'teal' : status === 'blocked' ? 'yellow' : 'red',
        message: status === 'passed' ? '用例运行通过' : status === 'blocked' ? '用例缺少可运行上下文' : '用例运行完成，存在失败项'
      })
      await load()
    } finally {
      setBenchmarkRunningId('')
    }
  }

  const runReadyBenchmarkCases = async () => {
    if (!projectId || !benchmark?.cases?.length) return
    const runnableCases = benchmark.cases.filter((item) => item.id && ['ready', 'converted'].includes(item.status)).slice(0, 20)
    if (!runnableCases.length) {
      notifications.show({ color: 'yellow', message: '没有 ready/converted 的可运行用例' })
      return
    }
    setBenchmarkBatchRunning(true)
    let passed = 0
    let failed = 0
    try {
      for (const item of runnableCases) {
        try {
          const res: any = await runTraceBenchmarkCase(projectId, item.id!, { diagnose: true })
          const result = (res?.data || res) as TraceBenchmarkRunResult
          setBenchmarkRunResult(result)
          if (result.run?.status === 'passed') passed += 1
          else failed += 1
        } catch {
          failed += 1
        }
      }
      notifications.show({ color: failed ? 'yellow' : 'teal', message: `批量运行完成：通过 ${passed}，失败/阻塞 ${failed}` })
      await load()
    } finally {
      setBenchmarkBatchRunning(false)
    }
  }

  const copyNormalizedBenchmarkJson = async () => {
    if (!benchmarkNormalizeResult?.cases.length) return
    try {
      await navigator.clipboard?.writeText(JSON.stringify(benchmarkNormalizeResult.cases, null, 2))
      notifications.show({ color: 'teal', message: '规范化 JSON 已复制' })
    } catch {
      notifications.show({ color: 'red', message: '复制失败' })
    }
  }

  const saveOperatorNote = async () => {
    const note = compact(operatorNote)
    if (!note) return
    const targetDraft = draftDetail || selectedDraft
    if (!projectId || !targetDraft?.id) {
      notifications.show({ color: 'yellow', message: '先选择一条用例，再补充运行说明' })
      return
    }
    setOperatorSaving(true)
    try {
      const prefix = operatorApplyMode === 'pause_and_apply' ? '暂停处理' : '后续参考'
      const nextNotes = [
        compact(targetDraft.tuning_notes),
        `${prefix}：${note}`
      ].filter(Boolean).join('\n\n')
      await updateTraceEvalDraft(projectId, targetDraft.id, {
        tuning_notes: nextNotes,
        replay_requirements: targetDraft.replay_requirements
      } as Partial<TraceEvalDraft>)
      setOperatorNote('')
      notifications.show({ color: 'teal', message: operatorApplyMode === 'pause_and_apply' ? '已加入调优备注，切回用例详情' : '补充说明已加入本次用例' })
      await Promise.all([load(), loadDraftDetail(targetDraft.id)])
      if (operatorApplyMode === 'pause_and_apply') {
        setMode('setup')
        setBuildSource('drafts')
      }
    } finally {
      setOperatorSaving(false)
    }
  }

  const workbenchMetrics = useMemo<TraceOptimizationMetric[]>(() => getTraceOptimizationMetrics(summary), [summary])

  const traceRunsForWorkbench = useMemo<AgentTraceRun[]>(() => {
    if (traceRuns.length) return traceRuns
    const targetDraft = draftDetail || selectedDraft
    const run = benchmarkRunResult?.run
    const candidates = [
      {
        source: run?.trace_snapshot || run,
        runId: run?.run_id || run?.id,
        sessionId: run?.session_id,
        question: targetDraft?.question || selectedReview?.question,
        status: run?.status,
        createdAt: run?.started_at,
        updatedAt: run?.finished_at || run?.updated_at
      },
      {
        source: targetDraft?.trace_snapshot,
        runId: targetDraft?.run_id,
        sessionId: targetDraft?.session_id,
        question: targetDraft?.question,
        status: targetDraft?.status,
        createdAt: targetDraft?.created_at,
        updatedAt: targetDraft?.updated_at
      },
      {
        source: selectedReview?.trace_snapshot,
        runId: selectedReview?.run_id,
        sessionId: selectedReview?.session_id,
        question: selectedReview?.question,
        status: selectedReview?.status,
        createdAt: selectedReview?.created_at,
        updatedAt: selectedReview?.updated_at
      },
      ...attempts.map((attempt) => ({
        source: attempt.trace_snapshot,
        runId: attempt.run_id,
        sessionId: attempt.session_id,
        question: targetDraft?.question || selectedReview?.question,
        status: attempt.status,
        createdAt: attempt.created_at,
        updatedAt: attempt.updated_at
      }))
    ]
    for (const candidate of candidates) {
      const snapshotRun = snapshotTraceRun({ ...candidate, projectId })
      if (snapshotRun) return [snapshotRun]
    }
    return []
  }, [attempts, benchmarkRunResult?.run, draftDetail, projectId, selectedDraft, selectedReview, traceRuns])

  const runDiagnosis = useMemo<TraceFailureDiagnosis | null>(() => {
    if (diagnosis) return diagnosis
    const latestAttemptDiagnosis = [...attempts]
      .reverse()
      .map((attempt) => asRecord(attempt.diagnosis))
      .find((item) => Boolean(firstString(item?.failure_stage, item?.summary)))
    if (latestAttemptDiagnosis) return latestAttemptDiagnosis as TraceFailureDiagnosis
    const benchmarkDiagnosis = asRecord(benchmarkRunResult?.run?.diagnosis)
    if (benchmarkDiagnosis && firstString(benchmarkDiagnosis.failure_stage, benchmarkDiagnosis.summary)) {
      return benchmarkDiagnosis as TraceFailureDiagnosis
    }
    return null
  }, [attempts, benchmarkRunResult?.run?.diagnosis, diagnosis])

  const loopEvents = useMemo(() => getTraceOptimizationLoopEvents({
    selectedReview,
    selectedDraft: draftDetail || selectedDraft,
    traceRuns: traceRunsForWorkbench,
    attempts,
    benchmarkReports: benchmark?.reports,
    benchmarkBatchRunning,
    benchmarkMaterializeResult,
    benchmarkRunResult,
    benchmarkRunningId
  }), [attempts, benchmark?.reports, benchmarkBatchRunning, benchmarkMaterializeResult, benchmarkRunResult, benchmarkRunningId, draftDetail, selectedDraft, selectedReview, traceRunsForWorkbench])

  const historyItems = useMemo<TraceOptimizationHistoryItem[]>(() => {
    const draftItems: TraceOptimizationHistoryItem[] = drafts.map((draft) => ({
      key: `draft:${draft.id}`,
      kind: 'draft',
      title: compact(draft.question) || '未命名样本',
      subtitle: `参考解：${draft.gold_solve_status || 'missing'} · 断言：${draft.assertion_type || 'manual'}`,
      meta: [draft.run_id, draft.failure_category].filter(Boolean).join(' · '),
      status: draft.status || draft.benchmark_status || 'draft',
      updatedAt: draft.updated_at || draft.created_at,
      draftId: draft.id
    }))
    const reviewItems: TraceOptimizationHistoryItem[] = reviews.map((review) => ({
      key: `review:${review.id}`,
      kind: 'review',
      title: compact(review.question) || compact(review.reason_text) || '未命名复盘',
      subtitle: review.draft ? '已生成样本草稿' : '还未生成样本草稿',
      meta: [review.reason_code, review.run_id].filter(Boolean).join(' · '),
      status: review.status || 'needs_review',
      updatedAt: review.updated_at || review.created_at,
      reviewId: review.id,
      draftId: review.draft?.id
    }))
    const reportItems: TraceOptimizationHistoryItem[] = (benchmark?.reports || []).map((report, index) => ({
      key: `run:${report.file || report.run_id || index}`,
      kind: 'run',
      title: report.filter || report.run_id || report.file || '回归运行',
      subtitle: `通过 ${report.passed}/${report.total} · 准确率 ${percent(report.pass_rate)}`,
      meta: report.error || report.file || '',
      status: normalizeBenchmarkReportStatus(report),
      updatedAt: report.updated_at || report.started_at,
      report
    }))
    return [...draftItems, ...reviewItems, ...reportItems]
      .sort((a, b) => historyTimeValue(b.updatedAt) - historyTimeValue(a.updatedAt))
      .slice(0, 80)
  }, [benchmark?.reports, drafts, reviews])

  if (!projectId) {
    return <EmptyPanel title="没有项目" detail="请先选择一个项目。" />
  }

  const openDraftFromBenchmark = (draft: TraceEvalDraft) => {
    setMode('setup')
    setBuildSource('drafts')
    setSelectedDraftId(draft.id)
    void loadDraftDetail(draft.id)
  }

  const openHistoryItem = (item: TraceOptimizationHistoryItem) => {
    setHistoryOpen(false)
    if (item.draftId) {
      setMode('setup')
      setBuildSource('drafts')
      setSelectedDraftId(item.draftId)
      void loadDraftDetail(item.draftId)
      return
    }
    if (item.reviewId) {
      setMode('setup')
      setBuildSource('sessions')
      setSelectedReviewId(item.reviewId)
      return
    }
    if (item.report) {
      const taskId = item.report.filter || item.report.run_id || item.report.file || ''
      const run: TraceBenchmarkRun = {
        id: item.report.run_id || item.report.file || item.key,
        project_id: projectId,
        benchmark_case_id: '',
        task_id: taskId,
        status: normalizeBenchmarkReportStatus(item.report),
        eval_run_id: item.report.run_id || '',
        report_file: item.report.file || '',
        report: item.report as unknown as Record<string, unknown>,
        result: {
          passed: item.report.passed,
          failed: item.report.failed,
          total: item.report.total,
          pass_rate: item.report.pass_rate,
          avg_score: item.report.avg_score,
          avg_recall: item.report.avg_recall,
          gold_coverage_rate: item.report.gold_coverage_rate,
          perfect_rate: item.report.perfect_rate
        },
        diagnosis: item.report.error ? { summary: item.report.error } : null,
        metrics: {
          avg_score: item.report.avg_score,
          avg_recall: item.report.avg_recall,
          gold_coverage_rate: item.report.gold_coverage_rate,
          perfect_rate: item.report.perfect_rate
        },
        started_at: item.report.started_at || null,
        finished_at: item.report.updated_at || null,
        updated_at: item.report.updated_at || item.report.started_at || null
      }
      setMode('run')
      setBenchmarkRunResult({ run, materialized: materializedPlaceholder(taskId) })
    }
  }

  const benchmarkWorkspaceProps = {
    benchmark,
    stats: benchmarkStats,
    candidates: benchmarkCandidates,
    input: benchmarkInput,
    format: benchmarkFormat,
    normalizeResult: benchmarkNormalizeResult,
    importableCount: importableBenchmarkCases.length,
    folderPath: benchmarkFolderPath,
    normalizing: benchmarkNormalizing,
    folderNormalizing: benchmarkFolderNormalizing,
    importing: benchmarkImporting,
    materializingId: benchmarkMaterializingId,
    runningId: benchmarkRunningId,
    batchRunning: benchmarkBatchRunning,
    materializeResult: benchmarkMaterializeResult,
    runResult: benchmarkRunResult,
    onInputChange: setBenchmarkInput,
    onFormatChange: setBenchmarkFormat,
    onNormalize: normalizeBenchmarkCases,
    onNormalizeFolder: normalizeBenchmarkFolderCases,
    onCopyNormalized: copyNormalizedBenchmarkJson,
    onImport: importNormalizedBenchmarkCases,
    onRunReady: runReadyBenchmarkCases,
    onMaterialize: materializeBenchmarkCase,
    onRun: runBenchmarkCaseNow,
    onCopyCommand: copyCommand,
    onOpenDraft: openDraftFromBenchmark
  }

  const setupContent = (
    <TraceOptimizationSetupPanel
      buildSource={buildSource}
      reviews={reviews}
      drafts={drafts}
      selectedReview={selectedReview}
      selectedDraft={selectedDraft}
      draftDetail={draftDetail}
      attempts={attempts}
      diagnosis={diagnosis}
      saving={saving}
      goldGenerating={goldGenerating}
      diagnosing={diagnosing}
      proposalGenerating={proposalGenerating}
      attemptSaving={attemptSaving}
      tuningProposal={tuningProposal}
      expectedBehavior={expectedBehavior}
      expectedAnswer={expectedAnswer}
      assertionType={assertionType}
      tagsText={tagsText}
      failureCategory={failureCategory}
      tuningNotes={tuningNotes}
      goldIntent={goldIntent}
      goldSources={goldSources}
      goldMetric={goldMetric}
      goldSteps={goldSteps}
      goldSql={goldSql}
      goldFinal={goldFinal}
      goldDiff={goldDiff}
      attemptStatus={attemptStatus}
      attemptHypothesis={attemptHypothesis}
      attemptChangeSummary={attemptChangeSummary}
      attemptNotes={attemptNotes}
      benchmarkWorkspaceProps={benchmarkWorkspaceProps}
      onBuildSourceChange={setBuildSource}
      onSelectReview={setSelectedReviewId}
      onSelectDraft={(draftId) => {
        setSelectedDraftId(draftId)
        void loadDraftDetail(draftId)
      }}
      onCreateDraft={createDraft}
      onCreateManualDraft={createManualDraft}
      onOpenImport={() => setBuildSource('import')}
      onExportTemplate={exportBenchmarkTemplate}
      draftQuestion={draftQuestion}
      onDraftQuestionChange={setDraftQuestion}
      onOpenDraft={(draftId) => {
        setMode('setup')
        setBuildSource('drafts')
        setSelectedDraftId(draftId)
        void loadDraftDetail(draftId)
      }}
      onExpectedBehaviorChange={setExpectedBehavior}
      onExpectedAnswerChange={setExpectedAnswer}
      onAssertionTypeChange={setAssertionType}
      onTagsTextChange={setTagsText}
      onFailureCategoryChange={setFailureCategory}
      onTuningNotesChange={setTuningNotes}
      onGoldIntentChange={setGoldIntent}
      onGoldSourcesChange={setGoldSources}
      onGoldMetricChange={setGoldMetric}
      onGoldStepsChange={setGoldSteps}
      onGoldSqlChange={setGoldSql}
      onGoldFinalChange={setGoldFinal}
      onGoldDiffChange={setGoldDiff}
      onAttemptStatusChange={setAttemptStatus}
      onAttemptHypothesisChange={setAttemptHypothesis}
      onAttemptChangeSummaryChange={setAttemptChangeSummary}
      onAttemptNotesChange={setAttemptNotes}
      onSaveDraft={saveDraft}
      onGenerateGold={generateGold}
      onDiagnoseDraft={diagnoseDraft}
      onGenerateProposal={generateProposal}
      onSaveGold={saveGold}
      onSaveAttempt={saveAttempt}
      onUpdateAttemptStatus={updateAttemptStatus}
    />
  )

  const runContent = (
    <div className={shellStyles.runStack}>
      <TraceOptimizationRunPanel
        benchmarkBatchRunning={benchmarkBatchRunning}
        benchmarkRunningId={benchmarkRunningId}
        operatorApplyMode={operatorApplyMode}
        operatorNote={operatorNote}
        operatorSaving={operatorSaving}
        diagnosis={runDiagnosis}
        traceRuns={traceRunsForWorkbench}
        loopEvents={loopEvents}
        onRunReady={runReadyBenchmarkCases}
        onOperatorApplyModeChange={setOperatorApplyMode}
        onOperatorNoteChange={setOperatorNote}
        onSaveOperatorNote={saveOperatorNote}
      />
      <section className={`${shellStyles.workspaceSection} ${shellStyles.runBenchmarkSection}`}>
        <div className={shellStyles.sectionHead}>
          <div>
            <h3>用例库与运行历史</h3>
          </div>
          <Badge size="xs" variant="light" color="gray">
            {(benchmark?.cases || []).length} 用例 · {(benchmark?.reports || []).length} 报告
          </Badge>
        </div>
        <div className={shellStyles.runBenchmarkDock}>
          <TraceOptimizationBenchmarkWorkspace
            {...benchmarkWorkspaceProps}
            initialMode="cases"
            availableModes={['cases', 'runs']}
            showCandidates={false}
          />
        </div>
      </section>
    </div>
  )

  const reviewContent = (
    <TraceOptimizationReviewPanel
      summary={summary}
      attempts={attempts}
      drafts={drafts}
      benchmark={benchmark}
      onOpenDraft={(draftId) => {
        setSelectedDraftId(draftId)
        setMode('setup')
        setBuildSource('drafts')
        void loadDraftDetail(draftId)
      }}
    />
  )

  const statusTone = (summary?.benchmark_runs?.failed || 0) ? 'bad' : (summary?.drafts.ready || 0) ? 'good' : (summary?.reviews.pending || 0) ? 'warn' : 'default'

  return (
    <>
      <TraceOptimizationTunerShell
        loading={loading}
        mode={mode}
        onModeChange={setMode}
        onRefresh={load}
        onOpenHistory={() => setHistoryOpen(true)}
        onCreateOptimization={() => {
          setMode('setup')
          setBuildSource('import')
        }}
        statusTone={statusTone}
        metrics={workbenchMetrics}
      >
        {mode === 'run' ? runContent : mode === 'review' ? reviewContent : setupContent}
      </TraceOptimizationTunerShell>
      <TraceOptimizationHistoryDrawer
        opened={historyOpen}
        items={historyItems}
        onClose={() => setHistoryOpen(false)}
        onOpenItem={openHistoryItem}
      />
    </>
  )
}
