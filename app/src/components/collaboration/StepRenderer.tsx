/**
 * StepRenderer — dispatches one step to the correct card component by
 * `step.kind`. Phase 2B implements SingleAgent only; the other kinds
 * render an "暂未支持" placeholder so future plans don't crash.
 */

import type { CollaborationId, Step } from '../../api/collaboration'
import { SingleAgentStepCard } from './SingleAgentStepCard'

interface Props {
  collaborationId: CollaborationId
  step: Step
}

export function StepRenderer({ collaborationId, step }: Props) {
  switch (step.kind) {
    case 'single_agent':
      return <SingleAgentStepCard collaborationId={collaborationId} step={step} />
    case 'parallel_agents':
    case 'host_summarize':
    case 'user_confirmation':
      return <PlaceholderCard step={step} />
  }
}

function PlaceholderCard({ step }: { step: Step }) {
  const label =
    step.kind === 'parallel_agents'
      ? '陪审团（多位伙伴一起聊）'
      : step.kind === 'host_summarize'
        ? '主精灵汇总'
        : '等你拍板'
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
