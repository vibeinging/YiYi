/**
 * ClaudeCodeDialog - Prompt user to enable Claude Code skill when CLI is detected.
 * Shows once per install (flag stored in DB).
 * Detects API key status and offers to reuse existing provider config.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal, Sparkles, Check, AlertTriangle, Zap } from 'lucide-react';
import { checkClaudeCodeStatus, getAppFlag, setAppFlag, type ClaudeCodeStatus } from '../api/system';
import { enableSkill, listSkills } from '../api/skills';

export function ClaudeCodeDialog() {
  const { i18n } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  const isZh = i18n.language?.startsWith('zh');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const prompted = await getAppFlag('claude_code_prompted');
        if (prompted) return;

        const st = await checkClaudeCodeStatus();
        if (!st.installed) return;

        const skills = await listSkills({ source: 'builtin' });
        const ccSkill = skills.find((s) => s.name === 'claude_code');
        if (ccSkill?.enabled) {
          await setAppFlag('claude_code_prompted', 'true');
          return;
        }

        if (!cancelled) {
          setStatus(st);
          setVisible(true);
        }
      } catch {
        // Silently ignore
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const handleEnable = async (useProvider?: string) => {
    setEnabling(true);
    setError(null);
    try {
      // If user chose to use a provider, save it
      if (useProvider) {
        await setAppFlag('claude_code_provider', useProvider);
      }
      await enableSkill('claude_code');
      await setAppFlag('claude_code_prompted', 'true');
      setDone(true);
      setTimeout(() => setVisible(false), 1500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Failed to enable claude_code skill:', msg);
      setError(isZh ? `启用失败: ${msg}` : `Enable failed: ${msg}`);
    }
    setEnabling(false);
  };

  const handleDismiss = async () => {
    await setAppFlag('claude_code_prompted', 'true').catch(() => {});
    setVisible(false);
  };

  if (!visible || !status) return null;

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
          <div className="min-w-0">
            <h2
              className="font-semibold text-[16px] mb-1"
              style={{ color: 'var(--color-text)' }}
            >
              {isZh ? '检测到 Claude Code' : 'Claude Code Detected'}
            </h2>
            <p
              className="text-[13px] leading-relaxed"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {isZh
                ? '检测到你的系统已安装 Claude Code CLI。启用后，复杂编码任务将自动委派给 Claude Code 执行，获得更强大的代码理解和编辑能力。'
                : 'Claude Code CLI is installed on your system. Enable it to delegate complex coding tasks to Claude Code for more powerful code understanding and editing.'}
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
          ].map((text, i) => (
            <div key={i} className="flex items-center gap-2.5 text-[13px]" style={{ color: 'var(--color-text)' }}>
              <Sparkles size={14} style={{ color: 'var(--color-primary)' }} />
              <span>{text}</span>
            </div>
          ))}
        </div>

        {/* Provider suggestion: no API key but has usable provider */}
        {!hasKey && provider && (
          <div
            className="mx-6 mb-4 px-4 py-3 rounded-xl flex items-start gap-2.5"
            style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-primary)', borderColor: 'color-mix(in srgb, var(--color-primary) 30%, transparent)' }}
          >
            <Zap size={15} className="shrink-0 mt-0.5" style={{ color: 'var(--color-primary)' }} />
            <div className="text-[12px] leading-relaxed">
              <div className="font-medium" style={{ color: 'var(--color-text)' }}>
                {isZh
                  ? `检测到你已配置 ${provider.name}`
                  : `${provider.name} is configured`}
              </div>
              <div style={{ color: 'var(--color-text-muted)' }}>
                {isZh
                  ? 'Claude Code 可以直接使用该配置，无需额外设置 API Key。'
                  : 'Claude Code can use this configuration directly, no extra API key needed.'}
              </div>
            </div>
          </div>
        )}

        {/* Warning: no API key and no provider */}
        {!hasKey && !provider && (
          <div
            className="mx-6 mb-4 px-4 py-3 rounded-xl flex items-start gap-2.5"
            style={{ background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)' }}
          >
            <AlertTriangle size={15} className="shrink-0 mt-0.5" style={{ color: 'var(--color-warning)' }} />
            <div className="text-[12px] leading-relaxed">
              <div className="font-medium" style={{ color: 'var(--color-text)' }}>
                {isZh ? '未检测到 API Key' : 'API Key Not Found'}
              </div>
              <div style={{ color: 'var(--color-text-muted)' }}>
                {isZh
                  ? '请在环境变量或 shell 配置中设置 ANTHROPIC_API_KEY，否则 Claude Code 将无法正常工作。'
                  : 'Please set ANTHROPIC_API_KEY in your environment or shell config, otherwise Claude Code won\'t work.'}
              </div>
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div
            className="mx-6 mb-3 px-4 py-2 rounded-xl text-[12px]"
            style={{ background: 'var(--color-error)', color: '#fff', opacity: 0.9 }}
          >
            {error}
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
          ) : (
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
                  ? (isZh ? '启用中...' : 'Enabling...')
                  : provider && !hasKey
                    ? (isZh ? `使用 ${provider.name} 启用` : `Enable with ${provider.name}`)
                    : (isZh ? '启用 Claude Code' : 'Enable Claude Code')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
