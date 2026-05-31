/**
 * SingleAgentStepCard — one companion + its streaming output.
 *
 * Renders the participant card from the spec doc: avatar emoji + main
 * color border + name + role + status icon + live token stream + token
 * counter + retry button on failure.
 */

import { Loader2, CheckCircle2, XCircle, BookOpenCheck, AlertCircle } from 'lucide-react'
import {
  mutateCollaboration,
  type CollaborationId,
  type Step,
  type StepStatus,
} from '../../api/collaboration'
import { selectStream, selectReasoning, useCollaborationStore } from '../../stores/collaborationStore'
import { ThinkingBlock, AgentMarkdown } from '../chat/markdownShared'

interface Props {
  collaborationId: CollaborationId
  step: Step
}

export function SingleAgentStepCard({ collaborationId, step }: Props) {
  const participant = step.participants[0]
  if (!participant) {
    return null
  }

  const accent = participant.color_hex || 'var(--color-text-muted)'
  const stream = useCollaborationStore(
    selectStream(collaborationId, step.id, participant.companion_id),
  )
  const reasoning = useCollaborationStore(
    selectReasoning(collaborationId, step.id, participant.companion_id),
  )

  // Prefer the live stream while the step is running; once Completed we
  // fall back to the durable output.summary / full_output.
  const liveText = step.status === 'running' ? stream : undefined
  const finalText =
    step.status === 'completed' || step.status === 'failed'
      ? step.output?.full_output ?? step.output?.summary
      : undefined
  const displayText = liveText ?? finalText ?? ''
  // 思考(reasoning)只在 live 期间有(StepOutput 不持久化思考)。与主 agent 同结构。
  const thinking = step.status === 'running' ? reasoning ?? '' : ''

  return (
    <div
      className="rounded-2xl p-4 flex flex-col gap-2.5"
      style={{
        background: 'var(--color-bg-subtle)',
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <div className="flex items-center gap-3">
        <div
          className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-[22px]"
          style={{ background: `${accent}22` }}
        >
          {participant.avatar_emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[14px]" style={{ color: 'var(--color-text)' }}>
            {participant.name}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            {statusLabel(step.status)}
          </div>
        </div>
        <StatusIcon status={step.status} accent={accent} />
      </div>

      {/* 思考过程 —— 与主 agent 同一个 ThinkingBlock。 */}
      {thinking && <ThinkingBlock content={thinking} streaming={step.status === 'running' && !displayText} />}

      {/* 正文 —— 与主 agent 同结构(markdown-body + 共享 markdown 渲染 + 流式光标)。 */}
      {displayText && (
        <div
          className={`text-[13px] leading-relaxed markdown-body${step.status === 'running' ? ' yiyi-stream-cursor' : ''}`}
          style={{ color: 'var(--color-text-secondary)' }}
        >
          <AgentMarkdown>{displayText}</AgentMarkdown>
        </div>
      )}

      <Footer step={step} collaborationId={collaborationId} accent={accent} />
    </div>
  )
}

function statusLabel(s: StepStatus): string {
  switch (s) {
    case 'pending':
      return '等开口…'
    case 'running':
      return '在想…'
    case 'completed':
      return '说完了'
    case 'failed':
      return '没回上来'
    case 'skipped':
      return '跳过'
  }
}

function StatusIcon({ status, accent }: { status: StepStatus; accent: string }) {
  switch (status) {
    case 'pending':
      return (
        <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
          ⌛
        </span>
      )
    case 'running':
      return <Loader2 size={16} className="animate-spin" style={{ color: accent }} />
    case 'completed':
      return <CheckCircle2 size={16} style={{ color: '#22C55E' }} />
    case 'failed':
      return <XCircle size={16} style={{ color: '#EF4444' }} />
    case 'skipped':
      return <BookOpenCheck size={16} style={{ color: 'var(--color-text-muted)' }} />
  }
}

function Footer({
  step,
  collaborationId,
  accent,
}: {
  step: Step
  collaborationId: CollaborationId
  accent: string
}) {
  if (step.status === 'failed') {
    return (
      <div className="flex items-center justify-between pt-1">
        <span
          className="flex items-center gap-1 text-[11px]"
          style={{ color: 'var(--color-error, #c00)' }}
        >
          <AlertCircle size={12} />
          没回上来
        </span>
        <button
          onClick={() => {
            void mutateCollaboration(collaborationId, { kind: 'retry_step', step_id: step.id })
          }}
          className="text-[11px] px-2 py-0.5 rounded transition-colors"
          style={{ background: `${accent}22`, color: accent }}
        >
          重叫她 ↺
        </button>
      </div>
    )
  }
  if (step.status === 'completed' && step.output) {
    const { duration_ms, tokens_used } = step.output
    return (
      <div className="flex items-center gap-3 text-[11px] pt-1" style={{ color: 'var(--color-text-muted)' }}>
        <span>{Math.round(duration_ms / 100) / 10}s</span>
        <span>·</span>
        <span>
          {tokens_used.input + tokens_used.output} tokens
        </span>
      </div>
    )
  }
  return null
}
