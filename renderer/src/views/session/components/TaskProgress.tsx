import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { t as gt } from '@/lang'
import ElSvgIcon from '@/components/ElSvgIcon'
import ContentBlock from './ContentBlock'
import TaskDetailBlock from './TaskDetailBlock'
import styles from './TaskProgress.module.scss'

// L2-9:节点类型图标 — 复用 workflow 编辑器 nodeCatalog 的 toolName→icon→组件映射。
// 原 Vue 直接 import NODE_CATALOG/ICON_MAP(EP 图标组件);React 侧 nodeCatalog 尚未迁移,
// 这里内联 toolName→EP 图标名的静态映射,渲染时交给 <ElSvgIcon> 转 Tabler。
// tool 节点按 tool_name(sql_scan/agentic_search…);condition/agent_condition 按 node_type 兜底。
const TOOL_ICON: Record<string, string> = {
  agentic_search: 'Compass',          // search-check
  sql_scan_operator: 'Coin',          // database
  format_result: 'Histogram',         // bar-chart
  metric_view_query: 'Grid',          // layout-grid
  rag_operator: 'Search',             // search
  semantic_scan_operator: 'Document', // document
  web_search_operator: 'Connection',  // globe
  free_llm: 'MagicStick',             // sparkles
  condition: 'Switch',                // git-branch
  semantic_filter_operator: 'Filter', // filter
  semantic_extract_operator: 'Plus',  // plus-square
  semantic_join_operator: 'Link',     // link
  align_metric: 'Histogram',          // chart-bar
  align_entity: 'Aim',                // target
  agent_condition: 'MagicStick',      // sparkles
}

// 返回 EP 图标名(供 <ElSvgIcon name=...>),无匹配返回 null
const nodeTypeIcon = (task: any): string | null => {
  if (task.tool_name && TOOL_ICON[task.tool_name]) return TOOL_ICON[task.tool_name]
  if (task.node_type && TOOL_ICON[task.node_type]) return TOOL_ICON[task.node_type]
  return null
}

const DETAIL_CATEGORIES = new Set([
  'thought', 'tool_call', 'tool_detail', 'intermediate_result', 'status', 'orchestration',
  'tool_progress',
])
// 富格式类型：表格、图表、SQL 等需要 ContentBlock 完整渲染
const RICH_CONTENT_TYPES = new Set([
  'table', 'chart', 'json', 'sql', 'html',
])
const isDetailCategory = (block: any): boolean => {
  const cat = block.metadata?.msg_category
  if (!DETAIL_CATEGORIES.has(cat)) return false
  // 富格式内容始终走 ContentBlock，保留表格/图表/SQL 等渲染能力
  if (RICH_CONTENT_TYPES.has(block.type)) return false
  return true
}

/* ─── metric view summary 可见性(内联自 composables/useContentBlock.js) ───
 * React 侧 useContentBlock 尚未迁移,此处内联 getFlattenedMetadata /
 * getMetricViewSummary / buildMetricViewSummaryVisibilityMap 三个纯函数,
 * 保持原判定逻辑(同一 signature 仅最后一个块显示 metric view 摘要)完全一致。 */
const getFlattenedMetadata = (block: any): any => {
  const metadata = block?.metadata && typeof block.metadata === 'object'
    ? block.metadata
    : (block?.meta && typeof block.meta === 'object' ? block.meta : {})

  if (metadata.metadata && typeof metadata.metadata === 'object') {
    return { ...metadata, ...metadata.metadata }
  }
  return metadata
}

const getMetricViewSummary = (block: any): any => {
  if (!block || block.type === 'user_input') {
    return { show: false }
  }

  const metadata = getFlattenedMetadata(block)
  const metricView = metadata.metric_view || {}
  const status = metadata.metric_view_status || ''

  if (!metricView?.name && !metricView?.source_name && !metricView?.source_id) {
    return { show: false }
  }

  const sourceText = metricView.source_name || metricView.source_id || ''
  const statusTextMap: Record<string, string> = {
    confirmed_hit: gt('session.metricView.statusConfirmedHit'),
    need_param_clarification: gt('session.metricView.statusNeedParam'),
    fallback: gt('session.metricView.statusFallback'),
  }
  const badge = status === 'fallback'
    ? gt('session.metricView.summaryFallback')
    : gt('session.metricView.summaryHit')
  const parts: string[] = []
  if (statusTextMap[status]) parts.push(gt('session.metricView.statusLabel', { status: statusTextMap[status] }))
  if (sourceText) parts.push(gt('session.metricView.sourceLabel', { source: sourceText }))
  if (status === 'fallback' && metadata.fallback_to) parts.push(gt('session.metricView.fallbackLabel', { target: metadata.fallback_to }))

  const signature = JSON.stringify({
    badge,
    name: metricView.name || gt('session.metricView.unnamedView'),
    status,
    sourceText,
    fallbackTo: metadata.fallback_to || '',
  })

  return {
    show: true,
    signature,
    badge,
    main: metricView.name || gt('session.metricView.unnamedView'),
    sub: parts.join(' · '),
    statusClass: status === 'fallback' ? 'is-fallback' : 'is-hit',
  }
}

