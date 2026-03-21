/**
 * Individual bot display card with status, actions, and expandable details
 */

import { useTranslation } from 'react-i18next';
import {
  Trash2,
  Edit,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import type { BotInfo, BotStatusInfo } from '../../api/bots';
import { PLATFORM_META } from './platformMeta';
import { StatusDot } from './StatusDot';

interface BotCardProps {
  bot: BotInfo;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  status?: BotStatusInfo;
  getPlatformName: (platform: string) => string;
}

export function BotCard({
  bot,
  isExpanded,
  onToggleExpand,
  onEdit,
  onDelete,
  onToggleEnabled,
  status,
  getPlatformName,
}: BotCardProps) {
  const { t } = useTranslation();
  const meta = PLATFORM_META[bot.platform] || PLATFORM_META.webhook;

  return (
    <div
      className="rounded-2xl border transition-all"
      style={{
        background: 'var(--color-bg-elevated)',
        borderColor: isExpanded ? meta.color + '40' : 'var(--color-border)',
        boxShadow: isExpanded ? `0 0 0 1px ${meta.color}20` : 'none',
        opacity: bot.enabled ? 1 : 0.6,
      }}
    >
      {/* Header row */}
      <div
        className="flex items-center gap-4 px-5 py-4 cursor-pointer select-none"
        onClick={onToggleExpand}
      >
        {/* Icon */}
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0"
          style={{ background: meta.color + '15' }}
        >
          {meta.icon}
        </div>

        {/* Name + platform */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="font-semibold text-[15px]" style={{ color: 'var(--color-text)' }}>
              {bot.name}
            </span>
            {/* Connection status dot */}
            <StatusDot
              state={status?.state || ('disconnected')}
              message={status?.message}
            />
            <span
              className="text-[11px] px-2 py-0.5 rounded-full font-medium"
              style={{
                background: bot.enabled ? 'var(--color-success)' + '18' : 'var(--color-text-muted)' + '18',
                color: bot.enabled ? 'var(--color-success)' : 'var(--color-text-muted)',
              }}
            >
              {bot.enabled ? t('bots.enabled') : t('bots.disabled')}
            </span>
          </div>
          <div className="text-[12px] mt-0.5 flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
            <span>{getPlatformName(bot.platform)}</span>
            <span className="opacity-50">·</span>
            <span className="font-mono text-[11px]">{bot.id.slice(0, 8)}...</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {/* Toggle */}
          <label className="relative inline-flex items-center shrink-0">
            <input
              type="checkbox"
              checked={bot.enabled}
              onChange={onToggleEnabled}
              className="sr-only peer"
            />
            <div
              className="w-10 h-[22px] rounded-full transition-colors duration-200 peer-checked:bg-[var(--color-success)] cursor-pointer"
              style={{ background: bot.enabled ? undefined : 'var(--color-bg-muted)' }}
            >
              <div
                className="absolute top-[3px] left-[3px] w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200"
                style={{ transform: bot.enabled ? 'translateX(18px)' : 'translateX(0)' }}
              />
            </div>
          </label>

          <button
            onClick={onEdit}
            className="p-2 rounded-lg transition-colors"
            style={{ color: 'var(--color-text-secondary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Edit size={15} />
          </button>
          <button
            onClick={onDelete}
            className="p-2 rounded-lg transition-colors"
            style={{ color: 'var(--color-error)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-error)' + '10'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Trash2 size={15} />
          </button>
        </div>

        {/* Expand arrow */}
        <div style={{ color: 'var(--color-text-muted)' }}>
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div className="px-5 pb-5 pt-0">
          <div className="h-px mb-4" style={{ background: 'var(--color-border)' }} />

          {/* Doc link */}
          {meta.docUrl && (
            <button
              onClick={() => open(meta.docUrl)}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium mb-4 transition-opacity hover:opacity-80"
              style={{ color: meta.color }}
            >
              <ExternalLink size={14} />
              {meta.docLabel}
            </button>
          )}

          {/* Config fields (read-only display) */}
          <div className="space-y-2">
            {meta.configFields.map((field) => {
              const val = (bot.config as any)?.[field.key];
              return (
                <div key={field.key} className="flex items-center gap-3">
                  <span className="text-[12px] font-medium w-28 shrink-0" style={{ color: 'var(--color-text-secondary)' }}>
                    {field.label}
                  </span>
                  <span className="text-[13px] font-mono truncate" style={{ color: val ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
                    {val ? (field.secret ? '••••••••' : String(val)) : '(not set)'}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Edit button */}
          <div className="mt-4 flex justify-end">
            <button
              onClick={onEdit}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-medium transition-colors text-white"
              style={{ background: meta.color }}
            >
              <Edit size={14} />
              {t('common.edit')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
