/**
 * StepRenderer — dispatches one step to the correct card component by `step.kind`.
 *
 * 所有成员发言统一走 ParallelAgentStepCard 的群聊气泡渲染(圆头像 + 气泡正文 +
 * "说完"),不再区分单/多成员的视觉 —— 一位成员就是一条气泡,N 位就是 N 条,
 * 看起来都是同一种微信群消息。
 *
 * - `single_agent` → @召唤单个成员(气泡组里就 1 条气泡)
 * - `parallel_agents` → 群聊多成员并发(N 条气泡)
 * - `host_summarize` → 群讨论的 YiYi 结论(单 participant=YiYi,同样气泡 + 结论分隔)
 * - `user_confirmation` → jury 模型遗留占位,产品里没用,不渲染
 */

import type { CollaborationId, Step } from '../../api/collaboration'
import { ParallelAgentStepCard } from './ParallelAgentStepCard'

interface Props {
  collaborationId: CollaborationId
  step: Step
}

export function StepRenderer({ collaborationId, step }: Props) {
  switch (step.kind) {
    case 'single_agent':
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
