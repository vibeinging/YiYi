/**
 * Setup Wizard - AI-guided onboarding flow
 * Steps: Language → Model → Workspace → Persona
 * Layout: vertical progress rail on left + content area on right
 */

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import {
  Globe,
  Cpu,
  User,
  ChevronRight,
  ChevronLeft,
  Check,
  Key,
  Loader2,
  ExternalLink,
  Sparkles,
  FolderOpen,
  Shield,
} from 'lucide-react';
import yiyiLogo from '../assets/yiyi-logo.png';
import {
  configureProvider,
  testProvider,
  setActiveLlm,
  createCustomProvider,
  ZHIPU_SITES,
  type TestConnectionResponse,
} from '../api/models';
import {
  getWorkspacePath,
  pickFolder,
  listAuthorizedFolders,
  addAuthorizedFolder,
  removeAuthorizedFolder,
  type AuthorizedFolder,
} from '../api/workspace';

// Built-in provider IDs from backend (providers.rs builtin_providers)
const BUILTIN_PROVIDER_IDS = [
  'openai', 'anthropic', 'google', 'deepseek', 'dashscope',
  'modelscope', 'coding-plan', 'moonshot', 'minimax', 'zhipu',
];
import { completeSetup } from '../api/system';

interface SetupWizardProps {
  onComplete: () => void;
}

// All providers - grouped by region
const QUICK_PROVIDERS = [
  // --- Coding Plan 特惠套餐 ---
  {
    id: 'coding-plan', name: '阿里云百炼',
    desc: { zh: 'Qwen / GLM / Kimi / MiniMax 聚合', en: 'Qwen / GLM / Kimi / MiniMax bundle' },
    color: '#FF6A00', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    signupUrl: 'https://bailian.console.aliyun.com/',
    models: [
      { id: 'qwen3.5-plus', name: 'Qwen 3.5 Plus', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', tag: null },
      { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next', tag: null },
      { id: 'qwen3-max-2026-01-23', name: 'Qwen3 Max', tag: null },
      { id: 'glm-5', name: 'GLM-5', tag: null },
      { id: 'glm-4.7', name: 'GLM-4.7', tag: null },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', tag: null },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', tag: null },
    ],
    group: 'special',
  },
  {
    id: 'zhipu-coding', name: '智谱 GLM',
    desc: { zh: 'GLM-5 / GLM-4.7 编程套餐', en: 'GLM-5 / GLM-4.7 coding plan' },
    color: '#4B45E5', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    signupUrl: 'https://bigmodel.cn/glm-coding',
    models: [
      { id: 'glm-5', name: 'GLM-5', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'glm-4.7', name: 'GLM-4.7', tag: null },
    ],
    group: 'special',
  },
  {
    id: 'minimax-coding', name: 'MiniMax',
    desc: { zh: 'M2.5 / M2.1 编程套餐', en: 'M2.5 / M2.1 coding plan' },
    color: '#1A1A2E', baseUrl: 'https://api.minimaxi.com/v1',
    signupUrl: 'https://platform.minimaxi.com/docs/coding-plan/intro',
    models: [
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', tag: null },
    ],
    group: 'special',
  },
  {
    id: 'volc-coding', name: '火山方舟',
    desc: { zh: '豆包 / DeepSeek / GLM / Kimi', en: 'Doubao / DeepSeek / GLM / Kimi' },
    color: '#3370FF', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    signupUrl: 'https://www.volcengine.com/activity/codingplan',
    models: [
      { id: 'doubao-seed-2.0-code', name: 'Doubao Seed 2.0 Code', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', tag: null },
      { id: 'glm-4.7', name: 'GLM-4.7', tag: null },
      { id: 'kimi-k2', name: 'Kimi K2', tag: null },
    ],
    group: 'special',
  },
  {
    id: 'infini-coding', name: '无问芯穹',
    desc: { zh: 'DeepSeek / MiniMax / Kimi 聚合', en: 'DeepSeek / MiniMax / Kimi bundle' },
    color: '#7C3AED', baseUrl: 'https://cloud.infini-ai.com/maas/coding/v1',
    signupUrl: 'https://cloud.infini-ai.com/',
    models: [
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', tag: null },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', tag: null },
      { id: 'glm-5', name: 'GLM-5', tag: null },
    ],
    group: 'special',
  },
  {
    id: 'tencent-coding', name: '腾讯云',
    desc: { zh: '混元 / GLM / Kimi / MiniMax', en: 'Hunyuan / GLM / Kimi / MiniMax' },
    color: '#0052D9', baseUrl: 'https://api.lkeap.cloud.tencent.com/v1',
    signupUrl: 'https://cloud.tencent.com/act/pro/codingplan',
    models: [
      { id: 'hunyuan-hy2.0', name: 'Hunyuan HY 2.0', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'glm-5', name: 'GLM-5', tag: null },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', tag: null },
    ],
    group: 'special',
  },
  {
    id: 'kimi-coding', name: 'Kimi Code',
    desc: { zh: 'Kimi K2.5 编程专属', en: 'Kimi K2.5 for coding' },
    color: '#1C1C28', baseUrl: 'https://api.kimi.com/coding/v1',
    signupUrl: 'https://www.kimi.com/code/docs/benefits.html',
    models: [
      { id: 'kimi-for-coding', name: 'Kimi for Coding', tag: { zh: '推荐', en: 'Pick' } },
    ],
    group: 'special',
  },
  // --- 国内提供商 ---
  {
    id: 'dashscope', name: '通义千问 (DashScope)',
    desc: { zh: 'Qwen Max / Plus / Turbo', en: 'Qwen Max / Plus / Turbo' },
    color: '#6236FF', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    signupUrl: 'https://dashscope.console.aliyun.com/apiKey',
    models: [
      { id: 'qwen-max', name: 'Qwen Max', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'qwen-plus', name: 'Qwen Plus', tag: null },
      { id: 'qwen-turbo', name: 'Qwen Turbo', tag: { zh: '快速', en: 'Fast' } },
    ],
    group: 'cn',
  },
  {
    id: 'deepseek', name: 'DeepSeek',
    desc: { zh: 'DeepSeek V3 / R1', en: 'DeepSeek V3 / R1' },
    color: '#5B6EF5', baseUrl: 'https://api.deepseek.com/v1',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', tag: { zh: '推理', en: 'Reason' } },
    ],
    group: 'cn',
  },
  {
    id: 'moonshot', name: 'Kimi (Moonshot)',
    desc: { zh: 'Kimi K2.5 / Moonshot V1', en: 'Kimi K2.5 / Moonshot V1' },
    color: '#1A1A2E', baseUrl: 'https://api.moonshot.cn/v1',
    signupUrl: 'https://platform.moonshot.cn/console/api-keys',
    models: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K', tag: null },
      { id: 'moonshot-v1-32k', name: 'Moonshot V1 32K', tag: null },
    ],
    group: 'cn',
  },
  {
    id: 'minimax', name: 'MiniMax',
    desc: { zh: 'M2.5 / M2.5 Highspeed / M2.1', en: 'M2.5 / M2.5 Highspeed / M2.1' },
    color: '#FF4F81', baseUrl: 'https://api.minimax.io/v1',
    signupUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    models: [
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'MiniMax-M2.5-highspeed', name: 'M2.5 Highspeed', tag: { zh: '快速', en: 'Fast' } },
      { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', tag: null },
    ],
    group: 'cn',
  },
  {
    id: 'zhipu', name: '智谱 AI',
    desc: { zh: 'GLM-5 / GLM-4.7 / GLM-4', en: 'GLM-5 / GLM-4.7 / GLM-4' },
    color: '#3366FF', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    signupUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [
      { id: 'glm-5', name: 'GLM-5', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'glm-4.7', name: 'GLM-4.7', tag: null },
      { id: 'glm-4-plus', name: 'GLM-4 Plus', tag: null },
      { id: 'glm-4-flash', name: 'GLM-4 Flash', tag: { zh: '快速', en: 'Fast' } },
    ],
    group: 'cn',
  },
  {
    id: 'modelscope', name: 'ModelScope',
    desc: { zh: '魔搭社区模型推理', en: 'ModelScope Inference' },
    color: '#1890FF', baseUrl: 'https://api-inference.modelscope.cn/v1',
    signupUrl: 'https://modelscope.cn/my/myaccesstoken',
    models: [
      { id: 'qwen-max', name: 'Qwen Max', tag: null },
      { id: 'qwen-plus', name: 'Qwen Plus', tag: null },
      { id: 'deepseek-v3', name: 'DeepSeek V3', tag: null },
      { id: 'deepseek-r1', name: 'DeepSeek R1', tag: null },
    ],
    group: 'cn',
  },
  // --- 国际提供商 ---
  {
    id: 'openai', name: 'OpenAI',
    desc: { zh: 'GPT-5 / GPT-4.1 / o3 / o4', en: 'GPT-5 / GPT-4.1 / o3 / o4' },
    color: '#10A37F', baseUrl: 'https://api.openai.com/v1',
    signupUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'gpt-5-chat', name: 'GPT-5', tag: null },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', tag: null },
      { id: 'gpt-4.1', name: 'GPT-4.1', tag: null },
      { id: 'o3', name: 'o3', tag: { zh: '推理', en: 'Reason' } },
      { id: 'o4-mini', name: 'o4-mini', tag: { zh: '推理', en: 'Reason' } },
    ],
    group: 'intl',
  },
  {
    id: 'anthropic', name: 'Anthropic',
    desc: { zh: 'Claude Opus / Sonnet / Haiku', en: 'Claude Opus / Sonnet / Haiku' },
    color: '#D97757', baseUrl: 'https://api.anthropic.com',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tag: null },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', tag: { zh: '快速', en: 'Fast' } },
    ],
    group: 'intl',
  },
  {
    id: 'google', name: 'Google AI',
    desc: { zh: 'Gemini 2.5 Pro / Flash', en: 'Gemini 2.5 Pro / Flash' },
    color: '#4285F4', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    signupUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tag: { zh: '推荐', en: 'Pick' } },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tag: { zh: '快速', en: 'Fast' } },
    ],
    group: 'intl',
  },
];

