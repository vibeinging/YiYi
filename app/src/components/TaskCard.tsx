/**
 * TaskCard -- Inline task card embedded in the chat message stream.
 * Shown when a tool_call.name === 'create_task' is encountered.
 */

import { memo, useMemo } from 'react';
import { ExternalLink, ListTodo, FolderOpen, CheckCircle2, Sparkles } from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import { TASK_STATUS_CONFIG } from '../utils/taskStatus';
import type { TaskInfo, TaskStage } from '../api/tasks';

interface TaskCardProps {
  taskId: string;
}

export const TaskCard = memo(function TaskCard({ taskId }: TaskCardProps) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId));

  const plan: TaskStage[] = useMemo(() => {
    if (!task?.plan) return [];
    try { return JSON.parse(task.plan); } catch { return []; }
  }, [task?.plan]);

  const handleClick = () => {
    if (!task) return;
    useTaskStore.getState().selectTask(taskId);
  };

  if (!task) {
    return (
      <div
        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl"
        style={{
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          fontSize: '12px',
          color: 'var(--color-text-muted)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <ListTodo size={12} />
        <span>Task {taskId.slice(0, 8)}...</span>
      </div>
    );
  }

  const cfg = TASK_STATUS_CONFIG[task.status] ?? TASK_STATUS_CONFIG.pending;
  const StatusIcon = cfg.Icon;
  const isRunning = task.status === 'running';
  const isCompleted = task.status === 'completed';
  const isFailed = task.status === 'failed';
  const isCancelled = task.status === 'cancelled';
  const hasProgress = task.totalStages > 0 && (task.progress > 0 || isCompleted);
  const displayProgress = isCompleted ? 100 : Math.min(task.progress, 100);

  const runningStage = plan.find((s) => s.status === 'running');
  const completedStages = plan.filter((s) => s.status === 'completed').length;

  return (
    <div
      className="group relative rounded-2xl overflow-hidden cursor-pointer transition-all"
      style={{
        background: 'var(--color-bg-elevated)',
        border: `1px solid ${isRunning
          ? `color-mix(in srgb, ${cfg.color} 32%, var(--color-border))`
          : 'var(--color-border)'}`,
        boxShadow: isRunning
          ? `0 0 0 4px color-mix(in srgb, ${cfg.color} 8%, transparent)`
          : '0 1px 2px rgba(0,0,0,0.04)',
        maxWidth: '460px',
      }}
      onClick={handleClick}
      title="点击查看任务详情"
      onMouseEnter={(e) => {
        if (!isRunning) e.currentTarget.style.boxShadow = '0 4px 14px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)';
      }}
      onMouseLeave={(e) => {
        if (!isRunning) e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.04)';
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-3 pb-2">
        <div
          className="relative w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: `color-mix(in srgb, ${cfg.color} 14%, transparent)`,
            color: cfg.color,
          }}
        >
          <StatusIcon size={16} className={cfg.spin ? 'animate-spin' : ''} />
          {isRunning && (
            <span
              className="absolute inset-0 rounded-xl"
              style={{
                border: `1.5px solid ${cfg.color}`,
                animation: 'buddy-breathe 1.8s ease-in-out infinite',
                opacity: 0.4,
              }}
            />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="truncate text-[13.5px] font-semibold"
              style={{ color: 'var(--color-text)' }}
              title={task.title}
            >
              {task.title}
            </span>
            <span
              className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
              style={{
                color: cfg.color,
                background: `color-mix(in srgb, ${cfg.color} 14%, transparent)`,
              }}
            >
              {cfg.label}
            </span>
          </div>

          {/* Sub-line: current stage when running, or subtitle */}
          {isRunning && runningStage ? (
            <div className="text-[11.5px] mt-0.5 truncate inline-flex items-center gap-1.5" style={{ color: 'var(--color-text-secondary)' }}>
              <span className="w-1 h-1 rounded-full shrink-0" style={{ background: cfg.color, animation: 'pulse-dot 1.2s ease-in-out infinite' }} />
              <span className="truncate">{runningStage.title}</span>
            </div>
          ) : task.description ? (
            <div className="text-[11.5px] mt-0.5 truncate" style={{ color: 'var(--color-text-muted)' }}>
              {task.description}
            </div>
          ) : null}
        </div>
      </div>

      {/* Progress bar */}
      {hasProgress && (
        <div className="px-4 pb-2.5">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-[3px] rounded-full overflow-hidden" style={{ background: 'var(--color-bg-muted)' }}>
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${displayProgress}%`,
                  background: isFailed || isCancelled
                    ? 'var(--color-error)'
                    : isCompleted
                      ? 'var(--color-success)'
                      : task.status === 'paused'
                        ? 'var(--color-warning)'
                        : 'var(--color-primary)',
                }}
              />
            </div>
            <span
              className="text-[10.5px] tabular-nums shrink-0 font-semibold"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {plan.length > 0 ? `${completedStages}/${plan.length}` : `${Math.round(displayProgress)}%`}
            </span>
          </div>
        </div>
      )}

      {/* Error message */}
      {isFailed && task.errorMessage && (
        <div
          className="mx-4 mb-2 px-2.5 py-2 rounded-lg text-[11px] leading-snug"
          style={{
            background: 'color-mix(in srgb, var(--color-error) 8%, transparent)',
            color: 'var(--color-error)',
          }}
        >
          {task.errorMessage.slice(0, 120)}
          {task.errorMessage.length > 120 ? '...' : ''}
        </div>
      )}

      {/* Footer actions */}
      <div
        className="px-4 py-2 flex items-center justify-between gap-2"
        style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-bg)' }}
      >
        {/* Left: completion hint / workspace shortcut */}
        {isCompleted && task.workspacePath ? (
          <span
            role="button"
            className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold transition-opacity hover:opacity-80"
            style={{ color: 'var(--color-success)' }}
            onClick={async (e) => {
              e.stopPropagation();
              try {
                const { open } = await import('@tauri-apps/plugin-shell');
                await open(task.workspacePath!);
              } catch { /* ignore */ }
            }}
          >
            <FolderOpen size={12} />
            打开成果
          </span>
        ) : isCompleted ? (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--color-success)' }}>
            <CheckCircle2 size={12} />
            已完成
          </span>
        ) : isRunning ? (
          <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            <Sparkles size={11} />
            正在执行
          </span>
        ) : (
          <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            {plan.length > 0 ? `${plan.length} 个步骤` : ''}
          </span>
        )}

        {/* Right: view detail */}
        <span
          className="inline-flex items-center gap-1 text-[11.5px] font-semibold transition-transform group-hover:translate-x-0.5"
          style={{ color: 'var(--color-primary)' }}
        >
          查看详情
          <ExternalLink size={11} />
        </span>
      </div>
    </div>
  );
});

export default TaskCard;
