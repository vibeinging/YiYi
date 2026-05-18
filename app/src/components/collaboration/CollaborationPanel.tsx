/**
 * CollaborationPanel — full UI for one in-flight or terminal协作.
 *
 * Connects the live store (`collaborationStore`) to the step renderer +
 * status bar + action bar. Single-agent / multi-step plans both flow
 * through here — the panel doesn't know the topology, just renders what
 * the store reports.
 */

import { useEffect } from 'react'
import { Loader2, X, RotateCcw } from 'lucide-react'
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
  /** Called when the user dismisses the panel (clicks ✕). */
  onClose: () => void
}

export function CollaborationPanel({ collaborationId, onClose }: Props) {
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
        className="p-6 rounded-2xl flex items-center gap-3"
        style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}
      >
        <Loader2 size={16} className="animate-spin" />
        加载协作…
      </div>
    )
  }

  const { collaboration } = entry
  const terminal = isTerminalStatus(collaboration.status)
  const steps = [...collaboration.plan.steps].sort((a, b) => a.id - b.id)

  return (
    <div
      className="rounded-2xl overflow-hidden flex flex-col gap-3 p-5"
      style={{ background: 'var(--color-bg-elevated)' }}
    >
      {/* Sticky status header */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
            协作 · #{collaboration.id}
          </div>
          <div
            className="text-[14px] font-medium leading-snug mt-0.5"
            style={{ color: 'var(--color-text)' }}
          >
            {collaboration.intent}
          </div>
          <StatusPill status={collaboration.status} />
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)]"
          title="关闭"
        >
          <X size={15} style={{ color: 'var(--color-text-muted)' }} />
        </button>
      </div>

      {/* Step list */}
      <div className="flex flex-col gap-3">
        {steps.map(step => (
          <StepRenderer key={step.id} collaborationId={collaboration.id} step={step} />
        ))}
      </div>

      {/* Action bar */}
      {!terminal && (
        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--color-border)]">
          <button
            onClick={() => {
              if (window.confirm('真的要中止整场协作吗？')) {
                void abortCollaboration(collaboration.id)
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] transition-colors hover:bg-[var(--color-bg-subtle)]"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <X size={13} />
            全部中止
          </button>
        </div>
      )}
      {collaboration.status.state === 'failed' && (
        <div
          className="p-3 rounded-lg text-[12px] flex items-center gap-2"
          style={{ background: 'var(--color-error-bg, #fee)', color: 'var(--color-error, #c00)' }}
        >
          <RotateCcw size={14} />
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
      className="inline-block mt-1.5 text-[11px] px-2 py-0.5 rounded-full"
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
