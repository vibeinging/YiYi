import type {
  AgentBlock,
  AgentMessage,
  AgentStreamEventV1,
  AgentStreamPatch,
  PlanStep,
  ToolCall,
  WorkstationDraft,
  WorkstationPatch
} from './types'
import { extractWorkspaceEvent } from './streamAdapter'
import { artifactKindForPath } from './uiCapabilities'

function parseJson(text: unknown): any {
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

function stepState(step: any): PlanStep['state'] {
  const raw = String(step?.state || step?.status || '').toLowerCase()
  if (raw === 'done' || raw === 'completed' || raw === 'complete') return 'done'
  if (raw === 'running' || raw === 'doing' || raw === 'in_progress') return 'running'
  return 'todo'
}

function planFromSteps(steps: any): PlanStep[] {
  return (Array.isArray(steps) ? steps : []).map((step: any) => ({
    title: step?.title || step?.name || '',
    detail: step?.detail || step?.description,
    state: stepState(step)
  }))
}

export function completeOpenPlanSteps(plan: PlanStep[]): PlanStep[] {
  if (!Array.isArray(plan) || plan.length === 0) return plan
  if (plan.every((step) => step.state === 'done')) return plan
  return plan.map((step) => (step.state === 'done' ? step : { ...step, state: 'done' }))
}

function toolWhere(name: string, where?: string): ToolCall['where'] {
  if (where === 'cloud' || /^mcp[_:-]/i.test(name)) return 'cloud'
  return 'local'
}

function toolStatus(status?: string | null): ToolCall['status'] {
  if (status === 'error' || status === 'failed') return 'error'
  if (status === 'running') return 'running'
  if (status === 'pending') return 'pending'
  return 'ok'
}

function toolPatch(payload: any, status: ToolCall['status']): NonNullable<AgentStreamPatch['workstation']>['tool'] | undefined {
  const id = String(payload?.tool_call_id || payload?.id || '').trim()
  const name = String(payload?.name || '').trim()
  if (!id || !name) return undefined
  return {
    id,
    value: {
      name,
      where: toolWhere(name, payload?.where),
      status,
      args: payload?.args_preview || payload?.args || '',
      result: payload?.result_preview || undefined
    }
  }
}

const TOOL_LABELS: Record<string, string> = {
  read: '读取文件',
  bash: '执行命令',
  write: '写入文件',
  edit: '修改文件',
  ls: '列出文件',
  find: '查找文件',
  grep: '搜索文件',
  metric_view_query: '召回指标视图',
  sql_scan_operator: '查询数据库',
  grep_tables: '检索表',
  grep_columns: '检索字段',
  align_metric: '对齐指标',
  align_value: '对齐实体值',
  semantic_scan_operator: '检索文档',
  semantic_filter_operator: '语义过滤',
  semantic_extract_operator: '语义抽取',
  semantic_join_operator: '语义关联',
  web_search_operator: '联网搜索',
  format_result: '生成结果展示'
}

const AUTO_EXPAND_TOOL_RESULTS = new Set(['ls', 'find', 'grep'])

function clippedPreview(value: unknown, max = 180) {
  const text = toText(value).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

function toolBlock(payload: any, title: 'running' | 'done' | 'error'): AgentBlock | null {
  const id = String(payload?.tool_call_id || payload?.id || '').trim()
  const name = String(payload?.name || '').trim()
  if (!id || !name) return null
  const preview = clippedPreview(payload?.args_preview || payload?.args || '')
  const label = TOOL_LABELS[name] || name
  return {
    id,
    type: 'tool',
    content: preview ? `${label} ${preview}` : label,
    title,
    metadata: {
      tool_call_id: id,
      tool_name: name,
      status: title
    }
  }
}

function toolResultBlock(payload: any): AgentBlock | null {
  const toolCallId = String(payload?.tool_call_id || '').trim()
  if (!toolCallId) return null
  const toolName = String(payload?.name || '').trim()
  const content = toText(payload?.result_preview || payload?.result || '').trim()
  if (!content) return null
  return {
    id: `result:${toolCallId}`,
    type: 'tool_result',
    content,
    title: TOOL_LABELS[toolName] || payload?.name || '工具',
    metadata: {
      tool_call_id: toolCallId,
      tool_name: toolName,
      auto_expand: AUTO_EXPAND_TOOL_RESULTS.has(toolName)
    }
  }
}

function artifactPatch(value: unknown): NonNullable<AgentStreamPatch['workstation']>['artifact'] | undefined {
  const path = typeof value === 'string' ? value : typeof (value as any)?.path === 'string' ? (value as any).path : ''
  if (!path) return undefined
  const name = String((value as any)?.name || path.split('/').pop() || path)
  const kind = (value as any)?.kind || artifactKindForPath(path)
  return {
    id: String((value as any)?.artifact_id || path),
    value: {
      name,
      meta: path,
      kind
    }
  }
}

function blockFromDelta(event: AgentStreamEventV1): AgentBlock | null {
  const payload = event.payload || {}
  if (event.visibility === 'hidden') return null
  const channel = String(payload.channel || (event.visibility === 'primary' ? 'answer' : 'thinking'))
  const format = String(payload.format || (channel === 'thinking' ? 'text' : 'markdown'))
  const blockId = String(payload.block_id || payload.content_id || `${channel}:${event.seq || Date.now()}`)
  const type = channel === 'thinking' ? 'thinking' : channel === 'error' || format === 'error' ? 'error' : format
  return {
    id: blockId,
    type,
    content: toText(payload.content),
    title: payload.title,
    metadata: { mode: payload.mode || 'replace', channel, visibility: event.visibility }
  }
}

function userInputBlock(payload: any, title = 'requested'): AgentBlock | null {
  const requestId = String(payload?.request_id || payload?.user_input_id || '').trim()
  if (!requestId) return null
  return {
    id: `user_input:${requestId}`,
    type: 'user_input',
    content: JSON.stringify({
      ...payload,
      request_id: requestId,
      prompt: payload?.prompt || '需要您确认',
      options: Array.isArray(payload?.options) ? payload.options : [],
      allow_multiple: Boolean(payload?.allow_multiple)
    }),
    title,
    metadata: {
      request_id: requestId,
      status: title,
      response: payload?.value,
      display: true
    }
  }
}

function skillPatch(payload: any): NonNullable<AgentStreamPatch['workstation']>['skill'] | undefined {
  const name = String(payload?.name || payload?.skill_name || '').trim()
  if (!name) return undefined
  return {
    id: name,
    value: {
      name,
      runtime: payload?.runtime || null,
      status: payload?.status || 'selected',
      reason: payload?.reason || ''
    }
  }
}

export function reduceAgentStreamEvent(event: AgentStreamEventV1): AgentStreamPatch {
  if (!event || event.v !== 1 || !event.type) return { ignored: true }
  const payload = event.payload || {}

  if (event.type === 'message.delta') {
    const block = blockFromDelta(event)
    return block ? { block } : { ignored: true }
  }

  if (event.type === 'plan.updated') {
    return { workstation: { plan: planFromSteps(payload.steps) } }
  }

  if (event.type === 'tool.started') {
    const tool = toolPatch(payload, 'running')
    const block = toolBlock(payload, 'running')
    return tool || block ? { block: block || undefined, workstation: tool ? { tool } : undefined } : { ignored: true }
  }

  if (event.type === 'tool.completed' || event.type === 'tool.failed') {
    const status = event.type === 'tool.failed' ? 'error' : toolStatus(payload.status)
    const tool = toolPatch(payload, status)
    const block = toolBlock(payload, status === 'error' ? 'error' : 'done')
    return tool || block ? { block: block || undefined, workstation: tool ? { tool } : undefined } : { ignored: true }
  }

  if (event.type === 'tool.output') {
    const toolCallId = String(payload.tool_call_id || '').trim()
    if (!toolCallId) return { ignored: true }
    const result = toText(payload.result_preview || payload.result || '')
    return {
      block: toolResultBlock(payload) || undefined,
      workstation: { toolResult: { id: toolCallId, result } }
    }
  }

  if (event.type === 'approval.requested') {
    const toolCallId = String(payload.tool_call_id || payload.approval_id || '').trim()
    if (!toolCallId) return { ignored: true }
    const summary = toText(payload.summary || payload.args_preview || '')
    const tool = payload.name ? toolPatch({ ...payload, tool_call_id: toolCallId }, 'pending') : undefined
    return {
      block: {
        id: `confirm:${toolCallId}`,
        type: 'confirm',
        content: summary,
        title: payload.name || 'confirm',
        metadata: { tool_call_id: toolCallId }
      },
      workstation: tool ? { tool } : undefined,
      scrollDelayMs: 120
    }
  }

  if (event.type === 'approval.resolved') {
    const toolCallId = String(payload.tool_call_id || payload.approval_id || '').trim()
    if (!toolCallId) return { ignored: true }
    return {
      block: {
        id: `confirm:${toolCallId}`,
        type: 'confirm',
        content: toText(payload.summary || payload.args_preview || ''),
        title: payload.approved ? 'approved' : 'rejected',
        metadata: { tool_call_id: toolCallId }
      }
    }
  }

  if (event.type === 'user_input.requested') {
    const block = userInputBlock(payload, 'requested')
    return block ? { block, scrollDelayMs: 120 } : { ignored: true }
  }

  if (event.type === 'user_input.resolved') {
    const status = !payload.status || payload.status === 'answered' ? 'resolved' : String(payload.status)
    const block = userInputBlock(payload, status)
    if (block) block.content = ''
    return block ? { block } : { ignored: true }
  }

  if (event.type === 'skill.selected') {
    const skill = skillPatch(payload)
    return skill ? { workstation: { skill } } : { ignored: true }
  }

  if (event.type === 'workspace.updated') {
    const workspaceEvent = extractWorkspaceEvent(event)
    return workspaceEvent ? { workspaceEvent } : { ignored: true }
  }

  if (event.type === 'artifact.created') {
    const artifact = artifactPatch(payload.path || payload.artifact || payload)
    return artifact ? { workstation: { artifact } } : { ignored: true }
  }

  return { ignored: true }
}

export function reduceContentItem(block: AgentBlock): AgentStreamPatch {
  if (block.type === 'skill_invocation') {
    const data = parseJson(block.content) || {}
    const skill = skillPatch({
      name: data.skill_name || block.metadata?.skill_name || block.title,
      runtime: data.runtime || block.metadata?.runtime,
      status: data.status || block.metadata?.status || 'selected',
      reason: data.reason || block.metadata?.reason || ''
    })
    return skill ? { workstation: { skill } } : { ignored: true }
  }

  if (block.type === 'plan') {
    return { workstation: { plan: planFromSteps(parseJson(block.content)) } }
  }

  if (block.metadata?.display === false || block.type === 'workspace_event') return { ignored: true }

  if (block.type === 'tool') {
    const name = block.metadata?.tool_name || String(block.content || '').split(/\s+/)[0] || ''
    const args = String(block.content || '').slice(name.length).trim()
    const status: ToolCall['status'] = block.title === 'running' ? 'running' : block.title === 'error' ? 'error' : 'ok'
    const tool = {
      id: block.id,
      value: {
        name,
        where: toolWhere(name, block.metadata?.where),
        status,
        args
      }
    }
    const artifact = artifactPatch(block.metadata?.artifact)
    return { workstation: { tool, ...(artifact ? { artifact } : {}) } }
  }

  if (block.type === 'tool_result') {
    const id = String(block.id || '').replace(/^result:/, '')
    return { workstation: id ? { toolResult: { id, result: toText(block.content) } } : undefined }
  }

  return { ignored: true }
}

export function reduceStreamEvent(event: any): AgentStreamPatch {
  return reduceAgentStreamEvent(event)
}

export function applyWorkstationPatch(patch: WorkstationPatch | undefined, draft: WorkstationDraft): boolean {
  if (!patch) return false
  let changed = false

  if (patch.plan) {
    draft.plan = patch.plan
    changed = true
  }

  if (patch.tool) {
    const prev = draft.tools.get(patch.tool.id)
    draft.tools.set(patch.tool.id, {
      ...prev,
      ...patch.tool.value,
      result: patch.tool.value.result ?? prev?.result
    })
    changed = true
  }

  if (patch.toolResult) {
    const prev = draft.tools.get(patch.toolResult.id)
    if (prev) {
      draft.tools.set(patch.toolResult.id, { ...prev, result: patch.toolResult.result })
      changed = true
    }
  }

  if (patch.artifact) {
    draft.artifacts.set(patch.artifact.id, patch.artifact.value)
    changed = true
  }

  if (patch.skill) {
    const prev = draft.skills.get(patch.skill.id)
    draft.skills.set(patch.skill.id, { ...prev, ...patch.skill.value })
    changed = true
  }

  return changed
}

export function backfillWorkstationFromMessages(messages: AgentMessage[]): WorkstationDraft {
  const draft: WorkstationDraft = {
    tools: new Map(),
    artifacts: new Map(),
    skills: new Map(),
    plan: []
  }

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.workstationBlocks || message.blocks) {
      const patch = reduceContentItem(block)
      applyWorkstationPatch(patch.workstation, draft)
    }
  }

  return draft
}
