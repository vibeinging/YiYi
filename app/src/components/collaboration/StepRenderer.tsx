/**
 * StepRenderer — dispatches one step to the correct card component by `step.kind`.
 *
 * - `single_agent` → Phase 2B @召唤 路径(SingleAgentStepCard,卡片化单 bubble)
 * - `parallel_agents` → 群聊多成员并发(ParallelAgentStepCard,群聊式 N bubble)
 * - `host_summarize` → 群讨论的 YiYi 结论(单 participant=YiYi,复用气泡渲染)
 * - `user_confirmation` → jury 模型遗留占位,产品里没用,不渲染
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
      // 群讨论的 YiYi 结论 —— 单 participant(YiYi),复用气泡组渲染(逐字流式)。
      // 前面加一条细分隔提示这是"结论"。
      return (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] font-medium tracking-wide px-1" style={{ color: 'var(--color-text-muted)' }}>
            — YiYi 的结论 —
          </div>
          <ParallelAgentStepCard collaborationId={collaborationId} step={step} />
        </div>
      )
    case 'user_confirmation':
      // jury 模型遗留的 step 类型,产品里没用,UI 不露出。
      return null
  }
}
