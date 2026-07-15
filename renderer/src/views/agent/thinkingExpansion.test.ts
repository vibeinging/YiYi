import { describe, expect, it } from 'vitest'
import type { AgentBlock } from './stream/types'
import { resolveBlockExpanded } from './thinkingExpansion'

const thinking: AgentBlock = {
  id: 'thinking-1',
  type: 'thinking',
  content: '正在分析问题'
}

describe('thinking expansion', () => {
  it('expands the latest thinking block while it is being output', () => {
    expect(resolveBlockExpanded(thinking, 0, 1, true, true, {})).toBe(true)
  })

  it('collapses thinking after the run finishes', () => {
    expect(resolveBlockExpanded(thinking, 0, 1, false, true, {})).toBe(false)
  })

  it('collapses thinking when a later answer block starts outputting', () => {
    expect(resolveBlockExpanded(thinking, 0, 2, true, true, {})).toBe(false)
  })

  it('keeps a new thinking block expanded after earlier tool output', () => {
    const nextThinking = { ...thinking, id: 'thinking-2' }
    expect(resolveBlockExpanded(nextThinking, 2, 3, true, true, {})).toBe(true)
  })

  it('keeps the user toggle result as the highest priority', () => {
    expect(resolveBlockExpanded(thinking, 0, 1, true, true, { 'thinking-1': false })).toBe(false)
    expect(resolveBlockExpanded(thinking, 0, 1, false, true, { 'thinking-1': true })).toBe(true)
  })

  it('preserves auto expansion for short tool results', () => {
    const toolResult: AgentBlock = {
      id: 'result-1',
      type: 'tool_result',
      content: 'file-a\nfile-b',
      metadata: { auto_expand: true }
    }
    expect(resolveBlockExpanded(toolResult, 0, 1, false, true, {})).toBe(true)
  })
})
