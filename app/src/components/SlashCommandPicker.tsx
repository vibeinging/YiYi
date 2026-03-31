/**
 * SlashCommandPicker — dropdown for / commands in chat input
 */

import { useRef, useEffect } from 'react';
import { Trash2, Puzzle, ClipboardList, type LucideIcon } from 'lucide-react';

export interface SlashCommand {
  name: string;
  description: string;
  icon: LucideIcon;
  /** true if command takes arguments after the name */
  hasArgs?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'chat.command.clearDesc', icon: Trash2 },
  { name: 'skills', description: 'chat.command.skillsDesc', icon: Puzzle },
  { name: 'task', description: 'chat.command.taskDesc', icon: ClipboardList, hasArgs: true },
];

export function filterCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((cmd) => cmd.name.includes(q));
}

interface SlashCommandPickerProps {
  query: string;
  selectedIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  t: (key: string) => string;
}

export function SlashCommandPicker({ query, selectedIndex, onSelect, t }: SlashCommandPickerProps) {
  const activeRef = useRef<HTMLDivElement>(null);
  const items = filterCommands(query);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (items.length === 0) return null;

  return (
    <div
      className="absolute left-0 right-0 bottom-full mb-1 rounded-xl overflow-hidden z-50"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border-strong)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div className="px-3 pt-2 pb-1">
        <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          {t('chat.command.title')}
        </span>
      </div>

      {items.map((cmd, i) => {
        const isActive = i === selectedIndex;
        const Icon = cmd.icon;
        return (
          <div
            key={cmd.name}
            ref={isActive ? activeRef : undefined}
            onClick={() => onSelect(cmd)}
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
            <Icon size={15} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
            <span className="text-[13px] font-medium" style={{ color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)' }}>
              /{cmd.name}
            </span>
            <span className="text-[12px] ml-1" style={{ color: 'var(--color-text-muted)' }}>
              {t(cmd.description)}
            </span>
          </div>
        );
      })}

      <div className="px-3 pt-1 pb-2">
        <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
          ↑↓ {t('chat.command.navigate')} · Enter {t('chat.command.select')} · Esc {t('chat.command.close')}
        </span>
      </div>
    </div>
  );
}
