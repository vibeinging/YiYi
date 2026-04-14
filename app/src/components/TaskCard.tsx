/**
 * TaskCard -- Inline task card embedded in the chat message stream.
 *
 * Shown when a tool_call.name === 'create_task' is encountered.
 * Compact design that blends with conversation flow.
 */

import { memo } from 'react';
import { ExternalLink, ListTodo } from 'lucide-react';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { TASK_STATUS_CONFIG } from '../utils/taskStatus';
import type { TaskInfo } from '../api/tasks';

function StatusDot({ status }: { status: TaskInfo['status'] }) {
  const cfg = TASK_STATUS_CONFIG[status] ?? TASK_STATUS_CONFIG.pending;
  const Icon = cfg.Icon;
  return <Icon size={12} className={cfg.spin ? 'animate-spin' : ''} style={{ color: cfg.color }} />;
}

/* ------------------------------------------------------------------ */
/*  TaskCard                                                           */
/* ------------------------------------------------------------------ */

interface TaskCardProps {
  taskId: string;
}

export const TaskCard = memo(function TaskCard({ taskId }: TaskCardProps) {
  const task = useTaskSidebarStore((s) => s.tasks.find((t) => t.id === taskId));

  const handleClick = () => {
    if (!task) return;
    // Navigate to task session via sidebar store
    useTaskSidebarStore.getState().navigateToSession(task.sessionId);
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

  const statusColor = (TASK_STATUS_CONFIG[task.status] ?? TASK_STATUS_CONFIG.pending).color;
  const hasProgress = task.totalStages > 0 && task.progress > 0;
  const isTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';

  return (
    <div
      className="rounded-xl overflow-hidden cursor-pointer transition-all hover:shadow-md"
      style={{
        background: 'var(--color-bg-elevated)',
        border: `1px solid ${task.status === 'running'
          ? 'color-mix(in srgb, var(--color-primary) 20%, var(--color-border))'
          : 'var(--color-border)'}`,
        maxWidth: '360px',
        transition: 'border-color 0.3s, box-shadow 0.2s',
      }}
      onClick={handleClick}
      title="点击查看任务详情"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <StatusDot status={task.status} />

        <span
          className="flex-1 truncate text-[12px] font-medium"
          style={{ color: 'var(--color-text)', fontFamily: 'var(--font-text)' }}
          title={task.title}
        >
          {task.title}
        </span>

        <span
          className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
          style={{
            color: statusColor,
            background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
          }}
        >
          {(TASK_STATUS_CONFIG[task.status] ?? TASK_STATUS_CONFIG.pending).label}
        </span>
      </div>

      {/* Progress bar — visible for all statuses when there's progress */}
      {hasProgress && (
        <div className="px-3 pb-1.5">
          <div className="flex items-center gap-2">
            <div
              className="flex-1 h-[2px] rounded-full overflow-hidden"
              style={{ background: 'var(--color-bg-muted)' }}
            >
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(task.progress, 100)}%`,
                  background: isTerminal
                    ? (task.status === 'completed' ? 'var(--color-success)' : 'var(--color-error)')
                    : (task.status === 'paused' ? 'var(--color-warning)' : 'var(--color-primary)'),
                  opacity: isTerminal ? 0.5 : 1,
                }}
              />
            </div>
            <span
              className="text-[10px] tabular-nums shrink-0"
              style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}
            >
              {Math.round(task.progress)}%
            </span>
          </div>
        </div>
      )}

      {/* Error message */}
      {task.status === 'failed' && task.errorMessage && (
        <div
          className="px-3 pb-2 text-[11px] leading-snug"
          style={{ color: 'var(--color-error)', fontFamily: 'var(--font-mono)' }}
        >
          {task.errorMessage.slice(0, 120)}
          {task.errorMessage.length > 120 ? '...' : ''}
        </div>
      )}

      {/* Footer */}
      <div
        className="px-3 py-1.5 flex items-center justify-end"
        style={{ borderTop: '1px solid var(--color-border)' }}
      >
        <span
          className="inline-flex items-center gap-1 text-[11px] font-medium"
          style={{ color: 'var(--color-primary)' }}
        >
          <ExternalLink size={10} />
          查看详情
        </span>
      </div>
    </div>
  );
});

export default TaskCard;
