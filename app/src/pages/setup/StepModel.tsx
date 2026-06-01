/**
 * Setup Wizard - Model step.
 * V4-only build: provider/model are locked to DeepSeek V4. User only enters API Key.
 */

import { Sparkles } from 'lucide-react';
import type { TestConnectionResponse } from '../../api/models';
import { QUICK_PROVIDERS, type Lang } from './setupWizardData';
import { ModelConfig } from './StepModelParts';
import { GlobalThinkingControl } from '../../components/ThinkingModeControl';

export interface StepModelProps {
  lang: Lang;
  apiKey: string;
  baseUrl: string;
  showBaseUrl: boolean;
  testing: boolean;
  testResult: TestConnectionResponse | null;
  onApiKeyChange: (key: string) => void;
  onBaseUrlChange: (url: string) => void;
  onShowBaseUrlChange: (show: boolean) => void;
  onTestConnection: () => void;
  onTestResultClear: () => void;
}

export function StepModel({
  lang,
  apiKey,
  baseUrl,
  showBaseUrl,
  testing,
  testResult,
  onApiKeyChange,
  onBaseUrlChange,
  onShowBaseUrlChange,
  onTestConnection,
  onTestResultClear,
}: StepModelProps) {
  const provider = QUICK_PROVIDERS[0];

  return (
    <div className="max-w-[640px] mx-auto">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-extrabold mb-3 tracking-tight" style={{ color: 'var(--color-text)' }}>
          {lang === 'zh' ? '连接 DeepSeek V4' : 'Connect DeepSeek V4'}
        </h1>
        <p className="text-[15px] leading-relaxed max-w-[520px] mx-auto" style={{ color: 'var(--color-text-secondary)' }}>
          {lang === 'zh'
            ? 'YiYi 使用 DeepSeek V4 Pro 处理复杂推理，V4 Flash 处理高频子任务。系统会自动路由，无需手动切换。'
            : 'YiYi uses DeepSeek V4 Pro for heavy reasoning and V4 Flash for fast sub-tasks. Routing is automatic — no manual switch.'}
        </p>
      </div>

      <div
        className="rounded-2xl px-6 py-4 mb-6 flex items-start gap-3"
        style={{ background: 'rgba(91,110,245,0.05)', border: '1px solid rgba(91,110,245,0.15)' }}
      >
        <Sparkles size={18} className="shrink-0 mt-0.5" style={{ color: '#5B6EF5' }} />
        <div className="text-[13px] leading-[1.7]" style={{ color: 'var(--color-text-secondary)' }}>
          {lang === 'zh' ? (
            <>
              在 <a href="#" onClick={(e) => { e.preventDefault(); import('@tauri-apps/plugin-shell').then(m => m.open(provider.signupUrl)); }} className="font-medium" style={{ color: '#5B6EF5' }}>DeepSeek 平台</a> 申请一个 API Key，下面粘贴即可。免费额度足够日常体验。
            </>
          ) : (
            <>
              Get an API key from <a href="#" onClick={(e) => { e.preventDefault(); import('@tauri-apps/plugin-shell').then(m => m.open(provider.signupUrl)); }} className="font-medium" style={{ color: '#5B6EF5' }}>DeepSeek</a> and paste it below. The free tier is enough to get started.
            </>
          )}
        </div>
      </div>

      <ModelConfig
        lang={lang}
        provider={provider}
        apiKey={apiKey}
        baseUrl={baseUrl}
        showBaseUrl={showBaseUrl}
        testing={testing}
        testResult={testResult}
        onApiKeyChange={onApiKeyChange}
        onBaseUrlChange={onBaseUrlChange}
        onShowBaseUrlChange={onShowBaseUrlChange}
        onTestConnection={onTestConnection}
        onTestResultClear={onTestResultClear}
      />

      {/* 深度思考(全局默认)—— 之后每个对话窗口可在顶栏单独覆盖。 */}
      <div className="mt-4">
        <GlobalThinkingControl lang={lang} />
      </div>
    </div>
  );
}
