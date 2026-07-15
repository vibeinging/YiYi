import type { AgentTraceRun, AgentTraceSpan } from '@/api/yiw'

export const KIND_LABEL: Record<string, string> = {
  agent: 'AGENT',
  llm: 'LLM',
  tool: 'TOOL',
  chain: 'CHAIN',
  retriever: 'RETR'
}

export const KIND_COLOR: Record<string, string> = {
  agent: 'var(--mantine-color-grape-6)',
  llm: 'var(--mantine-color-blue-6)',
  tool: 'var(--mantine-color-cyan-6)',
  chain: 'var(--mantine-color-yiw-6)',
  retriever: 'var(--mantine-color-teal-6)'
}

export function isError(status?: string | null) {
  const value = String(status || '').toLowerCase()
  return value === 'failed' || value === 'error'
}

export function statusColor(status?: string | null) {
  const value = String(status || '').toLowerCase()
  if (value === 'completed' || value === 'ok') return 'teal'
  if (value === 'running' || value === 'pending') return 'orange'
  if (value === 'suspended') return 'yellow'
  if (isError(value)) return 'red'
  return 'gray'
}

export function statusLabel(status?: string | null) {
  const value = String(status || '').toLowerCase()
  if (value === 'completed' || value === 'ok') return '完成'
  if (value === 'running') return '运行中'
  if (value === 'pending') return '等待'
  if (value === 'suspended') return '挂起'
  if (value === 'failed' || value === 'error') return '失败'
  return status || '未知'
}

export function spanKey(span?: AgentTraceSpan | null) {
  return span?.externalSpanId || span?.id || ''
}

export function spanRenderKey(span: AgentTraceSpan, index: number) {
  return spanKey(span) || `${span.name}-${span.depth || 0}-${index}`
}

