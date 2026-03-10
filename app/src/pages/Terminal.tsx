/**
 * Terminal Integration Page
 * Apple-inspired · Glassmorphism · Refined
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Terminal as TerminalIcon,
  Play,
  Square,
  Trash2,
  Copy,
  Plus,
  X,
  Check,
} from 'lucide-react';
import { execute_shell } from '../api/shell';

interface TerminalSession {
  id: string;
  name: string;
  command: string;
  history: { type: 'cmd' | 'out' | 'err'; text: string }[];
  running: boolean;
  exitCode?: number;
}

export function TerminalPage() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<TerminalSession[]>([
    { id: 'default', name: `${t('terminal.title')} 1`, command: '', history: [], running: false },
  ]);
  const [activeSessionId, setActiveSessionId] = useState('default');
  const [command, setCommand] = useState('');
  const [executing, setExecuting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.history]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [activeSessionId]);

  const handleExecute = async () => {
    if (!command.trim() || executing) return;

    const cmd = command;
    setCommand('');
    setExecuting(true);
    setCmdHistory((prev) => [cmd, ...prev]);
    setHistoryIdx(-1);

    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSessionId
          ? { ...s, command: cmd, running: true, history: [...s.history, { type: 'cmd', text: cmd }] }
          : s,
      ),
    );

    try {
      const result = await execute_shell(cmd);
      const stdout = result.stdout?.trim();
      const stderr = result.stderr?.trim();
      const lines: { type: 'out' | 'err'; text: string }[] = [];
      if (stdout) lines.push({ type: 'out', text: stdout });
      if (stderr) lines.push({ type: 'err', text: stderr });
      if (!stdout && !stderr) lines.push({ type: 'out', text: 'Command executed' });

      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSessionId
            ? { ...s, history: [...s.history, ...lines], running: false, exitCode: result.code }
            : s,
        ),
      );
    } catch (error) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSessionId
            ? { ...s, history: [...s.history, { type: 'err', text: String(error) }], running: false, exitCode: -1 }
            : s,
        ),
      );
    } finally {
      setExecuting(false);
    }
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (cmdHistory.length > 0) {
          const next = Math.min(historyIdx + 1, cmdHistory.length - 1);
          setHistoryIdx(next);
          setCommand(cmdHistory[next]);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIdx > 0) {
          const next = historyIdx - 1;
          setHistoryIdx(next);
          setCommand(cmdHistory[next]);
        } else {
          setHistoryIdx(-1);
          setCommand('');
        }
      }
    },
    [cmdHistory, historyIdx],
  );

  const handleNewTerminal = () => {
    const newSession: TerminalSession = {
      id: `term-${Date.now()}`,
      name: `${t('terminal.title')} ${sessions.length + 1}`,
      command: '',
      history: [],
      running: false,
    };
    setSessions([...sessions, newSession]);
    setActiveSessionId(newSession.id);
  };

  const handleCloseTerminal = (id: string) => {
    if (sessions.length === 1) {
      setSessions((prev) => prev.map((s) => ({ ...s, history: [], command: '', running: false })));
      return;
    }
    const updated = sessions.filter((s) => s.id !== id);
    setSessions(updated);
    if (activeSessionId === id) {
      setActiveSessionId(updated[0].id);
    }
  };

  const handleClear = () => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? { ...s, history: [] } : s)),
    );
  };

  const handleCopy = () => {
    const text = activeSession.history.map((h) => (h.type === 'cmd' ? `$ ${h.text}` : h.text)).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden animate-fade-in">
      {/* Toolbar */}
      <div className="h-14 border-b border-[var(--color-border)] flex items-center justify-between px-5 glass">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[var(--color-primary-subtle)] flex items-center justify-center">
            <TerminalIcon className="text-[var(--color-primary)]" size={16} />
          </div>
          <div>
            <h1 className="font-semibold text-[14px] tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
              {t('terminal.title')}
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="p-2 hover:bg-[var(--color-bg-subtle)] rounded-lg transition-all text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            title={t('terminal.copy')}
          >
            {copied ? <Check size={16} className="text-[var(--color-success)]" /> : <Copy size={16} />}
          </button>
          <button
            onClick={handleClear}
            className="p-2 hover:bg-[var(--color-bg-subtle)] rounded-lg transition-all text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            title={t('terminal.clear')}
          >
            <Trash2 size={16} />
          </button>
          <div className="w-px h-5 bg-[var(--color-border)] mx-1" />
          <button
            onClick={handleNewTerminal}
            className="flex items-center gap-1.5 px-3 py-1.5 btn-primary rounded-lg text-[13px]"
          >
            <Plus size={14} />
            {t('terminal.newTerminal')}
          </button>
        </div>
      </div>

      {/* Tabs */}
      {sessions.length > 1 && (
        <div className="flex items-center px-2 pt-1 pb-0 bg-[var(--color-bg)] gap-1 overflow-x-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`
                group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-t-lg cursor-pointer transition-all text-[13px]
                ${activeSessionId === session.id
                  ? 'bg-[var(--color-bg-elevated)] text-[var(--color-text)] shadow-sm'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-subtle)]'
                }
              `}
              onClick={() => setActiveSessionId(session.id)}
            >
              <TerminalIcon size={12} className={activeSessionId === session.id ? 'text-[var(--color-primary)]' : ''} />
              <span className="font-medium whitespace-nowrap">{session.name}</span>
              {session.running && <span className="w-1.5 h-1.5 bg-[var(--color-success)] rounded-full animate-pulse" />}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTerminal(session.id);
                }}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--color-bg-subtle)] text-[var(--color-text-tertiary)] hover:text-[var(--color-error)] transition-all ml-0.5"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Terminal body */}
      <div className="flex-1 flex flex-col overflow-hidden bg-[var(--color-bg-elevated)] mx-3 mb-3 mt-2 rounded-xl border border-[var(--color-border)] shadow-sm">
        {/* Output area */}
        <div
          className="flex-1 overflow-y-auto p-4 font-mono text-[13px] leading-6"
          onClick={() => inputRef.current?.focus()}
        >
          {activeSession.history.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-tertiary)] select-none">
              <div className="w-16 h-16 rounded-2xl bg-[var(--color-bg-subtle)] flex items-center justify-center mb-4">
                <TerminalIcon size={28} className="opacity-40" />
              </div>
              <p className="text-[13px]">{t('terminal.empty')}</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {activeSession.history.map((entry, idx) => (
                <div key={idx} className="whitespace-pre-wrap break-words">
                  {entry.type === 'cmd' ? (
                    <div className="flex items-start gap-2 pt-2 first:pt-0">
                      <span className="text-[var(--color-primary)] font-semibold select-none shrink-0">$</span>
                      <span className="text-[var(--color-text)] font-medium">{entry.text}</span>
                    </div>
                  ) : entry.type === 'err' ? (
                    <span className="text-[var(--color-error)] opacity-90 pl-5">{entry.text}</span>
                  ) : (
                    <span className="text-[var(--color-text-secondary)] pl-5">{entry.text}</span>
                  )}
                </div>
              ))}
              {activeSession.running && (
                <div className="flex items-center gap-2 pl-5 pt-1">
                  <div className="w-1.5 h-1.5 bg-[var(--color-primary)] rounded-full animate-pulse" />
                  <span className="text-[var(--color-text-tertiary)] text-[12px]">{t('terminal.running')}</span>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="border-t border-[var(--color-border)]">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleExecute();
            }}
            className="flex items-center gap-2 px-4 py-3"
          >
            <span className="text-[var(--color-primary)] font-mono font-semibold text-[13px] select-none">$</span>
            <input
              ref={inputRef}
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('terminal.placeholder')}
              disabled={executing || activeSession.running}
              className="flex-1 bg-transparent border-none text-[var(--color-text)] focus:outline-none focus:ring-0 focus:shadow-none font-mono text-[13px] p-0 placeholder:text-[var(--color-text-tertiary)]"
              autoFocus
            />
            <button
              type="submit"
              disabled={executing || activeSession.running || !command.trim()}
              className={`
                p-2 rounded-lg transition-all disabled:opacity-30
                ${command.trim()
                  ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white'
                  : 'text-[var(--color-text-tertiary)]'
                }
              `}
              title={t('terminal.execute')}
            >
              {executing || activeSession.running ? (
                <Square size={14} className="text-[var(--color-error)]" />
              ) : (
                <Play size={14} />
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
