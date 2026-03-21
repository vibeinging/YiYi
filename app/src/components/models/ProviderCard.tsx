import {
  Check,
  X,
  Key,
  Globe,
  Loader2,
  ChevronUp,
  ChevronDown,
  TestTube,
  ExternalLink,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-shell';
import {
  type ProviderDisplay,
  type TestConnectionResponse,
  ZHIPU_SITES,
  type ZhipuSiteKey,
} from '../../api/models';
import { toast } from '../Toast';

interface ProviderMeta {
  id: string;
  name: string;
  desc: string;
  color: string;
  baseUrl: string;
  signupUrl: string;
  signupLabel: string;
  models: { id: string; name: string }[];
  tag?: string;
  tagColor?: string;
}

interface ProviderCardProps {
  meta: ProviderMeta;
  provider: ProviderDisplay | undefined;
  activeLlm: { provider_id: string; model: string } | null;
  expandedProvider: string | null;
  setExpandedProvider: (id: string | null) => void;
  apiKeyInputs: Record<string, string>;
  setApiKeyInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  showApiKey: Record<string, boolean>;
  setShowApiKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  baseUrlInputs: Record<string, string>;
  setBaseUrlInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  customModelInput: Record<string, string>;
  setCustomModelInput: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  selectedModel: Record<string, string>;
  setSelectedModel: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  zhipuSite: ZhipuSiteKey;
  setZhipuSite: (site: ZhipuSiteKey) => void;
  testing: string | null;
  saving: string | null;
  testResults: Record<string, TestConnectionResponse>;
  onSaveProvider: (providerId: string) => Promise<void>;
  onTestConnection: (providerId: string) => Promise<void>;
  onSetActiveModel: (providerId: string, modelId: string) => Promise<void>;
  onAddModel: (providerId: string, modelId: string, modelName: string) => Promise<void>;
  onRemoveModel: (providerId: string, modelId: string) => Promise<void>;
}

export function ProviderCard({
  meta,
  provider,
  activeLlm,
  expandedProvider,
  setExpandedProvider,
  apiKeyInputs,
  setApiKeyInputs,
  showApiKey,
  setShowApiKey,
  baseUrlInputs,
  setBaseUrlInputs,
  customModelInput,
  setCustomModelInput,
  selectedModel,
  setSelectedModel,
  zhipuSite,
  setZhipuSite,
  testing,
  saving,
  testResults,
  onSaveProvider,
  onTestConnection,
  onSetActiveModel,
  onAddModel,
  onRemoveModel,
}: ProviderCardProps) {
  const { t } = useTranslation();
  const configured = provider?.has_api_key;
  const isExpanded = expandedProvider === meta.id;
  const isActive = activeLlm?.provider_id === meta.id;
  const allModels = provider
    ? [...provider.models, ...provider.extra_models]
    : meta.models;

  return (
    <div
      className={`rounded-2xl overflow-hidden transition-all ${isExpanded ? 'col-span-2 lg:col-span-3' : ''}`}
      style={{ background: 'var(--color-bg-elevated)' }}
    >
      {/* Card Header */}
      <div
        className="px-4 py-3.5 cursor-pointer select-none"
        onClick={() => setExpandedProvider(isExpanded ? null : meta.id)}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: meta.color + '15' }}>
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: meta.color }} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h3 className="font-semibold text-[13px] truncate" style={{ color: 'var(--color-text)' }}>
                  {meta.name}
                </h3>
                {meta.tag && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-md font-bold flex-shrink-0"
                    style={{ background: (meta.tagColor || meta.color) + '18', color: meta.tagColor || meta.color }}>
                    {meta.tag}
                  </span>
                )}
                {configured && (
                  <Check size={12} className="flex-shrink-0" style={{ color: 'var(--color-success)' }} />
                )}
                {isActive && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-md font-bold flex-shrink-0"
                    style={{ background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}>
                    {t('models.active')}
                  </span>
                )}
              </div>
              <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--color-text-muted)' }}>
                {meta.desc}
              </p>
            </div>
          </div>
          {!isExpanded && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const url = meta.id === 'zhipu' ? ZHIPU_SITES[zhipuSite].signupUrl : meta.signupUrl;
                open(url);
              }}
              className="flex-shrink-0 p-1.5 rounded-lg transition-all"
              style={{ color: meta.color }}
              onMouseEnter={(e) => { e.currentTarget.style.background = meta.color + '10'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title={meta.signupLabel}
            >
              <ExternalLink size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="px-4 pb-4 space-y-4">
          {/* 1. API Key & Base URL */}
          <div className="p-4 rounded-xl space-y-3" style={{ background: 'var(--color-bg-subtle)' }}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="flex items-center gap-1.5 text-[12px] font-medium mb-1.5"
                  style={{ color: 'var(--color-text-secondary)' }}>
                  <Key size={12} /> API Key
                </label>
                <div className="relative">
                  <input
                    type={showApiKey[meta.id] ? 'text' : 'password'}
                    value={apiKeyInputs[meta.id] ?? (provider?.api_key_saved || '')}
                    onChange={(e) => setApiKeyInputs(prev => ({ ...prev, [meta.id]: e.target.value }))}
                    placeholder={configured ? t('models.apiKeyPlaceholder') : `${t('models.apiKey')} (${meta.id.includes('coding') ? 'sk-sp...' : ''})`}
                    className="w-full rounded-lg px-3 py-2 pr-9 text-[13px] outline-none"
                    style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)' }}
                  />
                  {(provider?.api_key_saved || apiKeyInputs[meta.id]) && (
                    <button
                      type="button"
                      onClick={() => setShowApiKey(prev => ({ ...prev, [meta.id]: !prev[meta.id] }))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md transition-colors"
                      style={{ color: 'var(--color-text-muted)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; }}
                      title={showApiKey[meta.id] ? 'Hide' : 'Show'}
                    >
                      {showApiKey[meta.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  )}
                </div>
              </div>
              <div>
                <label className="flex items-center gap-1.5 text-[12px] font-medium mb-1.5"
                  style={{ color: 'var(--color-text-secondary)' }}>
                  <Globe size={12} /> Base URL
                  {meta.id === 'zhipu' && (
                    <span className="ml-auto flex gap-1">
                      {(['cn', 'intl'] as const).map(site => (
                        <button
                          key={site}
                          onClick={() => {
                            setZhipuSite(site);
                            setBaseUrlInputs(prev => ({ ...prev, zhipu: ZHIPU_SITES[site].baseUrl }));
                          }}
                          className="px-2 py-0.5 rounded-md text-[10px] font-medium transition-all"
                          style={{
                            background: zhipuSite === site ? meta.color + '20' : 'transparent',
                            color: zhipuSite === site ? meta.color : 'var(--color-text-muted)',
                            border: `1px solid ${zhipuSite === site ? meta.color + '40' : 'transparent'}`,
                          }}
                        >
                          {ZHIPU_SITES[site].label}
                        </button>
                      ))}
                    </span>
                  )}
                </label>
                <input
                  type="text"
                  value={baseUrlInputs[meta.id] ?? (provider?.current_base_url || meta.baseUrl)}
                  onChange={(e) => setBaseUrlInputs(prev => ({ ...prev, [meta.id]: e.target.value }))}
                  className="w-full rounded-lg px-3 py-2 text-[13px] outline-none"
                  style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}
                />
              </div>
            </div>
          </div>

          {/* 2. Models Grid */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12px] font-medium" style={{ color: 'var(--color-text-tertiary)' }}>
                {t('models.availableModels')} ({allModels.length})
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {allModels.map(model => {
                const isModelActive = isActive && activeLlm?.model === model.id;
                const isSelected = (selectedModel[meta.id] || (isActive ? activeLlm?.model : '')) === model.id;
                const isExtra = provider?.extra_models.some(m => m.id === model.id);
                return (
                  <div
                    key={model.id}
                    onClick={() => setSelectedModel(prev => ({ ...prev, [meta.id]: model.id }))}
                    className="flex items-center justify-between p-3 rounded-xl transition-all cursor-pointer"
                    style={{
                      background: isSelected ? meta.color + '15' : 'var(--color-bg-subtle)',
                      borderLeft: isModelActive ? `3px solid ${meta.color}` : isSelected ? `3px solid ${meta.color}50` : '3px solid transparent',
                    }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>
                        {model.name}
                      </span>
                      {isModelActive && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-md font-bold flex-shrink-0"
                          style={{ background: meta.color + '20', color: meta.color }}>
                          {t('models.active')}
                        </span>
                      )}
                    </div>
                    {isExtra && (
                      <button onClick={(e) => { e.stopPropagation(); onRemoveModel(meta.id, model.id); }}
                        className="p-0.5 rounded transition-colors flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                        <X size={12} />
                      </button>
                    )}
                  </div>
                );
              })}
              {/* Custom model input -- inline as a grid item */}
              <div
                className="flex items-center justify-between p-3 rounded-xl transition-all"
                style={{
                  background: customModelInput[meta.id] ? meta.color + '08' : 'var(--color-bg-subtle)',
                  border: customModelInput[meta.id] ? `1px dashed ${meta.color}40` : '1px dashed var(--color-border, rgba(255,255,255,0.08))',
                }}
              >
                <input
                  type="text"
                  value={customModelInput[meta.id] || ''}
                  onChange={(e) => setCustomModelInput(prev => ({ ...prev, [meta.id]: e.target.value }))}
                  placeholder={t('models.customModel')}
                  className="flex-1 bg-transparent text-[13px] font-medium outline-none min-w-0"
                  style={{ color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter' && customModelInput[meta.id]?.trim()) {
                      const modelId = customModelInput[meta.id].trim();
                      await onAddModel(meta.id, modelId, modelId);
                      setSelectedModel(prev => ({ ...prev, [meta.id]: modelId }));
                      setCustomModelInput(prev => ({ ...prev, [meta.id]: '' }));
                    }
                  }}
                />
                {customModelInput[meta.id]?.trim() && (
                  <button
                    onClick={async () => {
                      const modelId = customModelInput[meta.id].trim();
                      await onAddModel(meta.id, modelId, modelId);
                      setSelectedModel(prev => ({ ...prev, [meta.id]: modelId }));
                      setCustomModelInput(prev => ({ ...prev, [meta.id]: '' }));
                    }}
                    className="px-2.5 py-1 text-[12px] rounded-lg font-medium transition-all flex-shrink-0 ml-2"
                    style={{ color: meta.color }}
                  >
                    {t('common.add')}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 3. Actions: Save / Test / Set Active / Get Key */}
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-2">
              <button
                onClick={() => onTestConnection(meta.id)}
                disabled={testing === meta.id}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${testing !== meta.id ? 'disabled:opacity-50' : ''}`}
                style={{
                  color: testing === meta.id ? meta.color : 'var(--color-text-secondary)',
                }}
                onMouseEnter={(e) => { if (testing !== meta.id) e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {testing === meta.id ? <Loader2 size={13} className="animate-spin" /> : <TestTube size={13} />}
                {testing === meta.id ? t('models.testingConnection') : t('models.test')}
              </button>
              <button
                onClick={() => {
                  const url = meta.id === 'zhipu' ? ZHIPU_SITES[zhipuSite].signupUrl : meta.signupUrl;
                  open(url);
                }}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all"
                style={{ color: meta.color }}
                onMouseEnter={(e) => { e.currentTarget.style.background = meta.color + '10'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <ExternalLink size={12} />
                {meta.signupLabel}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onSaveProvider(meta.id)}
                disabled={saving === meta.id}
                className="px-4 py-1.5 rounded-lg text-[12px] font-medium transition-all disabled:opacity-50"
                style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
              >
                {saving === meta.id ? <Loader2 size={13} className="animate-spin" /> : t('models.save')}
              </button>
              <button
                onClick={async () => {
                  const modelId = selectedModel[meta.id] || (isActive ? activeLlm?.model : allModels[0]?.id);
                  if (!modelId) { toast.warning(t('models.select')); return; }
                  await onSetActiveModel(meta.id, modelId);
                  toast.success(`${t('models.active')}: ${modelId}`);
                }}
                className="px-4 py-1.5 rounded-lg text-[12px] font-medium transition-all"
                style={{ background: meta.color, color: '#FFFFFF' }}
              >
                {t('models.setActive')}
              </button>
            </div>
          </div>

          {/* Test result reply */}
          {testResults[meta.id] && (
            <div
              className="p-3 rounded-xl text-[12px] leading-relaxed"
              style={{
                background: testResults[meta.id].success ? meta.color + '08' : 'rgba(239,68,68,0.08)',
                border: `1px solid ${testResults[meta.id].success ? meta.color + '20' : 'rgba(239,68,68,0.2)'}`,
                color: 'var(--color-text-secondary)',
              }}
            >
              <div className="flex items-center gap-1.5">
                <span style={{ color: testResults[meta.id].success ? meta.color : '#ef4444', fontWeight: 600, fontSize: '11px' }}>
                  {testResults[meta.id].success ? `OK · ${testResults[meta.id].message}` : 'Failed'}
                </span>
                {!testResults[meta.id].success && (
                  <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>{testResults[meta.id].message}</span>
                )}
              </div>
              {testResults[meta.id].reply && (
                <div
                  className="mt-2 pt-2 text-[12px] whitespace-pre-wrap"
                  style={{
                    borderTop: `1px solid ${meta.color}15`,
                    color: 'var(--color-text)',
                    maxHeight: '120px',
                    overflowY: 'auto',
                  }}
                >
                  {testResults[meta.id].reply}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
