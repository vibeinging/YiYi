import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionIcon, Badge, Box, Button, Group, ScrollArea, Stack, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconAlertTriangle,
  IconChartBar,
  IconChevronsRight,
  IconDatabaseOff,
  IconLoader2,
  IconRefresh
} from '@tabler/icons-react'
import {
  getAgentSessionTraces,
  createTraceDraftFromReview,
  listTraceReviews,
  saveTraceReview,
  type AgentSessionTraceResponse,
  type AgentTraceRun,
  type AgentTraceSpan,
  type TraceReview
} from '@/api/yiw'
import TurnLocator, { type TurnLocatorMarker } from '@/components/TurnLocator'
import { EmptyState } from './WorkstationTraceCommon'
import {
  compareRuns,
  finalOutputText,
  jsonText,
  spanKey,
  traceSnapshotForRun,
  userQuestionText
} from './WorkstationTraceLogic'
import type { TraceReviewInlinePayload } from './WorkstationTraceReview'
import { TraceRound } from './WorkstationTraceRound'

export type ToolWhere = 'cloud' | 'local'
export type StepState = 'done' | 'running' | 'todo'
export type ArtifactKind = 'file' | 'table' | 'code' | 'image'

export interface PlanStep {
  title: string
  detail?: string
  state: StepState
}
export interface ToolCall {
  name: string
  where: ToolWhere
  status: 'ok' | 'running' | 'pending' | 'error'
  args?: string
  result?: string
}
export interface Artifact {
  name: string
  meta?: string
  kind: ArtifactKind
}
export interface SkillTrace {
  name: string
  runtime?: string | null
  status?: string | null
  reason?: string | null
}
export interface DataSource {
  name: string
  meta?: string
  ready?: boolean
}

export interface WorkstationProps {
  projectId?: string
  sessionId?: string | null
  hasStructured?: boolean
  showDataTools?: boolean
  running?: boolean
  plan?: PlanStep[]
  tools?: ToolCall[]
  skills?: SkillTrace[]
  dataSources?: DataSource[]
  artifacts?: Artifact[]
  onRefresh?: () => void
  onCollapse?: () => void
  onConnectSource?: () => void
  hideHeader?: boolean
}

function spanReviewStateKey(run: AgentTraceRun, span: AgentTraceSpan) {
  const id = spanKey(span)
  return id ? `${run.runId}:${id}` : ''
}

function spanActualOutput(run: AgentTraceRun, span: AgentTraceSpan) {
  return jsonText(span.output) || jsonText(span.input) || finalOutputText(run)
}

