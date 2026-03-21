import { X, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface JsonImportDialogProps {
  jsonImportText: string;
  setJsonImportText: (text: string) => void;
  onClose: () => void;
  onImport: () => Promise<void>;
}

export function JsonImportDialog({ jsonImportText, setJsonImportText, onClose, onImport }: JsonImportDialogProps) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="rounded-2xl p-6 w-full max-w-lg animate-scale-in" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-bold text-[16px]" style={{ fontFamily: 'var(--font-display)' }}>{t('models.fromJson')}</h2>
          <button onClick={() => { onClose(); setJsonImportText(''); }}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
            style={{ color: 'var(--color-text-tertiary)' }}>
            <X size={16} />
          </button>
        </div>
        <p className="text-[12px] mb-3" style={{ color: 'var(--color-text-secondary)' }}>
          Paste a provider plugin JSON configuration:
        </p>
        <textarea
          value={jsonImportText}
          onChange={(e) => setJsonImportText(e.target.value)}
          placeholder={`{
  "id": "my-provider",
  "name": "My Provider",
  "default_base_url": "https://api.example.com/v1",
  "api_key_env": "MY_API_KEY",
  "api_compat": "openai",
  "is_local": false,
  "models": [
    { "id": "model-1", "name": "Model 1" }
  ]
}`}
          className="w-full rounded-xl px-3.5 py-3 text-[12px] outline-none font-mono resize-none"
          style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)', height: '240px' }}
        />
        <div className="flex justify-end mt-4">
          <button
            onClick={onImport}
            disabled={!jsonImportText.trim()}
            className="px-4 py-2 rounded-lg text-[13px] font-medium disabled:opacity-50 flex items-center gap-1.5"
            style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}>
            <Upload size={14} />
            {t('models.importProvider')}
          </button>
        </div>
      </div>
    </div>
  );
}
