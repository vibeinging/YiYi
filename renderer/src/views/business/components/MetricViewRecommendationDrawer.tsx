import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Drawer,
  Progress,
  Select,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import { IconChevronDown, IconInfoCircleFilled } from '@tabler/icons-react'
import {
  applyMetricViewRecommendationReq,
  getLatestMetricViewRecommendationReq,
  getMetricViewRecommendationTaskReq,
  runMetricViewRecommendationReq,
} from '@/api/business-semantic'
import styles from './MetricViewRecommendationDrawer.module.scss'

export interface MetricViewRecommendationDrawerProps {
  modelValue?: boolean
  projectId: string
  businessId: string
  dataSources?: any[]
  // 父组件通知 Drawer: 这个候选刚刚通过 Wizard 编辑+暂存,
  // 已落库为草稿, Drawer 应该把它加入 appliedIds 显示"已存为草稿"标签
  externallyAppliedCandidateId?: string | null
  onUpdateModelValue?: (v: boolean) => void
  onEditCandidate?: (candidate: any) => void
  onApplied?: (results: any[]) => void
}

export interface MetricViewRecommendationDrawerRef {
  startAnalyze: () => void
  resetTask: () => void
}

const PHASE_PERCENT: Record<string, number> = {
  pending: 5,
  extracting: 30,
  clustering: 55,
  synthesizing: 80,
  completed: 100,
  failed: 100,
}

// 与后端 _IN_FLIGHT_STATUSES 对齐 (recommendation_service.py)
const IN_FLIGHT_STATUSES = ['pending', 'extracting', 'clustering', 'synthesizing']

const MetricViewRecommendationDrawer = forwardRef<
  MetricViewRecommendationDrawerRef,
  MetricViewRecommendationDrawerProps