const buildMetricViewSummaryVisibilityMap = (
  blocks: any[] = [],
  shouldIncludeBlock: (block: any, index: number) => boolean = () => true
): Record<number, boolean> => {
  const lastIndexBySignature = new Map<string, number>()
  const visibilityMap: Record<number, boolean> = {}

  blocks.forEach((block, index) => {
    if (!shouldIncludeBlock(block, index)) return
    const summary = getMetricViewSummary(block)
    if (!summary.show) return
    lastIndexBySignature.set(summary.signature, index)
  })

  blocks.forEach((block, index) => {
    if (!shouldIncludeBlock(block, index)) {
      visibilityMap[index] = false
      return
    }

    const summary = getMetricViewSummary(block)
    visibilityMap[index] = Boolean(summary.show && lastIndexBySignature.get(summary.signature) === index)
  })

  return visibilityMap
}

export interface TaskProgressProps {
  taskPlan?: any[]
  taskGroups?: Record<string, any[]>
  isStreaming?: boolean
  messageId?: string | number
  databaseId?: string | number | null
  sessionId?: string
  dismissedUserInputs?: Set<any>
  readonly?: boolean
  // defineEmits → 回调 props
  onSavePanel?: (payload: any) => void
  onPageChange?: (msgId: any, blkIdx: any, page: any) => void
  onSizeChange?: (msgId: any, blkIdx: any, size: any) => void
  onUserInputSubmitted?: (payload: any) => void
  onReviewIntermediate?: () => void
}

