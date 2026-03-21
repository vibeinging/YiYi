import { X, Key, Globe, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface CustomProviderForm {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: { id: string; name: string }[];
  newModelId: string;
  newModelName: string;
}

interface CustomProviderDialogProps {
  customForm: CustomProviderForm;
  setCustomForm: React.Dispatch<React.SetStateAction<CustomProviderForm>>;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  inputClass: string;
}

export function CustomProviderDialog({ customForm, setCustomForm, onClose, onSubmit, inputClass }: CustomProviderDialogProps) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="rounded-2xl p-6 w-full max-w-md animate-scale-in" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-bold text-[16px]" style={{ fontFamily: 'var(--font-display)' }}>{t('models.createTitle')}</h2>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
            style={{ color: 'var(--color-text-tertiary)' }}>
            <X size={16} />
          </button>
        </div>
        <div className="space-y-4 mb-5">
          <div>
            <label className="block text-[12px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>{t('models.providerId')}</label>
            <input type="text" value={customForm.id}
              onChange={(e) => setCustomForm(prev => ({ ...prev, id: e.target.value }))}
              placeholder={t('models.providerIdPlaceholder')}
              className={inputClass} style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }} />
          </div>
          <div>
            <label className="block text-[12px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>{t('models.providerName')}</label>
            <input type="text" value={customForm.name}
              onChange={(e) => setCustomForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder={t('models.providerNamePlaceholder')}
              className={inputClass} style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }} />
          </div>
          <div>
            <label className="flex items-center gap-1.5 text-[12px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
              <Globe size={13} /> Base URL
            </label>
            <input type="text" value={customForm.baseUrl}
              onChange={(e) => setCustomForm(prev => ({ ...prev, baseUrl: e.target.value }))}
              placeholder={t('models.baseUrlPlaceholder')}
              className={inputClass} style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }} />
          </div>
          <div>
            <label className="flex items-center gap-1.5 text-[12px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
              <Key size={13} /> API Key
            </label>
            <input type="password" value={customForm.apiKey}
              onChange={(e) => setCustomForm(prev => ({ ...prev, apiKey: e.target.value }))}
              placeholder={t('models.apiKeyPlaceholder')}
              className={inputClass} style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }} />
          </div>
          <div>
            <label className="block text-[12px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
              {t('models.availableModels')} ({customForm.models.length})
            </label>
            {customForm.models.length > 0 && (
              <div className="space-y-1 mb-3 max-h-36 overflow-y-auto">
                {customForm.models.map((m) => (
                  <div key={m.id} className="flex items-center justify-between px-3 py-2 rounded-lg text-[12px]"
                    style={{ background: 'var(--color-bg-subtle)' }}>
                    <span className="font-medium" style={{ color: 'var(--color-text)' }}>{m.name}</span>
                    <button onClick={() => setCustomForm(prev => ({ ...prev, models: prev.models.filter(x => x.id !== m.id) }))}
                      className="p-1 rounded" style={{ color: 'var(--color-text-muted)' }}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input type="text" value={customForm.newModelId}
                onChange={(e) => setCustomForm(prev => ({ ...prev, newModelId: e.target.value }))}
                placeholder={t('models.modelIdPlaceholder')}
                className="flex-1 rounded-lg px-3 py-2 text-[12px] outline-none"
                style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }} />
              <input type="text" value={customForm.newModelName}
                onChange={(e) => setCustomForm(prev => ({ ...prev, newModelName: e.target.value }))}
                placeholder={t('models.modelNamePlaceholder')}
                className="flex-1 rounded-lg px-3 py-2 text-[12px] outline-none"
                style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }} />
              <button onClick={() => {
                if (!customForm.newModelId.trim()) return;
                setCustomForm(prev => ({
                  ...prev,
                  models: [...prev.models, { id: prev.newModelId.trim(), name: prev.newModelName.trim() || prev.newModelId.trim() }],
                  newModelId: '', newModelName: '',
                }));
              }}
                className="px-3 py-2 rounded-lg text-[12px] font-medium flex-shrink-0"
                style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}>
                <Plus size={14} />
              </button>
            </div>
          </div>
        </div>
        <div className="flex justify-end">
          <button onClick={onSubmit}
            disabled={!customForm.id || !customForm.name}
            className="px-4 py-2 rounded-lg text-[13px] font-medium disabled:opacity-50"
            style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}>
            {t('models.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