>(function MetricViewRecommendationDrawer(props, ref) {
  const {
    modelValue = false,
    projectId,
    businessId,
    dataSources = [],
    externallyAppliedCandidateId = null,
    onUpdateModelValue,
    onEditCandidate,
    onApplied,
  } = props

  const { i18n } = useTranslation()

  const t = useMemo(() => {
    const isZh = String(i18n.language || '').startsWith('zh')
    return isZh
      ? {
          drawerTitle: '从历史问题智能推荐业务视图',
          sourceLabel: '数据源(可选)',
          sourcePlaceholder: '不限',
          sourceHint: '发起分析时限定 LLM 选源;结果出来后切换可过滤展示',
          filteredOut: '已被过滤',
          timeRangeLabel: '时间窗',
          daysUnit: '天',
          maxQuestionsLabel: '最大问题数',
          startAnalyze: '开始分析',
          analyzing: '分析中...',
          loadLatest: '加载上次结果',
          phasePending: '排队中,准备开始分析',
          phaseExtracting: '正在抽取问题特征(LLM 解析每条历史问题)',
          phaseClustering: '正在对相似问题聚类',
          phaseSynthesizing: '正在生成业务视图候选(LLM 综合)',
          phaseCompleted: '分析完成',
          phaseFailed: '分析失败',
          progressHint: '同步执行,预计 30~60 秒,请耐心等待 LLM 返回',
          statsScanned: '扫描问题',
          statsClusters: '问题簇',
          statsCandidates: '候选数',
          statsLLMCalls: 'LLM 调用',
          statsElapsed: '耗时',
          statusFailed: '任务失败',
          confidenceLabel: '置信度',
          intentLabel: '能力维度',
          keyChallenges: '关键挑战',
          intentReasoning: '意图推理',
          sourceTagLabel: '数据源',
          unknownSource: '未YiW据源',
          appliedTag: '已存为草稿',
          editCandidate: '编辑',
          validationErrorTitle: '需要在业务视图列表里继续完善',
          validationErrorHint:
            '该候选的部分字段(如维度的 field/列名)LLM 未能稳定输出。保存为草稿后,在业务视图列表中打开此条编辑、补全字段、再切换为启用。',
          validationErrorDetail: '查看原始错误',
          historicalLoaded: '当前展示的是 {time} 的历史推荐结果。点击"开始分析"将丢弃此结果重新跑一次。',
          noHistoricalResult: '该业务暂无历史推荐结果',
          supportingQuestions: '支撑问题',
          skippedTitle: '{n} 个簇已被现有启用视图覆盖,已跳过 LLM 生成',
          skippedQuestions: '条问题',
          skippedExpand: '展开明细',
          skippedCollapse: '收起',
          reasoning: '推荐理由',
          applyButton: '批量保存为草稿',
          applyHint: '保存为草稿后,可在业务视图列表中继续编辑、完善后启用',
          emptyAfterRun: '当前历史问题集未能抽象出可推荐的视图',
          emptyNoQuestions: '尚未发现可用历史问题,先去问几个业务问题再试',
          selectedCount: '已勾选',
          applyOk: '已成功保存 {n} 个草稿,可在业务视图列表中继续完善',
          applyPartial: '部分候选保存失败,详见列表',
        }
      : {
          drawerTitle: 'Smart Metric View Recommendations from History',
          sourceLabel: 'Source (optional)',
          sourcePlaceholder: 'Any',
          sourceHint: 'Constrains LLM during analyze; filters display after results.',
          filteredOut: 'filtered',
          timeRangeLabel: 'Time window',
          daysUnit: 'days',
          maxQuestionsLabel: 'Max questions',
          startAnalyze: 'Analyze',
          analyzing: 'Analyzing...',
          loadLatest: 'Load latest',
          phasePending: 'Queued, waiting to start',
          phaseExtracting: 'Extracting question features (LLM parsing each question)',
          phaseClustering: 'Clustering similar questions',
          phaseSynthesizing: 'Synthesizing metric view candidates (LLM)',
          phaseCompleted: 'Analysis completed',
          phaseFailed: 'Analysis failed',
          progressHint: 'Typically 30-60s while LLM is working.',
          statsScanned: 'Scanned',
          statsClusters: 'Clusters',
          statsCandidates: 'Candidates',
          statsLLMCalls: 'LLM calls',
          statsElapsed: 'Elapsed',
          statusFailed: 'Task failed',
          confidenceLabel: 'Confidence',
          intentLabel: 'Capabilities',
          keyChallenges: 'Key challenges',
          intentReasoning: 'Intent reasoning',
          sourceTagLabel: 'Source',
          unknownSource: 'Unknown source',
          appliedTag: 'Saved as draft',
          editCandidate: 'Edit',
          validationErrorTitle: 'Needs completion in the view list',
          validationErrorHint:
            'LLM did not stably emit some fields (e.g. dimension field/column). Save it as a draft, then open it in the metric view list to complete and activate.',
          validationErrorDetail: 'Show raw error',
          historicalLoaded: 'Showing historical result from {time}. Clicking "Analyze" will discard it and run again.',
          noHistoricalResult: 'No previous recommendation for this business',
          supportingQuestions: 'Supporting questions',
          skippedTitle: '{n} cluster(s) already covered by existing active views, skipped LLM',
          skippedQuestions: 'questions',
          skippedExpand: 'Show details',
          skippedCollapse: 'Hide',
          reasoning: 'Reasoning',
          applyButton: 'Save selected as drafts',
          applyHint: 'Drafts are saved into the metric view list; you can complete and activate them there',
          emptyAfterRun: 'No abstractable view candidates from current history',
          emptyNoQuestions: 'No usable history questions yet',
          selectedCount: 'Selected',
          applyOk: 'Saved {n} draft(s); complete them in the metric view list',
          applyPartial: 'Some candidates failed; check the list',
        }
  }, [i18n.language])

  // form (reactive)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [timeRangeDays, setTimeRangeDays] = useState<number>(90)
  const [maxQuestions, setMaxQuestions] = useState<number>(30)
  // include_negative_feedback 固定 false, 仅在 payload 中透传
  const includeNegativeFeedback = false

  const [running, setRunning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [task, setTask] = useState<any>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set())
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set())
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const drawerScrollRef = useRef<HTMLDivElement | null>(null)
  const [loadedFromHistory, setLoadedFromHistory] = useState(false)
  const [skippedExpanded, setSkippedExpanded] = useState(false)

  // visibleProxy.set → emit('update:modelValue', v)
  const setVisible = useCallback(
    (v: boolean) => {
      onUpdateModelValue?.(v)
    },
    [onUpdateModelValue],
  )

  const isHistoricalResult = useMemo(
    () =>
      loadedFromHistory &&
      !!task &&
      (task.status === 'completed' || task.status === 'failed'),
    [loadedFromHistory, task],
  )

  const historicalTitle = useMemo(() => {
    if (!task) return ''
    const raw = task.updated_at || task.created_at
    let timeText = raw || ''
    try {
      if (raw) timeText = new Date(raw).toLocaleString()
    } catch (e) {
      timeText = raw
    }
    return t.historicalLoaded.replace('{time}', timeText)
  }, [task, t])

  function formatValidationError(text: any) {
    if (!text) return ''
    return String(text).slice(0, 500)
  }

  const skippedClusters = useMemo<any[]>(() => {
    if (!task || !task.stats) return []
    return Array.isArray(task.stats.skipped_clusters) ? task.stats.skipped_clusters : []
  }, [task])

  function dedupedSupportingQuestions(candidate: any): any[] {
    if (!candidate || !Array.isArray(candidate.supporting_questions)) return []
    const seen = new Set<string>()
    const result: any[] = []
    for (const q of candidate.supporting_questions) {
      const key = (q?.text || '').trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      result.push(q)
    }
    return result
  }

  const progressPercent = useMemo(() => {
    if (!task) return running ? 5 : 0
    return PHASE_PERCENT[task.status] ?? 0
  }, [task, running])

  const progressPhase = useMemo(() => {
    if (!task) return running ? t.phasePending : ''
    const map: Record<string, string> = {
      pending: t.phasePending,
      extracting: t.phaseExtracting,
      clustering: t.phaseClustering,
      synthesizing: t.phaseSynthesizing,
      completed: t.phaseCompleted,
      failed: t.phaseFailed,
    }
    return map[task.status] ?? ''
  }, [task, running, t])

  const visibleCandidates = useMemo<any[]>(() => {
    if (!task || !task.candidates) return []
    return (task.candidates || []).filter((c: any) => {
      if (!c || c.merged_into) return false
      if (rejectedIds.has(c.candidate_id)) return false
      if (sourceId && String(c.source_id) !== String(sourceId)) return false
      return true
    })
  }, [task, rejectedIds, sourceId])

  const filteredOutCount = useMemo(() => {
    if (!task || !task.candidates || !sourceId) return 0
    return (task.candidates || []).filter(
      (c: any) =>
        c &&
        !c.merged_into &&
        !rejectedIds.has(c.candidate_id) &&
        String(c.source_id) !== String(sourceId),
    ).length
  }, [task, rejectedIds, sourceId])

  function getDataSourceDisplayName(ds: any) {
    if (!ds) return ''
    return ds.display_name || ds.name || ds.source_id
  }

  function sourceDisplayName(srcId: any) {
    if (!srcId) return t.unknownSource
    const hit = (dataSources || []).find((ds: any) => String(ds.source_id) === String(srcId))
    if (hit) return getDataSourceDisplayName(hit)
    return `${t.unknownSource} (${String(srcId).slice(0, 8)}...)`
  }

  function formatPercent(value: any) {
    const n = Number(value) || 0
    return `${Math.round(n * 100)}%`
  }

  function formatConflict(cf: any) {
    const sim = Number(cf.similarity || 0)
    return `${cf.name || cf.view_id}  (sim=${(sim * 100).toFixed(0)}%)`
  }

  function toggleSelect(candidateId: string) {
    setSelectedIds((prev) => {
      const idx = prev.indexOf(candidateId)
      if (idx >= 0) {
        const next = prev.slice()
        next.splice(idx, 1)
        return next
      }
      return [...prev, candidateId]
    })
  }

  function onCardClick(event: React.MouseEvent, candidateId: string) {
    if (appliedIds.has(candidateId)) return
    // 点击交互元素时不切换勾选(details/collapse 已 stopPropagation)
    const tag = ((event.target as HTMLElement).tagName || '').toLowerCase()
    if (['summary', 'a', 'button', 'input', 'code', 'details'].includes(tag)) return
    toggleSelect(candidateId)
  }

  function emitEdit(candidate: any) {
    onEditCandidate?.(JSON.parse(JSON.stringify(candidate)))
  }

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const resetTask = useCallback(() => {
    stopPolling()
    setTask(null)
    setSelectedIds([])
    setRejectedIds(new Set())
    setAppliedIds(new Set())
    setErrorMessage('')
    setLoadedFromHistory(false)
  }, [stopPolling])

  const startPolling = useCallback(
    (taskId: string) => {
      stopPolling()
      pollTimerRef.current = setInterval(async () => {
        try {
          const res = await getMetricViewRecommendationTaskReq(projectId, taskId)
          const next = res?.data
          if (!next) return
          setTask(next)
          if (next.status === 'completed' || next.status === 'failed') {
            stopPolling()
            setRunning(false)
            if (next.status === 'failed') {
              setErrorMessage(next.error_message || 'unknown error')
            }
          }
        } catch (e: any) {
          setErrorMessage(e?.message || String(e))
        }
      }, 2000)
    },
    [stopPolling, projectId, businessId],
  )

  const startAnalyze = useCallback(async () => {
    if (running) return
    resetTask()
    setRunning(true)
    try {
      const payload = {
        source_id: sourceId || null,
        time_range_days: timeRangeDays,
        max_questions: maxQuestions,
        include_negative_feedback: includeNegativeFeedback,
      }
      const res = await runMetricViewRecommendationReq(projectId, payload)
      const nextTask = res.data
      setTask(nextTask)
      const taskId = nextTask && (nextTask.task_id || nextTask.id)
      if (!taskId) {
        throw new Error('task_id missing in response')
      }
      if (nextTask.status === 'completed' || nextTask.status === 'failed') {
        setRunning(false)
        if (nextTask.status === 'failed') {
          setErrorMessage(nextTask.error_message || 'unknown error')
        }
        return
      }
      startPolling(taskId)
    } catch (e: any) {
      setRunning(false)
      const msg = e?.message || String(e)
      setErrorMessage(msg)
      notifications.show({ color: 'red', message: msg })
    }
  }, [
    running,
    resetTask,
    sourceId,
    timeRangeDays,
    maxQuestions,
    projectId,
    businessId,
    startPolling,
  ])

  async function loadLatest() {
    resetTask()
    try {
      const res = await getLatestMetricViewRecommendationReq(projectId)
      if (!res?.data) {
        notifications.show({ color: 'blue', message: t.noHistoricalResult })
        return
      }
      const nextTask = res.data
      setTask(nextTask)
      // 在途任务 (其他 tab/session 在跑): 自动恢复 polling, 禁用"开始分析"按钮
      // 否则 UI 显示进度条但永不刷新, 用户看到永远卡在 X%
      const taskId = nextTask.task_id || nextTask.id
      if (taskId && IN_FLIGHT_STATUSES.includes(nextTask.status)) {
        setRunning(true)
        startPolling(taskId)
        return
      }
      setLoadedFromHistory(true)
      if (Array.isArray(nextTask.applied_view_ids)) {
        setAppliedIds((prev) => {
          const next = new Set(prev)
          nextTask.applied_view_ids.forEach((rec: any) => {
            if (rec?.candidate_id) next.add(rec.candidate_id)
          })
          return next
        })
      }
    } catch (e: any) {
      setErrorMessage(e?.message || String(e))
    }
  }

  async function applySelections() {
    if (!task || !selectedIds.length) return
    setApplying(true)
    try {
      const selections = selectedIds.map((id) => ({ candidate_id: id }))
      const res = await applyMetricViewRecommendationReq(projectId, task.task_id || task.id,
        selections,
      )
      const results = res?.data?.results || []
      const okCount = results.filter((r: any) => r.success).length
      setAppliedIds((prev) => {
        const next = new Set(prev)
        results.forEach((r: any) => {
          if (r.success) next.add(r.candidate_id)
        })
        return next
      })
      if (okCount === results.length) {
        notifications.show({
          color: 'green',
          message: t.applyOk.replace('{n}', String(okCount)),
        })
      } else {
        notifications.show({ color: 'yellow', message: t.applyPartial })
      }
      setSelectedIds([])
      const updatedTask = res?.data?.task || task
      setTask(updatedTask)
      onApplied?.(results)
      // 全部成功时自动关闭 Drawer (有失败则保持打开让用户查看)
      if (okCount > 0 && okCount === results.length) {
        setVisible(false)
      }
    } catch (e: any) {
      const msg = e?.message || String(e)
      setErrorMessage(msg)
      notifications.show({ color: 'red', message: msg })
    } finally {
      setApplying(false)
    }
  }

  // watch(props.modelValue)
  useEffect(() => {
    if (modelValue) {
      // Drawer 打开时不 resetTask, 保留之前的 task 与候选列表 (尤其支持"编辑候选 → 返回 Drawer 继续看"链路)
      // 用户想从空白开始, 点"开始分析"或"加载上次结果"会自然触发 reset
      // 内容滚动区单独滚动条复位到顶部 (参数栏在它之上, 不参与滚动)
      queueMicrotask(() => {
        if (drawerScrollRef.current) {
          drawerScrollRef.current.scrollTop = 0
        }
      })
    } else {
      stopPolling()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelValue])

  // 接收父组件推送的"已暂存候选 id" - 加入 appliedIds 显示"已存为草稿"标签
  useEffect(() => {
    const cid = externallyAppliedCandidateId
    if (!cid) return
    setAppliedIds((prev) => {
      const next = new Set(prev)
      next.add(cid)
      return next
    })
    // 同时把它从 selectedIds 中移除 (用户已通过编辑路径处理)
    setSelectedIds((prev) => {
      const idx = prev.indexOf(cid)
      if (idx >= 0) {
        const next = prev.slice()
        next.splice(idx, 1)
        return next
      }
      return prev
    })
  }, [externallyAppliedCandidateId])

  // onBeforeUnmount
  useEffect(() => {
    return () => {
      stopPolling()
    }
  }, [stopPolling])

  useImperativeHandle(ref, () => ({ startAnalyze, resetTask }), [startAnalyze, resetTask])

  const progressStatusColor =
    task && task.status === 'failed' ? 'red' : task && task.status === 'completed' ? 'green' : 'blue'

  return (
    <Drawer
      opened={modelValue}
      onClose={() => setVisible(false)}
      title={t.drawerTitle}
      position="right"
      size="65%"
      closeOnClickOutside={false}
      keepMounted={false}
    >
      <div className={styles.recommendDrawer}>
        {/* 参数栏(不参与滚动, 始终顶部可见) */}
        <Card className={styles.paramCard} shadow="none" withBorder padding="sm">
          <div className={styles.paramForm}>
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>{t.sourceLabel}</div>
              <Select
                value={sourceId}
                onChange={(v) => setSourceId(v)}
                clearable
                placeholder={t.sourcePlaceholder}
                style={{ width: 220 }}
                data={(dataSources || []).map((ds: any) => ({
                  value: String(ds.source_id),
                  label: getDataSourceDisplayName(ds),
                }))}
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>{t.timeRangeLabel}</div>
              <Select
                value={String(timeRangeDays)}
                onChange={(v) => setTimeRangeDays(Number(v))}
                style={{ width: 120 }}
                allowDeselect={false}
                data={[30, 60, 90, 180].map((d) => ({
                  value: String(d),
                  label: `${d} ${t.daysUnit}`,
                }))}
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>{t.maxQuestionsLabel}</div>
              <Select
                value={String(maxQuestions)}
                onChange={(v) => setMaxQuestions(Number(v))}
                style={{ width: 120 }}
                allowDeselect={false}
                data={[10, 20, 30, 50].map((m) => ({ value: String(m), label: String(m) }))}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <Button loading={running} onClick={startAnalyze}>
                {running ? t.analyzing : t.startAnalyze}
              </Button>
              <Button variant="default" disabled={running} onClick={loadLatest}>
                {t.loadLatest}
              </Button>
            </div>
          </div>
          {(running || progressPhase) && (
            <div className={styles.progressBlock}>
              <Progress value={progressPercent} color={progressStatusColor} size={6} />
              <div className={styles.progressPhase}>{progressPhase}</div>
            </div>
          )}
          {errorMessage && <div className={styles.errorHint}>{errorMessage}</div>}
        </Card>

        {/* 滚动区: 统计 / 跳过簇 / 候选列表 (参数栏在它之上, 不滚动) */}
        <div ref={drawerScrollRef} className={styles.recommendScroll}>
          {/* 历史结果提示 */}
          {isHistoricalResult && (
            <Alert
              title={historicalTitle}
              color="blue"
              withCloseButton={false}
              icon={<IconInfoCircleFilled size={18} />}
              className={styles.historicalAlert}
            />
          )}

          {/* 统计 */}
          {task && task.stats && (task.status === 'completed' || task.status === 'failed') && (
            <div className={styles.statsBar}>
              <Badge variant="light" color="gray">
                {t.statsScanned}: {task.stats.questions_scanned ?? 0}
              </Badge>
              <Badge variant="light" color="gray">
                {t.statsClusters}: {task.stats.clusters ?? 0}
              </Badge>
              <Badge variant="light" color="green">
                {t.statsCandidates}: {visibleCandidates.length}
                {filteredOutCount ? (
                  <span className={styles.filteredOut}>
                    {' '}
                    (+{filteredOutCount} {t.filteredOut})
                  </span>
                ) : null}
              </Badge>
              <Badge variant="light" color="yellow">
                {t.statsLLMCalls}: {task.stats.llm_calls ?? 0}
              </Badge>
              <Badge variant="light" color="gray">
                {t.statsElapsed}: {Math.round((task.stats.elapsed_ms || 0) / 1000)}s
              </Badge>
              {task.status === 'failed' && (
                <span className={styles.statusFailed}>{t.statusFailed}</span>
              )}
            </div>
          )}

          {skippedClusters.length > 0 && (
            <div
              className={`${styles.skippedCard}${skippedExpanded ? ` ${styles.isOpen}` : ''}`}
            >
              <div
                className={styles.skippedCardHeader}
                onClick={() => setSkippedExpanded((v) => !v)}
              >
                <span className={styles.skippedCardIcon}>
                  <IconInfoCircleFilled size={16} />
                </span>
                <span className={styles.skippedCardTitle}>
                  {t.skippedTitle.replace('{n}', String(skippedClusters.length))}
                </span>
                <span className={styles.skippedCardAction}>
                  {skippedExpanded ? t.skippedCollapse : t.skippedExpand}
                  <span
                    className={`${styles.skippedCardToggle}${
                      skippedExpanded ? ` ${styles.isOpen}` : ''
                    }`}
                  >
                    <IconChevronDown size={14} />
                  </span>
                </span>
              </div>
              {skippedExpanded && (
                <ul className={styles.skippedList}>
                  {skippedClusters.map((item: any, idx: number) => (
                    <li key={idx}>
                      <span className={styles.skippedQ}>「{item.representative_text}」</span>
                      <span className={styles.skippedArrow}>→</span>
                      <span className={styles.skippedView}>{item.covered_by_name}</span>
                      <span className={styles.skippedMeta}>
                        (sim={Math.round((item.similarity || 0) * 100)}%, {item.member_count}{' '}
                        {t.skippedQuestions})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 候选列表 */}
          {visibleCandidates.length > 0 ? (
            <div className={styles.candidateList}>
              {visibleCandidates.map((candidate: any) => {
                const isSelected = selectedIds.includes(candidate.candidate_id)
                const isApplied = appliedIds.has(candidate.candidate_id)
                const isClickable = !isApplied
                const cardCls = [
                  styles.candidateCard,
                  isSelected ? styles.isSelected : '',
                  isApplied ? styles.isApplied : '',
                  isClickable ? styles.isClickable : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                const supporting = dedupedSupportingQuestions(candidate)
                return (
                  <Card
                    key={candidate.candidate_id}
                    className={cardCls}
                    shadow="sm"
                    withBorder
                    padding="md"
                    onClick={(e: React.MouseEvent) =>
                      onCardClick(e, candidate.candidate_id)
                    }
                  >
                    <div className={styles.candidateHeader}>
                      <div className={styles.candidateName}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isApplied}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleSelect(candidate.candidate_id)}
                        />
                        <span
                          className={`${styles.nameText}${
                            (candidate.confidence ?? 0) < 0.6 ? ` ${styles.lowConfidence}` : ''
                          }`}
                        >
                          {candidate.name}
                        </span>
                        <Badge color="blue" size="sm" variant="outline">
                          {t.sourceTagLabel}: {sourceDisplayName(candidate.source_id)}
                        </Badge>
                        <Badge color="gray" size="sm" variant="light">
                          {t.confidenceLabel}: {formatPercent(candidate.confidence)}
                        </Badge>
                        {isApplied && (
                          <Badge color="green" size="sm">
                            {t.appliedTag}
                          </Badge>
                        )}
                      </div>
                      <div
                        className={styles.candidateActions}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation()
                            emitEdit(candidate)
                          }}
                        >
                          {t.editCandidate}
                        </Button>
                      </div>
                    </div>

                    {candidate.description && (
                      <div className={styles.candidateDesc}>{candidate.description}</div>
                    )}

                    {/* 意图标签 (Level 2): 让用户一眼看到 LLM 把这道题归为什么类型 */}
                    {candidate.intent_labels && candidate.intent_labels.length > 0 && (
                      <div
                        className={styles.candidateIntents}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className={styles.intentPrefix}>{t.intentLabel}:</span>
                        {candidate.intent_labels.map((lab: string) => (
                          <Badge
                            key={lab}
                            size="sm"
                            color="blue"
                            variant="outline"
                            className={styles.intentChip}
                          >
                            {lab}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {candidate.aliases && candidate.aliases.length > 0 && (
                      <div className={styles.candidateAliases}>
                        {candidate.aliases.map((a: string) => (
                          <Badge key={a} size="sm" variant="light" color="gray">
                            {a}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {/* 关键挑战 (Level 2): 折叠展示, LLM 识别出的难点 */}
                    {candidate.key_challenges && candidate.key_challenges.length > 0 && (
                      <details
                        className={styles.candidateChallenges}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <summary>
                          {t.keyChallenges} ({candidate.key_challenges.length})
                        </summary>
                        <ul className={styles.challengesList}>
                          {candidate.key_challenges.map((ch: string, idx: number) => (
                            <li key={idx}>{ch}</li>
                          ))}
                        </ul>
                        {candidate.intent_reasoning && (
                          <div className={styles.intentReasoning}>
                            <span className={styles.reasoningLabel}>{t.intentReasoning}:</span>{' '}
                            {candidate.intent_reasoning}
                          </div>
                        )}
                      </details>
                    )}

                    {candidate.validation_error && (
                      <Alert
                        title={t.validationErrorTitle}
                        color="yellow"
                        withCloseButton={false}
                        className={styles.candidateWarning}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      >
                        <div>{t.validationErrorHint}</div>
                        <details
                          className={styles.validationDetail}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <summary>{t.validationErrorDetail}</summary>
                          <code>{formatValidationError(candidate.validation_error)}</code>
                        </details>
                      </Alert>
                    )}

                    {candidate.conflict_with_existing &&
                      candidate.conflict_with_existing.length > 0 && (
                        <div className={styles.candidateConflicts}>
                          {candidate.conflict_with_existing.map((cf: any) => (
                            <Badge
                              key={cf.view_id}
                              color="red"
                              size="sm"
                              variant="outline"
                            >
                              {formatConflict(cf)}
                            </Badge>
                          ))}
                        </div>
                      )}

                    {supporting.length > 0 && (
                      <details
                        className={styles.candidateQuestions}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <summary>
                          {t.supportingQuestions} ({supporting.length})
                        </summary>
                        <ul>
                          {supporting.map((q: any) => (
                            <li key={q.question_id}>{q.text}</li>
                          ))}
                        </ul>
                      </details>
                    )}

                    {candidate.reasoning && (
                      <div className={styles.candidateReasoning}>
                        <span className={styles.reasoningLabel}>{t.reasoning}:</span>{' '}
                        {candidate.reasoning}
                      </div>
                    )}
                  </Card>
                )
              })}
            </div>
          ) : (
            task &&
            !running && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '40px 0',
                  color: '#909399',
                  fontSize: 13,
                }}
              >
                {task.stats && task.stats.questions_scanned > 0
                  ? t.emptyAfterRun
                  : t.emptyNoQuestions}
              </div>
            )
          )}
        </div>
        {/* /recommendScroll */}

        {/* 底部应用栏 (不参与滚动, 始终底部可见) */}
        {visibleCandidates.length > 0 && (
          <div className={styles.footerBar}>
            <span className={styles.applyHint}>{t.applyHint}</span>
            <span className={styles.selectedCount}>
              {t.selectedCount}: {selectedIds.length}
            </span>
            <Button
              disabled={!selectedIds.length || applying}
              loading={applying}
              onClick={applySelections}
            >
              {t.applyButton} ({selectedIds.length})
            </Button>
          </div>
        )}
      </div>
    </Drawer>
  )
})

export default MetricViewRecommendationDrawer
