/**
 * Setup Wizard - Shared constants, types, and helper functions
 */

// Built-in provider IDs from backend (providers.rs builtin_providers)
export const BUILTIN_PROVIDER_IDS = [
  'openai', 'anthropic', 'google', 'deepseek', 'dashscope',
  'modelscope', 'coding-plan', 'moonshot', 'minimax', 'zhipu',
];

export interface ProviderModel {
  id: string;
  name: string;
  tag: { zh: string; en: string } | null;
}

export interface QuickProvider {
  id: string;
  name: string;
  desc: { zh: string; en: string };
  color: string;
  baseUrl: string;
  signupUrl: string;
  models: ProviderModel[];
  group: string;
}

// All providers - grouped by region
export const QUICK_PROVIDERS: QuickProvider[] = [
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
export const TONE_STYLES = [
  { id: 'witty', emoji: '😄', name: { zh: '诙谐幽默', en: 'Witty & Humorous' }, desc: { zh: '轻松有趣，偶尔开玩笑', en: 'Light-hearted, occasional jokes' } },
  { id: 'balanced', emoji: '😊', name: { zh: '亲切自然', en: 'Warm & Natural' }, desc: { zh: '友好但不过分正式', en: 'Friendly without being too formal' } },
  { id: 'serious', emoji: '🧐', name: { zh: '严谨专业', en: 'Serious & Professional' }, desc: { zh: '精确严肃，注重专业性', en: 'Precise, focused on expertise' } },
  { id: 'concise', emoji: '⚡', name: { zh: '简洁高效', en: 'Concise & Efficient' }, desc: { zh: '尽量少说废话，直击要点', en: 'Minimal words, straight to the point' } },
];

// Role presets
export const ROLE_PRESETS = [
  { id: 'assistant', emoji: '🤖', name: { zh: '通用助手', en: 'General Assistant' }, desc: { zh: '什么都能帮忙', en: 'Helps with everything' } },
  { id: 'developer', emoji: '💻', name: { zh: '开发助手', en: 'Dev Assistant' }, desc: { zh: '专注编程和技术', en: 'Coding & technical' } },
  { id: 'creative', emoji: '🎨', name: { zh: '创意助手', en: 'Creative Assistant' }, desc: { zh: '写作、创意、内容', en: 'Writing & content' } },
  { id: 'custom', emoji: '✨', name: { zh: '自定义', en: 'Custom' }, desc: { zh: '自由定义', en: 'Free-form' } },
];

// Step metadata with icons - icons imported separately by consumers
export const STEP_IDS = ['language', 'model', 'workspace', 'persona', 'memory', 'meditation'] as const;
export const STEP_LABELS: Record<Step, { zh: string; en: string }> = {
  language: { zh: '语言', en: 'Language' },
  model: { zh: '模型', en: 'Model' },
  workspace: { zh: '工作空间', en: 'Workspace' },
  persona: { zh: '人格', en: 'Persona' },
  memory: { zh: '记忆', en: 'Memory' },
  meditation: { zh: '冥想', en: 'Meditation' },
};

export type Step = 'language' | 'model' | 'workspace' | 'persona' | 'memory' | 'meditation';
export const STEPS: Step[] = ['language', 'model', 'workspace', 'persona', 'memory', 'meditation'];

export type Lang = 'zh' | 'en';

// Build SOUL.md content from persona config
export function buildSoulContent(
  aiName: string,
  ownerName: string,
  tone: string,
  role: string,
  customDesc: string,
  lang: Lang,
): string {
  const name = aiName.trim() || 'YiYi';
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
