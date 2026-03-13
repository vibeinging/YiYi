/**
 * ClaudeCodeDialog - Handles Claude Code discovery, installation, and enablement.
 *
 * Two modes:
 * 1. **Installed**: Prompt user to enable the claude_code skill (existing flow)
 * 2. **Not installed**: Offer to install via npm (new flow)
 *
 * Shows once per install cycle (flag stored in DB).
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Terminal,
  Sparkles,
  Check,
  AlertTriangle,
  Zap,
  Download,
  Loader2,
  ExternalLink,
  X,
} from 'lucide-react';
import {
  checkClaudeCodeStatus,
  installClaudeCode,
  getAppFlag,
  setAppFlag,
  type ClaudeCodeStatus,
} from '../api/system';
import { enableSkill, listSkills } from '../api/skills';

export function ClaudeCodeDialog() {
  const { i18n } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  const [installLog, setInstallLog] = useState<string | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isZh = i18n.language?.startsWith('zh');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const prompted = await getAppFlag('claude_code_prompted');
        if (prompted) return;

        const st = await checkClaudeCodeStatus();

        if (st.installed) {
          // Already installed — check if skill is already enabled
          const skills = await listSkills({ source: 'builtin' });
          const ccSkill = skills.find((s) => s.name === 'coding_assistant');
          if (ccSkill?.enabled) {
            await setAppFlag('claude_code_prompted', 'true');
            return;
          }
        }

        // Show dialog for both installed (enable skill) and not-installed (offer install)
        if (!cancelled) {
          setStatus(st);
          setVisible(true);
        }
      } catch {
        // Silently ignore
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  const handleEnable = async (useProvider?: string) => {
    setEnabling(true);
    setError(null);
    try {
      if (useProvider) {
        await setAppFlag('claude_code_provider', useProvider);
      }
      await enableSkill('coding_assistant');
      await setAppFlag('claude_code_prompted', 'true');
      setDone(true);
      const timeoutId = setTimeout(() => setVisible(false), 1500);
      hideTimeoutRef.current = timeoutId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Failed to enable claude_code skill:', msg);
      setError(isZh ? `启用失败: ${msg}` : `Enable failed: ${msg}`);
    }
    setEnabling(false);
  };

  const handleInstall = async () => {
    setInstalling(true);
    setError(null);
    setInstallLog(null);
    try {
      const result = await installClaudeCode();
      if (result.success) {
        setInstallLog(isZh ? '安装完成！' : 'Installation complete!');
        // Refresh status
        const newStatus = await checkClaudeCodeStatus();
        setStatus(newStatus);
        // If installed, auto-enable
        if (newStatus.installed) {
          await handleEnable(newStatus.available_provider?.id);
        }
      } else if (result.needs_node) {
        setError(
          isZh
            ? '未检测到 npm。请先安装 Node.js: https://nodejs.org/'
            : 'npm not found. Please install Node.js first: https://nodejs.org/',
        );
      } else {
        setError(result.message);
        if (result.output) {
          setInstallLog(result.output);
        }
      }
    } catch (e) {
      setError(String(e));
    }
    setInstalling(false);
  };

  const handleDismiss = async () => {
    await setAppFlag('claude_code_prompted', 'true').catch(() => {});
    setVisible(false);
  };

  if (!visible || !status) return null;

  const isInstalled = status.installed;
  const hasKey = status.has_api_key;
  const provider = status.available_provider;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] p-4 animate-fade-in">
      <div
        className="rounded-2xl w-full max-w-md shadow-2xl animate-scale-in overflow-hidden"
        style={{ background: 'var(--color-bg-elevated)' }}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex items-start gap-4">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'var(--color-primary)', opacity: 0.9 }}
          >
            <Terminal size={22} color="#FFFFFF" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between">
              <h2
                className="font-semibold text-[16px] mb-1"
                style={{ color: 'var(--color-text)' }}
              >
                {isInstalled
                  ? isZh
                    ? '检测到 Claude Code'
                    : 'Claude Code Detected'
                  : isZh
                    ? '推荐安装 Claude Code'
                    : 'Install Claude Code'}
              </h2>
              <button
                onClick={handleDismiss}
                className="p-1 rounded-lg transition-colors shrink-0 -mt-1 -mr-1"
                style={{ color: 'var(--color-text-muted)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-bg-muted)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <X size={16} />
              </button>
            </div>
            <p
              className="text-[13px] leading-relaxed"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {isInstalled
                ? isZh
                  ? '启用后，编码任务将自动委派给 Claude Code，获得更强大的代码理解和编辑能力。'
                  : 'Enable to delegate coding tasks to Claude Code for powerful code understanding and editing.'
                : isZh
                  ? 'Claude Code 是专业的 AI 编码工具。安装后，YiYiClaw 可以自动将编码任务委派给它，获得更强大的代码编写、搜索和重构能力。'
                  : 'Claude Code is a professional AI coding tool. Once installed, YiYiClaw can automatically delegate coding tasks to it for powerful code writing, search, and refactoring.'}
            </p>
          </div>
        </div>

        {/* Feature highlights */}
        <div
          className="mx-6 mb-4 px-4 py-3 rounded-xl space-y-1.5"
          style={{ background: 'var(--color-bg-subtle)' }}
        >
          {[
            isZh ? '自动搜索、编辑、重构代码' : 'Auto search, edit, and refactor code',
            isZh ? '运行测试和调试问题' : 'Run tests and debug issues',
            isZh ? 'Git 工作流自动化' : 'Git workflow automation',
            ...(isInstalled
              ? []
              : [isZh ? '支持多种编程语言和框架' : 'Support for many languages and frameworks']),
          ].map((text, i) => (
            <div
              key={i}
              className="flex items-center gap-2.5 text-[13px]"
              style={{ color: 'var(--color-text)' }}
            >
              <Sparkles size={14} style={{ color: 'var(--color-primary)' }} />
              <span>{text}</span>
            </div>
          ))}
        </div>

        {/* Provider suggestion (installed mode only) */}
        {isInstalled && !hasKey && provider && (
          <div
            className="mx-6 mb-4 px-4 py-3 rounded-xl flex items-start gap-2.5"
            style={{
              background: 'var(--color-bg-subtle)',
              border: '1px solid var(--color-primary)',
              borderColor: 'color-mix(in srgb, var(--color-primary) 30%, transparent)',
            }}
          >
            <Zap size={15} className="shrink-0 mt-0.5" style={{ color: 'var(--color-primary)' }} />
            <div className="text-[12px] leading-relaxed">
              <div className="font-medium" style={{ color: 'var(--color-text)' }}>
                {isZh ? `检测到你已配置 ${provider.name}` : `${provider.name} is configured`}
              </div>
              <div style={{ color: 'var(--color-text-muted)' }}>
                {isZh
                  ? 'Claude Code 可以直接使用该配置，无需额外设置 API Key。'
                  : 'Claude Code can use this configuration directly, no extra API key needed.'}
              </div>
            </div>
          </div>
        )}

        {/* Warning: installed but no API key and no provider */}
        {isInstalled && !hasKey && !provider && (
          <div
            className="mx-6 mb-4 px-4 py-3 rounded-xl flex items-start gap-2.5"
            style={{ background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)' }}
          >
            <AlertTriangle
              size={15}
              className="shrink-0 mt-0.5"
              style={{ color: 'var(--color-warning)' }}
            />
            <div className="text-[12px] leading-relaxed">
              <div className="font-medium" style={{ color: 'var(--color-text)' }}>
                {isZh ? '未检测到 API Key' : 'API Key Not Found'}
              </div>
              <div style={{ color: 'var(--color-text-muted)' }}>
                {isZh
                  ? '请设置 ANTHROPIC_API_KEY 环境变量，或先在 YiYiClaw 设置中配置 Anthropic 提供商。'
                  : 'Please set ANTHROPIC_API_KEY environment variable, or configure the Anthropic provider in YiYiClaw Settings first.'}
              </div>
            </div>
          </div>
        )}

        {/* Install info (not-installed mode) */}
        {!isInstalled && (
          <div
            className="mx-6 mb-4 px-4 py-3 rounded-xl flex items-start gap-2.5"
            style={{ background: 'var(--color-bg-subtle)' }}
          >
            <Download
              size={15}
              className="shrink-0 mt-0.5"
              style={{ color: 'var(--color-text-muted)' }}
            />
            <div className="text-[12px] leading-relaxed">
              <div className="font-medium" style={{ color: 'var(--color-text)' }}>
                {isZh ? '安装方式' : 'Installation'}
              </div>
              <div style={{ color: 'var(--color-text-muted)' }}>
                {isZh
                  ? '需要 Node.js 环境。点击下方按钮一键安装，或手动运行：'
                  : 'Requires Node.js. Click the button below to install, or run manually:'}
              </div>
              <code
                className="block mt-1.5 px-2 py-1 rounded text-[11px] font-mono"
                style={{ background: 'var(--color-bg)', color: 'var(--color-text-secondary)' }}
              >
                npm i -g @anthropic-ai/claude-code
              </code>
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div
            className="mx-6 mb-3 px-4 py-2.5 rounded-xl text-[12px] flex items-start gap-2"
            style={{
              background: 'color-mix(in srgb, var(--color-error) 10%, transparent)',
              color: 'var(--color-error)',
            }}
          >
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Install log */}
        {installLog && !error && (
          <div
            className="mx-6 mb-3 px-4 py-2 rounded-xl text-[12px]"
            style={{
              background: 'color-mix(in srgb, var(--color-success) 10%, transparent)',
              color: 'var(--color-success)',
            }}
          >
            {installLog}
          </div>
        )}

        {/* Actions */}
        <div className="px-6 pb-6 flex gap-3">
          {done ? (
            <div
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-medium"
              style={{ background: 'var(--color-success)', color: '#fff' }}
            >
              <Check size={16} />
              {isZh ? '已启用' : 'Enabled'}
            </div>
          ) : isInstalled ? (
            /* Installed: Enable button */
            <>
              <button
                onClick={handleDismiss}
                disabled={enabling}
                className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-all"
                style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-bg-muted)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--color-bg-subtle)';
                }}
              >
                {isZh ? '暂不启用' : 'Not Now'}
              </button>
              <button
                onClick={() => handleEnable(provider?.id)}
                disabled={enabling}
                className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-all disabled:opacity-50"
                style={{ background: 'var(--color-primary)', color: '#fff' }}
              >
                {enabling
                  ? isZh
                    ? '启用中...'
                    : 'Enabling...'
                  : provider && !hasKey
                    ? isZh
                      ? `使用 ${provider.name} 启用`
                      : `Enable with ${provider.name}`
                    : isZh
                      ? '启用 Claude Code'
                      : 'Enable Claude Code'}
              </button>
            </>
          ) : (
            /* Not installed: Install button */
            <>
              <button
                onClick={handleDismiss}
                disabled={installing}
                className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-all"
                style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-bg-muted)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--color-bg-subtle)';
                }}
              >
                {isZh ? '以后再说' : 'Later'}
              </button>
              <button
                onClick={handleInstall}
                disabled={installing}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-all disabled:opacity-50"
                style={{ background: 'var(--color-primary)', color: '#fff' }}
              >
                {installing ? (
                  <>
                    <Loader2 size={15} className="animate-spin" />
                    {isZh ? '安装中...' : 'Installing...'}
                  </>
                ) : (
                  <>
                    <Download size={15} />
                    {isZh ? '一键安装' : 'Install Now'}
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
