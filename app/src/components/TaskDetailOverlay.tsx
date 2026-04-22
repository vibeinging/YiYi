/**
 * TaskDetailOverlay - Left slide-out panel for task details.
 * Overlays on top of Chat (which stays rendered underneath).
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AlertCircle, Pause, Timer, ListTodo, Send, X, Calendar,
} from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import { cancelTask, pauseTask, sendTaskMessage, type TaskStage } from '../api/tasks';
import { TASK_STATUS_CONFIG, formatDuration } from '../utils/taskStatus';

/** Format a duration safely — returns '—' for invalid/future/zero inputs. */
function safeDuration(startMs: number | null | undefined, endMs: number | null | undefined): string {
  if (!startMs || startMs <= 0) return '—';
  const finish = endMs && endMs > 0 ? endMs : Date.now();
  const diff = finish - startMs;
  if (diff < 0 || diff > 30 * 86_400_000) return '—'; // >30d likely garbage
  return formatDuration(diff);
}

function LiveDuration({ startMs, endMs }: { startMs: number; endMs?: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (endMs) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [endMs]);
  return (
    <span className="tabular-nums" style={{ color: 'var(--color-text)' }}>
      {safeDuration(startMs, endMs ?? null)}
    </span>
  );
}

function formatDate(ts: number | null | undefined): string | null {
  if (!ts || ts <= 0) return null;
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch { return null; }
}

