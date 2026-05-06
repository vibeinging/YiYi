/**
 * MentionPicker — unified @-mention dropdown for agents + bots + workspace files
 * Agents appear first, then bots, then files.
 *
 * File matching: subsequence-fuzzy. Typing `prdc` matches `Product` and
 * `产品介绍` (the latter via path-component fallback). Exact prefix > word
 * prefix > scattered subsequence. Binary / large files still appear but
 * carry a small badge so the user (and reviewer) sees the warning.
 */

import { useRef, useEffect } from 'react';
import { Bot, FileText, Folder, FileCode, Image as ImageIcon } from 'lucide-react';
import type { WorkspaceFile } from '../api/workspace';
import type { BotInfo } from '../api/bots';
import type { AgentSummary } from '../api/agents';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']);
const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'rb',
  'php', 'swift', 'kt', 'lua', 'sh', 'bash', 'zsh', 'css', 'html', 'sql',
]);

function getFileIcon(file: WorkspaceFile) {
  if (file.is_dir) return Folder;
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (IMAGE_EXTS.has(ext)) return ImageIcon;
  if (CODE_EXTS.has(ext)) return FileCode;
  return FileText;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** A flattened mention item used for keyboard navigation indexing */
export type MentionItem =
  | { type: 'agent'; agent: AgentSummary }
  | { type: 'bot'; bot: BotInfo }
  | { type: 'file'; file: WorkspaceFile };

const MAX_AGENTS = 5;
const MAX_BOTS = 5;
const MAX_FILES = 8;

/**
 * Subsequence fuzzy score (≥ 0 means match, higher is better; -1 = no match).
 *  • Exact substring → big bonus
 *  • Match at word/path boundary → bonus
 *  • Adjacent matched chars → bonus (rewards contiguous spans)
 *  • Earlier matches > later matches
 * Fast enough for thousands of items; runs sync on each keystroke.
 */
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  // Exact substring is the strongest signal.
  const directIdx = h.indexOf(n);
  if (directIdx !== -1) {
    return 1000 - directIdx + (directIdx === 0 ? 100 : 0);
  }
  // Subsequence walk.
  let score = 0;
  let prevMatchedAt = -2;
  let ni = 0;
  for (let i = 0; i < h.length && ni < n.length; i++) {
    if (h[i] !== n[ni]) continue;
    let bonus = 1;
    if (i === prevMatchedAt + 1) bonus += 5;          // adjacent chars
    if (i === 0 || /[\s/_.\-]/.test(h[i - 1])) bonus += 3; // boundary
    score += bonus;
    prevMatchedAt = i;
    ni++;
  }
  return ni === n.length ? score : -1;
}

/** Build the filtered + flattened list used for display and keyboard nav */
export function buildMentionList(bots: BotInfo[], files: WorkspaceFile[], query: string, agents?: AgentSummary[]): MentionItem[] {
  const q = query.trim();
  const items: MentionItem[] = [];

  // Agents first
  if (agents) {
    const scored = agents
      .map(a => ({ a, s: q ? Math.max(fuzzyScore(a.name, q), fuzzyScore(a.description, q)) : 0 }))
      .filter(x => !q || x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_AGENTS);
    for (const { a } of scored) items.push({ type: 'agent', agent: a });
  }

  // Then bots
  const scoredBots = bots
    .filter(b => b.enabled)
    .map(b => ({ b, s: q ? Math.max(fuzzyScore(b.name, q), fuzzyScore(b.platform, q)) : 0 }))
    .filter(x => !q || x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_BOTS);
  for (const { b } of scoredBots) items.push({ type: 'bot', bot: b });

  // Then files — fuzzy on full path; tiebreak by directories-first then name.
  const scoredFiles = files
    .map(f => ({ f, s: q ? fuzzyScore(f.name, q) : 0 }))
    .filter(x => !q || x.s >= 0)
    .sort((a, b) => {
      if (q) return b.s - a.s;
      // No query → keep original order from backend (dirs-first, alpha).
      return 0;
    })
    .slice(0, MAX_FILES);
  for (const { f } of scoredFiles) items.push({ type: 'file', file: f });

  return items;
}

interface MentionPickerProps {
  bots: BotInfo[];
  files: WorkspaceFile[];
  query: string;
  selectedIndex: number;
  onSelectBot: (bot: BotInfo) => void;
  onSelectFile: (file: WorkspaceFile) => void;
  agents?: AgentSummary[];
  onSelectAgent?: (agent: AgentSummary) => void;
}

