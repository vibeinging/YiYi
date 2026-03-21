/**
 * Setup Wizard - Model/Provider selection step
 */

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { TestConnectionResponse } from '../../api/models';
import { QUICK_PROVIDERS, type Lang, type QuickProvider } from './setupWizardData';
import { ModelGuide, ModelConfig } from './StepModelParts';

export interface StepModelProps {
  lang: Lang;
  selectedProvider: string | null;
  selectedModel: string | null;
  customModelId: string;
  useCustomModel: boolean;
  apiKey: string;
  baseUrl: string;
  showBaseUrl: boolean;
  testing: boolean;
  testResult: TestConnectionResponse | null;
  onSelectProvider: (id: string | null) => void;
  onSelectModel: (id: string | null) => void;
  onCustomModelIdChange: (id: string) => void;
  onUseCustomModelChange: (use: boolean) => void;
  onApiKeyChange: (key: string) => void;
  onBaseUrlChange: (url: string) => void;
  onShowBaseUrlChange: (show: boolean) => void;
  onTestConnection: () => void;
  onTestResultClear: () => void;
}

export function StepModel({
  lang,
  selectedProvider,
  selectedModel,
  customModelId,
  useCustomModel,
  apiKey,
  baseUrl,
  showBaseUrl,
  testing,
  testResult,
  onSelectProvider,
  onSelectModel,
  onCustomModelIdChange,
  onUseCustomModelChange,
  onApiKeyChange,
  onBaseUrlChange,
  onShowBaseUrlChange,
  onTestConnection,
  onTestResultClear,
}: StepModelProps) {
  const [providerListAtBottom, setProviderListAtBottom] = useState(false);

  // Track provider list scroll to hide "scroll for more" indicator at bottom
  useEffect(() => {
    const check = () => {
      const el = document.getElementById('provider-list');
      if (!el) return;
      setProviderListAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 10);
    };
    // Wait for DOM to render
    const timer = setTimeout(() => {
      check();
      const el = document.getElementById('provider-list');
      el?.addEventListener('scroll', check);
    }, 100);
    return () => {
      clearTimeout(timer);
      const el = document.getElementById('provider-list');
      el?.removeEventListener('scroll', check);
    };
  }, []);

  const handleProviderClick = (p: QuickProvider) => {
    if (selectedProvider === p.id) {
      onSelectProvider(null);
      onSelectModel(null);
      onApiKeyChange('');
      onTestResultClear();
    } else {
      onSelectProvider(p.id);
      onSelectModel(p.models[0].id);
      onCustomModelIdChange('');
      onUseCustomModelChange(false);
      onApiKeyChange('');
      onBaseUrlChange(p.baseUrl);
      onShowBaseUrlChange(false);
      onTestResultClear();
    }
  };

  const handleNonSpecialProviderClick = (p: QuickProvider) => {
    onSelectProvider(p.id);
    onSelectModel(p.models[0].id);
    onCustomModelIdChange('');
    onUseCustomModelChange(false);
    onApiKeyChange('');
    onBaseUrlChange(p.baseUrl);
    onShowBaseUrlChange(false);
    onTestResultClear();
  };

  const renderProviderButton = (p: QuickProvider, isSpecial: boolean) => (
    <button
      key={p.id}
      onClick={() => isSpecial ? handleProviderClick(p) : handleNonSpecialProviderClick(p)}
      className={`w-full p-3.5 rounded-xl border-2 text-left transition-all ${isSpecial ? 'relative' : ''}`}
      style={{
        background: selectedProvider === p.id ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
        borderColor: selectedProvider === p.id ? 'var(--color-primary)' : 'var(--color-border)',
        boxShadow: selectedProvider === p.id ? '0 2px 12px rgba(var(--color-primary-rgb), 0.25)' : 'none',
      }}
    >
      <div className={`flex items-center ${isSpecial ? 'gap-3' : 'gap-2'}`}>
        <div className={`${isSpecial ? 'w-3.5 h-3.5' : 'w-3 h-3'} rounded-full shrink-0`} style={{ background: p.color }} />
        <div className="flex-1 min-w-0">
          <span className={`font-semibold ${isSpecial ? 'text-[13px]' : 'text-[12px]'} block truncate`} style={{ color: selectedProvider === p.id ? '#fff' : 'var(--color-text)' }}>{p.name}</span>
          <span className="text-[10px] block truncate" style={{ color: selectedProvider === p.id ? (isSpecial ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.6)') : 'var(--color-text-tertiary)' }}>{p.desc[lang]}</span>
        </div>
        {selectedProvider === p.id && <Check size={isSpecial ? 14 : 12} className="shrink-0 text-white/80" />}
      </div>
    </button>
  );

  return (
    <div>
      <div className="text-center mb-8">
        <h1 className="text-4xl font-extrabold mb-3 tracking-tight" style={{ color: 'var(--color-text)' }}>
          {lang === 'zh' ? '选择你的 AI 引擎' : 'Choose Your AI Engine'}
        </h1>
        <p className="text-[15px] leading-relaxed max-w-[500px] mx-auto" style={{ color: 'var(--color-text-secondary)' }}>
          {lang === 'zh'
            ? 'YiYi 本身是一个助手框架，它需要连接一个 AI 模型才能工作 —— 就像给它装上一颗会思考的大脑。选一个你喜欢的，填上 Key 就行'
            : 'YiYi is an assistant framework — it needs an AI model to work, like giving it a brain that can think. Just pick one you like and enter the API Key'}
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
                {QUICK_PROVIDERS.filter(p => p.group === 'special').map((p) => renderProviderButton(p, true))}
              </div>
            </>
          )}
          {/* Group: CN */}
          <div className="text-[11px] font-bold uppercase tracking-wider mb-3 px-1" style={{ color: 'var(--color-text-tertiary)' }}>
            {lang === 'zh' ? '国内' : 'China'}
          </div>
          <div className="space-y-2 mb-5">
            {QUICK_PROVIDERS.filter(p => p.group === 'cn').map((p) => renderProviderButton(p, false))}
          </div>
          {/* Group: Intl */}
          <div className="text-[11px] font-bold uppercase tracking-wider mb-3 px-1" style={{ color: 'var(--color-text-tertiary)' }}>
            {lang === 'zh' ? '国际' : 'International'}
          </div>
          <div className="space-y-2 pb-10">
            {QUICK_PROVIDERS.filter(p => p.group === 'intl').map((p) => renderProviderButton(p, false))}
          </div>
          </div>
          {/* Scroll indicator — auto-hide when scrolled to bottom */}
          {!providerListAtBottom && (
            <>
              <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none" style={{ background: 'linear-gradient(to top, var(--color-bg), transparent)' }} />
              <div className="absolute bottom-1 left-0 right-0 text-center pointer-events-none">
                <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' }}>
                  {lang === 'zh' ? '↓ 滑动查看更多' : '↓ Scroll for more'}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Right: Configuration */}
        <div className="flex-1 min-w-0">
          {!selectedProvider ? (
            <ModelGuide lang={lang} />
          ) : (() => {
            const provider = QUICK_PROVIDERS.find(p => p.id === selectedProvider)!;
            return (
              <ModelConfig
                lang={lang}
                provider={provider}
                selectedModel={selectedModel}
                customModelId={customModelId}
                useCustomModel={useCustomModel}
                apiKey={apiKey}
                baseUrl={baseUrl}
                showBaseUrl={showBaseUrl}
                testing={testing}
                testResult={testResult}
                onSelectModel={onSelectModel}
                onCustomModelIdChange={onCustomModelIdChange}
                onUseCustomModelChange={onUseCustomModelChange}
                onApiKeyChange={onApiKeyChange}
                onBaseUrlChange={onBaseUrlChange}
                onShowBaseUrlChange={onShowBaseUrlChange}
                onTestConnection={onTestConnection}
                onTestResultClear={onTestResultClear}
              />
            );
          })()}
        </div>
      </div>
    </div>
  );
}
