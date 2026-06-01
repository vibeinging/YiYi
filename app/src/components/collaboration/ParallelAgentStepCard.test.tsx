import { describe, it, expect } from 'vitest'
import { memberPersistedText } from './ParallelAgentStepCard'

describe('memberPersistedText', () => {
  it('extracts a single member section', () => {
    const full = '【闪闪】今天很闪亮'
    expect(memberPersistedText(full, '闪闪', 2)).toBe('今天很闪亮')
  })

  it('extracts each member from a multi-member block, no leak across markers', () => {
    const full = '【闪闪】我先说\n\n【小二】我接一句'
    expect(memberPersistedText(full, '闪闪', 2)).toBe('我先说')
    expect(memberPersistedText(full, '小二', 2)).toBe('我接一句')
  })

  // 回归:executor 早期会拼出「【名字】【名字】内容」双标记,旧解析会切出空串
  // → 重开后群成员气泡只剩头像没内容(实测 bug)。
  it('recovers content from doubled markers (legacy data)', () => {
    const full = '【闪闪】【闪闪】我会发光\n\n【小二】【小二】我爱接话'
    expect(memberPersistedText(full, '闪闪', 2)).toBe('我会发光')
    expect(memberPersistedText(full, '小二', 2)).toBe('我爱接话')
  })

  it('returns empty for a member absent from the block (passed)', () => {
    const full = '【闪闪】只有我说了'
    expect(memberPersistedText(full, '小二', 2)).toBe('')
  })

  it('single participant with no marker → whole text is theirs', () => {
    expect(memberPersistedText('直接就是结论', 'YiYi', 1)).toBe('直接就是结论')
  })

  it('empty input → empty', () => {
    expect(memberPersistedText('', '闪闪', 2)).toBe('')
  })
})
