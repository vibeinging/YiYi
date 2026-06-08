/**
 * CollaborationMessageCard — collaboration rendered inline in the chat
 * message stream (Slock/Slack-style), not as a separate overlay panel.
 *
 * Subscribes the store to receive streaming token updates, hydrates from
 * the DB once on mount, and renders each step through StepRenderer.
 */

import { useEffect } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { type CollaborationId } from '../../api/collaboration'
import { useCollaborationStore } from '../../stores/collaborationStore'
import { StepRenderer } from './StepRenderer'

interface Props {
  collaborationId: CollaborationId
}

export function CollaborationMessageCard({ collaborationId }: Props) {
  const entry = useCollaborationStore(s => s.collaborations.get(collaborationId))
  const ensureSubscribed = useCollaborationStore(s => s.ensureSubscribed)
  const hydrate = useCollaborationStore(s => s.hydrate)

  useEffect(() => {
    void ensureSubscribed()
    void hydrate(collaborationId)
  }, [collaborationId, ensureSubscribed, hydrate])

  if (!entry) {
    return (
      <div
        className="rounded-2xl px-4 py-3 flex items-center gap-2.5 text-[12px]"
        style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}
      >
        <Loader2 size={14} className="animate-spin" />
        加载协作…
      </div>
    )
  }

  const { collaboration } = entry
  const steps = [...collaboration.plan.steps].sort((a, b) => a.id - b.id)

  // 路由卡已彻底去掉(用户决策)。"谁选的、为什么"沉到 audit 里,UI 只见成员发言。
  // 单/多成员统一走 ParallelAgentStepCard 的群聊气泡渲染(一位 = 一条气泡),
  // 视觉一致;详见 StepRenderer。

  return (
    // 协作"卡"不再是卡 —— L1 多成员场景下,N 个家人气泡就是 N 条独立消息。
    // 外层只剩极淡的元 UI 行(状态 + 中止按钮),不再用 bg-elevated 包住气泡组。
    // 不显示"已完成/进行中"状态标签 —— IM 里消息没有状态,流式气泡本身就表达了进行中。
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-3">
        {steps.map(step => (
          <StepRenderer key={step.id} collaborationId={collaboration.id} step={step} />
        ))}
      </div>

      {collaboration.status.state === 'failed' && (
        <div
          className="px-3 py-2 rounded-lg text-[12px] flex items-center gap-2"
          style={{ background: 'var(--color-error-bg, #fee)', color: 'var(--color-error, #c00)' }}
        >
          <RotateCcw size={13} />
          {collaboration.status.reason || '协作失败'}
        </div>
      )}
    </div>
  )
}
