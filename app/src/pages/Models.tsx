/**
 * Models Page — V4-only build.
 * Shows DeepSeek V4 connection status and the two bound models (Pro orchestrator, Flash worker).
 * Pro/Flash routing is handled automatically by the engine — no manual picker.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  Key,
  ExternalLink,
  ChevronRight,
  Check,
  AlertTriangle,
  Cpu,
  Zap,
  Sparkles,
  Wallet,
  RefreshCw,
  Clipboard,
} from 'lucide-react';
import {
  listProviders,
  configureProvider,
  testProvider,
  getActiveLlm,
  setActiveLlm,
  type ProviderDisplay,
  type TestConnectionResponse,
} from '../api/models';
import {
  getDeepSeekBalance,
  openDeepSeekWindow,
  tryReadClipboardKey,
  type DeepSeekBalance,
} from '../api/deepseek';
import { PageHeader } from '../components/PageHeader';
import { toast } from '../components/Toast';

const PROVIDER_ID = 'deepseek';
const PROVIDER_COLOR = '#5B6EF5';
const SIGNUP_URL = 'https://platform.deepseek.com/api_keys';
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

const MODEL_ROLES: Record<string, { role: string; roleEn: string; desc: string; descEn: string; icon: typeof Cpu }> = {
  'deepseek-v4-pro': {
    role: '深度',
    roleEn: 'Deep',
    desc: '处理复杂任务、长篇分析、深度思考',
    descEn: 'Handles complex tasks, long-form analysis, deep thinking',
    icon: Cpu,
  },
  'deepseek-v4-flash': {
    role: '轻量',
    roleEn: 'Fast',
    desc: '后台轻活、快速回复、批量处理',
    descEn: 'Background work, quick replies, batch processing',
    icon: Zap,
  },
};

export function ModelsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const lang: 'zh' | 'en' = i18n.language?.startsWith('zh') ? 'zh' : 'en';

  const [provider, setProvider] = useState<ProviderDisplay | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [showBaseUrl, setShowBaseUrl] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);

  // Balance card state. Refreshes every 60s when the page is visible.
  const [balance, setBalance] = useState<DeepSeekBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const refreshBalance = async () => {
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const b = await getDeepSeekBalance();
      setBalance(b);
    } catch (e: any) {
      setBalanceError(e?.toString() ?? 'failed');
      setBalance(null);
    } finally {
      setBalanceLoading(false);
    }
  };

  // Auto-refresh balance every 60s while configured. Don't fetch when no key
  // is set (provider.has_api_key is the gate).
  useEffect(() => {
    if (!provider?.has_api_key) return;
    refreshBalance();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refreshBalance();
    }, 60_000);
    return () => clearInterval(id);
  }, [provider?.has_api_key]);

  const load = async () => {
    try {
      const [providers, active] = await Promise.all([listProviders(), getActiveLlm()]);
      const p = providers.find(x => x.id === PROVIDER_ID) ?? null;
      setProvider(p);
      if (p?.current_base_url) setBaseUrl(p.current_base_url);

      // Ensure active_llm is set: default to pro if none.
      if (!active.provider_id || !active.model || active.provider_id !== PROVIDER_ID) {
        await setActiveLlm(PROVIDER_ID, 'deepseek-v4-pro').catch(() => {});
      }
    } catch (e) {
      console.error('Failed to load DeepSeek provider:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      await configureProvider(PROVIDER_ID, apiKey.trim(), baseUrl || undefined);
      setApiKey('');
      await load();
      toast.success(lang === 'zh' ? 'API Key 已保存' : 'API Key saved');
    } catch (e: any) {
      toast.error(e?.toString() || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProvider(
        PROVIDER_ID,
        apiKey.trim() || undefined,
        baseUrl || undefined,
        'deepseek-v4-pro',
      );
      setTestResult(result);
      if (!result.success) toast.error(result.message);
    } catch (e: any) {
      const msg = e?.toString() || 'Test failed';
      setTestResult({ success: false, message: msg });
      toast.error(msg);
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={28} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
      </div>
    );
  }

  const configured = provider?.has_api_key === true;

  const content = (
    <>
      {!embedded && (
        <PageHeader
          title={lang === 'zh' ? '账户' : 'Account'}
          description={lang === 'zh'
            ? '余额、用量、API 接入。YiYi 自己决定何时用深度版、何时用轻量版，你只管说话。'
            : 'Balance, usage, and API connection. YiYi decides when to use the deep or fast model — just talk to it.'}
        />
      )}

      <div className="max-w-[760px] mx-auto space-y-5">
        {/* Status banner */}
        <div
          className="rounded-2xl px-5 py-4 flex items-center gap-3"
          style={{
            background: configured ? 'rgba(16,185,129,0.06)' : 'rgba(245,158,11,0.06)',
            border: `1px solid ${configured ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)'}`,
          }}
        >
          {configured
            ? <Check size={18} style={{ color: 'rgb(16,185,129)' }} />
            : <AlertTriangle size={18} style={{ color: 'rgb(245,158,11)' }} />}
          <div className="text-[13px]" style={{ color: 'var(--color-text)' }}>
            {configured
              ? (lang === 'zh' ? '已配置 API Key，可正常使用。' : 'API Key configured. Ready to go.')
              : (lang === 'zh' ? '尚未配置 API Key。请在下方填入。' : 'No API Key configured. Please enter one below.')}
          </div>
        </div>

        {/* Balance card — shown only when an API key is configured */}
        {configured && (() => {
          const cny = balance?.balance_infos.find(b => b.currency === 'CNY');
          const usd = balance?.balance_infos.find(b => b.currency === 'USD');
          const cnyValue = cny ? parseFloat(cny.total_balance) : NaN;
          const lowBalance = !Number.isNaN(cnyValue) && cnyValue < 5;
          return (
            <div
              className="p-5 rounded-2xl border flex items-center gap-4"
              style={{
                background: lowBalance ? 'rgba(245,158,11,0.06)' : 'var(--color-bg-elevated)',
                borderColor: lowBalance ? 'rgba(245,158,11,0.3)' : 'var(--color-border)',
              }}
            >
              <div
                className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  background: lowBalance ? 'rgba(245,158,11,0.15)' : PROVIDER_COLOR + '15',
                  color: lowBalance ? 'rgb(245,158,11)' : PROVIDER_COLOR,
                }}
              >
                <Wallet size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[13px] font-semibold" style={{ color: 'var(--color-text)' }}>
                    {lang === 'zh' ? 'DeepSeek 余额' : 'DeepSeek Balance'}
                  </span>
                  {balanceLoading && <Loader2 size={11} className="animate-spin opacity-60" />}
                  {lowBalance && (
                    <span
                      className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                      style={{ background: 'rgba(245,158,11,0.15)', color: 'rgb(245,158,11)' }}
                    >
                      {lang === 'zh' ? '余额偏低' : 'Low'}
                    </span>
                  )}
                </div>
                {balanceError ? (
                  <div className="text-[12px]" style={{ color: 'var(--color-error)' }}>
                    {balanceError}
                  </div>
                ) : balance ? (
                  <div className="flex items-baseline gap-3">
                    {cny && (
                      <span className="text-[18px] font-bold tabular-nums" style={{ color: 'var(--color-text)' }}>
                        ¥{cny.total_balance}
                      </span>
                    )}
                    {usd && (
                      <span className="text-[13px] tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
                        ${usd.total_balance}
                      </span>
                    )}
                    {cny && parseFloat(cny.granted_balance) > 0 && (
                      <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                        {lang === 'zh' ? '含赠送 ¥' : 'incl. granted ¥'}{cny.granted_balance}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
                    {lang === 'zh' ? '查询中…' : 'loading…'}
                  </div>
                )}
              </div>
              <button
                onClick={refreshBalance}
                disabled={balanceLoading}
                title={lang === 'zh' ? '刷新' : 'Refresh'}
                className="shrink-0 p-2 rounded-lg disabled:opacity-40"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <RefreshCw size={14} className={balanceLoading ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={() => openDeepSeekWindow('top_up')}
                className="shrink-0 px-4 py-2 rounded-lg text-[13px] font-semibold transition-all"
                style={{
                  background: lowBalance ? 'rgb(245,158,11)' : PROVIDER_COLOR,
                  color: '#fff',
                }}
              >
                {lang === 'zh' ? '立即充值' : 'Top up'}
              </button>
            </div>
          );
        })()}

        {/* API Key card */}
        <div
          className="p-6 rounded-2xl border"
          style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Key size={15} style={{ color: PROVIDER_COLOR }} />
              <span className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>
                API Key
              </span>
              {provider?.api_key_saved && (
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full" style={{
                  background: 'var(--color-bg-subtle)',
                  color: 'var(--color-text-tertiary)',
                }}>
                  {showApiKey ? provider.api_key_saved : '••••' + (provider.api_key_saved.slice(-4) || '')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {provider?.api_key_saved && (
                <button
                  onClick={() => setShowApiKey(v => !v)}
                  className="text-[11px] font-medium px-2 py-0.5 rounded"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {showApiKey ? (lang === 'zh' ? '隐藏' : 'Hide') : (lang === 'zh' ? '查看' : 'Show')}
                </button>
              )}
              <button
                onClick={() => openDeepSeekWindow('keys')}
                className="text-[12px] flex items-center gap-1 font-medium hover:underline"
                style={{ color: PROVIDER_COLOR }}
              >
                {lang === 'zh' ? '在 YiYi 内获取 Key' : 'Get Key in YiYi'} <ExternalLink size={12} />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={e => { setApiKey(e.target.value); setTestResult(null); }}
              placeholder={configured
                ? (lang === 'zh' ? '输入新 Key 以替换' : 'Enter new key to replace')
                : (lang === 'zh' ? '粘贴你的 DeepSeek API Key...' : 'Paste your DeepSeek API Key...')}
              className="flex-1 px-4 py-2.5 rounded-xl text-[13px] outline-none"
              style={{
                background: 'var(--color-bg-subtle)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border)',
              }}
            />
            <button
              onClick={async () => {
                const k = await tryReadClipboardKey();
                if (k) {
                  setApiKey(k);
                  setTestResult(null);
                  toast.success(lang === 'zh' ? '已从剪贴板读取 Key' : 'Key read from clipboard');
                } else {
                  toast.error(lang === 'zh' ? '剪贴板里没有有效的 sk- 开头 Key' : 'No valid sk- key in clipboard');
                }
              }}
              title={lang === 'zh' ? '从剪贴板读取（仅识别 sk- 开头的 DeepSeek Key）' : 'Read from clipboard (DeepSeek `sk-` keys only)'}
              className="shrink-0 px-3 py-2.5 rounded-lg text-[12px] font-medium flex items-center gap-1.5 transition-colors"
              style={{
                background: 'var(--color-bg-subtle)',
                color: 'var(--color-text-secondary)',
                border: '1px solid var(--color-border)',
              }}
            >
              <Clipboard size={13} />
              {lang === 'zh' ? '从剪贴板' : 'From clipboard'}
            </button>
          </div>

          {/* Base URL — collapsed by default */}
          <div className="mt-3">
            <button
              onClick={() => setShowBaseUrl(v => !v)}
              className="text-[11px] font-medium flex items-center gap-1"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <ChevronRight size={11} className={`transition-transform ${showBaseUrl ? 'rotate-90' : ''}`} />
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
                onChange={e => { setBaseUrl(e.target.value); setTestResult(null); }}
                placeholder={DEFAULT_BASE_URL}
                className="w-full mt-2 px-3.5 py-2 rounded-lg text-[12px] outline-none"
                style={{
                  background: 'var(--color-bg-subtle)',
                  color: 'var(--color-text)',
                  border: '1px solid var(--color-border)',
                }}
              />
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 mt-5">
            <button
              onClick={handleSave}
              disabled={!apiKey.trim() || saving}
              className="px-5 py-2 rounded-lg text-[13px] font-medium transition-all disabled:opacity-40"
              style={{ background: PROVIDER_COLOR, color: '#fff' }}
            >
              {saving
                ? (lang === 'zh' ? '保存中...' : 'Saving...')
                : (lang === 'zh' ? '保存' : 'Save')}
            </button>
            <button
              onClick={handleTest}
              disabled={(!apiKey.trim() && !configured) || testing}
              className="px-5 py-2 rounded-lg text-[13px] font-medium transition-all disabled:opacity-40 flex items-center gap-2"
              style={{
                background: 'var(--color-bg-subtle)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border)',
              }}
            >
              {testing && <Loader2 size={13} className="animate-spin" />}
              {testing
                ? (lang === 'zh' ? '测试中...' : 'Testing...')
                : (lang === 'zh' ? '测试连接' : 'Test Connection')}
            </button>
            {testResult && !testing && (
              <span
                className="text-[12px] font-medium"
                style={{ color: testResult.success ? 'var(--color-success)' : 'var(--color-error)' }}
              >
                {testResult.success ? `OK · ${testResult.message}` : testResult.message}
              </span>
            )}
          </div>
          {testResult?.reply && !testing && (
            <div
              className="mt-3 p-3 rounded-lg text-[12px] leading-relaxed whitespace-pre-wrap"
              style={{
                background: testResult.success ? PROVIDER_COLOR + '08' : 'rgba(239,68,68,0.08)',
                border: `1px solid ${testResult.success ? PROVIDER_COLOR + '20' : 'rgba(239,68,68,0.2)'}`,
                color: 'var(--color-text)',
                maxHeight: '100px',
                overflowY: 'auto',
              }}
            >
              {testResult.reply}
            </div>
          )}
        </div>

        {/* Bound models card */}
        <div
          className="p-6 rounded-2xl border"
          style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}
        >
          <div className="flex items-center gap-2 mb-4">
            <Sparkles size={15} style={{ color: PROVIDER_COLOR }} />
            <span className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>
              {lang === 'zh' ? '已绑定模型（自动路由）' : 'Bound Models (Auto-routed)'}
            </span>
          </div>

          <div className="space-y-2.5">
            {provider?.models.map(m => {
              const meta = MODEL_ROLES[m.id];
              const Icon = meta?.icon ?? Cpu;
              return (
                <div
                  key={m.id}
                  className="flex items-center gap-4 px-4 py-3 rounded-xl border"
                  style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-subtle)' }}
                >
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: PROVIDER_COLOR + '15', color: PROVIDER_COLOR }}
                  >
                    <Icon size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold" style={{ color: 'var(--color-text)' }}>
                        {m.name}
                      </span>
                      {meta && (
                        <span
                          className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                          style={{ background: PROVIDER_COLOR + '15', color: PROVIDER_COLOR }}
                        >
                          {lang === 'zh' ? meta.role : meta.roleEn}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-tertiary)' }}>
                      {meta ? (lang === 'zh' ? meta.desc : meta.descEn) : m.id}
                    </div>
                  </div>
                  <code className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{m.id}</code>
                </div>
              );
            })}
          </div>

          <p className="mt-4 text-[12px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>
            {lang === 'zh'
              ? 'YiYi 自动按任务繁重程度选用深度或轻量版本，你不需要手动切换。'
              : 'YiYi picks the deep or fast variant on its own based on the task — no manual switching required.'}
          </p>
        </div>
      </div>
    </>
  );

  if (embedded) return content;

  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full px-8 py-10">{content}</div>
    </div>
  );
}
