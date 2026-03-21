import {
  Check,
  X,
  Key,
  Loader2,
  ChevronUp,
  ChevronDown,
  Sparkles,
  Trash2,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderDisplay } from '../../api/models';
import { toast } from '../Toast';

interface CustomProviderCardProps {
  provider: ProviderDisplay;
  activeLlm: { provider_id: string; model: string } | null;
  expandedProvider: string | null;
  setExpandedProvider: (id: string | null) => void;
  apiKeyInputs: Record<string, string>;
  setApiKeyInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  showApiKey: Record<string, boolean>;
  setShowApiKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  customModelInput: Record<string, string>;
  setCustomModelInput: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  selectedModel: Record<string, string>;
  setSelectedModel: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  saving: string | null;
  onSaveProvider: (providerId: string) => Promise<void>;
  onSetActiveModel: (providerId: string, modelId: string) => Promise<void>;
  onAddModel: (providerId: string, modelId: string, modelName: string) => Promise<void>;
  onRemoveModel: (providerId: string, modelId: string) => Promise<void>;
  onDeleteProvider: (providerId: string) => Promise<void>;
}

export function CustomProviderCard({
  provider,
  activeLlm,
  expandedProvider,
  setExpandedProvider,
  apiKeyInputs,
  setApiKeyInputs,
  showApiKey,
  setShowApiKey,
  customModelInput,
  setCustomModelInput,
  selectedModel,
  setSelectedModel,
  saving,
  onSaveProvider,
  onSetActiveModel,
  onAddModel,
  onRemoveModel,
  onDeleteProvider,
}: CustomProviderCardProps) {
  const { t } = useTranslation();
  const isExpanded = expandedProvider === provider.id;
  const isActive = activeLlm?.provider_id === provider.id;
  const allModels = [...provider.models, ...provider.extra_models];

  return (
    <div
      className={`rounded-2xl overflow-hidden transition-all ${isExpanded ? 'col-span-2 lg:col-span-3' : ''}`}
      style={{ background: 'var(--color-bg-elevated)' }}
    >
      <div
        className="px-4 py-3.5 cursor-pointer select-none"
        onClick={() => setExpandedProvider(isExpanded ? null : provider.id)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: 'var(--color-bg-subtle)' }}>
              <Sparkles size={14} style={{ color: 'var(--color-text-tertiary)' }} />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h3 className="font-semibold text-[13px]" style={{ color: 'var(--color-text)' }}>{provider.name}</h3>
                <span className="text-[9px] px-1.5 py-0.5 rounded-md font-medium"
                  style={{ background: 'rgba(103, 232, 249, 0.1)', color: 'var(--color-info)' }}>
                  {t('models.custom')}
                </span>
                {provider.has_api_key && <Check size={12} style={{ color: 'var(--color-success)' }} />}
              </div>
              <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                {provider.current_base_url}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); onDeleteProvider(provider.id); }}
              className="w-7 h-7 flex items-center justify-center rounded-lg transition-colors"
              style={{ color: 'var(--color-error)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(251, 113, 133, 0.1)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <Trash2 size={14} />
            </button>
            <div className="w-7 h-7 flex items-center justify-center" style={{ color: 'var(--color-text-tertiary)' }}>
              {isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </div>
          </div>
        </div>
      </div>

      {isExpanded && (
        <div className="px-4 pb-4 space-y-4">
          <div className="p-4 rounded-xl space-y-3" style={{ background: 'var(--color-bg-subtle)' }}>
            <div>
              <label className="flex items-center gap-1.5 text-[12px] font-medium mb-1.5"
                style={{ color: 'var(--color-text-secondary)' }}>
                <Key size={12} /> API Key
              </label>
              <div className="relative">
                <input
                  type={showApiKey[provider.id] ? 'text' : 'password'}
                  value={apiKeyInputs[provider.id] ?? (provider.api_key_saved || '')}
                  onChange={(e) => setApiKeyInputs(prev => ({ ...prev, [provider.id]: e.target.value }))}
                  placeholder={t('models.apiKeyPlaceholder')}
                  className="w-full rounded-lg px-3 py-2 pr-9 text-[13px] outline-none"
                  style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)' }}
                />
                {(provider.api_key_saved || apiKeyInputs[provider.id]) && (
                  <button
                    type="button"
                    onClick={() => setShowApiKey(prev => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; }}
                    title={showApiKey[provider.id] ? 'Hide' : 'Show'}
                  >
                    {showApiKey[provider.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {allModels.map(model => {
              const isModelActive = isActive && activeLlm?.model === model.id;
              const isSelected = (selectedModel[provider.id] || (isActive ? activeLlm?.model : '')) === model.id;
              return (
                <div key={model.id}
                  onClick={() => setSelectedModel(prev => ({ ...prev, [provider.id]: model.id }))}
                  className="flex items-center justify-between p-3 rounded-xl transition-all cursor-pointer"
                  style={{
                    background: isSelected ? 'var(--color-primary-subtle)' : 'var(--color-bg-subtle)',
                    borderLeft: isModelActive ? '3px solid var(--color-primary)' : isSelected ? '3px solid var(--color-primary-subtle)' : '3px solid transparent',
                  }}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>{model.name}</span>
                    {isModelActive && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-md font-bold flex-shrink-0"
                        style={{ background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}>
                        {t('models.active')}
                      </span>
                    )}
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); onRemoveModel(provider.id, model.id); }}
                    className="p-0.5 rounded transition-colors flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                    <X size={12} />
                  </button>
                </div>
              );
            })}
            {/* Custom model input */}
            <div
              className="flex items-center justify-between p-3 rounded-xl transition-all"
              style={{
                background: customModelInput[provider.id] ? 'var(--color-primary-subtle)' : 'var(--color-bg-subtle)',
                border: customModelInput[provider.id] ? '1px dashed var(--color-primary)' : '1px dashed var(--color-border, rgba(255,255,255,0.08))',
              }}
            >
              <input
                type="text"
                value={customModelInput[provider.id] || ''}
                onChange={(e) => setCustomModelInput(prev => ({ ...prev, [provider.id]: e.target.value }))}
                placeholder={t('models.customModel')}
                className="flex-1 bg-transparent text-[13px] font-medium outline-none min-w-0"
                style={{ color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && customModelInput[provider.id]?.trim()) {
                    const modelId = customModelInput[provider.id].trim();
                    await onAddModel(provider.id, modelId, modelId);
                    setSelectedModel(prev => ({ ...prev, [provider.id]: modelId }));
                    setCustomModelInput(prev => ({ ...prev, [provider.id]: '' }));
                  }
                }}
              />
              {customModelInput[provider.id]?.trim() && (
                <button
                  onClick={async () => {
                    const modelId = customModelInput[provider.id].trim();
                    await onAddModel(provider.id, modelId, modelId);
                    setSelectedModel(prev => ({ ...prev, [provider.id]: modelId }));
                    setCustomModelInput(prev => ({ ...prev, [provider.id]: '' }));
                  }}
                  className="px-2.5 py-1 text-[12px] rounded-lg font-medium transition-all flex-shrink-0 ml-2"
                  style={{ color: 'var(--color-primary)' }}
                >
                  {t('common.add')}
                </button>
              )}
            </div>
          </div>
          {/* Actions: Save / Set Active */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={() => onSaveProvider(provider.id)}
              disabled={saving === provider.id}
              className="px-4 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50"
              style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}>
              {saving === provider.id ? <Loader2 size={13} className="animate-spin" /> : t('models.save')}
            </button>
            <button
              onClick={async () => {
                const modelId = selectedModel[provider.id] || (isActive ? activeLlm?.model : allModels[0]?.id);
                if (!modelId) { toast.warning(t('models.select')); return; }
                await onSetActiveModel(provider.id, modelId);
                toast.success(`${t('models.active')}: ${modelId}`);
              }}
              className="px-4 py-1.5 rounded-lg text-[12px] font-medium transition-all"
              style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}>
              {t('models.setActive')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
