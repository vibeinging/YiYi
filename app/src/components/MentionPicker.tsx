/**
 * MentionPicker — unified @-mention dropdown for agents + bots + workspace files
 * Agents appear first, then bots, then files.
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

/** Build the filtered + flattened list used for display and keyboard nav */
export function buildMentionList(bots: BotInfo[], files: WorkspaceFile[], query: string, agents?: AgentSummary[]): MentionItem[] {
  const q = query.toLowerCase();
  const items: MentionItem[] = [];

  // Agents first
  if (agents) {
    const filteredAgents = agents
      .filter(a => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
      .slice(0, MAX_AGENTS);
    for (const agent of filteredAgents) {
      items.push({ type: 'agent', agent });
    }
  }

  // Then bots
  const filteredBots = bots
    .filter(b => b.enabled)
    .filter(b => !q || b.name.toLowerCase().includes(q) || b.platform.toLowerCase().includes(q))
    .slice(0, MAX_BOTS);
  for (const bot of filteredBots) {
    items.push({ type: 'bot', bot });
  }

  // Then files
  const filteredFiles = files
    .filter(f => !q || f.name.toLowerCase().includes(q))
    .slice(0, MAX_FILES);
  for (const file of filteredFiles) {
    items.push({ type: 'file', file });
  }

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