export function MentionPicker({ bots, files, query, selectedIndex, onSelectBot, onSelectFile, agents, onSelectAgent }: MentionPickerProps) {
  const activeRef = useRef<HTMLDivElement>(null);

  const items = buildMentionList(bots, files, query, agents);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (items.length === 0) {
    return (
      <div
        className="absolute left-0 right-0 bottom-full mb-1 rounded-xl overflow-hidden z-50"
        style={{
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border-strong)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div className="px-4 py-3 text-[13px]" style={{ color: 'var(--color-text-muted)' }}>
          No results
        </div>
      </div>
    );
  }

  // Determine section boundaries for labels
  const hasAgents = items.some(i => i.type === 'agent');
  const hasBots = items.some(i => i.type === 'bot');
  const hasFiles = items.some(i => i.type === 'file');
  const firstAgentIdx = items.findIndex(i => i.type === 'agent');
  const firstBotIdx = items.findIndex(i => i.type === 'bot');
  const firstFileIdx = items.findIndex(i => i.type === 'file');

  return (
    <div
      className="absolute left-0 right-0 bottom-full mb-1 rounded-xl overflow-hidden overflow-y-auto z-50"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border-strong)',
        boxShadow: 'var(--shadow-lg)',
        maxHeight: '360px',
      }}
    >
      {items.map((item, i) => {
        const isActive = i === selectedIndex;

        // Section labels
        const showAgentLabel = hasAgents && i === firstAgentIdx;
        const showBotLabel = hasBots && i === firstBotIdx;
        const showFileLabel = hasFiles && i === firstFileIdx;

        const itemKey = item.type === 'agent' ? `agent-${item.agent.name}` : item.type === 'bot' ? `bot-${item.bot.id}` : `file-${item.file.path}`;

        return (
          <div key={itemKey}>
            {showAgentLabel && (
              <div className="px-3 pt-2 pb-1">
                <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                  Agents
                </span>
              </div>
            )}
            {showBotLabel && (
              <div className="px-3 pt-2 pb-1" style={hasAgents ? { borderTop: '1px solid var(--color-border)' } : undefined}>
                <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                  Bots
                </span>
              </div>
            )}
            {showFileLabel && (
              <div className="px-3 pt-2 pb-1" style={(hasAgents || hasBots) ? { borderTop: '1px solid var(--color-border)' } : undefined}>
                <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                  Files
                </span>
              </div>
            )}
            <div
              ref={isActive ? activeRef : undefined}
              onClick={() => {
                if (item.type === 'agent') onSelectAgent?.(item.agent);
                else if (item.type === 'bot') onSelectBot(item.bot);
                else onSelectFile(item.file);
              }}
              className="flex items-center gap-2.5 px-3 py-2 mx-1 rounded-lg cursor-pointer transition-colors"
              style={{
                background: isActive ? 'var(--color-primary-subtle)' : 'transparent',
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.background = 'var(--color-bg-muted)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = isActive ? 'var(--color-primary-subtle)' : 'transparent';
              }}
            >
              {item.type === 'agent' ? (
                <>
                  <span
                    className="text-[15px] shrink-0 w-5 h-5 flex items-center justify-center rounded-md"
                    style={{ background: item.agent.color ? `${item.agent.color}22` : 'var(--color-bg-subtle)' }}
                  >
                    {item.agent.emoji}
                  </span>
                  <span
                    className="flex-1 text-[13px] truncate"
                    style={{ color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)' }}
                  >
                    {item.agent.name}
                  </span>
                  <span className="text-[11px] shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                    {item.agent.description.slice(0, 30)}{item.agent.description.length > 30 ? '...' : ''}
                  </span>
                </>
              ) : item.type === 'bot' ? (
                <>
                  <Bot
                    size={15}
                    style={{ color: 'var(--color-primary)', flexShrink: 0 }}
                  />
                  <span
                    className="flex-1 text-[13px] truncate"
                    style={{ color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)' }}
                  >
                    {item.bot.name}
                  </span>
                  <span className="text-[11px] shrink-0 px-1.5 py-0.5 rounded-md" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
                    {item.bot.platform}
                  </span>
                </>
              ) : (
                <>
                  {(() => { const Icon = getFileIcon(item.file); return <Icon size={15} style={{ color: item.file.is_dir ? 'var(--color-primary)' : 'var(--color-text-muted)', flexShrink: 0 }} />; })()}
                  <span
                    className="flex-1 text-[13px] truncate"
                    style={{ color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)' }}
                  >
                    {item.file.name}
                  </span>
                  {!item.file.is_dir && item.file.is_binary && (
                    <span
                      className="text-[10px] shrink-0 px-1.5 py-0.5 rounded font-medium"
                      style={{ background: 'var(--color-warning-subtle, rgba(245,158,11,0.15))', color: 'var(--color-warning, rgb(245,158,11))' }}
                      title="二进制文件，模型无法读取内容"
                    >
                      binary
                    </span>
                  )}
                  {!item.file.is_dir && item.file.is_large && (
                    <span
                      className="text-[10px] shrink-0 px-1.5 py-0.5 rounded font-medium"
                      style={{ background: 'rgba(239,68,68,0.12)', color: 'rgb(239,68,68)' }}
                      title={`${formatSize(item.file.size)} — 选中后会消耗大量上下文`}
                    >
                      large
                    </span>
                  )}
                  {!item.file.is_dir && (
                    <span className="text-[11px] shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                      {formatSize(item.file.size)}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}

      <div className="px-3 pt-1 pb-2">
        <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
          ↑↓ navigate · Enter select · Esc close
        </span>
      </div>
    </div>
  );
}
