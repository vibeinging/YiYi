/**
 * CronJobSessionView
 * Task info header shown above the chat area when a cron job session is focused.
 * Displays job status, schedule, task content, and action buttons.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Loader,
  Zap,
  Calendar,
  Pause,
  Play,
  Edit,
  Trash2,
} from 'lucide-react';
import {
  listCronJobs,
  deleteCronJob,
  pauseCronJob,
  resumeCronJob,
  runCronJob,
  type CronJobSpec,
} from '../api/cronjobs';
import { listen } from '@tauri-apps/api/event';
import { toast, confirm } from './Toast';

interface CronJobSessionViewProps {
  jobId: string;
  onUnfocus: () => void;
}

function scheduleTypeLabel(type: string): string {
  switch (type) {
    case 'cron': return '周期执行';
    case 'delay': return '延时';
    case 'once': return '单次';
    default: return type;
  }
}

function scheduleDescription(schedule: CronJobSpec['schedule']): string {
  if (schedule.type === 'delay') return `${schedule.delay_minutes ?? 0} 分钟后`;
  if (schedule.type === 'once' && schedule.schedule_at) return new Date(schedule.schedule_at).toLocaleString();
  return schedule.cron || '';
}

export function CronJobSessionView({ jobId, onUnfocus }: CronJobSessionViewProps) {
  const [job, setJob] = useState<CronJobSpec | null>(null);
  const [running, setRunning] = useState(false);

  const loadJob = useCallback(async () => {
    try {
      const jobs = await listCronJobs();
      const found = jobs.find((j) => j.id === jobId);
      if (found) setJob(found);
    } catch (err) {
      console.error('Failed to load cron job:', err);
    }
  }, [jobId]);

  useEffect(() => { loadJob(); }, [loadJob]);

  // Auto-refresh on cron events
  useEffect(() => {
    const u1 = listen<{ job_id: string }>('cronjob://result', (e) => {
      if (e.payload.job_id === jobId) loadJob();
    });
    const u2 = listen('cronjob://refresh', () => loadJob());
    return () => { u1.then((fn) => fn()); u2.then((fn) => fn()); };
  }, [jobId, loadJob]);

  const handleRunNow = async () => {
    setRunning(true);
    toast.info('任务已触发');
    try {
      await runCronJob(jobId);
    } catch (err) {
      toast.error(`执行失败: ${String(err)}`);
    } finally {
      setRunning(false);
    }
  };

  const handleTogglePause = async () => {
    if (!job) return;
    try {
      if (job.enabled) await pauseCronJob(jobId);
      else await resumeCronJob(jobId);
      await loadJob();
    } catch (err) {
      toast.error(`操作失败: ${String(err)}`);
    }
  };

  const handleEdit = () => {
    window.dispatchEvent(new CustomEvent('navigate', { detail: 'cronjobs' }));
  };

  const handleDelete = async () => {
    if (!job) return;
    if (!(await confirm(`确定删除 "${job.name}"?`))) return;
    try {
      await deleteCronJob(jobId);
      toast.success('已删除');
      onUnfocus();
    } catch (err) {
      toast.error(`删除失败: ${String(err)}`);
    }
  };

  return (
    <div className="flex-shrink-0 mx-3 mt-3 mb-1 rounded-xl border backdrop-blur-sm" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          {/* Left: status + name + schedule */}
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {job && (
              <span
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium flex-shrink-0"
                style={{
                  background: job.enabled
                    ? 'color-mix(in srgb, var(--color-success) 12%, transparent)'
                    : 'var(--color-bg-muted)',
                  color: job.enabled ? 'var(--color-success)' : 'var(--color-text-tertiary)',
                }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: job.enabled ? 'var(--color-success)' : 'var(--color-text-tertiary)' }}
                />
                {job.enabled ? '运行中' : '已暂停'}
              </span>
            )}

            <span className="text-[14px] font-semibold truncate" style={{ color: 'var(--color-text)' }}>
              {job?.name || jobId}
            </span>

            {job && (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text-secondary)' }}
                >
                  {scheduleTypeLabel(job.schedule.type)}
                </span>
                <div className="flex items-center gap-1 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  <Calendar size={11} />
                  {job.schedule.type === 'cron' ? (
                    <code className="font-mono text-[11px] px-1 py-0.5 rounded" style={{ background: 'var(--color-bg-muted)' }}>
                      {job.schedule.cron}
                    </code>
                  ) : (
                    <span className="text-[11px]">{scheduleDescription(job.schedule)}</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Right: action buttons */}
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <button
              onClick={handleRunNow}
              disabled={running}
              className="p-2 rounded-lg transition-all disabled:opacity-50"
              style={{ color: 'var(--color-primary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-primary) 10%, transparent)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title="立即执行"
            >
              {running ? <Loader size={15} className="animate-spin" /> : <Zap size={15} />}
            </button>
            <button
              onClick={handleTogglePause}
              className="p-2 rounded-lg transition-all"
              style={{ color: 'var(--color-warning)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-warning) 10%, transparent)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title={job?.enabled ? '暂停' : '恢复'}
            >
              {job?.enabled ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button
              onClick={handleEdit}
              className="p-2 rounded-lg transition-all"
              style={{ color: 'var(--color-text-secondary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title="编辑"
            >
              <Edit size={15} />
            </button>
            <button
              onClick={handleDelete}
              className="p-2 rounded-lg transition-all"
              style={{ color: 'var(--color-text-tertiary)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'color-mix(in srgb, var(--color-error) 10%, transparent)';
                e.currentTarget.style.color = 'var(--color-error)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--color-text-tertiary)';
              }}
              title="删除"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        {/* Task content preview (collapsible) */}
        {job?.text && (
          <div
            className="mt-2 p-2.5 rounded-lg text-[12px] leading-relaxed line-clamp-2"
            style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text-secondary)' }}
          >
            {job.text}
          </div>
        )}
      </div>
    </div>
  );
}