export function formatTime(value?: string | null) {
  if (!value) return ''
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return ''
  return time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatDuration(ms?: number | null) {
  const n = Number(ms || 0)
  if (!Number.isFinite(n) || n <= 0) return '0 ms'
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(2)} s`
}

export function formatToken(value?: number | null) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function formatOptionalToken(value?: number | null) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '-'
  return formatToken(n)
}

export function runTime(run: AgentTraceRun) {
  return new Date(run.updatedAt || run.createdAt || run.finishedAt || '').getTime() || 0
}

export function compareRuns(a: { run: AgentTraceRun; index: number }, b: { run: AgentTraceRun; index: number }) {
  const aq = Number(a.run.question?.questionNo || 0)
  const bq = Number(b.run.question?.questionNo || 0)
  if (aq > 0 && bq > 0 && aq !== bq) return aq - bq
  if (aq > 0 && bq <= 0) return -1
  if (aq <= 0 && bq > 0) return 1
  return runTime(a.run) - runTime(b.run) || a.index - b.index
}

export function compactText(value?: string | null) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function rootSpan(run: AgentTraceRun) {
  const spans = run.trace?.spans || []
  return spans.find((span) => Number(span.depth || 0) === 0) || spans[0] || null
}

export function childSpansOf(run: AgentTraceRun, parent?: AgentTraceSpan | null) {
  if (!parent) return []
  const spans = run.trace?.spans || []
  const parentKeys = new Set([
    spanKey(parent),
    parent.id || '',
    parent.externalSpanId || ''
  ].filter(Boolean))
  return spans.filter((span) => {
    if (span === parent) return false
    const directParentKeys = [
      span.parentId || '',
      span.externalParentSpanId || '',
      String(span.attrs?.parent_tool_call_id || ''),
      String(span.attrs?.parent_span_id || ''),
      String(span.attrs?.trace_parent_span_id || '')
    ].filter(Boolean)
    return directParentKeys.some((key) => parentKeys.has(key))
  })
}

export function parentSpanOf(run: AgentTraceRun, span?: AgentTraceSpan | null) {
  if (!span) return null
  const spans = run.trace?.spans || []
  const parentKeys = [
    span.parentId || '',
    span.externalParentSpanId || '',
    String(span.attrs?.parent_tool_call_id || ''),
    String(span.attrs?.parent_span_id || ''),
    String(span.attrs?.trace_parent_span_id || '')
  ].filter(Boolean)
  if (!parentKeys.length) return null
  return spans.find((item) => {
    const keys = [spanKey(item), item.id || '', item.externalSpanId || ''].filter(Boolean)
    return keys.some((key) => parentKeys.includes(key))
  }) || null
}

export function descendantSpansOf(run: AgentTraceRun, parent?: AgentTraceSpan | null) {
  if (!parent) return []
  const out: AgentTraceSpan[] = []
  const visited = new Set<string>()
  const visit = (node: AgentTraceSpan) => {
    for (const child of childSpansOf(run, node)) {
      const key = spanKey(child) || child.id || `${child.name}-${child.depth}-${out.length}`
      if (visited.has(key)) continue
      visited.add(key)
      out.push(child)
      visit(child)
    }
  }
  visit(parent)
  return out
}

export function spanPath(run: AgentTraceRun, span?: AgentTraceSpan | null) {
  if (!span) return []
  const path: AgentTraceSpan[] = []
  const visited = new Set<string>()
  let current: AgentTraceSpan | null = span
  while (current) {
    const key = spanKey(current) || current.id || current.name
    if (visited.has(key)) break
    visited.add(key)
    path.unshift(current)
    current = parentSpanOf(run, current)
  }
  return path
}

export interface TraceTokenParts {
  input: number
  output: number
  total: number
  cached: number
  cacheWrite: number
}

const EMPTY_TOKEN_PARTS: TraceTokenParts = { input: 0, output: 0, total: 0, cached: 0, cacheWrite: 0 }
const CACHE_READ_ATTRS = [
  'trace_cached_tokens',
  'cached_tokens',
  'cachedTokens',
  'cacheRead',
  'cache_read',
  'cacheReadTokens',
  'cache_read_tokens',
  'cache_read_input_tokens',
  'cache_input_tokens',
  'prompt_cache_hit_tokens'
]
const CACHE_WRITE_ATTRS = [
  'trace_cache_write_tokens',
  'cache_write_tokens',
  'cacheWriteTokens',
  'cacheWrite',
  'cache_write',
  'cache_write_input_tokens',
  'cacheWriteInputTokens',
  'cache_creation_input_tokens'
]

export function numericAttr(span: AgentTraceSpan | null | undefined, ...keys: string[]) {
  if (!span?.attrs) return 0
  for (const key of keys) {
    const n = Number(span.attrs[key] || 0)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

export function addTokenParts(a: TraceTokenParts, b: TraceTokenParts): TraceTokenParts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    total: a.total + b.total,
    cached: a.cached + b.cached,
    cacheWrite: a.cacheWrite + b.cacheWrite
  }
}

export function ownTokenParts(span?: AgentTraceSpan | null): TraceTokenParts {
  if (!span) return { ...EMPTY_TOKEN_PARTS }
  const input = Number(span.inTok || 0) || numericAttr(span, 'trace_input_tokens', 'input_tokens', 'prompt_tokens')
  const output = Number(span.outTok || 0) || numericAttr(span, 'trace_output_tokens', 'output_tokens', 'completion_tokens')
  const total = input + output || numericAttr(span, 'trace_total_tokens', 'total_tokens')
  return {
    input,
    output,
    total,
    cached: numericAttr(span, ...CACHE_READ_ATTRS),
    cacheWrite: numericAttr(span, ...CACHE_WRITE_ATTRS)
  }
}

function resolvedSpanTokenParts(
  run: AgentTraceRun,
  span: AgentTraceSpan,
  visited: Set<AgentTraceSpan>
): TraceTokenParts {
  if (visited.has(span)) return { ...EMPTY_TOKEN_PARTS }
  visited.add(span)
  const own = ownTokenParts(span)
  const children = childSpansOf(run, span).reduce(
    (sum, child) => addTokenParts(sum, resolvedSpanTokenParts(run, child, visited)),
    { ...EMPTY_TOKEN_PARTS }
  )
  return {
    input: own.input || children.input,
    output: own.output || children.output,
    total: own.total || children.total,
    cached: own.cached || children.cached,
    cacheWrite: own.cacheWrite || children.cacheWrite
  }
}

export function spanTokenParts(run: AgentTraceRun, span?: AgentTraceSpan | null): TraceTokenParts {
  if (!span) return { ...EMPTY_TOKEN_PARTS }
  return resolvedSpanTokenParts(run, span, new Set())
}

export function formatTokenParts(parts: TraceTokenParts) {
  if (!parts.total && !parts.cached && !parts.cacheWrite) return '-'
  const base = parts.total ? formatToken(parts.total) : '-'
  const cache = []
  if (parts.cached > 0) cache.push(`cache ${formatToken(parts.cached)}`)
  if (parts.cacheWrite > 0) cache.push(`write ${formatToken(parts.cacheWrite)}`)
  return cache.length ? `${base} (${cache.join(', ')})` : base
}

export function tokenMetricItems(parts: TraceTokenParts) {
  if (!parts.total && !parts.cached && !parts.cacheWrite) return []
  return [
    { label: 'Token', value: formatOptionalToken(parts.total) },
    { label: '输入', value: formatOptionalToken(parts.input) },
    { label: '输出', value: formatOptionalToken(parts.output) },
    { label: 'Cache', value: formatToken(parts.cached) },
    { label: 'Cache写', value: formatToken(parts.cacheWrite) }
  ]
}

export function scopeTokenParts(run: AgentTraceRun, spans: AgentTraceSpan[]) {
  return spans.reduce((sum, span) => addTokenParts(sum, spanTokenParts(run, span)), { ...EMPTY_TOKEN_PARTS })
}

export function spanKindCount(spans: AgentTraceSpan[], kind: string) {
  return spans.filter((span) => String(span.kind || '') === kind).length
}

export function spanAttrText(span: AgentTraceSpan, key: string) {
  const value = span.attrs?.[key]
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export function spanMetricItems(run: AgentTraceRun, span: AgentTraceSpan) {
  const tokens = spanTokenParts(run, span)
  const duration = Number(span.durMs || 0)
  const model = String(span.model || spanAttrText(span, 'model_id') || '').trim()
  const channel = spanAttrText(span, 'channel')
  const format = spanAttrText(span, 'format')
  const category = spanAttrText(span, 'msg_category')
  const childCount = childSpansOf(run, span).length
  const items: Array<{ label: string; value: string }> = []

  if (Number.isFinite(duration) && duration > 0) items.push({ label: '耗时', value: formatDuration(duration) })
  items.push(...tokenMetricItems(tokens))
  if (model && model !== 'primary') items.push({ label: '模型', value: model })
  if (channel) items.push({ label: '通道', value: channel })
  if (format) items.push({ label: '格式', value: format })
  if (category) items.push({ label: '类型', value: category })
  if (childCount > 0) items.push({ label: '子调用', value: String(childCount) })
  if (!items.length) items.push({ label: '类型', value: KIND_LABEL[String(span.kind || '')] || span.kind || 'SPAN' })
  return items
}

export function userQuestionText(run: AgentTraceRun) {
  const explicit = compactText(run.question?.questionText)
  if (explicit) return explicit
  const input = compactText(rootSpan(run)?.input)
  if (input) return input
  return '用户问题'
}

export function finalOutputText(run: AgentTraceRun) {
  const spans = run.trace?.spans || []
  const finalSpan = [...spans].reverse().find((span) => String(span.attrs?.msg_category || '') === 'final_answer')
  const finalOutput = compactText(finalSpan?.output || finalSpan?.input)
  if (finalOutput) return finalOutput
  const rootOutput = compactText(rootSpan(run)?.output)
  if (rootOutput) return rootOutput
  const lastOutput = compactText([...spans].reverse().find((span) => compactText(span.output))?.output)
  return lastOutput || ''
}

export function traceSnapshotForRun(run: AgentTraceRun) {
  return {
    run: {
      runId: run.runId,
      sessionId: run.sessionId,
      projectId: run.projectId,
      status: run.status,
      skill: run.skill,
      mode: run.mode,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt
    },
    question: run.question,
    trace: run.trace
  }
}

export function jsonText(value: unknown) {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function formatDetailValue(value: unknown) {
  if (value == null || value === '') return { text: '', rawText: '', format: '' }
  if (typeof value !== 'string') {
    try {
      const text = JSON.stringify(value, null, 2)
      return { text, rawText: text, format: 'JSON' }
    } catch {
      const text = String(value)
      return { text, rawText: text, format: '' }
    }
  }
  const raw = value.trim()
  if (!raw) return { text: '', rawText: '', format: '' }
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return { text: JSON.stringify(JSON.parse(raw), null, 2), rawText: value, format: 'JSON' }
    } catch {
      return { text: value, rawText: value, format: '' }
    }
  }
  return { text: value, rawText: value, format: '' }
}
