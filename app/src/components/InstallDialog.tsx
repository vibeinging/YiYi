/**
 * InstallDialog — lazy-install consent + progress UI.
 *
 * Listens for backend `mcp://needs_install` events. When one fires, shows
 * a modal explaining what's missing, lets the user pick an install option,
 * runs `install_deps`, streams `mcp://install_progress` lines into a log
 * pane, then on success calls `retry_mcp_server` so the agent can use it
 * immediately.
 */

import { useEffect, useMemo, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { Loader2, Package, ExternalLink, X, Check, AlertTriangle } from 'lucide-react';

interface InstallStep {
  kind: string;             // "brew" | "winget" | "apt" | "url" | "manual"
  label: string;
  command?: string | null;
  url?: string | null;
}

interface DepSpec {
  bin: string;
  display_name: string;
  why?: string;
  install: InstallStep[];
}

interface NeedsInstallEvent {
  server_id: string;
  server_name: string;
  missing: DepSpec[];
}

interface ProgressLine {
  stream: 'stdout' | 'stderr';
  line: string;
}

type Phase = 'pick' | 'running' | 'done' | 'failed';

interface ActiveDialog {
  serverId: string;
  serverName: string;
  missing: DepSpec[];
  /** Index of dep currently being installed when phase=running. */
  depIdx: number;
  /** For each dep, the picked InstallStep. */
  picked: (InstallStep | null)[];
  phase: Phase;
  progress: ProgressLine[];
  error?: string;
}

export function InstallDialog() {
  const [active, setActive] = useState<ActiveDialog | null>(null);

  // Subscribe to needs_install events. New events while a dialog is
  // already open are ignored — the user finishes the current one first.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<NeedsInstallEvent>('mcp://needs_install', (event) => {
      setActive((prev) => {
        if (prev) return prev; // don't clobber an in-progress dialog
        return {
          serverId: event.payload.server_id,
          serverName: event.payload.server_name,
          missing: event.payload.missing,
          depIdx: 0,
          picked: event.payload.missing.map(() => null),
          phase: 'pick',
          progress: [],
        };
      });
    }).then((u) => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // Subscribe to progress lines. Filter to the active server.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<{ server_id: string; stream: 'stdout' | 'stderr'; line: string }>(
      'mcp://install_progress',
      (event) => {
        setActive((prev) => {
          if (!prev || prev.serverId !== event.payload.server_id) return prev;
          const progress = [...prev.progress, { stream: event.payload.stream, line: event.payload.line }];
          // Cap log to last 200 lines so the modal can't grow unboundedly.
          if (progress.length > 200) progress.splice(0, progress.length - 200);
          return { ...prev, progress };
        });
      },
    ).then((u) => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  if (!active) return null;

  const close = () => setActive(null);

  const currentDep: DepSpec | undefined = active.missing[active.depIdx];

  const pick = (step: InstallStep) => {
    setActive((prev) => {
      if (!prev) return prev;
      const picked = [...prev.picked];
      picked[prev.depIdx] = step;
      return { ...prev, picked };
    });
  };

  const runCurrent = async () => {
    if (!active) return;
    const step = active.picked[active.depIdx];
    if (!step) return;

    // url-only steps don't run a command — open the page and mark "done"
    // for the user to install manually, then bail.
    if (step.kind === 'url' && step.url) {
      await openExternal(step.url);
      setActive((prev) => prev && { ...prev, phase: 'done' });
      return;
    }

    setActive((prev) => prev && { ...prev, phase: 'running', progress: [] });
    try {
      await invoke('install_deps', { serverId: active.serverId, step });
      // Move to next dep, or mark all done.
      setActive((prev) => {
        if (!prev) return prev;
        const next = prev.depIdx + 1;
        if (next >= prev.missing.length) {
          return { ...prev, phase: 'done' };
        }
        return { ...prev, depIdx: next, phase: 'pick', progress: [] };
      });
    } catch (e: any) {
      setActive((prev) => prev && { ...prev, phase: 'failed', error: String(e) });
    }
  };

  const retryAndClose = async () => {
    if (!active) return;
    try {
      await invoke('retry_mcp_server', { serverId: active.serverId });
    } catch (e) {
      // Even on error we close — frontend log shows it; user can manually retry from Settings.
      console.warn('retry_mcp_server failed:', e);
    }
    close();
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
    >
      <div
        className="rounded-2xl shadow-xl flex flex-col"
        style={{
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border-strong)',
          width: 'min(640px, 90vw)',
          maxHeight: '80vh',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 py-4"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <Package size={18} style={{ color: 'var(--color-primary)' }} />
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>
              {active.serverName} 需要安装依赖
            </div>
            <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
              第 {active.depIdx + 1} / {active.missing.length} 项
            </div>
          </div>
          <button onClick={close} aria-label="close" className="p-1 rounded hover:opacity-80">
            <X size={16} style={{ color: 'var(--color-text-muted)' }} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {currentDep && active.phase === 'pick' && (
            <PickPanel dep={currentDep} picked={active.picked[active.depIdx]} onPick={pick} />
          )}
          {active.phase === 'running' && (
            <RunningPanel progress={active.progress} dep={currentDep} step={active.picked[active.depIdx]} />
          )}
          {active.phase === 'done' && (
            <DonePanel server={active.serverName} />
          )}
          {active.phase === 'failed' && (
            <FailedPanel error={active.error ?? 'unknown'} progress={active.progress} />
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-3 px-5 py-3"
          style={{ borderTop: '1px solid var(--color-border)' }}
        >
          {active.phase === 'pick' && (
            <>
              <button
                onClick={close}
                className="px-4 py-2 rounded-lg text-[13px]"
                style={{
                  background: 'var(--color-bg-subtle)',
                  color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border)',
                }}
              >
                跳过
              </button>
              <button
                onClick={runCurrent}
                disabled={!active.picked[active.depIdx]}
                className="px-4 py-2 rounded-lg text-[13px] font-medium disabled:opacity-40"
                style={{ background: 'var(--color-primary)', color: '#fff' }}
              >
                安装
              </button>
            </>
          )}
          {active.phase === 'running' && (
            <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
              安装中，请勿关闭…
            </span>
          )}
          {active.phase === 'done' && (
            <button
              onClick={retryAndClose}
              className="px-4 py-2 rounded-lg text-[13px] font-medium"
              style={{ background: 'var(--color-primary)', color: '#fff' }}
            >
              完成 · 启动 {active.serverName}
            </button>
          )}
          {active.phase === 'failed' && (
            <>
              <button
                onClick={close}
                className="px-4 py-2 rounded-lg text-[13px]"
                style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
              >
                关闭
              </button>
              <button
                onClick={() => setActive((prev) => prev && { ...prev, phase: 'pick', error: undefined })}
                className="px-4 py-2 rounded-lg text-[13px] font-medium"
                style={{ background: 'var(--color-primary)', color: '#fff' }}
              >
                重试
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PickPanel({ dep, picked, onPick }: {
  dep: DepSpec;
  picked: InstallStep | null;
  onPick: (step: InstallStep) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-[13px] font-medium mb-0.5" style={{ color: 'var(--color-text)' }}>
          📦 {dep.display_name} <span className="font-mono text-[11px] opacity-60">({dep.bin})</span>
        </div>
        {dep.why && (
          <div className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
            {dep.why}
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          安装方式
        </div>
        {dep.install.length === 0 && (
          <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
            没有提供自动安装步骤，请手动安装后点"重试"。
          </div>
        )}
        {dep.install.map((step, i) => {
          const active = picked === step;
          return (
            <button
              key={i}
              onClick={() => onPick(step)}
              className="w-full text-left px-3 py-2.5 rounded-xl border-2 transition-all"
              style={{
                background: active ? 'var(--color-primary-subtle)' : 'transparent',
                borderColor: active ? 'var(--color-primary)' : 'var(--color-border)',
              }}
            >
              <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--color-text)' }}>
                <span>{step.label}</span>
                {step.kind === 'url' && <ExternalLink size={12} className="opacity-60" />}
                {active && <Check size={13} className="ml-auto" style={{ color: 'var(--color-primary)' }} />}
              </div>
              {step.command && (
                <code className="block mt-1 text-[11px] font-mono opacity-70" style={{ color: 'var(--color-text-secondary)' }}>
                  $ {step.command}
                </code>
              )}
              {step.url && (
                <span className="block mt-1 text-[11px] opacity-70" style={{ color: 'var(--color-text-secondary)' }}>
                  {step.url}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RunningPanel({ progress, dep, step }: { progress: ProgressLine[]; dep?: DepSpec; step: InstallStep | null }) {
  const tail = useMemo(() => progress.slice(-80), [progress]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--color-text)' }}>
        <Loader2 size={14} className="animate-spin" />
        正在安装 <span className="font-medium">{dep?.display_name ?? ''}</span>…
      </div>
      {step?.command && (
        <code className="block text-[11px] font-mono opacity-70" style={{ color: 'var(--color-text-secondary)' }}>
          $ {step.command}
        </code>
      )}
      <div
        className="rounded-lg p-3 text-[11px] font-mono leading-relaxed overflow-y-auto"
        style={{
          background: 'var(--color-bg-subtle)',
          color: 'var(--color-text-secondary)',
          maxHeight: '260px',
          minHeight: '160px',
        }}
      >
        {tail.length === 0 ? (
          <span style={{ color: 'var(--color-text-muted)' }}>等待输出…</span>
        ) : (
          tail.map((p, i) => (
            <div key={i} style={{ color: p.stream === 'stderr' ? 'var(--color-warning)' : undefined }}>
              {p.line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function DonePanel({ server }: { server: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-6 gap-2">
      <Check size={28} style={{ color: 'var(--color-success)' }} />
      <div className="text-[14px] font-medium" style={{ color: 'var(--color-text)' }}>
        全部依赖安装完成
      </div>
      <div className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
        点下方按钮启动 {server}
      </div>
    </div>
  );
}

function FailedPanel({ error, progress }: { error: string; progress: ProgressLine[] }) {
  const tail = progress.slice(-30);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--color-error)' }}>
        <AlertTriangle size={14} />
        安装失败
      </div>
      <div className="text-[12px] whitespace-pre-wrap" style={{ color: 'var(--color-text-secondary)' }}>
        {error}
      </div>
      {tail.length > 0 && (
        <div
          className="rounded-lg p-3 text-[11px] font-mono leading-relaxed overflow-y-auto"
          style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)', maxHeight: '160px' }}
        >
          {tail.map((p, i) => (
            <div key={i} style={{ color: p.stream === 'stderr' ? 'var(--color-warning)' : undefined }}>{p.line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
