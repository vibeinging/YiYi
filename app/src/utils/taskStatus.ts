import {
  Loader2, CheckCircle, AlertCircle, Clock, Pause, XCircle,
} from 'lucide-react';

export const TASK_STATUS_CONFIG: Record<string, {
  color: string;
  label: string;
  Icon: React.ComponentType<any>;
  spin: boolean;
}> = {
  running:   { color: 'var(--color-primary)',    label: '进行中', Icon: Loader2,     spin: true },
  completed: { color: 'var(--color-success)',    label: '已完成', Icon: CheckCircle, spin: false },
  failed:    { color: 'var(--color-error)',      label: '失败',   Icon: AlertCircle, spin: false },
  paused:    { color: 'var(--color-warning)',    label: '已暂停', Icon: Pause,       spin: false },
  pending:   { color: 'var(--color-text-muted)', label: '等待中', Icon: Clock,       spin: false },
  cancelled: { color: 'var(--color-text-muted)', label: '已取消', Icon: XCircle,     spin: false },
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = Math.floor(secs % 60);
  if (mins < 60) return `${mins}m ${remainSecs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
