/**
 * Task Execution Detail Panel
 * Slide-in panel with card-style execution timeline + formatted result view
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  X,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader,
  Clock,
  Zap,
  Calendar,
  Timer,
  FileText,
} from 'lucide-react';
import {
  listCronJobExecutions,
  type CronJobExecution,
} from '../api/cronjobs';

interface TaskExecutionDetailProps {
  open: boolean;
  onClose: () => void;
  jobId: string;
  jobName: string;
}

function isLikelyMarkdown(text: string): boolean {
  return /^#{1,6}\s|^\*\*|^[-*]\s|^\d+\.\s|```|^\|.*\|/m.test(text);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = Math.floor(secs % 60);
  if (mins < 60) return `${mins}m ${remainSecs}s`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatTimeShort(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const statusConfig = {
  running: {
    color: 'var(--color-warning)',
    label: 'Running',
    Icon: Loader,
    spin: true,
  },
  success: {
    color: 'var(--color-success)',
    label: 'Success',
    Icon: CheckCircle,
    spin: false,
  },
  failed: {
    color: 'var(--color-error)',
    label: 'Failed',
    Icon: XCircle,
    spin: false,
  },
  partial: {
    color: 'var(--color-warning)',
    label: 'Partial',
    Icon: AlertTriangle,
    spin: false,
  },
} as const;

/** Grab first meaningful line from result as a preview */
function resultPreview(result: string | null, maxLen = 60): string {
  if (!result) return '';
  const line = result.split('\n').find(l => l.trim().length > 0)?.trim() || '';
  return line.length > maxLen ? line.slice(0, maxLen) + '...' : line;
}

