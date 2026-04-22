/**
 * TaskDetailOverlay - Left slide-out panel for task details.
 * Overlays on top of Chat (which stays rendered underneath).
 * Width: 480px, slides in from left edge of main area.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ChevronLeft, AlertCircle,
  Pause, Timer, ListTodo, Send, X,
} from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import { cancelTask, pauseTask, sendTaskMessage, type TaskStage } from '../api/tasks';
import { TASK_STATUS_CONFIG, formatDuration } from '../utils/taskStatus';

function ElapsedTimer({ startMs, endMs }: { startMs: number; endMs?: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (endMs) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [endMs]);
  const elapsed = (endMs || now) - startMs;
  return <span className="text-[14px] font-bold tabular-nums" style={{ color: 'var(--color-text)' }}>{formatDuration(elapsed)}</span>;
}

function PlanTimeline({ plan }: { plan: TaskStage[] }) {
  return (
    <div className="space-y-1">
      {plan.map((stage, idx) => {
        const cfg = TASK_STATUS_CONFIG[stage.status] || TASK_STATUS_CONFIG.pending;
        const StageIcon = cfg.Icon;
        const isLast = idx === plan.length - 1;
        return (
          <div key={idx} className="flex gap-3">
            <div className="flex flex-col items-center shrink-0" style={{ width: '20px' }}>
              <div className="w-5 h-5 rounded-full flex items-center justify-center"
                style={{ background: `color-mix(in srgb, ${cfg.color} 14%, transparent)`, border: `2px solid ${cfg.color}` }}>
                <StageIcon size={10} className={cfg.spin ? 'animate-spin' : ''} style={{ color: cfg.color }} />
              </div>
              {!isLast && (
                <div className="w-[2px] flex-1 min-h-[16px]"
                  style={{ background: stage.status === 'completed' ? 'var(--color-success)' : 'var(--color-border)', opacity: stage.status === 'completed' ? 0.5 : 0.3 }} />
              )}
            </div>
            <div className="flex-1 min-w-0 pb-3">
              <span className="text-[13px] font-medium"
                style={{ color: stage.status === 'pending' ? 'var(--color-text-muted)' : 'var(--color-text)' }}>
                {stage.title}
              </span>
            </div>
          </div>
        );
      })}
    </div>
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

  // Animation: mount -> visible (slide in), close -> invisible -> unmount
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

  // Escape key
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

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 transition-opacity duration-200"
        style={{
          background: 'rgba(0, 0, 0, 0.2)',
          backdropFilter: 'blur(2px)',
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? 'auto' : 'none',
        }}
        onClick={() => selectTask(null)}
      />

      {/* Panel - slides from left */}
      <div
        className="fixed top-0 bottom-0 z-50 flex flex-col"
        style={{
          left: 'var(--sidebar-width, 220px)',
          width: '480px',
          maxWidth: 'calc(100vw - var(--sidebar-width, 220px) - 40px)',
          background: 'var(--color-bg-elevated)',
          borderRight: '1px solid var(--color-border)',
          boxShadow: '4px 0 24px rgba(0,0,0,0.15)',
          transform: visible ? 'translateX(0)' : 'translateX(-100%)',
          transition: visible ? 'transform 300ms ease-out' : 'transform 200ms ease-in',
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b shrink-0" style={{ borderColor: 'var(--color-border)' }}>
          <button
            onClick={() => selectTask(null)}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--color-text-secondary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <ChevronLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-bold truncate" style={{ color: 'var(--color-text)' }}>
              {task.title}
            </h2>
            {task.description && (
              <p className="text-[12px] mt-0.5 truncate" style={{ color: 'var(--color-text-secondary)' }}>
                {task.description}
              </p>
            )}
          </div>
          {/* Action buttons */}
          {isActive && (
            <div className="flex items-center gap-1.5 shrink-0">
              {task.status === 'running' && (
                <button
                  onClick={() => pauseTask(task.id)}
                  className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors inline-flex items-center gap-1"
                  style={{
                    background: 'color-mix(in srgb, var(--color-warning) 12%, transparent)',
                    color: 'var(--color-warning)',
                  }}
                >
                  <Pause size={11} />
                  暂停
                </button>
              )}
              <button
                onClick={() => cancelTask(task.id)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors inline-flex items-center gap-1"
                style={{
                  background: 'color-mix(in srgb, var(--color-error) 12%, transparent)',
                  color: 'var(--color-error)',
                }}
              >
                <X size={11} />
                取消
              </button>
            </div>
          )}
        </div>

        {/* Status bar */}
        <div className="flex items-center gap-5 px-5 py-3 border-b shrink-0" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)' }}>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold"
            style={{ background: `color-mix(in srgb, ${sc.color} 14%, transparent)`, color: sc.color }}>
            <StatusIcon size={12} className={sc.spin ? 'animate-spin' : ''} />
            {sc.label}
          </span>
          <div className="flex items-center gap-1.5">
            <Timer size={12} style={{ color: 'var(--color-text-muted)' }} />
            <ElapsedTimer startMs={task.createdAt} endMs={task.completedAt} />
          </div>
          {task.totalStages > 0 && (
            <span className="text-[12px] tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
              {task.currentStage}/{task.totalStages}
            </span>
          )}
        </div>

        {/* Progress bar */}
        {task.totalStages > 0 && (
          <div className="px-5 py-2 shrink-0" style={{ borderBottom: '1px solid var(--color-border)' }}>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-[3px] rounded-full overflow-hidden" style={{ background: 'var(--color-bg-muted)' }}>
                <div className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${Math.min(task.progress, 100)}%`,
                    background: task.status === 'failed' ? 'var(--color-error)' : task.status === 'paused' ? 'var(--color-warning)' : 'var(--color-primary)',
                  }} />
              </div>
              <span className="text-[11px] font-bold tabular-nums shrink-0" style={{ color: 'var(--color-text-secondary)' }}>
                {Math.round(task.progress)}%
              </span>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5" style={{ scrollbarWidth: 'thin' }}>
          {task.errorMessage && (
            <div className="rounded-xl p-4 mb-4"
              style={{ background: 'color-mix(in srgb, var(--color-error) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--color-error) 20%, transparent)' }}>
              <div className="flex items-center gap-2 mb-1.5">
                <AlertCircle size={14} style={{ color: 'var(--color-error)' }} />
                <span className="text-[12px] font-bold" style={{ color: 'var(--color-error)' }}>Error</span>
              </div>
              <p className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {task.errorMessage}
              </p>
            </div>
          )}

          {plan.length > 0 && (
            <div>
              <h3 className="text-[11px] font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--color-text-muted)' }}>
                执行计划
              </h3>
              <PlanTimeline plan={plan} />
            </div>
          )}

          {plan.length === 0 && !task.errorMessage && (
            <div className="flex flex-col items-center justify-center h-full opacity-40">
              <ListTodo size={32} style={{ color: 'var(--color-text-muted)' }} />
              <p className="text-[12px] mt-3" style={{ color: 'var(--color-text-muted)' }}>
                暂无执行计划
              </p>
            </div>
          )}
        </div>

        {/* Footer input */}
        <div className="px-5 py-3 border-t shrink-0 flex items-center gap-2"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)' }}>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
            placeholder={isActive ? '对任务追加指令...' : '任务已结束'}
            disabled={!isActive || sending}
            className="flex-1 px-3 py-2 rounded-lg text-[12px] outline-none border-none"
            style={{
              background: 'var(--color-bg-subtle)',
              color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
              cursor: isActive ? 'text' : 'not-allowed',
              opacity: isActive ? 1 : 0.6,
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
    </>
  );
}
