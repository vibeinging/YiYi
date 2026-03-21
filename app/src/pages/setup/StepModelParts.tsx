/**
 * Setup Wizard - Model step sub-components (ModelGuide + ModelConfig)
 */

import {
  Check,
  Key,
  Loader2,
  ExternalLink,
  Sparkles,
  ChevronRight,
} from 'lucide-react';
import { ZHIPU_SITES, type TestConnectionResponse } from '../../api/models';
import type { Lang, QuickProvider } from './setupWizardData';

export function ModelGuide({ lang }: { lang: Lang }) {
  return (
    <div className="h-full flex flex-col justify-center px-8" style={{ minHeight: 'calc(100vh - 300px)' }}>
      {/* Coding plan tip */}
      <div
        className="rounded-2xl px-7 py-6 mb-10 flex items-start gap-4"
        style={{ background: 'rgba(255,106,0,0.05)', border: '1px solid rgba(255,106,0,0.10)' }}
      >
        <Sparkles size={22} className="shrink-0 mt-1" style={{ color: '#FF6A00' }} />
        <div>
          <div className="text-[18px] font-bold mb-1.5" style={{ color: 'var(--color-text)' }}>
            {lang === 'zh' ? '不知道选哪个？' : 'Not sure which to pick?'}
          </div>
          <p className="text-[16px] leading-[1.7]" style={{ color: 'var(--color-text-secondary)' }}>
            {lang === 'zh'
              ? '试试左侧「特惠套餐」—— 一个 Key 就能用多个模型，不用逐个注册，适合刚上手。'
              : 'Try "Special Plans" on the left — one Key for multiple models, no need to register each. Great for getting started.'}
          </p>
        </div>
      </div>

      {/* Model guide */}
      <div className="text-[15px] font-bold uppercase tracking-wider mb-6 px-1" style={{ color: 'var(--color-text-tertiary)' }}>
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
            <span className="text-[18px] font-semibold shrink-0 w-[100px]" style={{ color: 'var(--color-text)' }}>{m.name[lang]}</span>
            <span className="text-[16px]" style={{ color: 'var(--color-text-tertiary)' }}>{m.hint[lang]}</span>
          </div>
        ))}
      </div>

      <style>{`
        @keyframes point-left {
          0%, 100% { transform: translateX(0); opacity: 0.6; }
          50% { transform: translateX(-8px); opacity: 1; }
        }
      `}</style>
      <p className="text-[18px] text-center font-medium flex items-center justify-center gap-3" style={{ color: 'var(--color-text-muted)' }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ animation: 'point-left 2.5s cubic-bezier(0.4, 0, 0.2, 1) infinite', flexShrink: 0 }}>
          <path d="M14 6L8 12L14 18" stroke="#10B981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="9" y1="12" x2="20" y2="12" stroke="#10B981" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <span>{lang === 'zh' ? '从左侧选择一个提供商开始' : 'Pick a provider from the left'}</span>
      </p>
    </div>
  );
}

export interface ModelConfigProps {
  lang: Lang;
  provider: QuickProvider;
  selectedModel: string | null;
  customModelId: string;
  useCustomModel: boolean;
  apiKey: string;
  baseUrl: string;
  showBaseUrl: boolean;
  testing: boolean;
  testResult: TestConnectionResponse | null;
  onSelectModel: (id: string | null) => void;
  onCustomModelIdChange: (id: string) => void;
  onUseCustomModelChange: (use: boolean) => void;
  onApiKeyChange: (key: string) => void;
  onBaseUrlChange: (url: string) => void;
  onShowBaseUrlChange: (show: boolean) => void;
  onTestConnection: () => void;
  onTestResultClear: () => void;
}

export function ModelConfig({
  lang,
  provider,
  selectedModel,
  customModelId,
  useCustomModel,
  apiKey,
  baseUrl,
  showBaseUrl,
  testing,
  testResult,
  onSelectModel,
  onCustomModelIdChange,
  onUseCustomModelChange,
  onApiKeyChange,
  onBaseUrlChange,
  onShowBaseUrlChange,
  onTestConnection,
  onTestResultClear,
}: ModelConfigProps) {
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
          onChange={(e) => { onApiKeyChange(e.target.value); onTestResultClear(); }}
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
              onClick={() => onShowBaseUrlChange(!showBaseUrl)}
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
                      onClick={() => onBaseUrlChange(url)}
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
              onChange={(e) => { onBaseUrlChange(e.target.value); onTestResultClear(); }}
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
              onUseCustomModelChange(!useCustomModel);
              if (!useCustomModel) onSelectModel(null);
              else {
                onCustomModelIdChange('');
                onSelectModel(provider.models[0].id);
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
                onClick={() => { onSelectModel(m.id); onTestResultClear(); }}
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
              onChange={(e) => { onCustomModelIdChange(e.target.value); onTestResultClear(); }}
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
          onClick={onTestConnection}
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
}
