/**
 * CompanionDraftCard — inline preview of a `propose_companion` draft.
 *
 * Renders in the chat message stream where the LLM tool deposited a
 * draft. Four user actions:
 *  - 👀 看细节   expand persona_md + rationale
 *  - ✎ 改改      open AdoptModal pre-filled with the draft fields
 *  - ✓ 收养      call adoptCompanion + persist draft_state=adopted
 *  - ✕ 算了      persist draft_state=dismissed
 *
 * Persisted state survives session refresh — the metadata patch goes
 * back to messages.metadata via update_companion_draft_state.
 */

import { useState } from 'react'
import { ChevronDown, ChevronUp, Check, X, Pencil, Sparkles } from 'lucide-react'
import { adoptCompanion, updateCompanionDraftState } from '../../api/companions'
import type { CompanionDraftEnvelope } from '../../api/agent'
import { AdoptModal } from './AdoptModal'
import { toast } from '../Toast'

interface Props {
  messageId?: number
  envelope: CompanionDraftEnvelope
}

export function CompanionDraftCard({ messageId, envelope }: Props) {
  const draft = envelope.companion_draft
  const [state, setState] = useState<'pending' | 'adopted' | 'dismissed'>(
    (envelope.draft_state as any) || 'pending',
  )
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const accent = draft.color_hex

  async function handleAdopt() {
    if (adopting || state !== 'pending') return
    setAdopting(true)
    try {
      const id = await adoptCompanion({
        name: draft.name,
        agent_definition_name: draft.agent_definition_name,
        avatar_emoji: draft.avatar_emoji,
        color_hex: draft.color_hex,
        persona_md: draft.persona_md,
        role_label: draft.role_label,
      })
      if (messageId) {
        await updateCompanionDraftState(messageId, 'adopted', id).catch(() => {})
      }
      setState('adopted')
      toast.success(`${draft.name} 已收养 ✨`)
    } catch (e) {
      toast.error(`收养失败：${e}`)
    } finally {
      setAdopting(false)
    }
  }

  async function handleDismiss() {
    if (state !== 'pending') return
    setState('dismissed')
    if (messageId) {
      await updateCompanionDraftState(messageId, 'dismissed').catch(() => {})
    }
  }

  const isTerminal = state !== 'pending'

  return (
    <div
      className="rounded-2xl p-4 flex flex-col gap-3"
      style={{
        background: 'var(--color-bg-elevated)',
        borderLeft: `3px solid ${accent}`,
        opacity: state === 'dismissed' ? 0.55 : 1,
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center text-[26px]"
          style={{ background: `${accent}22` }}
        >
          {draft.avatar_emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles size={12} style={{ color: accent }} />
            <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
              草稿 · 等你拍板
            </span>
          </div>
          <div className="font-semibold text-[15px] mt-0.5" style={{ color: 'var(--color-text)' }}>
            {draft.name}
          </div>
          <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
            擅长：{draft.role_label}
          </div>
        </div>
        <StatusBadge state={state} accent={accent} />
      </div>

      <div
        className="rounded-xl px-3 py-2 text-[13px] italic"
        style={{
          background: 'var(--color-bg-subtle)',
          color: 'var(--color-text-secondary)',
        }}
      >
        "{draft.tone_preview}"
      </div>

      {expanded && (
        <div className="flex flex-col gap-3 pt-1">
          <div>
            <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: 'var(--color-text-muted)' }}>
              为什么这样设计
            </div>
            <div className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
              {draft.rationale}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: 'var(--color-text-muted)' }}>
              人格档案 (persona.md)
            </div>
            <pre
              className="text-[12px] leading-relaxed whitespace-pre-wrap rounded-lg p-3 max-h-64 overflow-auto"
              style={{
                background: 'var(--color-bg-subtle)',
                color: 'var(--color-text-secondary)',
                fontFamily: 'inherit',
              }}
            >
              {draft.persona_md}
            </pre>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-1 text-[12px] px-2 py-1 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)]"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? '收起' : '看细节'}
        </button>
        <div className="flex items-center gap-1.5">
          <button
            disabled={isTerminal}
            onClick={() => setEditing(true)}
            className="flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--color-bg-subtle)]"
            style={{ color: 'var(--color-text-secondary)' }}
            title="打开收养表单微调"
          >
            <Pencil size={12} />
            改改
          </button>
          <button
            disabled={isTerminal}
            onClick={handleDismiss}
            className="flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--color-bg-subtle)]"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <X size={12} />
            算了
          </button>
          <button
            disabled={isTerminal || adopting}
            onClick={handleAdopt}
            className="flex items-center gap-1 text-[12px] px-3 py-1 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
            style={{ background: `${accent}22`, color: accent }}
          >
            <Check size={13} />
            {adopting ? '收养中…' : '收养'}
          </button>
        </div>
      </div>

      {editing && (
        <AdoptModal
          onClose={() => setEditing(false)}
          onAdopted={() => {
            setState('adopted')
            if (messageId) {
              updateCompanionDraftState(messageId, 'adopted').catch(() => {})
            }
          }}
          initialDraft={{
            name: draft.name,
            avatar_emoji: draft.avatar_emoji,
            agent_definition_name: draft.agent_definition_name,
            role_label: draft.role_label,
          }}
          initialStep={4}
        />
      )}
    </div>
  )
}

function StatusBadge({ state, accent }: { state: 'pending' | 'adopted' | 'dismissed'; accent: string }) {
  if (state === 'pending') return null
  const label = state === 'adopted' ? '✓ 已收养' : '✕ 已算了'
  const color = state === 'adopted' ? accent : 'var(--color-text-muted)'
  return (
    <span
      className="shrink-0 text-[11px] px-2 py-0.5 rounded-full"
      style={{ background: `${color}1a`, color }}
    >
      {label}
    </span>
  )
}

