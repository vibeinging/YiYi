/**
 * 内容块处理逻辑
 */
import { t } from '@/lang'
import { isChartDisplayType } from '@/utils/chartRegistry'

// 内容类型映射配置
const CONTENT_TYPE_MAP: Record<string, { displayType: string; parser: string }> = {
  sql: { displayType: 'table', parser: 'sql' },
  text: { displayType: 'text', parser: 'text' },
  markdown: { displayType: 'text', parser: 'markdown' },
  json: { displayType: 'custom', parser: 'json' },
  chart: { displayType: 'bar', parser: 'json' },
  table: { displayType: 'table', parser: 'json' },
  result: { displayType: 'text', parser: 'text' }
}

// 映射到新的内容类型
export const mapToContentType = (type: string): string => {
  const mapping: Record<string, string> = {
    sql: 'sql',
    text: 'text',
    markdown: 'markdown',
    result: 'text',
    chart: 'json',
    table: 'json',
    json: 'json',
    html: 'html',
    chat: 'chat',
    error: 'text'
  }
  return mapping[type] || 'text'
}

// 判断是否为图表类型（委托给 chartRegistry）
export const isChartType = (block: any): boolean => {
  return block.type === 'chart' || (block.type === 'json' && isChartDisplayType(block.display_type))
}

// 判断是否为表格类型
export const isTableType = (block: any): boolean => {
  return block.type === 'table' || (block.type === 'json' && block.display_type === 'table')
}

// 判断是否为文本类型
export const isTextType = (block: any): boolean => {
  return (
    block.type === 'result' ||
    block.type === 'text' ||
    block.type === 'markdown' ||
    (block.type === 'json' && block.display_type === 'text')
  )
}

// 提取原始内容
export const extractRawContent = (block: any): string => {
  if (typeof block.content === 'string') return block.content
  if (typeof block.content === 'object') return JSON.stringify(block.content)
  return String(block.content || '')
}

const normalizeBlockContent = (content: any): string => {
  if (typeof content === 'string') {
    return content.trim()
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return String(content ?? '').trim()
}

const getFlattenedMetadata = (block: any): any => {
  const metadata = block?.metadata && typeof block.metadata === 'object'
    ? block.metadata
    : (block?.meta && typeof block.meta === 'object' ? block.meta : {})

  if (metadata.metadata && typeof metadata.metadata === 'object') {
    return {
      ...metadata,
      ...metadata.metadata
    }
  }

  return metadata
}

export const parseBlockContentObject = (content: any): any => {
  if (content && typeof content === 'object') {
    return content
  }

  if (typeof content === 'string') {
    try {
      return JSON.parse(content || '{}')
    } catch {
      return {}
    }
  }

  return {}
}

export const getReportCardData = (block: any, fallbackTitle = '正式报告'): any => {
  const content = parseBlockContentObject(block?.content)
  const metadata = getFlattenedMetadata(block)
  const viewerUrl = content.viewer_url || metadata.viewer_url || ''
  const reportId = content.report_id || metadata.report_id || ''
  const reportType = content.report_type || metadata.report_type || ''
  const fallbackSummary = typeof block?.content === 'string' && block?.type !== 'report'
    ? block.content
    : ''

  return {
    title: content.title || block?.title || fallbackTitle,
    summary: content.summary || fallbackSummary,
    viewerUrl,
    reportId,
    reportType
  }
}

export const isSessionReportCardBlock = (block: any): boolean => {
  if (!block || typeof block !== 'object') return false
  if (block.type === 'report') return true

  const metadata = getFlattenedMetadata(block)
  if (!metadata?.report_ready) return false

  const reportCard = getReportCardData(block)
  return Boolean(reportCard.viewerUrl || reportCard.reportId)
}

const buildDuplicateSignature = (block: any): string => {
  const metadata = getFlattenedMetadata(block)
  const category = metadata.msg_category || ''
  if (!category || category === 'final_result' || category === 'decomposition' || block.savable_to_panel) {
    return ''
  }

  return [
    block.type || '',
    category,
    block.title || '',
    normalizeBlockContent(block.content)
  ].join('::')
}

export const getMetricViewSummary = (block: any): any => {
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
    confirmed_hit: t('session.metricView.statusConfirmedHit'),
    need_param_clarification: t('session.metricView.statusNeedParam'),
    fallback: t('session.metricView.statusFallback')
  }
  const badge = status === 'fallback'
    ? t('session.metricView.summaryFallback')
    : t('session.metricView.summaryHit')
  const parts: string[] = []
  if (statusTextMap[status]) parts.push(t('session.metricView.statusLabel', { status: statusTextMap[status] }))
  if (sourceText) parts.push(t('session.metricView.sourceLabel', { source: sourceText }))
  if (status === 'fallback' && metadata.fallback_to) parts.push(t('session.metricView.fallbackLabel', { target: metadata.fallback_to }))

  const signature = JSON.stringify({
    badge,
    name: metricView.name || t('session.metricView.unnamedView'),
    status,
    sourceText,
    fallbackTo: metadata.fallback_to || ''
  })

  return {
    show: true,
    signature,
    badge,
    main: metricView.name || t('session.metricView.unnamedView'),
    sub: parts.join(' · '),
    statusClass: status === 'fallback' ? 'is-fallback' : 'is-hit'
  }
}

