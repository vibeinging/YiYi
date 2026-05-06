/**
 * Setup Wizard - Model step sub-components.
 * V4-only build: ModelConfig only collects API Key (+ optional base URL override) and tests.
 */

import { Key, Loader2, ExternalLink, ChevronRight, Clipboard } from 'lucide-react';
import type { TestConnectionResponse } from '../../api/models';
import type { Lang, QuickProvider } from './setupWizardData';
import { openDeepSeekWindow, tryReadClipboardKey } from '../../api/deepseek';

export interface ModelConfigProps {
  lang: Lang;
  provider: QuickProvider;
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

export function ModelConfig({
  lang,
  provider,
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
}: ModelConfigProps) {
  return (
    <div className="space-y-6">
      {/* API Key + optional base URL override */}
      <div className="p-7 rounded-2xl border" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <Key size={16} className="text-[var(--color-primary)]" />
            <span className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>
              API Key
            </span>
          </div>
          <button
            onClick={() => openDeepSeekWindow('keys')}
            className="text-[13px] flex items-center gap-1.5 font-medium hover:underline"
            style={{ color: 'var(--color-primary)' }}
          >
            {lang === 'zh' ? '在 YiYi 内获取 Key' : 'Get Key in YiYi'} <ExternalLink size={13} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => { onApiKeyChange(e.target.value); onTestResultClear(); }}
            placeholder={lang === 'zh' ? '粘贴你的 DeepSeek API Key...' : 'Paste your DeepSeek API Key...'}
            className="flex-1 px-5 py-3.5 rounded-xl text-[14px] outline-none"
            style={{
              background: 'var(--color-bg-subtle)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
            }}
          />
          <button
            onClick={async () => {
              const key = await tryReadClipboardKey();
              if (key) {
                onApiKeyChange(key);
                onTestResultClear();
              } else {
                // Surface a hint on the input itself; quickest path is the test result placeholder.
                onTestResultClear();
              }
            }}
            title={lang === 'zh' ? '从剪贴板读取（仅识别 sk- 开头的 DeepSeek Key）' : 'Read from clipboard (DeepSeek `sk-` keys only)'}
            className="shrink-0 px-3 py-3 rounded-xl text-[12px] font-medium flex items-center gap-1.5 transition-colors"
            style={{
              background: 'var(--color-bg-subtle)',
              color: 'var(--color-text-secondary)',
              border: '1px solid var(--color-border)',
            }}
          >
            <Clipboard size={14} />
            {lang === 'zh' ? '从剪贴板' : 'From clipboard'}
          </button>
        </div>

        {/* Base URL (advanced, collapsed by default) */}
        <div className="mt-3">
          <button
            onClick={() => onShowBaseUrlChange(!showBaseUrl)}
            className="text-[11px] font-medium flex items-center gap-1"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <ChevronRight size={12} className={`transition-transform ${showBaseUrl ? 'rotate-90' : ''}`} />
            {lang === 'zh' ? '高级：自定义 Base URL' : 'Advanced: Custom Base URL'}
            {!showBaseUrl && (
              <span className="ml-1 text-[10px] font-normal" style={{ color: 'var(--color-text-tertiary)' }}>
                {baseUrl}
              </span>
            )}
          </button>
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

      {/* Model summary — fixed dual model display */}
      <div className="p-7 rounded-2xl border" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
        <div className="text-[15px] font-semibold mb-4" style={{ color: 'var(--color-text)' }}>
          {lang === 'zh' ? '已绑定模型' : 'Bound Models'}
        </div>
        <div className="space-y-2.5">
          {provider.models.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-3.5 px-4 py-3 rounded-xl border"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-subtle)' }}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium" style={{ color: 'var(--color-text)' }}>{m.name}</div>
                <div className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{m.id}</div>
              </div>
              {m.tag && (
                <span
                  className="shrink-0 text-[11px] font-semibold px-2.5 py-1 rounded-full"
                  style={{ background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}
                >
                  {m.tag[lang]}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Test connection */}
      <div className="flex items-center gap-4">
        <button
          onClick={onTestConnection}
          disabled={!apiKey.trim() || testing}
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
