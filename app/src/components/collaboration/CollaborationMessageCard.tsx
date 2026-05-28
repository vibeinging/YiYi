/**
 * CollaborationMessageCard — collaboration rendered inline in the chat
 * message stream (Slock/Slack-style), not as a separate overlay panel.
 *
 * Subscribes the store to receive streaming token updates, hydrates from
 * the DB once on mount, and renders each step through StepRenderer. The
 * abort button only shows while the collaboration is still in flight.
 */

import { useEffect } from 'react'
import { Loader2, XCircle, RotateCcw } from 'lucide-react'
import {
  abortCollaboration,
  isTerminalStatus,
  type CollaborationId,
  type CollaborationStatus,
} from '../../api/collaboration'
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
  const terminal = isTerminalStatus(collaboration.status)
  const steps = [...collaboration.plan.steps].sort((a, b) => a.id - b.id)

  // 路由卡已彻底去掉(用户决策)。"谁选的、为什么"沉到 audit 里,UI 只见成员发言。
  // 多成员同框靠 ParallelAgentStepCard 渲染气泡组,SingleAgent 路径(Phase 2B @召唤)
  // 走 SingleAgentStepCard。

  return (
    <div
      className="rounded-2xl p-3 flex flex-col gap-2.5"
      style={{ background: 'var(--color-bg-elevated)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <StatusPill status={collaboration.status} />
        {!terminal && (
          <button
            onClick={() => {
              if (window.confirm('真的要中止整场协作吗？')) {
                void abortCollaboration(collaboration.id)
              }
            }}
            className="text-[11px] px-2 py-0.5 rounded-full transition-colors hover:bg-[var(--color-bg-subtle)]"
            style={{ color: 'var(--color-text-muted)' }}
            title="中止协作"
          >
            <XCircle size={12} className="inline mr-1" />
            中止
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
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

function StatusPill({ status }: { status: CollaborationStatus }) {
  const { label, color } = pillStyle(status)
  return (
    <span
      className="inline-block text-[11px] px-2 py-0.5 rounded-full"
      style={{ background: `${color}1a`, color }}
    >
      {label}
    </span>
  )
}

function pillStyle(status: CollaborationStatus): { label: string; color: string } {
  switch (status.state) {
    case 'planning':
      return { label: '规划中', color: '#94A3B8' }
    case 'awaiting_confirm':
      return { label: '等你拍板', color: '#F59E0B' }
    case 'running':
      return { label: '进行中…', color: '#3B82F6' }
    case 'done':
      return { label: '已完成', color: '#22C55E' }
    case 'aborted':
      return { label: '已中止', color: '#94A3B8' }
    case 'failed':
      return { label: '失败', color: '#EF4444' }
  }
}
