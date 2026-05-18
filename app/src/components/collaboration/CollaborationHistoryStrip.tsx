/**
 * CollaborationHistoryStrip — a thin row above the chat input showing
 * past collaborations for the current session. Each entry is a
 * double-line bordered chip that, when clicked, opens the full
 * CollaborationPanel for replay.
 *
 * Phase 2B minimal version: only listing + click-to-reopen. Per-step
 * replay (per design doc UX mockup) is part of CollaborationPanel
 * itself; the strip is just the entry point.
 */

import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import {
  isTerminalStatus,
  listRecentCollaborations,
  type Collaboration,
  type CollaborationId,
} from '../../api/collaboration'

interface Props {
  chatSessionId: string
  onOpen: (id: CollaborationId) => void
  /** Bump this to force a re-fetch (e.g. after a new collaboration ends). */
  reloadToken?: number
}

export function CollaborationHistoryStrip({
  chatSessionId,
  onOpen,
  reloadToken = 0,
}: Props) {
  const [items, setItems] = useState<Collaboration[] | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    listRecentCollaborations(chatSessionId, 10)
      .then(list => {
        if (!cancelled) setItems(list)
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
    return () => {
      cancelled = true
    }
  }, [chatSessionId, reloadToken])

  if (!items || items.length === 0) return null

  const terminalItems = items.filter(c => isTerminalStatus(c.status))
  if (terminalItems.length === 0) return null

  return (
    <div className="px-4 py-2" style={{ background: 'var(--color-bg)' }}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1.5 text-[11px] transition-colors hover:text-[var(--color-text)]"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <Sparkles size={11} />
        本会话有 {terminalItems.length} 个历史协作 {expanded ? '▾' : '▸'}
      </button>
      {expanded && (
        <div className="flex flex-wrap gap-2 mt-2">
          {terminalItems.map(c => (
            <HistoryChip key={c.id} collab={c} onOpen={() => onOpen(c.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function HistoryChip({
  collab,
  onOpen,
}: {
  collab: Collaboration
  onOpen: () => void
}) {
  // Participants from each step's first participant — a quick visual of
  // who took part. Multi-participant ParallelAgents steps (Phase 2C) get
  // all listed.
  const emojis = new Set<string>()
  for (const step of collab.plan.steps) {
    for (const p of step.participants) emojis.add(p.avatar_emoji)
  }
  const tag =
    collab.status.state === 'done'
      ? '✓'
      : collab.status.state === 'aborted'
        ? '✕'
        : collab.status.state === 'failed'
          ? '⚠'
          : '·'
  return (
    <button
      onClick={onOpen}
      className="text-left p-2 rounded-lg text-[11px] transition-all hover:shadow-sm"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '2px double var(--color-border)',
        color: 'var(--color-text-secondary)',
        minWidth: 200,
        maxWidth: 280,
      }}
      title={collab.intent}
    >
      <div className="flex items-center gap-1 mb-0.5">
        <span style={{ color: 'var(--color-text-muted)' }}>{tag}</span>
        {[...emojis].map(e => (
          <span key={e}>{e}</span>
        ))}
      </div>
      <div className="truncate" style={{ color: 'var(--color-text)' }}>
        {collab.intent}
      </div>
    </button>
  )
}
