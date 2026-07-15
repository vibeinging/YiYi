import { describe, expect, it } from 'vitest'

import type { AgentTraceRun, AgentTraceSpan } from '@/api/yiw'
import { ownTokenParts, spanTokenParts } from './WorkstationTraceLogic'

const span = (value: Partial<AgentTraceSpan> & Pick<AgentTraceSpan, 'id' | 'name' | 'kind'>): AgentTraceSpan => ({
  status: 'ok',
  depth: 0,
  durMs: 1,
  ...value
})

const runWith = (spans: AgentTraceSpan[]): AgentTraceRun => ({
  runId: 'run-1',
  sessionId: 'session-1',
  trace: {
    traceId: 'trace-1',
    name: 'Trace',
    status: 'ok',
    durMs: 1,
    cost: 0,
    spanCount: spans.length,
    spans
  }
})

describe('trace token usage', () => {
  it('fills missing parent cache fields from child spans', () => {
    const parent = span({ id: 'tool', name: 'sql_scan_operator', kind: 'tool', inTok: 100, outTok: 20 })
    const child = span({
      id: 'llm',
      parentId: 'tool',
      name: 'SQLGenerationAgent',
      kind: 'llm',
      depth: 1,
      attrs: { trace_input_tokens: 100, trace_output_tokens: 20, trace_cached_tokens: 80, trace_cache_write_tokens: 10 }
    })

    expect(spanTokenParts(runWith([parent, child]), parent)).toEqual({
      input: 100,
      output: 20,
      total: 120,
      cached: 80,
      cacheWrite: 10
    })
  })

  it('does not double count a child agent rollup and its LLM descendant', () => {
    const tool = span({ id: 'tool', name: 'tool', kind: 'tool' })
    const agent = span({ id: 'agent', parentId: 'tool', name: 'agent', kind: 'agent', depth: 1, inTok: 100, outTok: 20 })
    const llm = span({
      id: 'llm',
      parentId: 'agent',
      name: 'llm',
      kind: 'llm',
      depth: 2,
      inTok: 100,
      outTok: 20,
      attrs: { trace_cached_tokens: 80 }
    })

    expect(spanTokenParts(runWith([tool, agent, llm]), tool)).toEqual({
      input: 100,
      output: 20,
      total: 120,
      cached: 80,
      cacheWrite: 0
    })
  })

  it('reads raw cache aliases from external trace attrs', () => {
    const external = span({
      id: 'external',
      name: 'external',
      kind: 'llm',
      attrs: { prompt_cache_hit_tokens: 1200, cacheWriteInputTokens: 300 }
    })

    expect(ownTokenParts(external)).toEqual({
      input: 0,
      output: 0,
      total: 0,
      cached: 1200,
      cacheWrite: 300
    })
  })
})