export const buildMetricViewSummaryVisibilityMap = (
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

// 构建展示配置
export const buildDisplayConfig = (block: any, sessionSourceInfo: any): any => {
  const config: any = {}
  const content = block.content
  const metadata = getFlattenedMetadata(block)

  if (content && typeof content === 'object') {
    if (content.fields && Array.isArray(content.fields)) {
      config.fields = content.fields
    }
    if (content.x_axis_field) {
      config.x_axis_field = content.x_axis_field
    }
    if (content.y_axis_fields && Array.isArray(content.y_axis_fields)) {
      config.y_axis_fields = content.y_axis_fields
    }
    if (content.group_field) {
      config.group_field = content.group_field
    }
  }

  if (metadata) {
    if (metadata.sql_query) {
      config.sql_query = metadata.sql_query
    }
    if (metadata.source_type) {
      config.source_type = metadata.source_type
    }
    if (metadata.source_id) {
      config.source_id = metadata.source_id
    }
    if (metadata.metric_view?.source_id) {
      config.source_id = metadata.metric_view.source_id
    }
    if (metadata.metric_view?.source_name) {
      config.source_name = metadata.metric_view.source_name
    }
    if (metadata.metric_view?.name) {
      config.metric_view_name = metadata.metric_view.name
    }
  }

  // 从 session 信息中获取数据源
  if (!config.source_type && sessionSourceInfo) {
    config.source_type = block.source_type || sessionSourceInfo.source_type
    config.source_id = block.source_id || sessionSourceInfo.source_id
  }

  return Object.keys(config).length > 0 ? config : null
}

// 构建 PanelCard 需要的数据格式
export const buildPanelData = (block: any, sessionSourceInfo: any): any => {
  const typeConfig = CONTENT_TYPE_MAP[block.type] || CONTENT_TYPE_MAP['text']

  return {
    id: block.id || '',
    title: block.title || 'Untitled',
    content_type: mapToContentType(block.type),
    content: extractRawContent(block),
    display_type: block.display_type || block.form_type || typeConfig.displayType,
    display_config: buildDisplayConfig(block, sessionSourceInfo),
    execute_type: block.execute_type || null,
    execute: block.execute || null,
    source_type: block.source_type || sessionSourceInfo?.source_type || '',
    source_id: block.source_id || sessionSourceInfo?.source_id || ''
  }
}

// 从消息中提取可渲染的内容块
export const getMessageBlocks = (message: any): any[] => {
  if (!message) {
    return []
  }

  if (Array.isArray(message.content_items) && message.content_items.length > 0) {
    return message.content_items.map((item: any) => {
      let displayType = item.display_type
      if (!displayType && item.content && typeof item.content === 'object') {
        displayType = item.content.display_type
      }
      if (!displayType) {
        displayType = item.type
      }

      const savableToPanel = item.savable_to_panel || item.metadata?.savable_to_panel || false
      const executeType = item.execute_type || item.metadata?.execute_type || null
      const execute = item.execute || item.metadata?.execute || null

      return {
        ...item,
        display_type: displayType,
        savable_to_panel: savableToPanel,
        execute_type: executeType,
        execute
      }
    })
  }

  return []
}

// 检查消息是否有可执行的代码
export const hasExecutableCode = (message: any): boolean => {
  return getMessageBlocks(message).some(
    (block) =>
      (block.type === 'code' && block.metadata?.actions?.includes('execute')) ||
      (block.type === 'sql' && block.metadata?.executable)
  )
}

// 获取第一个可执行的代码块
export const getFirstExecutableCode = (message: any): any => {
  return getMessageBlocks(message).find(
    (block) =>
      (block.type === 'code' && block.metadata?.actions?.includes('execute')) ||
      (block.type === 'sql' && block.metadata?.executable)
  )
}

const TASK_PLAN_STATUS_RE = /^\[[^\]]+\]\s*(全部任务完成|等待用户确认|恢复执行|任务进展|重新分解子任务|All tasks completed|Awaiting user confirmation|Resuming execution|Task progress|Re-decomposing subtasks)\s*$/
/** Redis/流式合并异常时可能出现的重复前缀，仍视为仅驱动 task_plan 的控制行 */
const TASK_PLAN_STATUS_CORRUPT_RE = /^任务进展\s*\[[^\]]+\]\s*任务进展\s*$/