// Tone style options
const TONE_STYLES = [
  { id: 'witty', emoji: '😄', name: { zh: '诙谐幽默', en: 'Witty & Humorous' }, desc: { zh: '轻松有趣，偶尔开玩笑', en: 'Light-hearted, occasional jokes' } },
  { id: 'balanced', emoji: '😊', name: { zh: '亲切自然', en: 'Warm & Natural' }, desc: { zh: '友好但不过分正式', en: 'Friendly without being too formal' } },
  { id: 'serious', emoji: '🧐', name: { zh: '严谨专业', en: 'Serious & Professional' }, desc: { zh: '精确严肃，注重专业性', en: 'Precise, focused on expertise' } },
  { id: 'concise', emoji: '⚡', name: { zh: '简洁高效', en: 'Concise & Efficient' }, desc: { zh: '尽量少说废话，直击要点', en: 'Minimal words, straight to the point' } },
];

// Role presets
const ROLE_PRESETS = [
  { id: 'assistant', emoji: '🤖', name: { zh: '通用助手', en: 'General Assistant' }, desc: { zh: '什么都能帮忙', en: 'Helps with everything' } },
  { id: 'developer', emoji: '💻', name: { zh: '开发助手', en: 'Dev Assistant' }, desc: { zh: '专注编程和技术', en: 'Coding & technical' } },
  { id: 'creative', emoji: '🎨', name: { zh: '创意助手', en: 'Creative Assistant' }, desc: { zh: '写作、创意、内容', en: 'Writing & content' } },
  { id: 'custom', emoji: '✨', name: { zh: '自定义', en: 'Custom' }, desc: { zh: '自由定义', en: 'Free-form' } },
];

// Step metadata with icons
const STEP_META = [
  { id: 'language' as const, icon: Globe, labelKey: { zh: '语言', en: 'Language' } },
  { id: 'model' as const, icon: Cpu, labelKey: { zh: '模型', en: 'Model' } },
  { id: 'workspace' as const, icon: FolderOpen, labelKey: { zh: '工作空间', en: 'Workspace' } },
  { id: 'persona' as const, icon: User, labelKey: { zh: '人格', en: 'Persona' } },
];

// Build SOUL.md content from persona config
function buildSoulContent(
  aiName: string,
  ownerName: string,
  tone: string,
  role: string,
  customDesc: string,
  lang: 'zh' | 'en',
): string {
  const name = aiName.trim() || 'YiYiClaw';
  const owner = ownerName.trim();

  const toneMap: Record<string, { zh: string; en: string }> = {
    witty: {
      zh: '你的风格诙谐幽默，喜欢用轻松有趣的方式交流，偶尔来点小幽默让对话更愉快。',
      en: 'Your style is witty and humorous. You communicate in a light-hearted way with occasional humor to make conversations enjoyable.',
    },
    balanced: {
      zh: '你的风格亲切自然，像朋友一样交流，友好但不浮夸。',
      en: 'Your style is warm and natural, communicating like a friend — friendly without being over-the-top.',
    },
    serious: {
      zh: '你的风格严谨专业，回答精确严肃，注重事实和专业性，避免不必要的闲聊。',
      en: 'Your style is serious and professional. You give precise, fact-based answers and avoid unnecessary small talk.',
    },
    concise: {
      zh: '你的风格简洁高效，尽量用最少的话表达最多的信息，直击要点，不说废话。',
      en: 'Your style is concise and efficient. You use minimal words to convey maximum information, always getting straight to the point.',
    },
  };

  const roleMap: Record<string, { zh: string; en: string }> = {
    assistant: {
      zh: `你是 ${name}，一个全能的 AI 助手。你善于对话、执行任务、分析问题、编写代码。`,
      en: `You are ${name}, a versatile AI assistant. You excel at conversation, task execution, problem analysis, and coding.`,
    },
    developer: {
      zh: `你是 ${name}，一个专业的开发助手。你精通多种编程语言和框架，擅长代码审查、调试、架构设计。`,
      en: `You are ${name}, a professional development assistant. You are proficient in multiple languages and frameworks, excelling at code review, debugging, and architecture design.`,
    },
    creative: {
      zh: `你是 ${name}，一个富有创造力的 AI 助手。你擅长创意写作、文案创作、头脑风暴和内容策划。`,
      en: `You are ${name}, a creative AI assistant. You excel at creative writing, copywriting, brainstorming, and content planning.`,
    },
    custom: { zh: '', en: '' },
  };

  const parts: string[] = [];

  // Role description
  if (role === 'custom') {
    if (customDesc.trim()) parts.push(customDesc.trim());
  } else {
    parts.push(roleMap[role]?.[lang] || roleMap.assistant[lang]);
  }

  // Owner
  if (owner) {
    parts.push(
      lang === 'zh'
        ? `你的主人叫「${owner}」，请记住这个名字并在合适的时候使用。`
        : `Your owner's name is "${owner}". Remember this name and use it when appropriate.`
    );
  }

  // Tone
  if (toneMap[tone]) {
    parts.push(toneMap[tone][lang]);
  }

  return parts.join('\n\n');
}

