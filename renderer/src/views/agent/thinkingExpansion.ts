import type { AgentBlock } from './stream/types'

export function resolveBlockExpanded(
  block: AgentBlock,
  blockIndex: number,
  blockCount: number,
  busy: boolean,
  isLastMessage: boolean,
  overrides: Record<string, boolean>
) {
  if (Object.prototype.hasOwnProperty.call(overrides, block.id)) {
    return Boolean(overrides[block.id])
  }

  if (block.type === 'thinking') {
    return busy && isLastMessage && blockIndex === blockCount - 1
  }

  return Boolean(block.metadata?.auto_expand)
}
