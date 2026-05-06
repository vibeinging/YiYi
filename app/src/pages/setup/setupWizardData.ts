/**
 * Setup Wizard - Shared constants, types, and helper functions.
 * V4-only build: only DeepSeek (deepseek-v4-pro / deepseek-v4-flash) is supported.
 */

export const BUILTIN_PROVIDER_IDS = ['deepseek'];

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

// V4-only build: a single locked-in provider entry.
export const QUICK_PROVIDERS: QuickProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek V4',
    desc: { zh: 'DeepSeek V4 Pro + Flash 双模型自动路由', en: 'DeepSeek V4 Pro + Flash with auto routing' },
    color: '#5B6EF5',
    baseUrl: 'https://api.deepseek.com/v1',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tag: { zh: '主控', en: 'Orchestrator' } },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', tag: { zh: '工人', en: 'Worker' } },
    ],
    group: 'cn',
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

  if (role === 'custom') {
    if (customDesc.trim()) parts.push(customDesc.trim());
  } else {
    parts.push(roleMap[role]?.[lang] || roleMap.assistant[lang]);
  }

  if (owner) {
    parts.push(
      lang === 'zh'
        ? `你的主人叫「${owner}」，请记住这个名字并在合适的时候使用。`
        : `Your owner's name is "${owner}". Remember this name and use it when appropriate.`
    );
  }

  if (toneMap[tone]) {
    parts.push(toneMap[tone][lang]);
  }

  return parts.join('\n\n');
}