function PlanTimeline({ plan }: { plan: TaskStage[] }) {
  return (
    <ol className="space-y-0">
      {plan.map((stage, idx) => {
        const cfg = TASK_STATUS_CONFIG[stage.status] || TASK_STATUS_CONFIG.pending;
        const StageIcon = cfg.Icon;
        const isLast = idx === plan.length - 1;
        const dim = stage.status === 'pending';
        return (
          <li key={idx} className="flex gap-3">
            <div className="flex flex-col items-center shrink-0" style={{ width: '22px' }}>
              <div
                className="w-[22px] h-[22px] rounded-full flex items-center justify-center transition-all"
                style={{
                  background: stage.status === 'completed'
                    ? cfg.color
                    : `color-mix(in srgb, ${cfg.color} 14%, transparent)`,
                  border: `2px solid ${cfg.color}`,
                  color: stage.status === 'completed' ? '#fff' : cfg.color,
                  opacity: dim ? 0.5 : 1,
                }}
              >
                <StageIcon size={11} className={cfg.spin ? 'animate-spin' : ''} />
              </div>
              {!isLast && (
                <div
                  className="w-[2px] flex-1 min-h-[28px]"
                  style={{
                    background: stage.status === 'completed'
                      ? `color-mix(in srgb, ${cfg.color} 60%, transparent)`
                      : 'var(--color-border)',
                    opacity: dim ? 0.5 : 0.8,
                  }}
                />
              )}
            </div>
            <div className="flex-1 min-w-0 pb-4">
              <div
                className="text-[13px] leading-snug"
                style={{
                  color: dim ? 'var(--color-text-muted)' : 'var(--color-text)',
                  fontWeight: stage.status === 'running' ? 600 : 500,
                }}
              >
                {stage.title}
              </div>
              {stage.status === 'running' && (
                <div className="text-[11px] mt-0.5" style={{ color: cfg.color }}>
                  执行中…
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function TaskDetailOverlay() {
  const selectedTaskId = useTaskStore((s) => s.selectedTaskId);
  const tasks = useTaskStore((s) => s.tasks);
  const selectTask = useTaskStore((s) => s.selectTask);
  const task = tasks.find((t) => t.id === selectedTaskId);
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (selectedTaskId && task) {
      setMounted(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      const timer = setTimeout(() => setMounted(false), 200);
      return () => clearTimeout(timer);
    }
  }, [selectedTaskId, task]);

  const plan = useMemo<TaskStage[]>(() => {
    if (!task?.plan) return [];
    try { return JSON.parse(task.plan); } catch { return []; }
  }, [task?.plan]);

  useEffect(() => {
    if (!mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') selectTask(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mounted, selectTask]);

  const handleSendMessage = useCallback(async () => {
    if (!inputValue.trim() || !task || sending) return;
    const isActive = task.status === 'running' || task.status === 'paused';
    if (!isActive) return;
    setSending(true);
    try {
      await sendTaskMessage(task.id, inputValue.trim());
      setInputValue('');
    } catch (err) {
      console.error('Failed to send task message:', err);
    } finally {
      setSending(false);
    }
  }, [inputValue, task, sending]);

  if (!mounted || !task) return null;

  const sc = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.pending;
  const StatusIcon = sc.Icon;
  const isActive = task.status === 'running' || task.status === 'paused';
  const isDone = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
  // Completed tasks always display 100% so the bar matches the status badge.
  const displayProgress = task.status === 'completed' ? 100 : Math.min(task.progress, 100);
  const startedAt = formatDate(task.createdAt);
  const finishedAt = isDone ? formatDate(task.completedAt ?? task.updatedAt) : null;
  const stageCount = plan.length || task.totalStages || 0;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 transition-opacity duration-200"
        style={{
          background: 'rgba(0, 0, 0, 0.28)',
          backdropFilter: 'blur(3px)',
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? 'auto' : 'none',
        }}
        onClick={() => selectTask(null)}
      />

      {/* Panel — centered modal */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-5 pointer-events-none"
      >
        <div
          className="flex flex-col pointer-events-auto rounded-2xl overflow-hidden"
          style={{
            width: 'min(560px, 100%)',
            maxHeight: 'min(720px, calc(100vh - 60px))',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            boxShadow: '0 24px 64px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04)',
            opacity: visible ? 1 : 0,
            transform: visible ? 'scale(1) translateY(0)' : 'scale(0.96) translateY(8px)',
            transition: 'opacity 200ms ease, transform 240ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
        {/* ── Header ── */}
        <div className="relative shrink-0 px-5 pt-4 pb-5" style={{ borderBottom: '1px solid var(--color-border)' }}>
          <button
            onClick={() => selectTask(null)}
            className="absolute top-3 right-3 w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; e.currentTarget.style.color = 'var(--color-text)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-muted)'; }}
            title="关闭 (Esc)"
          >
            <X size={15} />
          </button>

          {/* Status chip */}
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold mb-3"
            style={{
              background: `color-mix(in srgb, ${sc.color} 14%, transparent)`,
              color: sc.color,
            }}
          >
            <StatusIcon size={11} className={sc.spin ? 'animate-spin' : ''} />
            {sc.label}
          </span>

          <h2 className="text-[17px] font-bold leading-snug pr-8" style={{ color: 'var(--color-text)' }}>
            {task.title}
          </h2>
          {task.description && (
            <p className="text-[12.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
              {task.description}
            </p>
          )}

          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-3 text-[11.5px]" style={{ color: 'var(--color-text-muted)' }}>
            <span className="inline-flex items-center gap-1">
              <Timer size={11} />
              <LiveDuration startMs={task.createdAt} endMs={task.completedAt} />
            </span>
            {startedAt && (
              <span className="inline-flex items-center gap-1" title="创建时间">
                <Calendar size={11} />
                <span>{startedAt}</span>
              </span>
            )}
            {finishedAt && startedAt !== finishedAt && (
              <span className="inline-flex items-center gap-1" title="完成时间">
                <span style={{ opacity: 0.5 }}>→</span>
                <span>{finishedAt}</span>
              </span>
            )}
          </div>

          {/* Action buttons */}
          {isActive && (
            <div className="flex items-center gap-2 mt-3">
              {task.status === 'running' && (
                <button
                  onClick={() => pauseTask(task.id)}
                  className="px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors inline-flex items-center gap-1.5"
                  style={{
                    background: 'color-mix(in srgb, var(--color-warning) 12%, transparent)',
                    color: 'var(--color-warning)',
                  }}
                >
                  <Pause size={12} />
                  暂停
                </button>
              )}
              <button
                onClick={() => cancelTask(task.id)}
                className="px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors inline-flex items-center gap-1.5"
                style={{
                  background: 'color-mix(in srgb, var(--color-error) 12%, transparent)',
                  color: 'var(--color-error)',
                }}
              >
                <X size={12} />
                取消
              </button>
            </div>
          )}
        </div>

        {/* ── Progress block ── */}
        {stageCount > 0 && !(task.status === 'completed' && task.progress === 0) && (
          <div className="shrink-0 px-5 py-3" style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg)' }}>
            <div className="flex items-center gap-3">
              <div
                className="flex-1 h-[4px] rounded-full overflow-hidden"
                style={{ background: 'var(--color-bg-muted)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${displayProgress}%`,
                    background: task.status === 'failed'
                      ? 'var(--color-error)'
                      : task.status === 'paused'
                        ? 'var(--color-warning)'
                        : task.status === 'completed'
                          ? 'var(--color-success)'
                          : 'var(--color-primary)',
                  }}
                />
              </div>
              <div className="shrink-0 flex items-center gap-2 text-[11.5px] tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
                <span>{task.currentStage}/{stageCount}</span>
                <span style={{ opacity: 0.5 }}>·</span>
                <span style={{ fontWeight: 600, color: 'var(--color-text)' }}>{Math.round(displayProgress)}%</span>
              </div>
            </div>
          </div>
        )}

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          {task.errorMessage && (
            <div
              className="mx-5 mt-4 rounded-xl p-3.5"
              style={{
                background: 'color-mix(in srgb, var(--color-error) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-error) 22%, transparent)',
              }}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <AlertCircle size={13} style={{ color: 'var(--color-error)' }} />
                <span className="text-[12px] font-bold" style={{ color: 'var(--color-error)' }}>错误信息</span>
              </div>
              <p
                className="text-[12px] leading-relaxed"
                style={{ color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
              >
                {task.errorMessage}
              </p>
            </div>
          )}

          {plan.length > 0 ? (
            <div className="px-5 py-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--color-text-muted)' }}>
                执行计划
              </h3>
              <PlanTimeline plan={plan} />
            </div>
          ) : (
            !task.errorMessage && (
              <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                <div
                  className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3"
                  style={{ background: 'var(--color-bg-muted)' }}
                >
                  <ListTodo size={22} style={{ color: 'var(--color-text-muted)', opacity: 0.8 }} />
                </div>
                <p className="text-[13px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  暂无详细执行计划
                </p>
                <p className="text-[11.5px] mt-1" style={{ color: 'var(--color-text-muted)' }}>
                  任务将按照默认流程执行
                </p>
              </div>
            )
          )}
        </div>

        {/* ── Footer input ── */}
        <div
          className="px-4 py-3 shrink-0 flex items-center gap-2"
          style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-bg)' }}
        >
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
            placeholder={isActive ? '对任务追加指令...' : '任务已结束'}
            disabled={!isActive || sending}
            className="flex-1 px-3 py-2 rounded-lg text-[12.5px] outline-none border-none"
            style={{
              background: 'var(--color-bg-subtle)',
              color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
              cursor: isActive ? 'text' : 'not-allowed',
              opacity: isActive ? 1 : 0.5,
            }}
          />
          {isActive && (
            <button
              onClick={handleSendMessage}
              disabled={!inputValue.trim() || sending}
              className="p-2 rounded-lg transition-colors shrink-0"
              style={{
                background: inputValue.trim() ? 'var(--color-primary)' : 'var(--color-bg-subtle)',
                color: inputValue.trim() ? '#fff' : 'var(--color-text-muted)',
              }}
            >
              <Send size={14} />
            </button>
          )}
        </div>
        </div>
      </div>
    </>
  );
}
