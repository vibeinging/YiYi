/**
 * GrowthSuggestionsBubble — pop-out card above the Buddy sprite listing
 * pending "save as skill / code / workflow" suggestions.
 *
 * Two modes per suggestion:
 *   • collapsed row (name + type chip + glance-value reason)
 *   • expanded card (full description, editable name, save / discard / snooze)
 *
 * Rendered conditionally by <BuddySprite> when the store has visible pending
 * suggestions. Dismissing the bubble doesn't clear the store — only acting
 * on a suggestion does.
 */
import React, { useMemo, useState } from 'react';
import { Sparkles, X, Save, Clock, Pencil, Check, Trash2, Loader2 } from 'lucide-react';
import {
  useGrowthSuggestionsStore,
  type GrowthSuggestion,
  type SuggestionType,
} from '../../stores/growthSuggestionsStore';
import { createSkill } from '../../api/skills';
import { toast } from '../Toast';

const TYPE_LABEL: Record<SuggestionType, string> = {
  skill: '技能',
  code: '代码工具',
  workflow: '工作流',
};

const TYPE_COLOR: Record<SuggestionType, string> = {
  skill: '#A78BFA',
  code: '#38BDF8',
  workflow: '#FCD34D',
};

interface Props {
  onClose: () => void;
  flipRight?: boolean;
}

export const GrowthSuggestionsBubble: React.FC<Props> = ({ onClose, flipRight }) => {
  // Select stable fields — calling s.visiblePending() returns a fresh array
  // every render and trips zustand into an infinite re-render loop (which
  // unmounts the whole app tree and shows a blank/dark screen).
  const pending = useGrowthSuggestionsStore((s) => s.pending);
  const snoozedUntil = useGrowthSuggestionsStore((s) => s.snoozedUntil);
  const remove = useGrowthSuggestionsStore((s) => s.remove);
  const snooze = useGrowthSuggestionsStore((s) => s.snooze);
  const recordSave = useGrowthSuggestionsStore((s) => s.recordSave);

  const visible = useMemo(() => {
    const now = Date.now();
    return pending.filter((s) => {
      const until = snoozedUntil[s.id];
      return !until || until <= now;
    });
  }, [pending, snoozedUntil]);

  const [expandedId, setExpandedId] = useState<string | null>(
    visible[0]?.id ?? null,
  );
  const [editingName, setEditingName] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  if (visible.length === 0) return null;

  const handleSave = async (s: GrowthSuggestion) => {
    const finalName = (editingName[s.id] ?? s.name).trim();
    if (!finalName) {
      toast.error('名称不能为空');
      return;
    }
    setSavingId(s.id);
    try {
      const content = buildSkillMarkdown(s, finalName);
      await createSkill(finalName, content);
      recordSave(finalName, content);
      remove(s.id);
      toast.success(`已保存「${finalName}」到技能库`);
    } catch (e) {
      toast.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingId(null);
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
        {/* Header */}
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

        {/* List */}
        <div className="max-h-[420px] overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          {visible.map((s) => {
            const expanded = expandedId === s.id;
            const color = TYPE_COLOR[s.type];
            const displayName = editingName[s.id] ?? s.name;
            return (
              <div
                key={s.id}
                className="px-3 py-2.5"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                {/* Row header — always visible */}
                <button
                  onClick={() => setExpandedId(expanded ? null : s.id)}
                  className="w-full flex items-center gap-2 text-left"
                >
                  <span
                    className="shrink-0 text-[10px] font-semibold px-1.5 py-[1px] rounded-md"
                    style={{
                      color,
                      background: `color-mix(in srgb, ${color} 14%, transparent)`,
                    }}
                  >
                    {TYPE_LABEL[s.type]}
                  </span>
                  <span
                    className="flex-1 truncate text-[12.5px] font-medium"
                    style={{ color: 'var(--color-text)' }}
                  >
                    {displayName}
                  </span>
                </button>

                {!expanded && s.reason && (
                  <div
                    className="text-[11px] mt-0.5 pl-1 truncate"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {s.reason}
                  </div>
                )}

                {expanded && (
                  <div className="mt-2 space-y-2">
                    {/* Editable name */}
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
                          setEditingName((m) => ({ ...m, [s.id]: e.target.value }))
                        }
                        className="w-full mt-0.5 px-2 py-1 rounded text-[12px] outline-none"
                        style={{
                          background: 'var(--color-bg)',
                          color: 'var(--color-text)',
                          border: '1px solid var(--color-border-strong, rgba(255,255,255,0.14))',
                        }}
                      />
                    </div>

                    {/* Description (read-only preview) */}
                    {s.description && (
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
                          {s.description}
                        </div>
                      </div>
                    )}

                    {s.reason && (
                      <div
                        className="text-[11px]"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        <Pencil size={10} className="inline mr-1 -mt-0.5" />
                        {s.reason}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 pt-1">
                      <button
                        onClick={() => handleSave(s)}
                        disabled={savingId === s.id}
                        className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[11.5px] font-semibold transition-colors disabled:opacity-60"
                        style={{
                          background: 'var(--color-primary)',
                          color: '#fff',
                        }}
                      >
                        {savingId === s.id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Save size={12} />
                        )}
                        {savingId === s.id ? '保存中' : '保存'}
                      </button>
                      <button
                        onClick={() => snooze(s.id, 24)}
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
                        onClick={() => remove(s.id)}
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11.5px] transition-colors"
                        style={{
                          background: 'var(--color-bg-subtle)',
                          color: 'var(--color-error)',
                        }}
                        title="丢弃"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Tail */}
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

/**
 * Compose the minimum valid SKILL.md content from a suggestion.
 * User can rename / refine later via Settings → Skills.
 */
function buildSkillMarkdown(s: GrowthSuggestion, finalName: string): string {
  const lines: string[] = ['---'];
  lines.push(`name: "${finalName}"`);
  if (s.description) lines.push(`description: "${s.description.replace(/"/g, '\\"')}"`);
  lines.push('metadata:');
  lines.push('  yiyi:');
  lines.push(`    source: growth-suggestion`);
  if (s.sessionId) lines.push(`    origin_session: "${s.sessionId}"`);
  if (s.taskId) lines.push(`    origin_task: "${s.taskId}"`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${finalName}`);
  lines.push('');
  if (s.description) {
    lines.push(s.description);
    lines.push('');
  }
  if (s.reason) {
    lines.push(`> ${s.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}
