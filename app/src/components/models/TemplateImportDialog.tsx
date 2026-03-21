import { X, Check, Loader2, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderDisplay, ProviderTemplate } from '../../api/models';

interface TemplateImportDialogProps {
  templates: ProviderTemplate[];
  providers: ProviderDisplay[];
  importingTemplate: string | null;
  onClose: () => void;
  onImport: (templateId: string) => Promise<void>;
}

export function TemplateImportDialog({ templates, providers, importingTemplate, onClose, onImport }: TemplateImportDialogProps) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="rounded-2xl p-6 w-full max-w-lg animate-scale-in" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-bold text-[16px]" style={{ fontFamily: 'var(--font-display)' }}>{t('models.templates')}</h2>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
            style={{ color: 'var(--color-text-tertiary)' }}>
            <X size={16} />
          </button>
        </div>
        <p className="text-[12px] mb-4" style={{ color: 'var(--color-text-secondary)' }}>{t('models.templateDesc')}</p>
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {templates.map((tpl) => {
            const alreadyAdded = providers.some(p => p.id === tpl.id);
            return (
              <div key={tpl.id}
                className="flex items-center justify-between p-3.5 rounded-xl transition-all"
                style={{ background: 'var(--color-bg-subtle)' }}>
                <div className="min-w-0 flex-1 mr-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--color-text)' }}>{tpl.name}</span>
                    {tpl.plugin.is_local && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium"
                        style={{ background: 'var(--color-success-subtle, rgba(52,199,89,0.1))', color: 'var(--color-success, #34C759)' }}>
                        {t('models.localProvider')}
                      </span>
                    )}
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium"
                      style={{ background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}>
                      {tpl.plugin.api_compat}
                    </span>
                  </div>
                  <p className="text-[11px] truncate" style={{ color: 'var(--color-text-tertiary)' }}>
                    {tpl.description}
                  </p>
                  <p className="text-[10px] mt-0.5 font-mono" style={{ color: 'var(--color-text-muted)' }}>
                    {tpl.plugin.default_base_url}
                  </p>
                </div>
                <button
                  onClick={() => onImport(tpl.id)}
                  disabled={alreadyAdded || importingTemplate === tpl.id}
                  className="px-3 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50 flex-shrink-0 flex items-center gap-1.5"
                  style={{ background: alreadyAdded ? 'var(--color-bg-subtle)' : 'var(--color-primary)', color: alreadyAdded ? 'var(--color-text-muted)' : '#FFFFFF' }}>
                  {importingTemplate === tpl.id ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : alreadyAdded ? (
                    <><Check size={13} /> {t('models.configured')}</>
                  ) : (
                    <><Download size={13} /> {t('models.importProvider')}</>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
