/**
 * Models Configuration Page - Quick Setup
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  X,
  Key,
  Globe,
  Loader2,
  ChevronDown,
  ChevronUp,
  TestTube,
  Plus,
  Trash2,
  ExternalLink,
  Sparkles,
  Download,
  Upload,
  Package,
  Server,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import {
  listProviders,
  configureProvider,
  testProvider,
  createCustomProvider,
  deleteCustomProvider,
  addModel,
  removeModel,
  getActiveLlm,
  setActiveLlm as setActiveLlmApi,
  listProviderTemplates,
  importProviderFromTemplate,
  importProviderPlugin,
  type ProviderDisplay,
  type ModelInfo,
  type ProviderTemplate,
  type ProviderPlugin,
  type TestConnectionResponse,
  ZHIPU_SITES,
  type ZhipuSiteKey,
} from '../api/models';
import { PageHeader } from '../components/PageHeader';
import { toast, confirm } from '../components/Toast';

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

const PROVIDER_LIST: ProviderMeta[] = [
  // --- Coding Plan (国内优惠套餐) ---
  {
    id: 'coding-plan', name: 'Aliyun Coding Plan', desc: '阿里云编程专属套餐，聚合 8 款主流模型',
    color: '#FF6A00', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    signupUrl: 'https://help.aliyun.com/zh/model-studio/developer-reference/aliyun-coding-plan',
    signupLabel: '了解详情',
    models: [
      { id: 'qwen3.5-plus', name: 'Qwen 3.5 Plus' }, { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' },
      { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next' }, { id: 'qwen3-max-2026-01-23', name: 'Qwen3 Max' },
      { id: 'glm-5', name: 'GLM-5' }, { id: 'glm-4.7', name: 'GLM-4.7' },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' }, { id: 'kimi-k2.5', name: 'Kimi K2.5' },
    ],
    tag: 'Coding Plan', tagColor: '#FF6A00',
  },
  // --- 国内提供商 ---
  {
    id: 'dashscope', name: '通义千问 (DashScope)', desc: 'Qwen Max, Plus, Turbo',
    color: '#6236FF', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    signupUrl: 'https://dashscope.console.aliyun.com/apiKey',
    signupLabel: '获取 API Key',
    models: [
      { id: 'qwen-max', name: 'Qwen Max' }, { id: 'qwen-plus', name: 'Qwen Plus' }, { id: 'qwen-turbo', name: 'Qwen Turbo' },
    ],
    tag: '国内', tagColor: '#6236FF',
  },
  {
    id: 'deepseek', name: 'DeepSeek', desc: 'DeepSeek V3, R1',
    color: '#5B6EF5', baseUrl: 'https://api.deepseek.com/v1',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    signupLabel: '获取 API Key',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3' }, { id: 'deepseek-reasoner', name: 'DeepSeek R1' },
    ],
    tag: '国内', tagColor: '#5B6EF5',
  },
  {
    id: 'moonshot', name: 'Kimi (Moonshot)', desc: 'Kimi K2.5, Moonshot V1 128K/32K',
    color: '#1A1A2E', baseUrl: 'https://api.moonshot.cn/v1',
    signupUrl: 'https://platform.moonshot.cn/console/api-keys',
    signupLabel: '获取 API Key',
    models: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5' }, { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K' },
      { id: 'moonshot-v1-32k', name: 'Moonshot V1 32K' },
    ],
    tag: '国内', tagColor: '#1A1A2E',
  },
  {
    id: 'minimax', name: 'MiniMax', desc: 'MiniMax M2.5, M2.5 Highspeed, M2.1',
    color: '#FF4F81', baseUrl: 'https://api.minimax.io/v1',
    signupUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    signupLabel: '获取 API Key',
    models: [
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' }, { id: 'MiniMax-M2.5-highspeed', name: 'M2.5 Highspeed' },
      { id: 'MiniMax-M2.1', name: 'MiniMax M2.1' },
    ],
    tag: '国内', tagColor: '#FF4F81',
  },
  {
    id: 'zhipu', name: '智谱 AI', desc: 'GLM-5, GLM-4.7, GLM-4 Plus/Flash',
    color: '#3366FF', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    signupUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    signupLabel: '获取 API Key',
    models: [
      { id: 'glm-5', name: 'GLM-5' }, { id: 'glm-4.7', name: 'GLM-4.7' },
      { id: 'glm-4-plus', name: 'GLM-4 Plus' }, { id: 'glm-4-flash', name: 'GLM-4 Flash' },
    ],
    tag: '国内', tagColor: '#3366FF',
  },
  {
    id: 'modelscope', name: 'ModelScope', desc: '魔搭社区模型推理',
    color: '#1890FF', baseUrl: 'https://api-inference.modelscope.cn/v1',
    signupUrl: 'https://modelscope.cn/my/myaccesstoken',
    signupLabel: '获取 Token',
    models: [
      { id: 'qwen-max', name: 'Qwen Max' }, { id: 'qwen-plus', name: 'Qwen Plus' },
      { id: 'deepseek-v3', name: 'DeepSeek V3' }, { id: 'deepseek-r1', name: 'DeepSeek R1' },
    ],
    tag: '国内', tagColor: '#1890FF',
  },
  // --- 国际提供商 ---
  {
    id: 'openai', name: 'OpenAI', desc: 'GPT-5, GPT-4.1, o3, o4-mini',
    color: '#10A37F', baseUrl: 'https://api.openai.com/v1',
    signupUrl: 'https://platform.openai.com/api-keys',
    signupLabel: '获取 API Key',
    models: [
      { id: 'gpt-5-chat', name: 'GPT-5' }, { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
      { id: 'gpt-4.1', name: 'GPT-4.1' }, { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'o3', name: 'o3' }, { id: 'o4-mini', name: 'o4-mini' },
    ],
  },
  {
    id: 'anthropic', name: 'Anthropic', desc: 'Claude Opus 4.6, Sonnet 4.6, Haiku 4.5',
    color: '#D97757', baseUrl: 'https://api.anthropic.com',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    signupLabel: '获取 API Key',
    models: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }, { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ],
  },
  {
    id: 'google', name: 'Google AI', desc: 'Gemini 2.5 Pro, Flash',
    color: '#4285F4', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    signupUrl: 'https://aistudio.google.com/apikey',
    signupLabel: '获取 API Key',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }, { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    ],
  },
];

export function ModelsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderDisplay[]>([]);
  const [activeLlm, setActiveLlm] = useState<{ provider_id: string; model: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [baseUrlInputs, setBaseUrlInputs] = useState<Record<string, string>>({});
  const [customModelInput, setCustomModelInput] = useState<Record<string, string>>({});
  const [selectedModel, setSelectedModel] = useState<Record<string, string>>({});

  // Zhipu site switcher (CN / Intl)
  const [zhipuSite, setZhipuSite] = useState<ZhipuSiteKey>('cn');

  // Custom provider dialog
  const [showCustomDialog, setShowCustomDialog] = useState(false);
  const [customForm, setCustomForm] = useState({
    id: '', name: '', baseUrl: '', apiKey: '', models: [] as { id: string; name: string }[],
    newModelId: '', newModelName: '',
  });

  // Template import dialog
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [templates, setTemplates] = useState<ProviderTemplate[]>([]);
  const [importingTemplate, setImportingTemplate] = useState<string | null>(null);

  // JSON import dialog
  const [showJsonImportDialog, setShowJsonImportDialog] = useState(false);
  const [jsonImportText, setJsonImportText] = useState('');

  const loadData = async () => {
    try {
      const [providersData, activeData] = await Promise.all([listProviders(), getActiveLlm()]);
      setProviders(providersData);
      // Detect zhipu site from saved base URL
      const zhipuProvider = providersData.find((p: ProviderDisplay) => p.id === 'zhipu');
      if (zhipuProvider?.current_base_url?.includes('z.ai')) {
        setZhipuSite('intl');
      }
      if (activeData.provider_id && activeData.model) {
        setActiveLlm({ provider_id: activeData.provider_id, model: activeData.model });
      } else {
        setActiveLlm(null);
      }
    } catch (error) {
      console.error('Failed to load models:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleSaveProvider = async (providerId: string) => {
    setSaving(providerId);
    try {
      const apiKey = apiKeyInputs[providerId];
      const baseUrl = baseUrlInputs[providerId];
      await configureProvider(providerId, apiKey || undefined, baseUrl || undefined);
      await loadData();
      setApiKeyInputs(prev => ({ ...prev, [providerId]: '' }));
    } catch (error) {
      console.error('Failed to save config:', error);
    } finally { setSaving(null); }
  };

  const [testResults, setTestResults] = useState<Record<string, TestConnectionResponse>>({});

  const handleTestConnection = async (providerId: string) => {
    setTesting(providerId);
    setTestResults(prev => { const next = { ...prev }; delete next[providerId]; return next; });
    try {
      const apiKey = apiKeyInputs[providerId];
      const baseUrl = baseUrlInputs[providerId];
      const modelId = selectedModel[providerId] || (activeLlm?.provider_id === providerId ? activeLlm.model : undefined);
      const result = await testProvider(providerId, apiKey || undefined, baseUrl || undefined, modelId);
      setTestResults(prev => ({ ...prev, [providerId]: { success: result.success, message: result.message, reply: result.reply } }));
      if (!result.success) {
        toast.error(result.message);
      }
    } catch (error: any) {
      const msg = error?.toString() || 'Test failed';
      setTestResults(prev => ({ ...prev, [providerId]: { success: false, message: msg } }));
      toast.error(msg);
    } finally { setTesting(null); }
  };

  const handleSetActiveModel = async (providerId: string, modelId: string) => {
    try { await setActiveLlmApi(providerId, modelId); await loadData(); } catch (error) { console.error(error); }
  };

  const handleAddModel = async (providerId: string, modelId: string, modelName: string) => {
    if (!modelId) return;
    try { await addModel(providerId, modelId, modelName || modelId); await loadData(); } catch (error) { console.error(error); }
  };

  const handleRemoveModel = async (providerId: string, modelId: string) => {
    try { await removeModel(providerId, modelId); await loadData(); } catch (error) { console.error(error); }
  };

  const handleCreateCustomProvider = async () => {
    if (!customForm.id || !customForm.name) return;
    try {
      await createCustomProvider(customForm.id, customForm.name, customForm.baseUrl, '', customForm.models);
      if (customForm.apiKey) {
        await configureProvider(customForm.id, customForm.apiKey, customForm.baseUrl || undefined);
      }
      await loadData();
      setShowCustomDialog(false);
      setCustomForm({ id: '', name: '', baseUrl: '', apiKey: '', models: [], newModelId: '', newModelName: '' });
    } catch (error) { console.error(error); }
  };

  const handleDeleteProvider = async (providerId: string) => {
    if (!(await confirm(`${t('common.delete')}?`))) return;
    try { await deleteCustomProvider(providerId); await loadData(); } catch (error) { console.error(error); }
  };

  const handleOpenTemplates = async () => {
    try {
      const tpls = await listProviderTemplates();
      setTemplates(tpls);
      setShowTemplateDialog(true);
    } catch (error) { console.error(error); }
  };

  const handleImportTemplate = async (templateId: string) => {
    setImportingTemplate(templateId);
    try {
      await importProviderFromTemplate(templateId);
      await loadData();
      toast.success(t('models.importSuccess'));
      setShowTemplateDialog(false);
    } catch (error: any) {
      toast.error(`${t('models.importError')}: ${error?.toString() || ''}`);
    } finally { setImportingTemplate(null); }
  };

  const handleJsonImport = async () => {
    try {
      const plugin = JSON.parse(jsonImportText) as ProviderPlugin;
      if (!plugin.id || !plugin.name) {
        toast.error('JSON must contain "id" and "name" fields');
        return;
      }
      await importProviderPlugin(plugin);
      await loadData();
      toast.success(t('models.importSuccess'));
      setShowJsonImportDialog(false);
      setJsonImportText('');
    } catch (error: any) {
      toast.error(`${t('models.importError')}: ${error?.toString() || ''}`);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={28} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
      </div>
    );
  }

  // Merge PROVIDER_LIST with backend data + custom providers
  const customProviders = providers.filter(p => p.is_custom && !PROVIDER_LIST.find(m => m.id === p.id));

  const inputClass = "w-full rounded-xl px-3.5 py-2.5 text-[13px] outline-none transition-shadow";

  const content = (
    <>
      {!embedded && <PageHeader title={t('models.title')} description={t('models.description')} />}

        {/* Current active model */}
        {activeLlm && activeLlm.model && (
          <div className="mb-8 p-5 rounded-2xl" style={{ background: 'var(--color-bg-elevated)' }}>
            <p className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-tertiary)' }}>
              {t('models.currentModel')}
            </p>
            <div className="flex items-center gap-3">
              <span className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>{activeLlm.model}</span>
              <span
                className="text-[12px] px-2.5 py-1 rounded-lg font-medium"
                style={{ background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}
              >
                {providers.find(p => p.id === activeLlm.provider_id)?.name || activeLlm.provider_id}
              </span>
            </div>
          </div>
        )}

        {/* Provider Cards */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[15px] font-bold" style={{ color: 'var(--color-text)' }}>{t('models.quickSetup')}</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={handleOpenTemplates}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
              >
                <Package size={14} />
                {t('models.fromTemplate')}
              </button>
              <button
                onClick={() => setShowJsonImportDialog(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
              >
                <Upload size={14} />
                {t('models.fromJson')}
              </button>
              <button
                onClick={() => setShowCustomDialog(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
              >
                <Plus size={14} />
                {t('models.addProvider')}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {PROVIDER_LIST.map(meta => {
              const provider = providers.find(p => p.id === meta.id);
              const configured = provider?.has_api_key;
              const isExpanded = expandedProvider === meta.id;
              const isActive = activeLlm?.provider_id === meta.id;
              const allModels = provider
                ? [...provider.models, ...provider.extra_models]
                : meta.models;

              return (
                <div
                  key={meta.id}
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
                            <input
                              type="password"
                              value={apiKeyInputs[meta.id] || ''}
                              onChange={(e) => setApiKeyInputs(prev => ({ ...prev, [meta.id]: e.target.value }))}
                              placeholder={configured ? t('models.apiKeyPlaceholder') : `${t('models.apiKey')} (${meta.id.includes('coding') ? 'sk-sp...' : ''})`}
                              className="w-full rounded-lg px-3 py-2 text-[13px] outline-none"
                              style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)' }}
                            />
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
                                  <button onClick={(e) => { e.stopPropagation(); handleRemoveModel(meta.id, model.id); }}
                                    className="p-0.5 rounded transition-colors flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                                    <X size={12} />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                          {/* Custom model input — inline as a grid item */}
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
                                  await handleAddModel(meta.id, modelId, modelId);
                                  setSelectedModel(prev => ({ ...prev, [meta.id]: modelId }));
                                  setCustomModelInput(prev => ({ ...prev, [meta.id]: '' }));
                                }
                              }}
                            />
                            {customModelInput[meta.id]?.trim() && (
                              <button
                                onClick={async () => {
                                  const modelId = customModelInput[meta.id].trim();
                                  await handleAddModel(meta.id, modelId, modelId);
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
                            onClick={() => handleTestConnection(meta.id)}
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
                            onClick={() => handleSaveProvider(meta.id)}
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
                              await handleSetActiveModel(meta.id, modelId);
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
            })}

            {/* Custom providers */}
            {customProviders.map(provider => {
              const isExpanded = expandedProvider === provider.id;
              const isActive = activeLlm?.provider_id === provider.id;
              const allModels = [...provider.models, ...provider.extra_models];

              return (
                <div
                  key={provider.id}
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
                          onClick={(e) => { e.stopPropagation(); handleDeleteProvider(provider.id); }}
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
                          <input type="password"
                            value={apiKeyInputs[provider.id] || ''}
                            onChange={(e) => setApiKeyInputs(prev => ({ ...prev, [provider.id]: e.target.value }))}
                            placeholder={t('models.apiKeyPlaceholder')}
                            className="w-full rounded-lg px-3 py-2 text-[13px] outline-none"
                            style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)' }}
                          />
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
                              <button onClick={(e) => { e.stopPropagation(); handleRemoveModel(provider.id, model.id); }}
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
                                await handleAddModel(provider.id, modelId, modelId);
                                setSelectedModel(prev => ({ ...prev, [provider.id]: modelId }));
                                setCustomModelInput(prev => ({ ...prev, [provider.id]: '' }));
                              }
                            }}
                          />
                          {customModelInput[provider.id]?.trim() && (
                            <button
                              onClick={async () => {
                                const modelId = customModelInput[provider.id].trim();
                                await handleAddModel(provider.id, modelId, modelId);
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
                        <button onClick={() => handleSaveProvider(provider.id)}
                          disabled={saving === provider.id}
                          className="px-4 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50"
                          style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}>
                          {saving === provider.id ? <Loader2 size={13} className="animate-spin" /> : t('models.save')}
                        </button>
                        <button
                          onClick={async () => {
                            const modelId = selectedModel[provider.id] || (isActive ? activeLlm?.model : allModels[0]?.id);
                            if (!modelId) { toast.warning(t('models.select')); return; }
                            await handleSetActiveModel(provider.id, modelId);
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
            })}
          </div>
        </div>

      {/* Create custom provider dialog */}
      {showCustomDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="rounded-2xl p-6 w-full max-w-md animate-scale-in" style={{ background: 'var(--color-bg-elevated)' }}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-bold text-[16px]" style={{ fontFamily: 'var(--font-display)' }}>{t('models.createTitle')}</h2>
              <button onClick={() => setShowCustomDialog(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
                style={{ color: 'var(--color-text-tertiary)' }}>
                <X size={16} />
              </button>
            </div>
            <div className="space-y-4 mb-5">
              <div>
                <label className="block text-[12px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>{t('models.providerId')}</label>
                <input type="text" value={customForm.id}
                  onChange={(e) => setCustomForm({ ...customForm, id: e.target.value })}
                  placeholder={t('models.providerIdPlaceholder')}
                  className={inputClass} style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }} />
              </div>
              <div>
                <label className="block text-[12px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>{t('models.providerName')}</label>
                <input type="text" value={customForm.name}
                  onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
                  placeholder={t('models.providerNamePlaceholder')}
                  className={inputClass} style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }} />
              </div>
              <div>
                <label className="flex items-center gap-1.5 text-[12px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  <Globe size={13} /> Base URL
                </label>
                <input type="text" value={customForm.baseUrl}
                  onChange={(e) => setCustomForm({ ...customForm, baseUrl: e.target.value })}
                  placeholder={t('models.baseUrlPlaceholder')}
                  className={inputClass} style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }} />
              </div>
              <div>
                <label className="flex items-center gap-1.5 text-[12px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  <Key size={13} /> API Key
                </label>
                <input type="password" value={customForm.apiKey}
                  onChange={(e) => setCustomForm({ ...customForm, apiKey: e.target.value })}
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
                        <button onClick={() => setCustomForm({ ...customForm, models: customForm.models.filter(x => x.id !== m.id) })}
                          className="p-1 rounded" style={{ color: 'var(--color-text-muted)' }}>
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input type="text" value={customForm.newModelId}
                    onChange={(e) => setCustomForm({ ...customForm, newModelId: e.target.value })}
                    placeholder={t('models.modelIdPlaceholder')}
                    className="flex-1 rounded-lg px-3 py-2 text-[12px] outline-none"
                    style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }} />
                  <input type="text" value={customForm.newModelName}
                    onChange={(e) => setCustomForm({ ...customForm, newModelName: e.target.value })}
                    placeholder={t('models.modelNamePlaceholder')}
                    className="flex-1 rounded-lg px-3 py-2 text-[12px] outline-none"
                    style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }} />
                  <button onClick={() => {
                    if (!customForm.newModelId.trim()) return;
                    setCustomForm({
                      ...customForm,
                      models: [...customForm.models, { id: customForm.newModelId.trim(), name: customForm.newModelName.trim() || customForm.newModelId.trim() }],
                      newModelId: '', newModelName: '',
                    });
                  }}
                    className="px-3 py-2 rounded-lg text-[12px] font-medium flex-shrink-0"
                    style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}>
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <button onClick={handleCreateCustomProvider}
                disabled={!customForm.id || !customForm.name}
                className="px-4 py-2 rounded-lg text-[13px] font-medium disabled:opacity-50"
                style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}>
                {t('models.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Template import dialog */}
      {showTemplateDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="rounded-2xl p-6 w-full max-w-lg animate-scale-in" style={{ background: 'var(--color-bg-elevated)' }}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-bold text-[16px]" style={{ fontFamily: 'var(--font-display)' }}>{t('models.templates')}</h2>
              <button onClick={() => setShowTemplateDialog(false)}
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
                      onClick={() => handleImportTemplate(tpl.id)}
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
      )}

      {/* JSON import dialog */}
      {showJsonImportDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="rounded-2xl p-6 w-full max-w-lg animate-scale-in" style={{ background: 'var(--color-bg-elevated)' }}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-bold text-[16px]" style={{ fontFamily: 'var(--font-display)' }}>{t('models.fromJson')}</h2>
              <button onClick={() => { setShowJsonImportDialog(false); setJsonImportText(''); }}
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
                onClick={handleJsonImport}
                disabled={!jsonImportText.trim()}
                className="px-4 py-2 rounded-lg text-[13px] font-medium disabled:opacity-50 flex items-center gap-1.5"
                style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}>
                <Upload size={14} />
                {t('models.importProvider')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (embedded) return content;

  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full px-8 py-10">
        {content}
      </div>
    </div>
  );
}
