/**
 * TaskCard -- Inline task card embedded in the chat message stream.
 *
 * Shown when a tool_call.name === 'create_task' is encountered.
 * Compact design that blends with conversation flow.
 */

import { memo, useEffect, useState } from 'react';
import {
  CheckCircle,
  AlertCircle,
  Clock,
  Loader2,
  Pause,
  ExternalLink,
  ListTodo,
} from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import type { TaskInfo } from '../api/tasks';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const STATUS_COLORS: Record<TaskInfo['status'], string> = {
  running:   'var(--color-primary)',
  completed: 'var(--color-success)',
  failed:    'var(--color-error)',
  paused:    'var(--color-warning)',
  pending:   'var(--color-text-muted)',
  cancelled: 'var(--color-text-muted)',
};

const STATUS_LABELS: Record<TaskInfo['status'], string> = {
  running:   'Running',
  completed: 'Completed',
  failed:    'Failed',
  paused:    'Paused',
  pending:   'Pending',
  cancelled: 'Cancelled',
};

function StatusDot({ status }: { status: TaskInfo['status'] }) {
  if (status === 'running') {
    return <Loader2 size={12} className="animate-spin" style={{ color: STATUS_COLORS.running }} />;
  }
  if (status === 'completed') {
    return <CheckCircle size={12} style={{ color: STATUS_COLORS.completed }} />;
  }
  if (status === 'failed') {
    return <AlertCircle size={12} style={{ color: STATUS_COLORS.failed }} />;
  }
  if (status === 'paused') {
    return <Pause size={12} style={{ color: STATUS_COLORS.paused }} />;
  }
  return <Clock size={12} style={{ color: STATUS_COLORS.pending }} />;
}

/* ------------------------------------------------------------------ */
/*  TaskCard                                                           */
/* ------------------------------------------------------------------ */

interface TaskCardProps {
  taskId: string;
}

export const TaskCard = memo(function TaskCard({ taskId }: TaskCardProps) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId));
  const selectTask = useTaskStore((s) => s.selectTask);

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

  const statusColor = STATUS_COLORS[task.status];
  const hasProgress = (task.status === 'running' || task.status === 'paused') && task.totalStages > 0;

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        background: 'var(--color-bg-elevated)',
        border: `1px solid ${task.status === 'running'
          ? 'color-mix(in srgb, var(--color-primary) 20%, var(--color-border))'
          : 'var(--color-border)'}`,
        maxWidth: '360px',
        transition: 'border-color 0.3s',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <StatusDot status={task.status} />

        <span
          className="flex-1 truncate text-[12px] font-medium"
          style={{ color: 'var(--color-text)', fontFamily: 'var(--font-text)' }}
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
          {STATUS_LABELS[task.status]}
        </span>
      </div>

      {/* Progress bar */}
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
                  background: task.status === 'paused' ? 'var(--color-warning)' : 'var(--color-primary)',
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
        <button
          onClick={() => selectTask(task.id)}
          className="inline-flex items-center gap-1 text-[11px] font-medium rounded-md px-2 py-1 transition-colors"
          style={{ color: 'var(--color-primary)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-primary-subtle)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <ExternalLink size={10} />
          View details
        </button>
      </div>
    </div>
  );
});

export default TaskCard;
