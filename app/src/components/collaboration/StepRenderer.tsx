/**
 * StepRenderer — dispatches one step to the correct card component by `step.kind`.
 *
 * - `single_agent` → Phase 2B @召唤 路径(SingleAgentStepCard,卡片化单 bubble)
 * - `parallel_agents` → L1 家族会话多成员并发(ParallelAgentStepCard,群聊式 N bubble)
 * - `host_summarize` / `user_confirmation` → 未来 plan DAG 留位(暂用 PlaceholderCard)
 */

import type { CollaborationId, Step } from '../../api/collaboration'
import { SingleAgentStepCard } from './SingleAgentStepCard'
import { ParallelAgentStepCard } from './ParallelAgentStepCard'

interface Props {
  collaborationId: CollaborationId
  step: Step
}

export function StepRenderer({ collaborationId, step }: Props) {
  switch (step.kind) {
    case 'single_agent':
      return <SingleAgentStepCard collaborationId={collaborationId} step={step} />
    case 'parallel_agents':
      return <ParallelAgentStepCard collaborationId={collaborationId} step={step} />
    case 'host_summarize':
    case 'user_confirmation':
      return <PlaceholderCard step={step} />
  }
}

function PlaceholderCard({ step }: { step: Step }) {
  const label = step.kind === 'host_summarize' ? '主精灵汇总' : '等你拍板'
  return (
    <div
      className="p-4 rounded-2xl text-[13px]"
      style={{
        background: 'var(--color-bg-subtle)',
        color: 'var(--color-text-muted)',
        border: '1px dashed var(--color-border)',
      }}
    >
      <div className="font-medium mb-1">{label}</div>
      <div>暂未支持，下个版本开放。</div>
    </div>
  )
}
