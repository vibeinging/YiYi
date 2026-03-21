/**
 * Modal for sending a message through a bot
 */

import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Select } from '../Select';
import type { BotInfo } from '../../api/bots';
import { PLATFORM_META } from './platformMeta';

interface SendForm {
  botId: string;
  target: string;
  content: string;
}

interface SendMessageModalProps {
  bots: BotInfo[];
  sendForm: SendForm;
  sending: boolean;
  onSendFormChange: (form: SendForm) => void;
  onClose: () => void;
  onSend: () => void;
}

export function SendMessageModal({
  bots,
  sendForm,
  sending,
  onSendFormChange,
  onClose,
  onSend,
}: SendMessageModalProps) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div
        className="rounded-3xl p-6 w-full max-w-md shadow-2xl border"
        style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-semibold tracking-tight">{t('bots.sendTitle')}</h2>
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
          <div>
            <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
              {t('bots.selectBot')}
            </label>
            <Select
              value={sendForm.botId}
              onChange={(v) => onSendFormChange({ ...sendForm, botId: v })}
              options={bots.filter(b => b.enabled).map((b) => ({
                value: b.id,
                label: `${PLATFORM_META[b.platform]?.icon || '🤖'} ${b.name}`,
              }))}
              fullWidth
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
              {t('bots.targetId')}
            </label>
            <input
              type="text"
              value={sendForm.target}
              onChange={(e) => onSendFormChange({ ...sendForm, target: e.target.value })}
              placeholder={t('bots.targetIdPlaceholder')}
              className="w-full rounded-xl border px-4 py-2.5 text-[13px] focus:outline-none focus:ring-2 transition-shadow"
              style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
              {t('bots.messageContent')}
            </label>
            <textarea
              value={sendForm.content}
              onChange={(e) => onSendFormChange({ ...sendForm, content: e.target.value })}
              placeholder={t('bots.messagePlaceholder')}
              rows={4}
              className="w-full resize-none rounded-xl border px-4 py-2.5 text-[13px] focus:outline-none focus:ring-2 transition-shadow"
              style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
            />
          </div>
        </div>

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
            onClick={onSend}
            disabled={sending || !sendForm.botId || !sendForm.target.trim() || !sendForm.content.trim()}
            className="px-4 py-2.5 text-[13px] font-medium text-white rounded-xl disabled:opacity-50 transition-colors shadow-sm"
            style={{ background: 'var(--color-primary)' }}
          >
            {sending ? t('bots.sending') : t('common.send')}
          </button>
        </div>
      </div>
    </div>
  );
}
