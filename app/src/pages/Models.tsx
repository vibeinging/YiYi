/**
 * Models Configuration Page - Quick Setup
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  Plus,
  Package,
  Upload,
} from 'lucide-react';
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
import { ActiveModelCard } from '../components/models/ActiveModelCard';
import { ProviderCard } from '../components/models/ProviderCard';
import { CustomProviderCard } from '../components/models/CustomProviderCard';
import { CustomProviderDialog } from '../components/models/CustomProviderDialog';
import { TemplateImportDialog } from '../components/models/TemplateImportDialog';
import { JsonImportDialog } from '../components/models/JsonImportDialog';

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
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
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
      setApiKeyInputs(prev => { const next = { ...prev }; delete next[providerId]; return next; });
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
          <ActiveModelCard
            activeLlm={activeLlm}
            providers={providers}
            expandedProvider={expandedProvider}
            setExpandedProvider={setExpandedProvider}
          />
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
            {PROVIDER_LIST.map(meta => (
              <ProviderCard
                key={meta.id}
                meta={meta}
                provider={providers.find(p => p.id === meta.id)}
                activeLlm={activeLlm}
                expandedProvider={expandedProvider}
                setExpandedProvider={setExpandedProvider}
                apiKeyInputs={apiKeyInputs}
                setApiKeyInputs={setApiKeyInputs}
                showApiKey={showApiKey}
                setShowApiKey={setShowApiKey}
                baseUrlInputs={baseUrlInputs}
                setBaseUrlInputs={setBaseUrlInputs}
                customModelInput={customModelInput}
                setCustomModelInput={setCustomModelInput}
                selectedModel={selectedModel}
                setSelectedModel={setSelectedModel}
                zhipuSite={zhipuSite}
                setZhipuSite={setZhipuSite}
                testing={testing}
                saving={saving}
                testResults={testResults}
                onSaveProvider={handleSaveProvider}
                onTestConnection={handleTestConnection}
                onSetActiveModel={handleSetActiveModel}
                onAddModel={handleAddModel}
                onRemoveModel={handleRemoveModel}
              />
            ))}

            {/* Custom providers */}
            {customProviders.map(provider => (
              <CustomProviderCard
                key={provider.id}
                provider={provider}
                activeLlm={activeLlm}
                expandedProvider={expandedProvider}
                setExpandedProvider={setExpandedProvider}
                apiKeyInputs={apiKeyInputs}
                setApiKeyInputs={setApiKeyInputs}
                showApiKey={showApiKey}
                setShowApiKey={setShowApiKey}
                customModelInput={customModelInput}
                setCustomModelInput={setCustomModelInput}
                selectedModel={selectedModel}
                setSelectedModel={setSelectedModel}
                saving={saving}
                onSaveProvider={handleSaveProvider}
                onSetActiveModel={handleSetActiveModel}
                onAddModel={handleAddModel}
                onRemoveModel={handleRemoveModel}
                onDeleteProvider={handleDeleteProvider}
              />
            ))}
          </div>
        </div>

      {/* Create custom provider dialog */}
      {showCustomDialog && (
        <CustomProviderDialog
          customForm={customForm}
          setCustomForm={setCustomForm}
          onClose={() => setShowCustomDialog(false)}
          onSubmit={handleCreateCustomProvider}
          inputClass={inputClass}
        />
      )}

      {/* Template import dialog */}
      {showTemplateDialog && (
        <TemplateImportDialog
          templates={templates}
          providers={providers}
          importingTemplate={importingTemplate}
          onClose={() => setShowTemplateDialog(false)}
          onImport={handleImportTemplate}
        />
      )}

      {/* JSON import dialog */}
      {showJsonImportDialog && (
        <JsonImportDialog
          jsonImportText={jsonImportText}
          setJsonImportText={setJsonImportText}
          onClose={() => setShowJsonImportDialog(false)}
          onImport={handleJsonImport}
        />
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