export function TaskExecutionDetail({ open, onClose, jobId, jobName }: TaskExecutionDetailProps) {
  const { t } = useTranslation();
  const [executions, setExecutions] = useState<CronJobExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CronJobExecution | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !jobId) return;
    setLoading(true);
    setSelected(null);
    listCronJobExecutions(jobId, 50)
      .then((data) => {
        setExecutions(data);
        if (data.length > 0) setSelected(data[0]);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [open, jobId]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const sc = selected ? statusConfig[selected.status] : null;
  const duration = selected?.finished_at
    ? selected.finished_at - selected.started_at
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="relative flex w-full max-w-[900px] h-full animate-slide-in-right"
        style={{
          background: 'var(--color-bg-elevated)',
          borderLeft: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-xl)',
        }}
      >
        {/* ═══ Timeline sidebar ═══ */}
        <div
          className="w-[280px] flex-shrink-0 flex flex-col border-r overflow-hidden"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)' }}
        >
          {/* Sidebar header */}
          <div className="px-4 pt-6 pb-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
            <h3 className="text-[14px] font-bold" style={{ color: 'var(--color-text)' }}>
              {t('cronjobs.executionHistory')}
            </h3>
            <span className="text-[12px] mt-1 block" style={{ color: 'var(--color-text-muted)' }}>
              {executions.length} {executions.length === 1 ? 'record' : 'records'}
            </span>
          </div>

          {/* Execution cards */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader size={18} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
              </div>
            ) : executions.length === 0 ? (
              <div className="text-center py-16">
                <FileText size={28} className="mx-auto mb-3 opacity-20" style={{ color: 'var(--color-text-muted)' }} />
                <p className="text-[13px]" style={{ color: 'var(--color-text-muted)' }}>
                  {t('cronjobs.noExecutions')}
                </p>
              </div>
            ) : (
              <>
                {executions.map((exec, idx) => {
                  const cfg = statusConfig[exec.status];
                  const isSelected = selected?.id === exec.id;
                  const dur = exec.finished_at ? exec.finished_at - exec.started_at : null;
                  const isToday = new Date(exec.started_at).toDateString() === new Date().toDateString();
                  const prevExec = idx > 0 ? executions[idx - 1] : null;
                  const showDateSep = !prevExec ||
                    new Date(prevExec.started_at).toDateString() !== new Date(exec.started_at).toDateString();
                  const preview = resultPreview(exec.result);

                  return (
                    <div key={exec.id}>
                      {/* Date separator */}
                      {showDateSep && (
                        <div className="px-2 pt-2 pb-1">
                          <span
                            className="text-[11px] font-semibold uppercase tracking-wider"
                            style={{ color: 'var(--color-text-muted)' }}
                          >
                            {isToday
                              ? 'Today'
                              : new Date(exec.started_at).toLocaleDateString(undefined, {
                                  weekday: 'short',
                                  month: 'short',
                                  day: 'numeric',
                                })}
                          </span>
                        </div>
                      )}

                      {/* Execution card */}
                      <button
                        onClick={() => setSelected(exec)}
                        className="w-full text-left rounded-xl p-3 transition-all relative overflow-hidden"
                        style={{
                          background: isSelected ? 'var(--color-bg-elevated)' : 'transparent',
                          boxShadow: isSelected ? 'var(--shadow-sm)' : 'none',
                          borderLeft: `3px solid ${isSelected ? cfg.color : 'transparent'}`,
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) {
                            e.currentTarget.style.background = 'var(--color-bg-muted)';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected) {
                            e.currentTarget.style.background = 'transparent';
                          }
                        }}
                      >
                        {/* Top row: status icon + time + duration */}
                        <div className="flex items-center gap-2">
                          <cfg.Icon
                            size={16}
                            className={cfg.spin ? 'animate-spin' : ''}
                            style={{ color: cfg.color, flexShrink: 0 }}
                          />
                          <span
                            className="text-[13px] font-semibold tabular-nums flex-1"
                            style={{ color: isSelected ? 'var(--color-text)' : 'var(--color-text-secondary)' }}
                          >
                            {formatTimeShort(exec.started_at)}
                          </span>
                          {dur !== null && (
                            <span
                              className="text-[11px] tabular-nums px-1.5 py-0.5 rounded-md"
                              style={{
                                color: 'var(--color-text-muted)',
                                background: isSelected ? 'var(--color-bg-muted)' : 'transparent',
                              }}
                            >
                              {formatDuration(dur)}
                            </span>
                          )}
                        </div>

                        {/* Middle row: status label + trigger badge */}
                        <div className="flex items-center gap-2 mt-1.5 pl-6">
                          <span
                            className="text-[11px] font-semibold"
                            style={{ color: cfg.color }}
                          >
                            {cfg.label}
                          </span>
                          <span
                            className="text-[10px] px-1.5 py-px rounded-full font-medium"
                            style={{
                              background: `color-mix(in srgb, ${exec.trigger_type === 'manual' ? 'var(--color-warning)' : 'var(--color-info)'} 10%, transparent)`,
                              color: exec.trigger_type === 'manual' ? 'var(--color-warning)' : 'var(--color-info)',
                            }}
                          >
                            {exec.trigger_type === 'manual' ? (
                              <span className="inline-flex items-center gap-0.5"><Zap size={8} /> {t('cronjobs.triggerManual')}</span>
                            ) : (
                              t('cronjobs.triggerScheduled')
                            )}
                          </span>
                        </div>

                        {/* Preview snippet */}
                        {preview && (
                          <p
                            className="text-[11px] mt-2 pl-6 truncate leading-snug"
                            style={{ color: 'var(--color-text-muted)' }}
                          >
                            {preview}
                          </p>
                        )}
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* ═══ Main detail area ═══ */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Header */}
          <div
            className="flex items-center justify-between px-6 pt-6 pb-4 border-b flex-shrink-0"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <div className="flex-1 min-w-0">
              <h2 className="text-[17px] font-bold tracking-tight truncate" style={{ color: 'var(--color-text)' }}>
                {jobName}
              </h2>
              {selected && sc && (
                <div className="flex items-center gap-3 mt-2.5">
                  {/* Status badge */}
                  <span
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-bold"
                    style={{
                      background: `color-mix(in srgb, ${sc.color} 14%, transparent)`,
                      color: sc.color,
                    }}
                  >
                    <sc.Icon size={13} className={sc.spin ? 'animate-spin' : ''} />
                    {sc.label}
                  </span>

                  {/* Trigger badge */}
                  <span
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium"
                    style={{
                      background: 'var(--color-bg-muted)',
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    {selected.trigger_type === 'manual' ? (
                      <><Zap size={10} /> {t('cronjobs.triggerManual')}</>
                    ) : (
                      <><Calendar size={10} /> {t('cronjobs.triggerScheduled')}</>
                    )}
                  </span>
                </div>
              )}
            </div>

            <button
              onClick={onClose}
              className="p-2 rounded-xl transition-colors flex-shrink-0 ml-4"
              style={{ color: 'var(--color-text-secondary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <X size={18} />
            </button>
          </div>

          {/* Metadata bar */}
          {selected && (
            <div
              className="flex items-center gap-8 px-6 py-3.5 border-b flex-shrink-0"
              style={{
                borderColor: 'var(--color-border)',
                background: 'var(--color-bg)',
              }}
            >
              <div className="flex items-center gap-2.5">
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center"
                  style={{ background: 'var(--color-primary-subtle)' }}
                >
                  <Calendar size={13} style={{ color: 'var(--color-primary)' }} />
                </div>
                <div>
                  <span className="text-[10px] block font-medium uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                    {t('cronjobs.startTime') || 'Start'}
                  </span>
                  <span className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--color-text)' }}>
                    {formatTime(selected.started_at)}
                  </span>
                </div>
              </div>

              {selected.finished_at && (
                <>
                  <div className="flex items-center gap-2.5">
                    <div
                      className="w-7 h-7 rounded-lg flex items-center justify-center"
                      style={{ background: `color-mix(in srgb, var(--color-success) 10%, transparent)` }}
                    >
                      <CheckCircle size={13} style={{ color: 'var(--color-success)' }} />
                    </div>
                    <div>
                      <span className="text-[10px] block font-medium uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                        {t('cronjobs.endTime') || 'End'}
                      </span>
                      <span className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--color-text)' }}>
                        {formatTime(selected.finished_at)}
                      </span>
                    </div>
                  </div>

                  {duration !== null && (
                    <div className="flex items-center gap-2.5">
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center"
                        style={{ background: `color-mix(in srgb, var(--color-warning) 10%, transparent)` }}
                      >
                        <Timer size={13} style={{ color: 'var(--color-warning)' }} />
                      </div>
                      <div>
                        <span className="text-[10px] block font-medium uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                          {t('cronjobs.duration') || 'Duration'}
                        </span>
                        <span className="text-[14px] font-bold tabular-nums" style={{ color: 'var(--color-text)' }}>
                          {formatDuration(duration)}
                        </span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Result body */}
          <div className="flex-1 overflow-y-auto">
            {!selected ? (
              <div className="flex flex-col items-center justify-center h-full opacity-40">
                <FileText size={40} style={{ color: 'var(--color-text-muted)' }} />
                <p className="text-[13px] mt-3" style={{ color: 'var(--color-text-muted)' }}>
                  {executions.length === 0
                    ? t('cronjobs.noExecutions')
                    : 'Select an execution to view details'}
                </p>
              </div>
            ) : selected.status === 'running' && !selected.result ? (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <div className="relative">
                  <div
                    className="w-14 h-14 rounded-full border-[3px] border-t-transparent animate-spin"
                    style={{ borderColor: 'var(--color-warning)', borderTopColor: 'transparent' }}
                  />
                  <div
                    className="absolute inset-0 w-14 h-14 rounded-full animate-ping opacity-20"
                    style={{ background: 'var(--color-warning)' }}
                  />
                </div>
                <p className="text-[14px] font-semibold" style={{ color: 'var(--color-warning)' }}>
                  Running...
                </p>
              </div>
            ) : selected.result ? (
              <div className="p-6">
                <div
                  className="rounded-xl p-5 overflow-hidden"
                  style={{
                    background: 'var(--color-bg)',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  {isLikelyMarkdown(selected.result) ? (
                    <div className="markdown-body prose-sm max-w-none text-[13px] leading-relaxed">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {selected.result}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div
                      className="text-[13px] leading-[1.75] break-words"
                      style={{
                        color: 'var(--color-text-secondary)',
                        fontFamily: 'var(--font-text)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {selected.result}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full opacity-40">
                <FileText size={32} style={{ color: 'var(--color-text-muted)' }} />
                <p className="text-[13px] mt-3" style={{ color: 'var(--color-text-muted)' }}>
                  No result data
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
