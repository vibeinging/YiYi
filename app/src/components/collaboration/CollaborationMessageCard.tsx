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
import { selectDispatch, useCollaborationStore } from '../../stores/collaborationStore'
import { StepRenderer } from './StepRenderer'

interface Props {
  collaborationId: CollaborationId
}

export function CollaborationMessageCard({ collaborationId }: Props) {
  const entry = useCollaborationStore(s => s.collaborations.get(collaborationId))
  const ensureSubscribed = useCollaborationStore(s => s.ensureSubscribed)
  const hydrate = useCollaborationStore(s => s.hydrate)
  const dispatch = useCollaborationStore(selectDispatch(collaborationId))

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

  // 路由头来源:live 的 dispatches map（带 reason，仅本次会话内）优先；刷新后
  // 它清空，则从已持久化的 collaboration 派生（mode=dispatched + 首个成员）——
  // 成员归属持久可见，reason 是 live-only 的加成。手动 @ 召唤（manual）不显示。
  const dispatchedParticipant =
    collaboration.mode.kind === 'dispatched' ? collaboration.plan.steps[0]?.participants[0] : undefined
  const routing =
    dispatch ??
    (dispatchedParticipant
      ? {
          companion_name: dispatchedParticipant.name,
          avatar_emoji: dispatchedParticipant.avatar_emoji,
          color_hex: dispatchedParticipant.color_hex,
          reason: '',
          confidence: 0,
        }
      : undefined)

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

      {routing && (
        <div
          className="flex items-center flex-wrap gap-1.5 text-[12px] px-1"
          style={{ color: 'var(--color-text-muted)' }}
          title={routing.confidence > 0 ? `置信度 ${Math.round(routing.confidence * 100)}%` : undefined}
        >
          <span>🧭 主精灵交给</span>
          <span className="inline-flex items-center gap-1 font-medium" style={{ color: routing.color_hex }}>
            <span>{routing.avatar_emoji}</span>
            {routing.companion_name}
          </span>
          {routing.reason && <span className="opacity-80">· {routing.reason}</span>}
        </div>
      )}

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