export default function Workstation(props: WorkstationProps) {
  const { projectId, sessionId, running = false, onRefresh, onCollapse, hideHeader = false } = props
  const runNodesRef = useRef<Record<string, HTMLDivElement | null>>({})
  const [traceData, setTraceData] = useState<AgentSessionTraceResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expandedRunIds, setExpandedRunIds] = useState<string[]>([])
  const [activeRunId, setActiveRunId] = useState('')
  const [selectedSpanIds, setSelectedSpanIds] = useState<Record<string, string>>({})
  const [traceReviews, setTraceReviews] = useState<TraceReview[]>([])
  const [reviewPanelRunId, setReviewPanelRunId] = useState('')
  const [savingReviewRunId, setSavingReviewRunId] = useState('')
  const [creatingDraftRunId, setCreatingDraftRunId] = useState('')
  const [reviewPanelSpanId, setReviewPanelSpanId] = useState('')
  const [savingReviewSpanId, setSavingReviewSpanId] = useState('')
  const [creatingDraftSpanId, setCreatingDraftSpanId] = useState('')

  const loadTrace = useCallback(async (resolveTrace = false) => {
    if (!projectId || !sessionId) {
      setTraceData(null)
      setExpandedRunIds([])
      setTraceReviews([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const res: any = await getAgentSessionTraces(projectId, sessionId, { resolveTrace })
      const next: AgentSessionTraceResponse = res?.data || res || { enabled: false, items: [] }
      setTraceData(next)
    } catch (err: any) {
      setError(err?.message || 'Trace 加载失败')
    } finally {
      setLoading(false)
    }
  }, [projectId, sessionId])

  const loadReviews = useCallback(async () => {
    if (!projectId || !sessionId) {
      setTraceReviews([])
      return
    }
    try {
      const res: any = await listTraceReviews(projectId, { session_id: sessionId, limit: 200 })
      setTraceReviews((res?.data || res || []) as TraceReview[])
    } catch {
      setTraceReviews([])
    }
  }, [projectId, sessionId])

  useEffect(() => {
    loadTrace(false)
  }, [loadTrace])

  useEffect(() => {
    loadReviews()
  }, [loadReviews])

  useEffect(() => {
    if (!running || !projectId || !sessionId) return undefined
    const id = window.setInterval(() => loadTrace(true), 4000)
    return () => window.clearInterval(id)
  }, [loadTrace, projectId, running, sessionId])

  useEffect(() => {
    const shouldResolveTrace = traceData?.traceResolveDeferred || traceData?.traceReadTimeout
    if (!shouldResolveTrace || loading || !projectId || !sessionId) return undefined
    const delay = traceData?.traceWarmupPending ? 800 : 0
    const id = window.setTimeout(() => loadTrace(true), delay)
    return () => window.clearTimeout(id)
  }, [
    loadTrace,
    loading,
    projectId,
    sessionId,
    traceData?.traceReadTimeout,
    traceData?.traceResolveDeferred,
    traceData?.traceWarmupPending
  ])

  const runs = useMemo(
    () => (traceData?.items || []).map((run, index) => ({ run, index }))
      .sort(compareRuns)
      .map((item) => item.run),
    [traceData?.items]
  )
  const reviewsByRunId = useMemo(
    () => new Map(traceReviews.filter((review) => review.target_type === 'run').map((review) => [review.run_id, review])),
    [traceReviews]
  )
  const reviewsByRunSpan = useMemo(() => {
    const byRun = new Map<string, Map<string, TraceReview>>()
    for (const review of traceReviews) {
      if (review.target_type !== 'span' || !review.span_id) continue
      if (!byRun.has(review.run_id)) byRun.set(review.run_id, new Map())
      byRun.get(review.run_id)?.set(review.span_id, review)
    }
    return byRun
  }, [traceReviews])
  const traceMarkers = useMemo<TurnLocatorMarker[]>(
    () => runs.map((run) => {
      const questionNo = Number(run.question?.questionNo || 0)
      return {
        id: run.runId,
        title: questionNo ? `第 ${questionNo} 问` : '用户问题',
        excerpt: userQuestionText(run),
        meta: '定位到 Trace'
      }
    }),
    [runs]
  )
  const runIdsKey = runs.map((run) => run.runId).join('|')
  const hasTraceDetail = runs.some((run) => Boolean(selectedSpanIds[run.runId]))

  useEffect(() => {
    setExpandedRunIds((prev) => {
      const currentIds = new Set(runs.map((run) => run.runId))
      const kept = prev.filter((id) => currentIds.has(id))
      if (kept.length) return kept
      const latest = [...runs].reverse().find((run) => run.trace)?.runId || runs[runs.length - 1]?.runId
      return latest ? [latest] : []
    })
    setActiveRunId((prev) => {
      const currentIds = new Set(runs.map((run) => run.runId))
      if (prev && currentIds.has(prev)) return prev
      return [...runs].reverse().find((run) => run.trace)?.runId || runs[runs.length - 1]?.runId || ''
    })
    setSelectedSpanIds((prev) => {
      const next: Record<string, string> = {}
      for (const run of runs) {
        const spans = run.trace?.spans || []
        if (!spans.length) continue
        const hasCurrent = Object.prototype.hasOwnProperty.call(prev, run.runId)
        const current = prev[run.runId]
        if (hasCurrent && !current) {
          next[run.runId] = ''
          continue
        }
        const currentStillExists = current && spans.some((span) => spanKey(span) === current)
        next[run.runId] = currentStillExists ? current : ''
      }
      return next
    })
  }, [runIdsKey, runs])

  const toggleRun = (runId: string) => {
    setActiveRunId(runId)
    setExpandedRunIds((prev) => (prev.includes(runId) ? prev.filter((id) => id !== runId) : [...prev, runId]))
  }

  const setRunNode = useCallback(
    (runId: string) => (node: HTMLDivElement | null) => {
      runNodesRef.current[runId] = node
    },
    []
  )

  const selectRun = useCallback((runId: string) => {
    setActiveRunId(runId)
    setExpandedRunIds((prev) => (prev.includes(runId) ? prev : [...prev, runId]))
    window.requestAnimationFrame(() => {
      runNodesRef.current[runId]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [])

  const selectSpan = (runId: string, span: AgentTraceSpan | null) => {
    const id = spanKey(span)
    setSelectedSpanIds((prev) => ({ ...prev, [runId]: id && prev[runId] !== id ? id : '' }))
  }

  const createDraftForRun = async (run: AgentTraceRun, review: TraceReview) => {
    setCreatingDraftRunId(run.runId)
    try {
      const res: any = await createTraceDraftFromReview(projectId || '', {
        review_id: review.id,
        question: userQuestionText(run),
        actual_output: finalOutputText(run),
        expected_behavior: review.expected_behavior || '',
        assertion_type: 'manual',
        tags: [run.skill || 'agent'].filter(Boolean) as string[],
        failure_category: review.reason_code || review.status,
        replay_requirements: {
          project_id: projectId,
          session_id: sessionId,
          run_id: run.runId,
          trace_id: run.trace?.traceId || run.trace?.externalTraceId || null,
          assertion_type: 'manual'
        },
        trace_snapshot: traceSnapshotForRun(run)
      })
      const draft = res?.data || res
      setTraceReviews((prev) => prev.map((item) => (item.id === review.id ? { ...item, draft } : item)))
      notifications.show({ color: 'teal', message: '评测草稿已生成' })
      await loadReviews()
    } finally {
      setCreatingDraftRunId('')
    }
  }

  const createDraftForSpan = async (run: AgentTraceRun, span: AgentTraceSpan, review: TraceReview) => {
    const stateKey = spanReviewStateKey(run, span)
    if (!stateKey) return
    setCreatingDraftSpanId(stateKey)
    try {
      const spanId = spanKey(span)
      const res: any = await createTraceDraftFromReview(projectId || '', {
        review_id: review.id,
        question: userQuestionText(run),
        actual_output: spanActualOutput(run, span),
        expected_behavior: review.expected_behavior || '',
        assertion_type: 'manual',
        tags: [run.skill || 'agent', span.kind || 'span'].filter(Boolean) as string[],
        failure_category: review.reason_code || review.status,
        replay_requirements: {
          project_id: projectId,
          session_id: sessionId,
          run_id: run.runId,
          trace_id: run.trace?.traceId || run.trace?.externalTraceId || null,
          span_id: spanId,
          assertion_type: 'manual'
        },
        trace_snapshot: {
          ...traceSnapshotForRun(run),
          focus_span_id: spanId,
          focus_span: span
        }
      })
      const draft = res?.data || res
      setTraceReviews((prev) => prev.map((item) => (item.id === review.id ? { ...item, draft } : item)))
      notifications.show({ color: 'teal', message: '步骤评测草稿已生成' })
      await loadReviews()
    } finally {
      setCreatingDraftSpanId('')
    }
  }

  const saveReviewForRun = async (
    run: AgentTraceRun,
    payload: TraceReviewInlinePayload,
    createDraft: boolean
  ) => {
    if (!projectId) return
    setSavingReviewRunId(run.runId)
    try {
      const res: any = await saveTraceReview(projectId, {
        session_id: sessionId,
        run_id: run.runId,
        trace_id: run.trace?.traceId || run.trace?.externalTraceId || run.runId,
        target_type: 'run',
        question: userQuestionText(run),
        actual_output: finalOutputText(run),
        trace_snapshot: traceSnapshotForRun(run),
        status: payload.status,
        severity: payload.severity,
        reason_code: payload.reason_code,
        reason_text: payload.reason_text,
        expected_behavior: payload.expected_behavior,
        source: 'human'
      })
      const review = (res?.data || res) as TraceReview
      setTraceReviews((prev) => {
        const next = prev.filter((item) => item.id !== review.id && !(item.run_id === review.run_id && item.target_type === 'run'))
        return [review, ...next]
      })
      notifications.show({ color: 'teal', message: '标注已保存' })
      if (createDraft) {
        await createDraftForRun(run, review)
      }
      setReviewPanelRunId('')
    } finally {
      setSavingReviewRunId('')
    }
  }

  const saveReviewForSpan = async (
    run: AgentTraceRun,
    span: AgentTraceSpan,
    payload: TraceReviewInlinePayload,
    createDraft: boolean
  ) => {
    const spanId = spanKey(span)
    const stateKey = spanReviewStateKey(run, span)
    if (!projectId || !spanId || !stateKey) return
    setSavingReviewSpanId(stateKey)
    try {
      const res: any = await saveTraceReview(projectId, {
        session_id: sessionId,
        run_id: run.runId,
        trace_id: run.trace?.traceId || run.trace?.externalTraceId || run.runId,
        span_id: spanId,
        target_type: 'span',
        question: userQuestionText(run),
        actual_output: spanActualOutput(run, span),
        trace_snapshot: {
          ...traceSnapshotForRun(run),
          focus_span_id: spanId,
          focus_span: span
        },
        status: payload.status,
        severity: payload.severity,
        reason_code: payload.reason_code,
        reason_text: payload.reason_text,
        expected_behavior: payload.expected_behavior,
        source: 'human'
      })
      const review = (res?.data || res) as TraceReview
      setTraceReviews((prev) => {
        const next = prev.filter((item) => (
          item.id !== review.id &&
          !(item.run_id === review.run_id && item.target_type === 'span' && item.span_id === review.span_id)
        ))
        return [review, ...next]
      })
      notifications.show({ color: 'teal', message: '步骤标注已保存' })
      if (createDraft) {
        await createDraftForSpan(run, span, review)
      }
      setReviewPanelSpanId('')
    } finally {
      setSavingReviewSpanId('')
    }
  }

  const handleCreateDraft = async (run: AgentTraceRun) => {
    const review = reviewsByRunId.get(run.runId)
    if (!review) {
      setReviewPanelRunId(run.runId)
      return
    }
    await createDraftForRun(run, review)
  }

  const refresh = () => {
    onRefresh?.()
    loadTrace(true)
    loadReviews()
  }

  return (
    <Stack h="100%" gap={0} style={{ minHeight: 0, minWidth: 0, width: '100%' }}>
      <Group
        justify="space-between"
        px="md"
        h={hideHeader ? 42 : 52}
        style={{ borderBottom: '1px solid var(--app-border)', flex: '0 0 auto', minWidth: 0 }}
      >
        <Group gap={8} wrap="nowrap">
          <IconChartBar size={15} stroke={1.8} color="var(--yiw-accent)" />
          <Text fw={650} size={hideHeader ? '13px' : '14px'}>
            Trace
          </Text>
          {running && (
            <Badge size="xs" variant="light" color="orange" leftSection={<IconLoader2 size={10} />}>
              运行中
            </Badge>
          )}
          {traceData?.traceReadTimeout && (
            <Badge size="xs" variant="light" color="yellow" leftSection={<IconLoader2 size={10} />}>
              恢复中
            </Badge>
          )}
        </Group>
        <Group gap={2}>
          <ActionIcon variant="subtle" color="gray" onClick={refresh} aria-label="刷新 Trace" loading={loading}>
            <IconRefresh size={16} />
          </ActionIcon>
          {!hideHeader && (
            <ActionIcon variant="subtle" color="gray" onClick={onCollapse} aria-label="折叠">
              <IconChevronsRight size={16} />
            </ActionIcon>
          )}
        </Group>
      </Group>

      {!projectId || !sessionId ? (
        <EmptyState icon={<IconChartBar size={18} />} title="选择一个对话后查看 Trace" />
      ) : error ? (
        <EmptyState icon={<IconAlertTriangle size={18} />} title={error} />
      ) : traceData && traceData.enabled === false ? (
        <EmptyState
          icon={<IconDatabaseOff size={18} />}
          title="Trace DB 未启用"
          detail={traceData.dataDir ? `数据目录: ${traceData.dataDir}` : undefined}
        />
      ) : traceData?.traceReadTimeout && runs.length === 0 ? (
        <EmptyState icon={<IconLoader2 size={18} />} title="Trace DB 正在恢复" detail="恢复完成后会自动刷新" />
      ) : loading && !traceData ? (
        <EmptyState icon={<IconLoader2 size={18} />} title="正在加载 Trace" />
      ) : runs.length === 0 ? (
        <EmptyState icon={<IconChartBar size={18} />} title={running ? 'Trace 将在本轮结束后写入' : '当前会话还没有 Trace'} />
      ) : (
        <ScrollArea style={{ flex: 1, minHeight: 0, minWidth: 0, width: '100%', background: 'var(--yiw-bg)' }} type="hover" scrollbarSize={7}>
          <Box
            p="sm"
            style={{
              boxSizing: 'border-box',
              display: 'grid',
              gridTemplateColumns: hasTraceDetail ? 'minmax(0, 1fr)' : '44px minmax(0, 1fr)',
              columnGap: hasTraceDetail ? 0 : 4,
              minWidth: 0,
              width: '100%'
            }}
          >
            {!hasTraceDetail && (
              <TurnLocator
                markers={traceMarkers}
                activeId={activeRunId}
                ariaLabel="Trace 轮次导航"
                variant="inline"
                onSelect={selectRun}
              />
            )}
            <Stack gap={10} style={{ minWidth: 0, width: '100%' }}>
              {runs.map((run) => (
                <Box key={run.runId} ref={setRunNode(run.runId)} style={{ minWidth: 0, scrollMarginTop: 10 }}>
                  <TraceRound
                    run={run}
                    expanded={expandedRunIds.includes(run.runId)}
                    onToggle={() => toggleRun(run.runId)}
                    selectedSpanId={selectedSpanIds[run.runId]}
                    onSelectSpan={(span) => selectSpan(run.runId, span)}
                    review={reviewsByRunId.get(run.runId)}
                    reviewPanelOpen={reviewPanelRunId === run.runId}
                    savingReview={savingReviewRunId === run.runId}
                    creatingDraft={creatingDraftRunId === run.runId}
                    spanReviews={reviewsByRunSpan.get(run.runId)}
                    reviewPanelSpanId={reviewPanelSpanId}
                    savingReviewSpanId={savingReviewSpanId}
                    creatingDraftSpanId={creatingDraftSpanId}
                    onOpenReview={() => {
                      setReviewPanelSpanId('')
                      setReviewPanelRunId(run.runId)
                    }}
                    onCancelReview={() => setReviewPanelRunId('')}
                    onSaveReview={(payload, createDraft) => saveReviewForRun(run, payload, createDraft)}
                    onCreateDraft={() => handleCreateDraft(run)}
                    onOpenSpanReview={(span) => {
                      setReviewPanelRunId('')
                      setReviewPanelSpanId(spanReviewStateKey(run, span))
                    }}
                    onCancelSpanReview={() => setReviewPanelSpanId('')}
                    onSaveSpanReview={(span, payload, createDraft) => saveReviewForSpan(run, span, payload, createDraft)}
                    onCreateSpanDraft={(span, review) => createDraftForSpan(run, span, review)}
                  />
                </Box>
              ))}
            </Stack>
          </Box>
        </ScrollArea>
      )}
    </Stack>
  )
}
