/**
 * StepRenderer — dispatches one step to the correct card component by `step.kind`.
 *
 * - `single_agent` → Phase 2B @召唤 路径(SingleAgentStepCard,卡片化单 bubble)
 * - `parallel_agents` → L1 群聊多成员并发(ParallelAgentStepCard,群聊式 N bubble)
 * - `host_summarize` / `user_confirmation` → jury 模型的占位,产品里没用,直接不渲染
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
      // jury 模型遗留的 step 类型,当前 plan 不会产生,UI 不露出。
      return null
  }
}