export default function TaskProgress({
  taskPlan = [],
  taskGroups = {},
  isStreaming = false,
  messageId = '',
  databaseId = null,
  sessionId = '',
  dismissedUserInputs = new Set(),
  readonly = false,
  onSavePanel,
  onPageChange,
  onSizeChange,
  onUserInputSubmitted,
  onReviewIntermediate,
}: TaskProgressProps) {
  const { t } = useTranslation()
  const [expandedTasks, setExpandedTasks] = useState<Set<any>>(new Set())

  const getTaskBlocks = (taskId: any): any[] => {
    return taskGroups[taskId] || []
  }

  const hasContent = (taskId: any): boolean => {
    return Boolean(taskGroups[taskId] && taskGroups[taskId].length > 0)
  }

  // 有效任务计划：stream 结束后，将残留 running 状态修正为 completed（兜底保护）
  // 后端已在 format_result 时推送最终 task_plan，此处仅防止异常情况
  const effectiveTaskPlan = useMemo(() => {
    if (isStreaming) {
      // 兜底:pending 但已有详情块 = 实际在执行(running 状态可能被 SSE 重连/历史重放
      // 覆盖成 pending)→ 修正回 running,圆圈暖黄脉冲 + isDetailOpen 自动实时展开,对齐 superagent
      return taskPlan.map((task) =>
        (task.status === 'pending' && hasContent(task.id))
          ? { ...task, status: 'running' }
          : task
      )
    }
    return taskPlan.map((task) => {
      if (task.status === 'running') {
        return { ...task, status: 'completed' }
      }
      return task
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskPlan, taskGroups, isStreaming])

  const allCompleted = useMemo(
    () => effectiveTaskPlan.length > 0 && effectiveTaskPlan.every((task) => task.status === 'completed'),
    [effectiveTaskPlan]
  )

  const taskMetricViewVisibilityMap = useMemo<Record<string, Record<number, boolean>>>(() => {
    const visibilityByTask: Record<string, Record<number, boolean>> = {}

    Object.entries(taskGroups || {}).forEach(([taskId, blocks]) => {
      visibilityByTask[taskId] = buildMetricViewSummaryVisibilityMap(
        blocks,
        (block) => !isDetailCategory(block)
      )
    })

    return visibilityByTask
  }, [taskGroups])

  // 展开逻辑：waiting_input / running+streaming / 手动展开
  const isDetailOpen = (task: any): boolean => {
    if (task.status === 'waiting_input') return true
    if (task.status === 'running' && isStreaming) return true
    if (!hasContent(task.id)) return false
    return expandedTasks.has(task.id)
  }

  // 判断是否为运行中任务的最后一个块（显示 loading 动画）
  const isLastActiveBlock = (task: any, bIdx: number): boolean => {
    if (task.status !== 'running' || !isStreaming) return false
    return bIdx === getTaskBlocks(task.id).length - 1
  }

  const toggleTask = (taskId: any): void => {
    if (!hasContent(taskId)) return
    setExpandedTasks((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(taskId)) {
        newSet.delete(taskId)
      } else {
        newSet.add(taskId)
      }
      return newSet
    })
  }

  // 状态 → CSS module class(原 :class="`s-${task.status}`")
  const statusClass = (status: string): string => {
    const map: Record<string, string | undefined> = {
      pending: styles.sPending,
      running: styles.sRunning,
      completed: styles.sCompleted,
      failed: styles.sFailed,
      waiting_input: styles.sWaitingInput,
      skipped: styles.sSkipped,
    }
    return map[status] || ''
  }

  if (effectiveTaskPlan.length === 0) return null

  return (
    <div className={styles.taskProgress}>
      {effectiveTaskPlan.map((task, idx) => (
        <div key={task.id} className={`${styles.taskStep} ${statusClass(task.status)}`}>
          {/* 轨道列：节点 + 连接线 */}
          <div className={styles.stepTrack}>
            <div className={styles.stepNode}>
              {/* waiting_input: 叹号 */}
              {task.status === 'waiting_input' && <span className={styles.nodeWarn}>!</span>}
              {/* pending: 序号 */}
              {task.status === 'pending' && <span className={styles.nodeNum}>{idx + 1}</span>}
              {/* running: 旋转 spinner */}
              {task.status === 'running' && <span className={styles.nodeSpinner} />}
              {/* completed: 勾选 SVG */}
              {task.status === 'completed' && (
                <svg
                  className={styles.nodeCheck}
                  width="10"
                  height="8"
                  viewBox="0 0 10 8"
                  fill="none"
                >
                  <path d="M1 4L3.8 7L9 1" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {/* failed: X */}
              {task.status === 'failed' && <span className={styles.nodeFail}>✕</span>}
              {/* skipped: 分支裁剪/级联跳过 ⋯ (L2) */}
              {task.status === 'skipped' && <span className={styles.nodeSkip}>⋯</span>}
            </div>
          </div>

          {/* 内容列：标题 + 详情 */}
          <div className={styles.stepBody}>
            <div className={styles.stepRow}>
              <span className={styles.stepTitle}>
                {nodeTypeIcon(task) && (
                  <span className={styles.stepTypeIcon}>
                    <ElSvgIcon name={nodeTypeIcon(task)!} size={13} />
                  </span>
                )}
                {task.title}
              </span>
              {/* L2-7: skipped 节点的裁剪原因(「xx 分支未走」),灰色小字标注 */}
              {task.status === 'skipped' && task.skip_reason && (
                <span className={styles.stepSkipReason}>{task.skip_reason}</span>
              )}
              {/* L1-6: 节点黄色 hint(视图未命中回退 / 多候选选最优等系统纠错提示) */}
              {task.hint && <span className={styles.stepHint}>{task.hint}</span>}
              {/* 详情 chip: 完成/失败且有内容时显示（running/waiting_input 自动展开，无需 chip） */}
              {task.status !== 'running' &&
                task.status !== 'pending' &&
                task.status !== 'waiting_input' &&
                hasContent(task.id) && (
                <span
                  className={`${styles.chipDone} ${expandedTasks.has(task.id) ? styles.open : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleTask(task.id)
                  }}
                >
                  {t('session.taskProgress.details')}
                  <span className={styles.chipChevron}>›</span>
                </span>
              )}
            </div>

            {/* 展开的详细内容面板：running 自动展开，其他状态手动切换 */}
            <div className={`${styles.stepDetail} ${isDetailOpen(task) ? styles.open : ''}`}>
              <div className={styles.stepDetailWrap}>
                <div className={styles.stepDetailInner}>
                  {getTaskBlocks(task.id).map((block, bIdx) =>
                    isDetailCategory(block) ? (
                      <TaskDetailBlock
                        key={`${task.id}-${bIdx}`}
                        block={block}
                        messageId={messageId}
                        readonly={readonly}
                        isActive={isLastActiveBlock(task, bIdx)}
                      />
                    ) : (
                      <ContentBlock
                        key={`${task.id}-${bIdx}`}
                        block={block}
                        messageId={messageId}
                        blockIndex={`task-${task.id}-${bIdx}`}
                        readonly={readonly}
                        showMetricViewSummary={taskMetricViewVisibilityMap[task.id]?.[bIdx]}
                        databaseId={databaseId == null ? null : String(databaseId)}
                        sessionId={sessionId}
                        dismissedUserInputs={dismissedUserInputs}
                        onSavePanel={(payload: any) => onSavePanel?.(payload)}
                        onPageChange={(msgId: any, blkIdx: any, page: any) => onPageChange?.(msgId, blkIdx, page)}
                        onSizeChange={(msgId: any, blkIdx: any, size: any) => onSizeChange?.(msgId, blkIdx, size)}
                        onUserInputSubmitted={(payload: any) => onUserInputSubmitted?.(payload)}
                      />
                    )
                  )}
                  {/* 运行中任务的 loading 指示 */}
                  {task.status === 'running' && isStreaming && (
                    <div className={styles.stepLoading}>
                      <span className={styles.stepLoadingDot} />
                      <span className={styles.stepLoadingText}>{t('session.taskProgress.processing')}</span>
                      <span className={styles.stepLoadingBounce}>
                        <span /><span /><span />
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* 完成汇总行 */}
      {allCompleted && (
        <div className={styles.taskRailFooter}>
          <div className={styles.trfDot} />
          <span className={styles.trfText}>
            <strong>{t('session.taskProgress.allStepsCompleted', { count: effectiveTaskPlan.length })}</strong>
          </span>
          {!readonly && (
            <button className={styles.trfReviewBtn} onClick={() => onReviewIntermediate?.()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
              {t('session.taskProgress.reviewIntermediate')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