const isTaskPlanControlStatus = (block: any): boolean => {
  const metadata = getFlattenedMetadata(block)
  if (metadata.msg_category !== 'status') return false
  if (!Array.isArray(metadata.task_plan) || metadata.task_plan.length === 0) return false
  const content = extractRawContent(block).trim()
  return TASK_PLAN_STATUS_RE.test(content) || TASK_PLAN_STATUS_CORRUPT_RE.test(content)
}

/**
 * 按任务分组消息内容块
 *
 * @param {Object} message - 消息对象
 * @returns {Object|null} 分组结果，无任务元数据时返回 null（前端降级为旧渲染模式）
 *
 * 返回结构:
 * {
 *   taskPlan: [{id, title, status}, ...],  // 任务列表
 *   taskGroups: { task_id: ContentBlock[] },  // 每个任务的详细内容块
 *   finalResults: ContentBlock[],  // 始终可见的最终结果
 * }
 */
export const groupBlocksByTask = (message: any): any => {
  const blocks = getMessageBlocks(message)
  const taskPlan = message.task_plan

  // 任何"结构化类目"出现就走新模式，避免流式期间（只有 thought 还没拆解出
  // decomposition/orchestration）退回 legacy 平铺渲染——这会让 thought 在流式
  // 期间没有卡片样式、等流式结束才"跳"出"✨ 分析"卡，视觉跳变明显。
  const STRUCTURED_CATEGORIES = new Set([
    'thought', 'decomposition', 'orchestration',
    'tool_call', 'tool_detail', 'tool_progress',
    'intermediate_result', 'tool_completed', 'tool_failed',
  ])
  const hasTaskFlowMetadata = blocks.some((block) => {
    const metadata = getFlattenedMetadata(block)
    const category = metadata.msg_category

    if (metadata.task_group) return true
    if (STRUCTURED_CATEGORIES.has(category)) return true
    if (category === 'status' && Array.isArray(metadata.task_plan) && metadata.task_plan.length > 0) return true
    return false
  })

  // 无任务流元数据 → 返回 null，触发旧模式渲染
  if (!taskPlan && !hasTaskFlowMetadata) return null

  const result: any = {
    taskPlan: taskPlan || [],
    taskGroups: {},
    topResults: [],
    finalResults: [],
  }

  const appendTaskBlock = (taskId: string, block: any) => {
    if (!result.taskGroups[taskId]) {
      result.taskGroups[taskId] = []
    }
    result.taskGroups[taskId].push(block)
  }

  // orchestration/task_group 出现后，后续无 task_group 的 status 视为“流程后段状态”
  let hasEnteredTaskFlow = false

  for (const block of blocks) {
    const metadata = getFlattenedMetadata(block)
    const category = metadata.msg_category
    const taskId = metadata.task_group

    // 任务计划控制语句只用于驱动 TaskProgress，不单独渲染为状态文本
    if (isTaskPlanControlStatus(block)) {
      continue
    }

    // decomposition → 问题拆分思考，渲染在步骤上方
    if (category === 'decomposition') {
      result.topResults.push(block)
      continue
    }

    // thought（无 task_group）→ 流式期间的首轮思考；位置与 decomposition 对齐，
    // 这样后端把 thought 替换成 decomposition 时不会跳位。
    // 有 task_group 的 thought 仍然走下面的"按任务分组"路径，归到对应步骤。
    if (category === 'thought' && !taskId) {
      result.topResults.push(block)
      continue
    }

    // orchestration → 渲染在时间线前，保留编排说明
    // 但 message.task_plan 已存在时，顶部 orchestration 文本块和 TaskProgress
    // 时间线展示同源数据（都是 LLM 编排出的任务列表），文本卡片是人类可读重复，
    // 跳过避免视觉冗余（含 task_group 的仍归入对应步骤，可在 TaskProgress detail 看到）
    if (category === 'orchestration') {
      if (taskId) {
        appendTaskBlock(taskId, block)
        hasEnteredTaskFlow = true
      } else if (!taskPlan || taskPlan.length === 0) {
        // task_plan 不存在时保留顶部文本作为后备（流式中途未拿到 task_plan）
        result.topResults.push(block)
        hasEnteredTaskFlow = true
      } else {
        // task_plan 已有 → 冗余，跳过顶部文本卡片
        hasEnteredTaskFlow = true
      }
      continue
    }

    // status → 前段状态放顶部；任务内状态放对应步骤；后段状态放最终结果前
    if (category === 'status') {
      if (taskId) {
        appendTaskBlock(taskId, block)
        hasEnteredTaskFlow = true
      } else if (!hasEnteredTaskFlow) {
        result.topResults.push(block)
      } else {
        result.finalResults.push(block)
      }
      continue
    }

    // user_input / error / memory_applied → 有 task_group 时归入对应任务，否则始终可见
    if (block.type === 'user_input' || block.type === 'error' || block.type === 'memory_applied') {
      if (taskId) {
        appendTaskBlock(taskId, block)
        hasEnteredTaskFlow = true
      } else {
        result.finalResults.push(block)
      }
      continue
    }

    // 无分类 或 最终结果 或 可保存内容 → 始终可见
    if (!category || category === 'final_result' || block.savable_to_panel) {
      result.finalResults.push(block)
      continue
    }

    // thought / tool_call / tool_detail / intermediate_result → 按 task_group 分组
    if (!taskId) {
      // 无 task_group 的分类块放入 finalResults，避免被静默丢弃
      result.finalResults.push(block)
      continue
    }
    appendTaskBlock(taskId, block)
    hasEnteredTaskFlow = true
  }

  // 保护性去重：如果同一详情块同时落入任务区和最终结果区，以任务区为准；
  // 同时去掉 finalResults 内部的重复详情块，避免界面重复展示。
  const taskGroupSignatures = new Set<string>()
  Object.values(result.taskGroups).forEach((groupBlocks: any) => {
    groupBlocks.forEach((block: any) => {
      const signature = buildDuplicateSignature(block)
      if (signature) {
        taskGroupSignatures.add(signature)
      }
    })
  })

  const seenFinalSignatures = new Set<string>()
  result.finalResults = result.finalResults.filter((block: any) => {
    const signature = buildDuplicateSignature(block)
    if (!signature) {
      return true
    }
    if (taskGroupSignatures.has(signature)) {
      return false
    }
    if (seenFinalSignatures.has(signature)) {
      return false
    }
    seenFinalSignatures.add(signature)
    return true
  })

  return result
}
