/**
 * InboxPanel — White-box co-construction inbox.
 * Agent-proposed growth drafts (currently skill_create) wait here for user review.
 * See docs/design/2026-05-11_growth-v3-白盒共建.md.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check, ChevronDown, ChevronUp, Inbox as InboxIcon,
  Loader2, Sparkles, X,
} from 'lucide-react'
import {
  approveInboxItem, listInboxItems, parseEvidence, parseSkillDraft,
  rejectInboxItem,
  type InboxItem,
} from '../../api/inbox'
import { toast } from '../Toast'

interface InboxPanelProps {
  /** Accent color from companion palette — keeps Inbox visually tied to the buddy identity. */
  accent: string
  /** Companion name — used in copy like "她想跟你商量". */
  buddyName: string
}

export function InboxPanel({ accent, buddyName }: InboxPanelProps) {
  const [items, setItems] = useState<InboxItem[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [actingOn, setActingOn] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await listInboxItems('pending', 50)
      setItems(list)
    } catch (e) {
      console.error('inbox list failed', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleApprove = useCallback(async (item: InboxItem) => {
    setActingOn(item.id)
    try {
      await approveInboxItem(item.id)
      toast.success(`${buddyName}学会了一招 ✨`)
      setItems(prev => prev.filter(i => i.id !== item.id))
    } catch (e) {
      toast.error(`批准失败：${String(e)}`)
    } finally {
      setActingOn(null)
    }
  }, [buddyName])

  const handleReject = useCallback(async (item: InboxItem) => {
    setActingOn(item.id)
    try {
      await rejectInboxItem(item.id)
      setItems(prev => prev.filter(i => i.id !== item.id))
    } catch (e) {
      toast.error(`否决失败：${String(e)}`)
    } finally {
      setActingOn(null)
    }
  }, [])

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Hide entire panel when empty — proposes happen via the settings drawer "让她翻翻" action.
  if (loading || items.length === 0) return null

  return (
    <div
      className="p-5 rounded-2xl"
      style={{ background: 'var(--color-bg-elevated)' }}
    >
      <div className="flex items-center gap-2 mb-3">
        <InboxIcon size={15} style={{ color: accent }} />
        <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>
          {buddyName}想跟你商量 {items.length} 件事
        </h2>
      </div>

      <div className="space-y-2.5">
        {items.map(item => (
          <InboxCard
            key={item.id}
            item={item}
            accent={accent}
            buddyName={buddyName}
            expanded={expanded.has(item.id)}
            busy={actingOn === item.id}
            onToggle={() => toggleExpand(item.id)}
            onApprove={() => handleApprove(item)}
            onReject={() => handleReject(item)}
          />
        ))}
      </div>
    </div>
  )
}

interface InboxCardProps {
  item: InboxItem
  accent: string
  buddyName: string
  expanded: boolean
  busy: boolean
  onToggle: () => void
  onApprove: () => void
  onReject: () => void
}

function InboxCard({ item, accent, buddyName, expanded, busy, onToggle, onApprove, onReject }: InboxCardProps) {
  const draft = useMemo(() => parseSkillDraft(item), [item])
  const evidence = useMemo(() => parseEvidence(item), [item])

  if (!draft) {
    return (
      <div className="p-3 rounded-lg" style={{ background: 'var(--color-bg-subtle)' }}>
        <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
          未知草稿 ({item.kind}) — {item.id.slice(0, 8)}
        </div>
        <button onClick={onReject} className="mt-2 text-[11px]" style={{ color: 'var(--color-error)' }}>
          先放着不管
        </button>
      </div>
    )
  }

  const confColor =
    draft.confidence >= 0.8 ? 'var(--color-success)' :
    draft.confidence >= 0.5 ? '#FBBF24' :
    'var(--color-text-muted)'

  return (
    <div
      className="relative rounded-xl overflow-hidden"
      style={{ background: 'var(--color-bg-subtle)' }}
    >
      {/* Confidence accent strip — wider, more visible */}
      <div className="absolute left-0 top-0 bottom-0 w-1" style={{ background: confColor }} />

      <div className="pl-4 pr-3 py-3">
        {/* Headline: "她想把 X 固化为技能" */}
        <div className="flex items-baseline gap-2 mb-1.5">
          <Sparkles size={12} style={{ color: accent }} className="self-center" />
          <div className="text-[13px] leading-snug flex-1" style={{ color: 'var(--color-text)' }}>
            {buddyName}想把
            <span className="font-semibold mx-1" style={{ color: accent }}>{draft.name}</span>
            固化为技能
          </div>
          <span
            className="text-[10px] tabular-nums shrink-0 px-1.5 py-0.5 rounded-full"
            style={{ background: `${confColor}20`, color: confColor }}
            title="她对这个提议的信心"
          >
            {Math.round(draft.confidence * 100)}%
          </span>
        </div>

        {/* Description */}
        <div className="text-[12px] mb-2 leading-relaxed pl-5" style={{ color: 'var(--color-text-secondary)' }}>
          {draft.description}
        </div>

        {/* Her reason */}
        <div
          className="text-[11px] mb-2 leading-relaxed p-2 rounded-md ml-5"
          style={{
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-text-secondary)',
          }}
        >
          <span className="opacity-70">{buddyName}说：</span>{draft.reason}
          {evidence && (
            <div className="text-[10px] mt-1 leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
              出现过 {evidence.occurrence_count} 次（{evidence.session_ids.length} 个会话） · {evidence.tools.join(' → ')}
            </div>
          )}
        </div>

        {/* Expandable draft preview */}
        <button
          onClick={onToggle}
          className="text-[11px] flex items-center gap-1 mb-2 ml-5 transition-colors hover:opacity-100"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {expanded ? '收起她写的草稿' : '看看她写的草稿'}
        </button>
        {expanded && (
          <pre
            className="text-[11px] p-2 rounded-md mb-2 ml-5 overflow-x-auto whitespace-pre-wrap leading-relaxed"
            style={{
              background: 'var(--color-bg-elevated)',
              color: 'var(--color-text-secondary)',
              maxHeight: 260,
              overflowY: 'auto',
            }}
          >
            {draft.content}
          </pre>
        )}

        {/* Actions — approve is primary (bigger/bolder), reject is ghost */}
        <div className="flex items-center gap-2 ml-5">
          <button
            onClick={onApprove}
            disabled={busy}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12px] font-semibold transition-all hover:scale-[1.03] active:scale-[0.97] disabled:opacity-60"
            style={{ background: accent, color: '#fff', boxShadow: `0 1px 4px ${accent}40` }}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            好，学吧
          </button>
          <button
            onClick={onReject}
            disabled={busy}
            className="flex items-center gap-1 px-2.5 py-2 rounded-lg text-[11px] transition-colors hover:bg-[var(--color-bg-elevated)] disabled:opacity-60"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <X size={11} />
            算了
          </button>
          <span className="ml-auto text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
            {formatRelative(item.created_at)}
          </span>
        </div>
      </div>
    </div>
  )
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  return `${day} 天前`
}