type Step = 'language' | 'model' | 'workspace' | 'persona';
const STEPS: Step[] = ['language', 'model', 'workspace', 'persona'];

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const { t } = useTranslation();
  const [currentStep, setCurrentStep] = useState<Step>('language');
  const [slideDir, setSlideDir] = useState<'up' | 'down' | null>(null);
  const [animating, setAnimating] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Language step
  const [selectedLang, setSelectedLang] = useState(
    localStorage.getItem('language') || 'zh'
  );

  // Model step
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [customModelId, setCustomModelId] = useState('');
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showBaseUrl, setShowBaseUrl] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);
  const [modelSaving, setModelSaving] = useState(false);

  // Workspace step
  const [workspacePath, setWorkspacePath] = useState('');
  const [authorizedFolders, setAuthorizedFolders] = useState<AuthorizedFolder[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  // Persona step
  const [aiName, setAiName] = useState('YiYiClaw');
  const [ownerName, setOwnerName] = useState('');
  const [toneStyle, setToneStyle] = useState('balanced');
  const [selectedRole, setSelectedRole] = useState('assistant');
  const [customSoul, setCustomSoul] = useState('');
  const [finishing, setFinishing] = useState(false);

  const lang = selectedLang.startsWith('zh') ? 'zh' : 'en';
  const stepIndex = STEPS.indexOf(currentStep);

  // Animate step transition
  const transitionTo = (target: Step) => {
    const targetIndex = STEPS.indexOf(target);
    const dir = targetIndex > stepIndex ? 'up' : 'down';
    setSlideDir(dir);
    setAnimating(true);

    // After exit animation, switch step and enter
    setTimeout(() => {
      setCurrentStep(target);
      setSlideDir(dir === 'up' ? 'down' : 'up'); // enter from opposite
      setTimeout(() => {
        setSlideDir(null);
        setAnimating(false);
      }, 30);
    }, 250);
  };

  // Reset scroll on step change
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [currentStep]);

  // Load workspace info when entering workspace step
  useEffect(() => {
    if (currentStep === 'workspace' && !workspacePath) {
      getWorkspacePath().then(setWorkspacePath).catch(() => {});
      listAuthorizedFolders().then(setAuthorizedFolders).catch(() => {});
    }
  }, [currentStep]);

  const handlePickFolder = async () => {
    const path = await pickFolder();
    if (path) {
      // Check if already in list
      if (authorizedFolders.some(f => f.path === path)) return;
      setWorkspaceLoading(true);
      try {
        const folder = await addAuthorizedFolder(path, undefined, 'read_write');
        setAuthorizedFolders(prev => [...prev, folder]);
      } catch (e) {
        console.error('Failed to add folder:', e);
      } finally {
        setWorkspaceLoading(false);
      }
    }
  };

  const handleRemoveFolder = async (id: string) => {
    try {
      await removeAuthorizedFolder(id);
      setAuthorizedFolders(prev => prev.filter(f => f.id !== id));
    } catch (e) {
      console.error('Failed to remove folder:', e);
    }
  };

  const handleLangSelect = (lng: string) => {
    setSelectedLang(lng);
    i18n.changeLanguage(lng);
    localStorage.setItem('language', lng);
  };

  const handleTestConnection = async () => {
    const provider = QUICK_PROVIDERS.find(p => p.id === selectedProvider);
    if (!provider || !apiKey.trim()) return;

    setTesting(true);
    setTestResult(null);
    try {
      const modelId = selectedModel || provider.models[0]?.id;
      const result = await testProvider(provider.id, apiKey.trim(), baseUrl || provider.baseUrl, modelId);
      setTestResult(result);
    } catch (e: any) {
      setTestResult({ success: false, message: e.toString() });
    } finally {
      setTesting(false);
    }
  };

  const handleModelSave = async () => {
    const provider = QUICK_PROVIDERS.find(p => p.id === selectedProvider);
    if (!provider || !apiKey.trim()) return;

    const modelId = useCustomModel ? customModelId.trim() : (selectedModel || provider.models[0].id);
    setModelSaving(true);
    try {
      // For non-builtin providers, create as custom provider first
      if (!BUILTIN_PROVIDER_IDS.includes(provider.id)) {
        await createCustomProvider(
          provider.id,
          provider.name,
          baseUrl || provider.baseUrl,
          provider.id.toUpperCase().replace(/-/g, '_') + '_API_KEY',
          provider.models.map(m => ({ id: m.id, name: m.name })),
        );
      }
      // Configure API key (needed for both custom and builtin)
      await configureProvider(provider.id, apiKey.trim(), baseUrl || provider.baseUrl);
      await setActiveLlm(provider.id, modelId);
      transitionTo('workspace');
    } catch (e: any) {
      setTestResult({ success: false, message: e.toString() });
    } finally {
      setModelSaving(false);
    }
  };

  const handleFinish = async () => {
    setFinishing(true);
    try {
      // Build and write SOUL.md
      const soulContent = buildSoulContent(aiName, ownerName, toneStyle, selectedRole, customSoul, lang);
      const { invoke } = await import('@tauri-apps/api/core');

      if (soulContent.trim()) {
        await invoke('save_workspace_file', {
          filename: 'SOUL.md',
          content: `---\nname: ${aiName.trim() || 'YiYiClaw'}\n---\n\n${soulContent}`,
        });
      }

      // Write language config
      await invoke('save_agents_config', { language: selectedLang });

      await completeSetup();
      onComplete();
    } catch (e) {
      console.error('Failed to finish setup:', e);
      // Still complete even if persona write fails
      await completeSetup().catch(() => {});
      onComplete();
    } finally {
      setFinishing(false);
    }
  };

  const canProceed = () => {
    switch (currentStep) {
      case 'language': return true;
      case 'model': return !!selectedProvider && !!apiKey.trim() && (useCustomModel ? !!customModelId.trim() : !!selectedModel);
      case 'workspace': return true; // workspace has defaults, always can proceed
      case 'persona': return selectedRole !== 'custom' || customSoul.trim().length > 0;
    }
  };

  const goNext = () => {
    if (currentStep === 'language') transitionTo('model');
    else if (currentStep === 'model') handleModelSave();
    else if (currentStep === 'workspace') transitionTo('persona');
    else if (currentStep === 'persona') handleFinish();
  };

  const goBack = () => {
    if (currentStep === 'model') transitionTo('language');
    else if (currentStep === 'workspace') transitionTo('model');
    else if (currentStep === 'persona') transitionTo('workspace');
  };

  // Slide animation style
  const contentStyle: React.CSSProperties = {
    transition: slideDir ? 'transform 0.25s ease, opacity 0.25s ease' : 'none',
    transform: slideDir === 'up' ? 'translateY(-30px)' : slideDir === 'down' ? 'translateY(30px)' : 'translateY(0)',
    opacity: slideDir ? 0 : 1,
  };

  return (
    <div
      className="h-screen flex"
      style={{ background: 'var(--color-bg)' }}
    >
      {/* Left: Vertical progress rail */}
      <div
        className="w-[260px] shrink-0 flex flex-col items-center pt-20 pb-10 px-6"
        style={{
          background: 'var(--color-bg-elevated)',
          borderRight: '1px solid var(--color-border)',
        }}
      >
        {/* Brand */}
        <div className="mb-16 text-center">
          <img src={yiyiLogo} alt="YiYiClaw" className="w-14 h-14 rounded-2xl mx-auto mb-3" />
          <div className="text-[20px] font-extrabold tracking-tight" style={{ color: 'var(--color-text)' }}>
            YiYiClaw
          </div>
          <div className="text-[12px] mt-1 font-medium tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
            {lang === 'zh' ? '初始设置' : 'Setup'}
          </div>
        </div>

        {/* Steps */}
        <div className="flex flex-col items-start gap-0 w-full pl-6">
          {STEP_META.map((step, i) => {
            const Icon = step.icon;
            const isActive = i === stepIndex;
            const isDone = i < stepIndex;

            return (
              <div key={step.id} className="flex items-start gap-0">
                {/* Dot + Line column */}
                <div className="flex flex-col items-center">
                  <div
                    className={`w-11 h-11 rounded-full flex items-center justify-center transition-all duration-300 ${
                      isDone ? 'bg-[var(--color-success)]' :
                      isActive ? 'bg-[var(--color-primary)]' :
                      'bg-[var(--color-bg-subtle)]'
                    }`}
                    style={{
                      boxShadow: isActive ? '0 0 0 5px var(--color-primary-subtle)' : 'none',
                    }}
                  >
                    {isDone ? (
                      <Check size={18} className="text-white" />
                    ) : (
                      <Icon size={18} className={isActive ? 'text-white' : ''} style={{ color: isActive ? undefined : 'var(--color-text-muted)' }} />
                    )}
                  </div>
                  {/* Connecting line */}
                  {i < STEP_META.length - 1 && (
                    <div
                      className="w-0.5 h-14 transition-colors duration-300"
                      style={{
                        background: isDone ? 'var(--color-success)' : 'var(--color-border)',
                      }}
                    />
                  )}
                </div>

                {/* Label */}
                <div className="ml-4 pt-2.5">
                  <div
                    className={`text-[14px] font-semibold transition-colors duration-300`}
                    style={{
                      color: isActive ? 'var(--color-text)' : isDone ? 'var(--color-success)' : 'var(--color-text-muted)',
                    }}
                  >
                    {step.labelKey[lang]}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Version */}
        <div className="text-[11px] font-medium" style={{ color: 'var(--color-text-tertiary)' }}>
          v0.1.0
        </div>
      </div>

      {/* Right: Content area */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Content */}
        <div
          ref={contentRef}
          className="flex-1 overflow-hidden"
        >
          <div className="h-full mx-auto px-12 py-10 flex flex-col" style={{ ...contentStyle, maxWidth: '1100px' }}>
            {/* Step: Language */}
            {currentStep === 'language' && (
              <div className="text-center pt-20">
                <img src={yiyiLogo} alt="YiYiClaw" className="w-24 h-24 rounded-3xl mx-auto mb-8" style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }} />
                <h1 className="text-4xl font-extrabold mb-4 tracking-tight" style={{ color: 'var(--color-text)' }}>
                  {lang === 'zh' ? '欢迎使用 YiYiClaw' : 'Welcome to YiYiClaw'}
                </h1>
                <p className="text-[16px] mb-12" style={{ color: 'var(--color-text-secondary)' }}>
                  {lang === 'zh' ? '选择你偏好的语言' : 'Choose your preferred language'}
                </p>

                <div className="flex gap-6 justify-center">
                  {[
                    { id: 'zh', label: '中文', sub: 'Chinese' },
                    { id: 'en', label: 'English', sub: '英语' },
                  ].map((l) => (
                    <button
                      key={l.id}
                      onClick={() => handleLangSelect(l.id)}
                      className="w-52 p-7 rounded-2xl border-2 transition-all text-center relative"
                      style={{
                        background: selectedLang === l.id ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
                        borderColor: selectedLang === l.id ? 'var(--color-primary)' : 'var(--color-border)',
                        color: selectedLang === l.id ? '#fff' : 'var(--color-text)',
                        boxShadow: selectedLang === l.id ? '0 8px 32px rgba(var(--color-primary-rgb), 0.3)' : 'var(--shadow-sm)',
                      }}
                    >
                      {selectedLang === l.id && (
                        <div className="absolute top-3 right-3">
                          <Check size={16} />
                        </div>
                      )}
                      <div className="text-xl font-bold mb-1.5">{l.label}</div>
                      <div className="text-[13px]" style={{ color: selectedLang === l.id ? 'rgba(255,255,255,0.8)' : 'var(--color-text-muted)' }}>{l.sub}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Step: Model */}
            {currentStep === 'model' && (
              <div>
                <div className="text-center mb-8">
                  <h1 className="text-4xl font-extrabold mb-3 tracking-tight" style={{ color: 'var(--color-text)' }}>
                    {lang === 'zh' ? '选择你的 AI 引擎' : 'Choose Your AI Engine'}
                  </h1>
                  <p className="text-[15px] leading-relaxed max-w-[500px] mx-auto" style={{ color: 'var(--color-text-secondary)' }}>
                    {lang === 'zh'
                      ? 'YiYiClaw 本身是一个助手框架，它需要连接一个 AI 模型才能工作 —— 就像给它装上一颗会思考的大脑。选一个你喜欢的，填上 Key 就行'
                      : 'YiYiClaw is an assistant framework — it needs an AI model to work, like giving it a brain that can think. Just pick one you like and enter the API Key'}
                  </p>
                </div>

                <div className="flex gap-10 flex-1 min-h-0">
                  {/* Left: Provider list (scrollable) */}
                  <div className="w-[280px] shrink-0 relative">
                    <div className="overflow-y-auto pr-1 h-full scrollbar-visible" style={{ maxHeight: 'calc(100vh - 280px)' }} id="provider-list">
                    {/* Group: Special */}
                    {QUICK_PROVIDERS.filter(p => p.group === 'special').length > 0 && (
                      <>
                        <div className="text-[11px] font-bold uppercase tracking-wider mb-3 px-1" style={{ color: 'var(--color-text-tertiary)' }}>
                          {lang === 'zh' ? '特惠套餐' : 'Special'}
                        </div>
                        <div className="space-y-2 mb-5">
                          {QUICK_PROVIDERS.filter(p => p.group === 'special').map((p) => (
                            <button
                              key={p.id}
                              onClick={() => {
                                if (selectedProvider === p.id) {
                                  setSelectedProvider(null);
                                  setSelectedModel(null);
                                  setApiKey('');
                                  setTestResult(null);
                                } else {
                                  setSelectedProvider(p.id);
                                  setSelectedModel(p.models[0].id);
                                  setCustomModelId('');
                                  setUseCustomModel(false);
                                  setApiKey('');
                                  setBaseUrl(p.baseUrl);
                                  setShowBaseUrl(false);
                                  setTestResult(null);
                                }
                              }}
                              className="w-full p-3.5 rounded-xl border-2 text-left transition-all relative"
                              style={{
                                background: selectedProvider === p.id ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
                                borderColor: selectedProvider === p.id ? 'var(--color-primary)' : 'var(--color-border)',
                                boxShadow: selectedProvider === p.id ? '0 2px 12px rgba(var(--color-primary-rgb), 0.25)' : 'none',
                              }}
                            >
                              <div className="flex items-center gap-3">
                                <div className="w-3.5 h-3.5 rounded-full shrink-0" style={{ background: p.color }} />
                                <div className="flex-1 min-w-0">
                                  <span className="font-semibold text-[13px] block truncate" style={{ color: selectedProvider === p.id ? '#fff' : 'var(--color-text)' }}>{p.name}</span>
                                  <span className="text-[10px] block truncate" style={{ color: selectedProvider === p.id ? 'rgba(255,255,255,0.65)' : 'var(--color-text-tertiary)' }}>{p.desc[lang]}</span>
                                </div>
                                {selectedProvider === p.id && <Check size={14} className="shrink-0 text-white/80" />}
                              </div>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    {/* Group: CN */}
                    <div className="text-[11px] font-bold uppercase tracking-wider mb-3 px-1" style={{ color: 'var(--color-text-tertiary)' }}>
                      {lang === 'zh' ? '国内' : 'China'}
                    </div>
                    <div className="space-y-2 mb-5">
                      {QUICK_PROVIDERS.filter(p => p.group === 'cn').map((p) => (
                        <button
                          key={p.id}
                          onClick={() => {
                            setSelectedProvider(p.id);
                            setSelectedModel(p.models[0].id);
                            setCustomModelId('');
                            setUseCustomModel(false);
                            setApiKey('');
                            setBaseUrl(p.baseUrl);
                            setShowBaseUrl(false);
                            setTestResult(null);
                          }}
                          className="w-full p-3.5 rounded-xl border-2 text-left transition-all"
                          style={{
                            background: selectedProvider === p.id ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
                            borderColor: selectedProvider === p.id ? 'var(--color-primary)' : 'var(--color-border)',
                            boxShadow: selectedProvider === p.id ? '0 2px 12px rgba(var(--color-primary-rgb), 0.25)' : 'none',
                          }}
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ background: p.color }} />
                            <div className="flex-1 min-w-0">
                              <span className="font-semibold text-[12px] block truncate" style={{ color: selectedProvider === p.id ? '#fff' : 'var(--color-text)' }}>{p.name}</span>
                              <span className="text-[10px] block truncate" style={{ color: selectedProvider === p.id ? 'rgba(255,255,255,0.6)' : 'var(--color-text-tertiary)' }}>{p.desc[lang]}</span>
                            </div>
                            {selectedProvider === p.id && <Check size={12} className="shrink-0 text-white/80" />}
                          </div>
                        </button>
                      ))}
                    </div>
                    {/* Group: Intl */}
                    <div className="text-[11px] font-bold uppercase tracking-wider mb-3 px-1" style={{ color: 'var(--color-text-tertiary)' }}>
                      {lang === 'zh' ? '国际' : 'International'}
                    </div>
                    <div className="space-y-2 pb-10">
                      {QUICK_PROVIDERS.filter(p => p.group === 'intl').map((p) => (
                        <button
                          key={p.id}
                          onClick={() => {
                            setSelectedProvider(p.id);
                            setSelectedModel(p.models[0].id);
                            setCustomModelId('');
                            setUseCustomModel(false);
                            setApiKey('');
                            setBaseUrl(p.baseUrl);
                            setShowBaseUrl(false);
                            setTestResult(null);
                          }}
                          className="w-full p-3.5 rounded-xl border-2 text-left transition-all"
                          style={{
                            background: selectedProvider === p.id ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
                            borderColor: selectedProvider === p.id ? 'var(--color-primary)' : 'var(--color-border)',
                            boxShadow: selectedProvider === p.id ? '0 2px 12px rgba(var(--color-primary-rgb), 0.25)' : 'none',
                          }}
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ background: p.color }} />
                            <div className="flex-1 min-w-0">
                              <span className="font-semibold text-[12px] block truncate" style={{ color: selectedProvider === p.id ? '#fff' : 'var(--color-text)' }}>{p.name}</span>
                              <span className="text-[10px] block truncate" style={{ color: selectedProvider === p.id ? 'rgba(255,255,255,0.6)' : 'var(--color-text-tertiary)' }}>{p.desc[lang]}</span>
                            </div>
                            {selectedProvider === p.id && <Check size={12} className="shrink-0 text-white/80" />}
                          </div>
                        </button>
                      ))}
                    </div>
                    </div>
                    {/* Scroll indicator */}
                    <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none" style={{ background: 'linear-gradient(to top, var(--color-bg), transparent)' }} />
                    <div className="absolute bottom-1 left-0 right-0 text-center pointer-events-none">
                      <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' }}>
                        {lang === 'zh' ? '↓ 滑动查看更多' : '↓ Scroll for more'}
                      </span>
                    </div>
                  </div>

                  {/* Right: Configuration */}
                  <div className="flex-1 min-w-0">
                    {!selectedProvider ? (
                      <div className="h-full flex flex-col justify-center px-8" style={{ minHeight: 'calc(100vh - 300px)' }}>
                        {/* Coding plan tip */}
                        <div
                          className="rounded-2xl px-7 py-6 mb-10 flex items-start gap-4"
                          style={{ background: 'rgba(255,106,0,0.05)', border: '1px solid rgba(255,106,0,0.10)' }}
                        >
                          <Sparkles size={20} className="shrink-0 mt-1" style={{ color: '#FF6A00' }} />
                          <div>
                            <div className="text-[15px] font-bold mb-1.5" style={{ color: 'var(--color-text)' }}>
                              {lang === 'zh' ? '不知道选哪个？' : 'Not sure which to pick?'}
                            </div>
                            <p className="text-[14px] leading-[1.7]" style={{ color: 'var(--color-text-secondary)' }}>
                              {lang === 'zh'
                                ? '试试左侧「特惠套餐」—— 一个 Key 就能用多个模型，不用逐个注册，适合刚上手。'
                                : 'Try "Special Plans" on the left — one Key for multiple models, no need to register each. Great for getting started.'}
                            </p>
                          </div>
                        </div>

                        {/* Model guide */}
                        <div className="text-[13px] font-bold uppercase tracking-wider mb-6 px-1" style={{ color: 'var(--color-text-tertiary)' }}>
                          {lang === 'zh' ? '选型参考' : 'Quick Reference'}
                        </div>

                        <div className="space-y-5 mb-12">
                          {([
                            { name: { zh: '编程套餐', en: 'Coding Plans' }, hint: { zh: '一个 Key 用多个模型，新手首选', en: 'One key, multiple models — best for beginners' }, color: '#FF6A00' },
                            { name: { zh: 'DeepSeek', en: 'DeepSeek' }, hint: { zh: '推理强，价格低', en: 'Strong reasoning, low cost' }, color: '#5B6EF5' },
                            { name: { zh: 'Qwen', en: 'Qwen' }, hint: { zh: '中文好，工具调用稳定', en: 'Best Chinese, stable tool use' }, color: '#6236FF' },
                            { name: { zh: 'MiniMax', en: 'MiniMax' }, hint: { zh: '速度快，综合能力强', en: 'Fast, strong overall' }, color: '#FF4F81' },
                            { name: { zh: 'OpenAI', en: 'OpenAI' }, hint: { zh: '行业标杆，生态完善', en: 'Industry standard, rich ecosystem' }, color: '#10A37F' },
                            { name: { zh: 'Claude', en: 'Claude' }, hint: { zh: '编程最强，输出质量高', en: 'Best coding, high quality output' }, color: '#D97757' },
                            { name: { zh: 'Gemini', en: 'Gemini' }, hint: { zh: '多模态领先，免费额度大', en: 'Best multimodal, generous free tier' }, color: '#4285F4' },
                          ]).map((m, i) => (
                            <div key={i} className="flex items-center gap-4">
                              <div className="w-3 h-3 rounded-full shrink-0" style={{ background: m.color }} />
                              <span className="text-[15px] font-semibold shrink-0 w-[90px]" style={{ color: 'var(--color-text)' }}>{m.name[lang]}</span>
                              <span className="text-[14px]" style={{ color: 'var(--color-text-tertiary)' }}>{m.hint[lang]}</span>
                            </div>
                          ))}
                        </div>

                        <p className="text-[13px] text-center" style={{ color: 'var(--color-text-muted)' }}>
                          {lang === 'zh' ? '← 从左侧选择一个提供商开始' : '← Pick a provider from the left'}
                        </p>
                      </div>
                    ) : (() => {
                      const provider = QUICK_PROVIDERS.find(p => p.id === selectedProvider)!;
                      return (
                        <div className="space-y-6">
                          {/* API Key + Base URL */}
                          <div className="p-7 rounded-2xl border" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
                            <div className="flex items-center justify-between mb-4">
                              <div className="flex items-center gap-2.5">
                                <Key size={16} className="text-[var(--color-primary)]" />
                                <span className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>
                                  API Key
                                </span>
                              </div>
                              <a
                                href="#"
                                onClick={(e) => {
                                  e.preventDefault();
                                  import('@tauri-apps/plugin-shell').then(m => m.open(provider.signupUrl));
                                }}
                                className="text-[13px] flex items-center gap-1.5 font-medium"
                                style={{ color: 'var(--color-primary)' }}
                              >
                                {lang === 'zh' ? '获取 Key' : 'Get Key'} <ExternalLink size={13} />
                              </a>
                            </div>
                            <input
                              type="password"
                              value={apiKey}
                              onChange={(e) => { setApiKey(e.target.value); setTestResult(null); }}
                              placeholder={lang === 'zh' ? '粘贴你的 API Key...' : 'Paste your API Key...'}
                              className="w-full px-5 py-3.5 rounded-xl text-[14px] outline-none"
                              style={{
                                background: 'var(--color-bg-subtle)',
                                color: 'var(--color-text)',
                                border: '1px solid var(--color-border)',
                              }}
                            />

                            {/* Base URL (collapsible) */}
                            <div className="mt-3">
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => setShowBaseUrl(!showBaseUrl)}
                                  className="text-[11px] font-medium flex items-center gap-1"
                                  style={{ color: 'var(--color-text-muted)' }}
                                >
                                  <ChevronRight size={12} className={`transition-transform ${showBaseUrl ? 'rotate-90' : ''}`} />
                                  Base URL
                                  {!showBaseUrl && (
                                    <span className="ml-1 text-[10px] font-normal" style={{ color: 'var(--color-text-tertiary)' }}>
                                      {baseUrl}
                                    </span>
                                  )}
                                </button>
                                {(provider.id === 'zhipu' || provider.id === 'zhipu-coding') && (
                                  <span className="ml-auto flex gap-1">
                                    {(['cn', 'intl'] as const).map(siteKey => {
                                      const site = ZHIPU_SITES[siteKey];
                                      const url = provider.id === 'zhipu-coding' ? site.codingBaseUrl : site.baseUrl;
                                      return (
                                        <button
                                          key={siteKey}
                                          onClick={() => setBaseUrl(url)}
                                          className="px-2 py-0.5 rounded-md text-[10px] font-medium transition-all"
                                          style={{
                                            background: baseUrl === url ? provider.color + '20' : 'transparent',
                                            color: baseUrl === url ? provider.color : 'var(--color-text-muted)',
                                            border: `1px solid ${baseUrl === url ? provider.color + '40' : 'transparent'}`,
                                          }}
                                        >
                                          {site.label}
                                        </button>
                                      );
                                    })}
                                  </span>
                                )}
                              </div>
                              {showBaseUrl && (
                                <input
                                  value={baseUrl}
                                  onChange={(e) => setBaseUrl(e.target.value)}
                                  placeholder={provider.baseUrl}
                                  className="w-full mt-2 px-4 py-2 rounded-lg text-[12px] outline-none"
                                  style={{
                                    background: 'var(--color-bg-subtle)',
                                    color: 'var(--color-text)',
                                    border: '1px solid var(--color-border)',
                                  }}
                                />
                              )}
                            </div>

                          </div>

                          {/* Model selection */}
                          <div className="p-7 rounded-2xl border" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
                            <div className="flex items-center justify-between mb-4">
                              <div className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>
                                {lang === 'zh' ? '选择模型' : 'Choose Model'}
                              </div>
                              <button
                                onClick={() => {
                                  setUseCustomModel(!useCustomModel);
                                  if (!useCustomModel) setSelectedModel(null);
                                  else {
                                    setCustomModelId('');
                                    setSelectedModel(provider.models[0].id);
                                  }
                                }}
                                className="text-[11px] font-medium px-2.5 py-1 rounded-lg transition-colors"
                                style={{
                                  color: useCustomModel ? 'var(--color-primary)' : 'var(--color-text-muted)',
                                  background: useCustomModel ? 'var(--color-primary-subtle)' : 'transparent',
                                }}
                              >
                                {lang === 'zh' ? '自定义' : 'Custom'}
                              </button>
                            </div>

                            {!useCustomModel ? (
                              <div className="space-y-2.5 max-h-[220px] overflow-y-auto pr-1">
                                {provider.models.map((m) => (
                                  <button
                                    key={m.id}
                                    onClick={() => setSelectedModel(m.id)}
                                    className="w-full flex items-center gap-3.5 px-4 py-3 rounded-xl border-2 text-left transition-all"
                                    style={{
                                      background: selectedModel === m.id ? 'var(--color-primary)' : 'transparent',
                                      borderColor: selectedModel === m.id ? 'var(--color-primary)' : 'var(--color-border)',
                                      boxShadow: selectedModel === m.id ? '0 2px 12px rgba(var(--color-primary-rgb), 0.25)' : 'none',
                                    }}
                                  >
                                    <div className="flex-1 min-w-0">
                                      <span className="text-[14px] font-medium" style={{ color: selectedModel === m.id ? '#fff' : 'var(--color-text)' }}>
                                        {m.name}
                                      </span>
                                      <span className="text-[12px] ml-2" style={{ color: selectedModel === m.id ? 'rgba(255,255,255,0.7)' : 'var(--color-text-tertiary)' }}>
                                        {m.id}
                                      </span>
                                    </div>
                                    {m.tag && (
                                      <span
                                        className="shrink-0 text-[11px] font-semibold px-2.5 py-1 rounded-full"
                                        style={{
                                          background: selectedModel === m.id ? 'rgba(255,255,255,0.2)' : 'var(--color-primary-subtle)',
                                          color: selectedModel === m.id ? '#fff' : 'var(--color-primary)',
                                        }}
                                      >
                                        {m.tag[lang]}
                                      </span>
                                    )}
                                    {selectedModel === m.id && <Check size={14} className="text-white/80 shrink-0" />}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div>
                                <p className="text-[12px] mb-2.5" style={{ color: 'var(--color-text-muted)' }}>
                                  {lang === 'zh' ? '输入模型 ID（如 gpt-4o-2024-08-06）' : 'Enter model ID (e.g. gpt-4o-2024-08-06)'}
                                </p>
                                <input
                                  value={customModelId}
                                  onChange={(e) => setCustomModelId(e.target.value)}
                                  placeholder={lang === 'zh' ? '模型 ID...' : 'Model ID...'}
                                  className="w-full px-4 py-2.5 rounded-lg text-[13px] outline-none"
                                  style={{
                                    background: 'var(--color-bg-subtle)',
                                    color: 'var(--color-text)',
                                    border: '1px solid var(--color-border)',
                                  }}
                                />
                              </div>
                            )}
                          </div>

                          {/* Test connection - after both key and model are set */}
                          <div className="flex items-center gap-4">
                            <button
                              onClick={handleTestConnection}
                              disabled={!apiKey.trim() || (!selectedModel && !customModelId.trim()) || testing}
                              className={`px-6 py-3 rounded-xl text-[14px] font-medium flex items-center gap-2.5 transition-all ${!testing ? 'disabled:opacity-40' : ''}`}
                              style={{
                                background: testing ? provider.color + '10' : 'var(--color-bg-elevated)',
                                color: testing ? provider.color : 'var(--color-text)',
                                border: `1px solid ${testing ? provider.color + '40' : 'var(--color-border)'}`,
                              }}
                            >
                              {testing ? <Loader2 size={15} className="animate-spin" /> : null}
                              {testing
                                ? (lang === 'zh' ? '测试中...' : 'Testing...')
                                : (lang === 'zh' ? '测试连接' : 'Test Connection')}
                            </button>
                            {testResult && !testing && (
                              <span className={`text-[14px] font-medium ${testResult.success ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}>
                                {testResult.success ? `OK · ${testResult.message}` : testResult.message}
                              </span>
                            )}
                          </div>
                          {testResult?.reply && !testing && (
                            <div
                              className="p-3 rounded-xl text-[13px] leading-relaxed whitespace-pre-wrap"
                              style={{
                                background: testResult.success ? provider.color + '08' : 'rgba(239,68,68,0.08)',
                                border: `1px solid ${testResult.success ? provider.color + '20' : 'rgba(239,68,68,0.2)'}`,
                                color: 'var(--color-text)',
                                maxHeight: '120px',
                                overflowY: 'auto',
                              }}
                            >
                              {testResult.reply}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )}

            {/* Step: Workspace */}
            {currentStep === 'workspace' && (
              <div className="pt-10">
                <div className="text-center mb-10">
                  <div className="w-20 h-20 rounded-3xl bg-[var(--color-primary-subtle)] flex items-center justify-center mx-auto mb-8">
                    <FolderOpen size={36} className="text-[var(--color-primary)]" />
                  </div>
                  <h1 className="text-4xl font-extrabold mb-4 tracking-tight" style={{ color: 'var(--color-text)' }}>
                    {lang === 'zh' ? '工作空间设置' : 'Workspace Setup'}
                  </h1>
                  <p className="text-[16px]" style={{ color: 'var(--color-text-secondary)' }}>
                    {lang === 'zh'
                      ? 'Agent 生成的文件将保存到默认工作目录，你也可以授权额外的文件夹'
                      : 'Agent-generated files are saved to the default workspace. You can also authorize additional folders.'}
                  </p>
                </div>

                {/* Default workspace */}
                <div className="mb-8">
                  <div className="text-[13px] font-semibold mb-3 uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                    {lang === 'zh' ? '默认工作目录' : 'Default Workspace'}
                  </div>
                  <div
                    className="flex items-center gap-4 px-5 py-4 rounded-xl"
                    style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
                  >
                    <FolderOpen size={20} style={{ color: 'var(--color-primary)' }} />
                    <code className="text-[14px] flex-1 truncate" style={{ color: 'var(--color-text)' }}>
                      {workspacePath || '~/Documents/YiYiClaw'}
                    </code>
                    <div
                      className="px-3 py-1 rounded-lg text-[11px] font-semibold"
                      style={{ background: 'var(--color-success)', color: '#fff' }}
                    >
                      {lang === 'zh' ? '读写' : 'R/W'}
                    </div>
                  </div>
                  <p className="text-[12px] mt-2" style={{ color: 'var(--color-text-tertiary)' }}>
                    {lang === 'zh'
                      ? '此目录由系统管理，Agent 会将产物（代码、文档、图片等）保存到这里'
                      : 'Managed by the system. Agent saves generated files (code, docs, images) here.'}
                  </p>
                </div>

                {/* Authorized folders */}
                <div className="mb-6">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                      {lang === 'zh' ? '授权文件夹' : 'Authorized Folders'}
                    </div>
                    <button
                      onClick={handlePickFolder}
                      disabled={workspaceLoading}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                      style={{ background: 'var(--color-primary)', color: '#fff' }}
                    >
                      {workspaceLoading ? <Loader2 size={12} className="animate-spin" /> : <>+ {lang === 'zh' ? '添加文件夹' : 'Add Folder'}</>}
                    </button>
                  </div>

                  {authorizedFolders.filter(f => !f.is_default).length === 0 ? (
                    <div
                      className="px-4 py-6 rounded-xl text-center text-[13px]"
                      style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-tertiary)', border: '1px dashed var(--color-border)' }}
                    >
                      {lang === 'zh'
                        ? '暂无额外授权文件夹。Agent 仅能访问默认工作目录。'
                        : 'No extra folders authorized. Agent can only access the default workspace.'}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {authorizedFolders.filter(f => !f.is_default).map(folder => (
                        <div
                          key={folder.id}
                          className="flex items-center gap-3 px-4 py-2.5 rounded-xl group"
                          style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
                        >
                          <FolderOpen size={16} style={{ color: 'var(--color-text-muted)' }} />
                          <code className="text-[12px] flex-1 truncate" style={{ color: 'var(--color-text)' }}>
                            {folder.path}
                          </code>
                          <div
                            className="px-2 py-0.5 rounded text-[10px] font-medium"
                            style={{
                              background: folder.permission === 'read_write' ? 'var(--color-success)' : 'var(--color-warning)',
                              color: '#fff',
                            }}
                          >
                            {folder.permission === 'read_write' ? (lang === 'zh' ? '读写' : 'R/W') : (lang === 'zh' ? '只读' : 'R/O')}
                          </div>
                          <button
                            onClick={() => handleRemoveFolder(folder.id)}
                            className="opacity-0 group-hover:opacity-100 text-[12px] px-1.5 py-0.5 rounded transition-opacity"
                            style={{ color: 'var(--color-danger)' }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-[11px] mt-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
                    {lang === 'zh'
                      ? '授权后 Agent 可读写这些文件夹。可随时在设置中修改。'
                      : 'Agent can read/write these folders once authorized. Adjustable in Settings anytime.'}
                  </p>
                </div>

                {/* Security note */}
                <div
                  className="flex items-start gap-3 px-4 py-3 rounded-xl"
                  style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)' }}
                >
                  <Shield size={18} className="shrink-0 mt-0.5" style={{ color: 'var(--color-warning)' }} />
                  <div>
                    <div className="text-[12px] font-semibold mb-0.5" style={{ color: 'var(--color-text)' }}>
                      {lang === 'zh' ? '敏感文件保护' : 'Sensitive File Protection'}
                    </div>
                    <div className="text-[11px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                      {lang === 'zh'
                        ? '系统内置了 .env、.ssh、.pem 等敏感文件的保护规则，即使在授权文件夹中也会被拦截。可在设置中查看和管理。'
                        : 'Built-in protection rules for .env, .ssh, .pem and other sensitive files. These are blocked even in authorized folders. Manage in Settings.'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Step: Persona */}
            {currentStep === 'persona' && (
              <div className="flex-1 overflow-y-auto min-h-0">
                <div className="text-center mb-10">
                  <h1 className="text-4xl font-extrabold mb-4 tracking-tight" style={{ color: 'var(--color-text)' }}>
                    {lang === 'zh' ? '设定你的 AI 助手' : 'Set Up Your AI Assistant'}
                  </h1>
                  <p className="text-[16px]" style={{ color: 'var(--color-text-secondary)' }}>
                    {lang === 'zh' ? '给 AI 起个名字，告诉它你是谁' : 'Give your AI a name and introduce yourself'}
                  </p>
                </div>

                {/* Names row */}
                <div className="grid grid-cols-2 gap-6 mb-8">
                  <div className="p-6 rounded-2xl border" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
                    <label className="text-[13px] font-semibold block mb-3" style={{ color: 'var(--color-text-muted)' }}>
                      {lang === 'zh' ? 'AI 的名字' : 'AI Name'}
                    </label>
                    <input
                      value={aiName}
                      onChange={(e) => setAiName(e.target.value)}
                      placeholder="YiYiClaw"
                      className="w-full px-4 py-3 rounded-xl text-[15px] font-medium outline-none"
                      style={{
                        background: 'var(--color-bg-subtle)',
                        color: 'var(--color-text)',
                        border: '1px solid var(--color-border)',
                      }}
                    />
                  </div>
                  <div className="p-6 rounded-2xl border" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
                    <label className="text-[13px] font-semibold block mb-3" style={{ color: 'var(--color-text-muted)' }}>
                      {lang === 'zh' ? '你的称呼（主人名字）' : 'Your Name (Owner)'}
                    </label>
                    <input
                      value={ownerName}
                      onChange={(e) => setOwnerName(e.target.value)}
                      placeholder={lang === 'zh' ? '你的名字或昵称' : 'Your name or nickname'}
                      className="w-full px-4 py-3 rounded-xl text-[15px] font-medium outline-none"
                      style={{
                        background: 'var(--color-bg-subtle)',
                        color: 'var(--color-text)',
                        border: '1px solid var(--color-border)',
                      }}
                    />
                  </div>
                </div>

                {/* Tone style */}
                <div className="mb-8">
                  <div className="text-[13px] font-semibold mb-4" style={{ color: 'var(--color-text-muted)' }}>
                    {lang === 'zh' ? '回复语气' : 'Response Tone'}
                  </div>
                  <div className="grid grid-cols-4 gap-3.5">
                    {TONE_STYLES.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setToneStyle(t.id)}
                        className="p-4 rounded-2xl border-2 text-center transition-all"
                        style={{
                          background: toneStyle === t.id ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
                          borderColor: toneStyle === t.id ? 'var(--color-primary)' : 'var(--color-border)',
                          boxShadow: toneStyle === t.id ? '0 2px 12px rgba(var(--color-primary-rgb), 0.25)' : 'none',
                        }}
                      >
                        <div className="text-2xl mb-2">{t.emoji}</div>
                        <div className="text-[12px] font-semibold" style={{ color: toneStyle === t.id ? '#fff' : 'var(--color-text)' }}>
                          {t.name[lang]}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Role preset */}
                <div className="mb-8">
                  <div className="text-[13px] font-semibold mb-4" style={{ color: 'var(--color-text-muted)' }}>
                    {lang === 'zh' ? '角色定位' : 'Role'}
                  </div>
                  <div className="grid grid-cols-4 gap-3.5">
                    {ROLE_PRESETS.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => setSelectedRole(r.id)}
                        className="p-4 rounded-2xl border-2 text-center transition-all"
                        style={{
                          background: selectedRole === r.id ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
                          borderColor: selectedRole === r.id ? 'var(--color-primary)' : 'var(--color-border)',
                          boxShadow: selectedRole === r.id ? '0 2px 12px rgba(var(--color-primary-rgb), 0.25)' : 'none',
                        }}
                      >
                        <div className="text-2xl mb-2">{r.emoji}</div>
                        <div className="text-[12px] font-semibold" style={{ color: selectedRole === r.id ? '#fff' : 'var(--color-text)' }}>
                          {r.name[lang]}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Custom role description */}
                {selectedRole === 'custom' && (
                  <div className="p-4 rounded-xl border mb-6" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
                    <label className="text-[12px] font-medium block mb-2" style={{ color: 'var(--color-text-muted)' }}>
                      {lang === 'zh' ? '自定义角色描述' : 'Custom Role Description'}
                    </label>
                    <textarea
                      value={customSoul}
                      onChange={(e) => setCustomSoul(e.target.value)}
                      rows={3}
                      placeholder={
                        lang === 'zh'
                          ? '例如：你是一个专业的数据分析师，擅长用简洁的方式解释复杂的数据...'
                          : 'e.g.: You are a professional data analyst who excels at explaining complex data simply...'
                      }
                      className="w-full px-3 py-2.5 rounded-lg text-[13px] outline-none resize-none"
                      style={{
                        background: 'var(--color-bg-subtle)',
                        color: 'var(--color-text)',
                        border: '1px solid var(--color-border)',
                      }}
                    />
                  </div>
                )}

                {/* Preview */}
                {(selectedRole !== 'custom' || customSoul.trim()) && (
                  <div className="p-4 rounded-xl" style={{ background: 'var(--color-bg-subtle)' }}>
                    <div className="text-[11px] font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>
                      {lang === 'zh' ? '预览 SOUL.md' : 'Preview SOUL.md'}
                    </div>
                    <div className="text-[12px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--color-text-secondary)' }}>
                      {buildSoulContent(aiName, ownerName, toneStyle, selectedRole, customSoul, lang)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Bottom navigation bar */}
        <div
          className="shrink-0 px-8 py-5 flex items-center justify-between"
          style={{ borderTop: '1px solid var(--color-border)' }}
        >
          <div>
            {stepIndex > 0 && (
              <button
                onClick={goBack}
                disabled={animating}
                className="flex items-center gap-2.5 px-6 py-3 rounded-xl text-[14px] font-medium transition-colors disabled:opacity-40"
                style={{ color: 'var(--color-text-secondary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <ChevronLeft size={18} />
                {t('common.back')}
              </button>
            )}
          </div>

          <div className="flex items-center gap-4">
            {(currentStep === 'model' || currentStep === 'workspace') && (
              <button
                onClick={() => transitionTo(currentStep === 'model' ? 'workspace' : 'persona')}
                disabled={animating}
                className="px-6 py-3 rounded-xl text-[14px] font-medium disabled:opacity-40"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {lang === 'zh' ? '跳过' : 'Skip'}
              </button>
            )}
            <button
              onClick={goNext}
              disabled={!canProceed() || modelSaving || finishing || animating}
              className="flex items-center gap-2.5 px-8 py-3 rounded-xl text-[14px] font-bold text-white transition-all disabled:opacity-40"
              style={{ background: 'var(--color-primary)', boxShadow: '0 4px 16px rgba(var(--color-primary-rgb), 0.3)' }}
            >
              {(modelSaving || finishing) && <Loader2 size={16} className="animate-spin" />}
              {currentStep === 'persona' ? (
                <>
                  <Sparkles size={16} />
                  {lang === 'zh' ? '开始使用' : 'Get Started'}
                </>
              ) : (
                <>
                  {t('common.next')}
                  <ChevronRight size={18} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
