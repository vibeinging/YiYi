/**
 * Bot create/edit form dialog
 */

import { useTranslation } from 'react-i18next';
import {
  X,
  ExternalLink,
  Sparkles,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { Select } from '../Select';
import { BotSetupGuide, hasSetupGuide } from '../BotSetupGuide';
import type { PlatformType } from '../../api/bots';
import { PLATFORM_META } from './platformMeta';

export interface BotDialog {
  open: boolean;
  mode: 'create' | 'edit';
  id: string;
  name: string;
  platform: PlatformType;
  config: Record<string, string>;
  enabled: boolean;
}

export const emptyDialog: BotDialog = {
  open: false,
  mode: 'create',
  id: '',
  name: '',
  platform: 'discord',
  config: {},
  enabled: true,
};

interface BotFormDialogProps {
  dialog: BotDialog;
  saving: boolean;
  onDialogChange: (dialog: BotDialog) => void;
  onClose: () => void;
  onSave: () => void;
  getPlatformName: (platform: string) => string;
}

export function BotFormDialog({
  dialog,
  saving,
  onDialogChange,
  onClose,
  onSave,
  getPlatformName,
}: BotFormDialogProps) {
  const { t } = useTranslation();
  const showGuide = dialog.mode === 'create' && hasSetupGuide(dialog.platform);
  const isZh = t('bots.title') !== 'Bots';

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div
        className={`rounded-3xl p-6 w-full shadow-2xl border max-h-[85vh] overflow-y-auto transition-all ${
          showGuide ? 'max-w-2xl' : 'max-w-md'
        }`}
        style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-semibold text-[15px]">
            {dialog.mode === 'create' ? t('bots.createTitle') : t('bots.editTitle')}
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-xl transition-colors"
            style={{ color: 'var(--color-text-secondary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
              {t('bots.botName')} *
            </label>
            <input
              type="text"
              value={dialog.name}
              onChange={(e) => onDialogChange({ ...dialog, name: e.target.value })}
              placeholder={t('bots.botNamePlaceholder')}
              className="w-full rounded-xl border px-4 py-2.5 text-[13px] focus:outline-none focus:ring-2 transition-shadow"
              style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
            />
          </div>

          {/* Platform -- card-style selector for create mode */}
          <div>
            <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
              {t('bots.platform')} *
            </label>
            {dialog.mode === 'create' ? (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {Object.keys(PLATFORM_META).map((p) => {
                  const meta = PLATFORM_META[p];
                  const isActive = dialog.platform === p;
                  const hasGuide = hasSetupGuide(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => onDialogChange({ ...dialog, platform: p as PlatformType, config: {} })}
                      className="relative flex flex-col items-center gap-1.5 px-2 py-3 rounded-xl border text-center transition-all"
                      style={{
                        borderColor: isActive ? meta.color : 'var(--color-border)',
                        background: isActive ? meta.color + '08' : 'var(--color-bg)',
                        boxShadow: isActive ? `0 0 0 1px ${meta.color}40` : 'none',
                      }}
                    >
                      <span className="text-xl leading-none">{meta.icon}</span>
                      <span
                        className="text-[11px] font-medium leading-tight"
                        style={{ color: isActive ? meta.color : 'var(--color-text-secondary)' }}
                      >
                        {getPlatformName(p)}
                      </span>
                      {hasGuide && (
                        <span
                          className="absolute -top-1.5 -right-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold text-white shadow-sm"
                          style={{ background: 'linear-gradient(135deg, var(--color-primary), #A855F7)' }}
                        >
                          <Sparkles size={8} />
                          AI
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <Select
                value={dialog.platform}
                onChange={(v) => onDialogChange({ ...dialog, platform: v as PlatformType, config: {} })}
                options={Object.keys(PLATFORM_META).map((p) => ({
                  value: p,
                  label: `${PLATFORM_META[p].icon} ${getPlatformName(p)}`,
                }))}
                fullWidth
                disabled
              />
            )}
          </div>

          {/* Guided setup wizard for supported platforms */}
          {showGuide ? (
            <BotSetupGuide
              platform={dialog.platform as 'feishu' | 'dingtalk' | 'wecom'}
              config={dialog.config}
              onConfigChange={(c) => onDialogChange({ ...dialog, config: c })}
              onComplete={onSave}
              lang={isZh ? 'zh' : 'en'}
            />
          ) : (
            <>
              {/* Platform doc link */}
              {PLATFORM_META[dialog.platform]?.docUrl && (
                <div
                  className="flex items-center gap-3 px-4 py-3 rounded-xl"
                  style={{ background: PLATFORM_META[dialog.platform].color + '08', border: `1px solid ${PLATFORM_META[dialog.platform].color}20` }}
                >
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-base shrink-0"
                    style={{ background: PLATFORM_META[dialog.platform].color + '15' }}
                  >
                    {PLATFORM_META[dialog.platform].icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
                      {t('bots.platformDocHint')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => open(PLATFORM_META[dialog.platform].docUrl)}
                    className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-opacity hover:opacity-80 text-white"
                    style={{ background: PLATFORM_META[dialog.platform].color }}
                  >
                    <ExternalLink size={12} />
                    {t('bots.platformDoc')}
                  </button>
                </div>
              )}

              {/* Platform config fields */}
              <div>
                <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('bots.config')}
                </label>
                <div className="space-y-3">
                  {(PLATFORM_META[dialog.platform]?.configFields || []).map((field) => (
                    <div key={field.key}>
                      <label className="block text-[12px] mb-1" style={{ color: 'var(--color-text-muted)' }}>
                        {field.label}
                      </label>
                      <input
                        type={field.secret ? 'password' : 'text'}
                        value={dialog.config[field.key] || ''}
                        onChange={(e) => onDialogChange({
                          ...dialog,
                          config: { ...dialog.config, [field.key]: e.target.value },
                        })}
                        placeholder={field.placeholder}
                        className="w-full rounded-xl border px-3.5 py-2.5 text-[13px] font-mono focus:outline-none focus:ring-2 transition-shadow"
                        style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Enable toggle */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="bot-enabled"
              checked={dialog.enabled}
              onChange={(e) => onDialogChange({ ...dialog, enabled: e.target.checked })}
              className="accent-[var(--color-primary)]"
            />
            <label htmlFor="bot-enabled" className="text-[13px]">
              {t('bots.enabled')}
            </label>
          </div>
        </div>

        {/* Hide default buttons when guided wizard handles completion */}
        {!showGuide && (
          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={onClose}
              className="px-4 py-2.5 text-[13px] font-medium rounded-xl transition-colors"
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={onSave}
              disabled={saving || !dialog.name.trim()}
              className="px-4 py-2.5 text-[13px] font-medium text-white rounded-xl disabled:opacity-50 transition-colors shadow-sm"
              style={{ background: 'var(--color-primary)' }}
            >
              {saving ? t('common.saving') : (dialog.mode === 'create' ? t('common.create') : t('common.save'))}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
