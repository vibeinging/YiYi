/**
 * GrowthSuggestionsBubble — pop-out card above the Buddy sprite listing
 * pending growth proposals from the white-box Inbox.
 *
 * Data source: `inbox_items` (SQLite, kind='skill_create'). Approve writes
 * SKILL.md via `approve_inbox_item`; reject marks the row rejected; snooze
 * is purely UI-side (stored in `useInboxStore.snoozedUntil`).
 */
import React, { useMemo, useState } from 'react';
import { Sparkles, X, Save, Clock, Pencil, Check, Trash2, Loader2 } from 'lucide-react';
import { useInboxStore } from '../../stores/inboxStore';
import {
  approveInboxItem,
  parseSkillDraft,
  rejectInboxItem,
  type InboxItem,
  type SkillDraft,
} from '../../api/inbox';
import { toast } from '../Toast';

interface Props {
  onClose: () => void;
  flipRight?: boolean;
}

export const GrowthSuggestionsBubble: React.FC<Props> = ({ onClose, flipRight }) => {
  const pending = useInboxStore((s) => s.pending);
  const snoozedUntil = useInboxStore((s) => s.snoozedUntil);
  const removeLocal = useInboxStore((s) => s.removeLocal);
  const snooze = useInboxStore((s) => s.snooze);
  const refresh = useInboxStore((s) => s.refresh);

  const visible = useMemo(() => {
    const now = Date.now();
    return pending
      .map((item) => ({ item, draft: parseSkillDraft(item) }))
      .filter(({ item, draft }) => {
        if (!draft) return false;
        const until = snoozedUntil[item.id];
        return !until || until <= now;
      });
  }, [pending, snoozedUntil]);

  const [expandedId, setExpandedId] = useState<string | null>(visible[0]?.item.id ?? null);
  const [editingName, setEditingName] = useState<Record<string, string>>({});
  const [actingOn, setActingOn] = useState<string | null>(null);

  if (visible.length === 0) return null;

  const handleApprove = async (item: InboxItem, draft: SkillDraft) => {
    setActingOn(item.id);
    try {
      const finalName = (editingName[item.id] ?? draft.name).trim();
      if (!finalName) {
        toast.error('名称不能为空');
        setActingOn(null);
        return;
      }
      // If the user renamed, splice the new name into the draft content's
      // `name:` frontmatter line before sending it back as edited content.
      let editedContent: string | undefined;
      if (finalName !== draft.name) {
        editedContent = draft.content.replace(
          /^name:\s*.+$/m,
          `name: ${finalName}`,
        );
      }
      await approveInboxItem(item.id, editedContent);
      toast.success(`已学会「${finalName}」`);
      removeLocal(item.id);
      refresh();
    } catch (e) {
      toast.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActingOn(null);
    }
  };

  const handleReject = async (item: InboxItem) => {
    setActingOn(item.id);
    try {
      await rejectInboxItem(item.id);
      removeLocal(item.id);
    } catch (e) {
      toast.error(`否决失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActingOn(null);
    }
  };

  return (
    <div
      className="absolute bottom-full mb-4"
      style={{
        ...(flipRight ? { left: 0 } : { right: 0 }),
        width: 300,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="rounded-xl overflow-hidden"
        style={{
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border-strong, rgba(255,255,255,0.14))',
          boxShadow: '0 12px 32px rgba(0,0,0,0.3)',
          backdropFilter: 'blur(18px)',
          animation: 'buddy-bubble-in 0.22s ease-out',
        }}
      >
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <Sparkles size={13} style={{ color: '#A78BFA' }} />
          <span
            className="flex-1 text-[12px] font-semibold"
            style={{ color: 'var(--color-text)' }}
          >
            成长建议
            <span
              className="ml-1.5 text-[10px] font-normal"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {visible.length}
            </span>
          </span>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10"
            title="关闭"
          >
            <X size={13} style={{ color: 'var(--color-text-muted)' }} />
          </button>
        </div>

        <div className="max-h-[420px] overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          {visible.map(({ item, draft }) => {
            if (!draft) return null;
            const expanded = expandedId === item.id;
            const displayName = editingName[item.id] ?? draft.name;
            const busy = actingOn === item.id;
            return (
              <div
                key={item.id}
                className="px-3 py-2.5"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <button
                  onClick={() => setExpandedId(expanded ? null : item.id)}
                  className="w-full flex items-center gap-2 text-left"
                >
                  <span
                    className="shrink-0 text-[10px] font-semibold px-1.5 py-[1px] rounded-md"
                    style={{
                      color: '#A78BFA',
                      background: 'color-mix(in srgb, #A78BFA 14%, transparent)',
                    }}
                  >
                    技能
                  </span>
                  <span
                    className="flex-1 truncate text-[12.5px] font-medium"
                    style={{ color: 'var(--color-text)' }}
                  >
                    {displayName}
                  </span>
                </button>

                {!expanded && draft.reason && (
                  <div
                    className="text-[11px] mt-0.5 pl-1 truncate"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {draft.reason}
                  </div>
                )}

                {expanded && (
                  <div className="mt-2 space-y-2">
                    <div>
                      <label
                        className="text-[10px]"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        名称
                      </label>
                      <input
                        value={displayName}
                        onChange={(e) =>
                          setEditingName((m) => ({ ...m, [item.id]: e.target.value }))
                        }
                        className="w-full mt-0.5 px-2 py-1 rounded text-[12px] outline-none"
                        style={{
                          background: 'var(--color-bg)',
                          color: 'var(--color-text)',
                          border: '1px solid var(--color-border-strong, rgba(255,255,255,0.14))',
                        }}
                      />
                    </div>

                    {draft.description && (
                      <div>
                        <label
                          className="text-[10px]"
                          style={{ color: 'var(--color-text-muted)' }}
                        >
                          描述
                        </label>
                        <div
                          className="text-[11.5px] mt-0.5 p-2 rounded leading-relaxed"
                          style={{
                            background: 'var(--color-bg-subtle)',
                            color: 'var(--color-text-secondary)',
                            maxHeight: '120px',
                            overflowY: 'auto',
                          }}
                        >
                          {draft.description}
                        </div>
                      </div>
                    )}

                    {draft.reason && (
                      <div
                        className="text-[11px]"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        <Pencil size={10} className="inline mr-1 -mt-0.5" />
                        {draft.reason}
                      </div>
                    )}

                    <div className="flex items-center gap-1.5 pt-1">
                      <button
                        onClick={() => handleApprove(item, draft)}
                        disabled={busy}
                        className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[11.5px] font-semibold transition-colors disabled:opacity-60"
                        style={{ background: 'var(--color-primary)', color: '#fff' }}
                      >
                        {busy ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Save size={12} />
                        )}
                        {busy ? '保存中' : '保存'}
                      </button>
                      <button
                        onClick={() => snooze(item.id, 24)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11.5px] transition-colors"
                        style={{
                          background: 'var(--color-bg-subtle)',
                          color: 'var(--color-text-secondary)',
                        }}
                        title="稍后（24h）"
                      >
                        <Clock size={11} />
                      </button>
                      <button
                        onClick={() => handleReject(item)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11.5px] transition-colors"
                        style={{
                          background: 'var(--color-bg-subtle)',
                          color: 'var(--color-error)',
                        }}
                        title="丢弃"
                      >
                        {busy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div
          className="absolute top-full w-0 h-0"
          style={{
            ...(flipRight ? { left: 14 } : { right: 14 }),
            borderLeft: '6px solid transparent',
            borderRight: '6px solid transparent',
            borderTop: '6px solid var(--color-border-strong, rgba(255,255,255,0.14))',
          }}
        />
      </div>
    </div>
  );
};
