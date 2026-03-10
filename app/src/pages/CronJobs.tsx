/**
 * Cron Jobs Management Page
 * Swiss Minimalism · Clean · Precise
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Clock,
  Plus,
  Trash2,
  Play,
  Pause,
  Edit,
  RefreshCw,
  Calendar,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Info,
  X,
  Zap,
  ChevronDown,
  ChevronUp,
  History,
  Loader,
  Bell,
  MessageSquare,
  Send,
} from 'lucide-react';
import {
  listCronJobs,
  createCronJob,
  updateCronJob,
  deleteCronJob,
  pauseCronJob,
  resumeCronJob,
  runCronJob,
  listCronJobExecutions,
  type CronJobSpec,
  type CronJobExecution,
} from '../api/cronjobs';
import { listen } from '@tauri-apps/api/event';
import { listBots, type BotInfo } from '../api/bots';
import { PageHeader } from '../components/PageHeader';
import { toast, confirm } from '../components/Toast';

interface BotDispatchEntry {
  bot_id: string;
  target: string;
}

interface CronJobDialog {
  open: boolean;
  mode: 'create' | 'edit';
  job?: CronJobSpec;
  id: string;
  name: string;
  cron: string;
  scheduleType: 'cron' | 'delay' | 'once';
  delayMinutes: string;
  scheduleAt: string;
  text: string;
  enabled: boolean;
  dispatchSystem: boolean;
  dispatchApp: boolean;
  dispatchBots: BotDispatchEntry[];
}

export function CronJobsPage() {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<CronJobSpec[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningJobs, setRunningJobs] = useState<Set<string>>(new Set());
  const [execDialog, setExecDialog] = useState<{ open: boolean; jobId: string; jobName: string }>({ open: false, jobId: '', jobName: '' });
  const [executions, setExecutions] = useState<CronJobExecution[]>([]);
  const [execLoading, setExecLoading] = useState(false);
  const [expandedExecs, setExpandedExecs] = useState<Set<number>>(new Set());
  const [dialog, setDialog] = useState<CronJobDialog>({
    open: false,
    mode: 'create',
    id: '',
    name: '',
    cron: '0 * * * *',
    scheduleType: 'cron',
    delayMinutes: '30',
    scheduleAt: '',
    text: '',
    enabled: true,
    dispatchSystem: true,
    dispatchApp: true,
    dispatchBots: [],
  });

  const [availableBots, setAvailableBots] = useState<BotInfo[]>([]);

  // Load data
  const loadJobs = async () => {
    setLoading(true);
    try {
      const data = await listCronJobs();
      setJobs(data);
    } catch (error) {
      console.error('Failed to load cron jobs:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadJobs();
    listBots().then(setAvailableBots).catch(() => {});
  }, []);

  // Listen for cronjob execution results
  useEffect(() => {
    const unlisten = listen<{ job_id: string; job_name: string; result: string }>(
      'cronjob://result',
      (event) => {
        const { job_name, result } = event.payload;
        toast.success(`${job_name}: ${result.slice(0, 200)}`);
      }
    );
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Listen for cronjob refresh (e.g. one-time job completed)
  useEffect(() => {
    const unlisten = listen('cronjob://refresh', () => {
      loadJobs();
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Open create dialog
  const openCreateDialog = () => {
    const now = new Date();
    now.setHours(now.getHours() + 1);
    const defaultScheduleAt = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

    setDialog({
      open: true,
      mode: 'create',
      id: `job-${Date.now()}`,
      name: '',
      cron: '0 * * * *',
      scheduleType: 'cron',
      delayMinutes: '30',
      scheduleAt: defaultScheduleAt,
      text: '',
      enabled: true,
      dispatchSystem: true,
      dispatchApp: true,
      dispatchBots: [],
    });
  };

  // Open edit dialog
  const openEditDialog = (job: CronJobSpec) => {
    const scheduleType = (job.schedule as any).type || 'cron';
    let scheduleAt = '';
    if (scheduleType === 'once' && (job.schedule as any).schedule_at) {
      const dt = new Date((job.schedule as any).schedule_at);
      scheduleAt = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }

    // Parse dispatch targets
    const targets = job.dispatch?.targets || [];
    const hasSystem = targets.length === 0 || targets.some(t => t.type === 'system');
    const hasApp = targets.length === 0 || targets.some(t => t.type === 'app');
    const botTargets = targets
      .filter(t => t.type === 'bot' && t.bot_id)
      .map(t => ({ bot_id: t.bot_id!, target: t.target || '' }));

    setDialog({
      open: true,
      mode: 'edit',
      job,
      id: job.id,
      name: job.name,
      cron: job.schedule.cron,
      scheduleType: scheduleType === 'once' ? 'once' : (scheduleType === 'delay' ? 'delay' : 'cron'),
      delayMinutes: (job.schedule as any).delay_minutes?.toString() || '30',
      scheduleAt,
      text: job.text || '',
      enabled: job.enabled ?? true,
      dispatchSystem: hasSystem,
      dispatchApp: hasApp,
      dispatchBots: botTargets,
    });
  };

  // Save job
  const handleSave = async () => {
    if (!dialog.name.trim()) {
      toast.info(t('cronjobs.jobName'));
      return;
    }
    if (dialog.scheduleType === 'cron' && !dialog.cron.trim()) {
      toast.info(t('cronjobs.cronExpr'));
      return;
    }
    if (dialog.scheduleType === 'delay' && !dialog.delayMinutes.trim()) {
      toast.info('Delay minutes is required');
      return;
    }
    if (dialog.scheduleType === 'once' && !dialog.scheduleAt) {
      toast.info('Schedule time is required');
      return;
    }

    let schedule: CronJobSpec['schedule'];
    if (dialog.scheduleType === 'delay') {
      schedule = {
        type: 'delay',
        cron: '',
        delay_minutes: parseInt(dialog.delayMinutes) || 30,
      };
    } else if (dialog.scheduleType === 'once') {
      const dt = new Date(dialog.scheduleAt);
      schedule = {
        type: 'once',
        cron: '',
        schedule_at: dt.toISOString(),
      };
    } else {
      schedule = {
        type: 'cron',
        cron: dialog.cron,
      };
    }

    // Build dispatch targets
    const dispatchTargets: import('../api/cronjobs').DispatchTarget[] = [];
    if (dialog.dispatchSystem) {
      dispatchTargets.push({ type: 'system' });
    }
    if (dialog.dispatchApp) {
      dispatchTargets.push({ type: 'app' });
    }
    for (const entry of dialog.dispatchBots) {
      if (entry.bot_id && entry.target) {
        dispatchTargets.push({ type: 'bot', bot_id: entry.bot_id, target: entry.target });
      }
    }

    const spec: CronJobSpec = {
      id: dialog.id,
      name: dialog.name,
      enabled: dialog.enabled,
      schedule,
      task_type: 'notify',
      text: dialog.text,
      dispatch: { targets: dispatchTargets },
    };

    try {
      if (dialog.mode === 'create') {
        await createCronJob(spec);
      } else {
        await updateCronJob(dialog.job!.id, spec);
      }
      await loadJobs();
      setDialog({ ...dialog, open: false });
    } catch (error) {
      console.error('Failed to save cron job:', error);
      toast.error(`${t('cronjobs.save')}: ${String(error)}`);
    }
  };

  // Delete job
  const handleDelete = async (id: string, name: string) => {
    if (!(await confirm(`${t('cronjobs.delete')} "${name}"?`))) return;
    try {
      await deleteCronJob(id);
      await loadJobs();
    } catch (error) {
      console.error('Failed to delete cron job:', error);
      toast.error(`${t('cronjobs.delete')}: ${String(error)}`);
    }
  };

  // Toggle pause
  const handleTogglePause = async (id: string, enabled: boolean) => {
    try {
      if (enabled) {
        await pauseCronJob(id);
      } else {
        await resumeCronJob(id);
      }
      await loadJobs();
    } catch (error) {
      console.error('Failed to toggle cron job:', error);
      toast.error(`${t('cronjobs.runNow')}: ${String(error)}`);
    }
  };

  // Run now
  const handleRun = async (id: string) => {
    setRunningJobs(prev => new Set(prev).add(id));
    toast.info(t('cronjobs.runTriggered'));
    try {
      await runCronJob(id);
    } catch (error) {
      console.error('Failed to run cron job:', error);
      toast.error(`${t('cronjobs.runNow')}: ${String(error)}`);
    } finally {
      setRunningJobs(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Open execution history dialog
  const openExecDialog = async (jobId: string, jobName: string) => {
    setExecDialog({ open: true, jobId, jobName });
    setExecutions([]);
    setExpandedExecs(new Set());
    setExecLoading(true);
    try {
      const data = await listCronJobExecutions(jobId, 20);
      setExecutions(data);
    } catch (error) {
      console.error('Failed to load executions:', error);
    } finally {
      setExecLoading(false);
    }
  };

  // Toggle individual execution result
  const toggleExecExpand = (execId: number) => {
    setExpandedExecs(prev => {
      const next = new Set(prev);
      if (next.has(execId)) {
        next.delete(execId);
      } else {
        next.add(execId);
      }
      return next;
    });
  };

  // Format cron expression
  const formatCron = (cron: string) => {
    const parts = cron.split(' ');
    if (parts.length !== 5) return cron;
    const [min, hour, day, month, weekday] = parts;
    return `${min}min ${hour}h ${day}d ${month}m ${weekday}`;
  };

  // Get status icon
  const getStatusBadge = (enabled?: boolean) => {
    if (enabled) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[13px] font-medium bg-[var(--color-success)]/10 text-[var(--color-success)]">
          <CheckCircle size={12} />
          {t('cronjobs.running')}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[13px] font-medium bg-[var(--color-bg-muted)] text-[var(--color-text-muted)]">
        <XCircle size={12} />
        {t('cronjobs.paused')}
      </span>
    );
  };

  // Cron presets
  const cronPresets = [
    { label: 'Hourly', value: '0 * * * *' },
    { label: 'Daily 0am', value: '0 0 * * *' },
    { label: 'Daily 9am', value: '0 9 * * *' },
    { label: 'Mon 9am', value: '0 9 * * 1' },
    { label: 'Monthly 1st', value: '0 0 1 * *' },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <PageHeader
          title={t('cronjobs.title')}
          description={t('cronjobs.description')}
          actions={<>
            <button onClick={loadJobs} disabled={loading} className="w-9 h-9 flex items-center justify-center rounded-xl transition-colors disabled:opacity-50" style={{ color: 'var(--color-text-secondary)' }} onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }} title={t('cronjobs.refresh')}>
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={openCreateDialog} className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors" style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}>
              <Plus size={15} />
              {t('cronjobs.create')}
            </button>
          </>}
        />

        {/* Jobs list */}
        {jobs.length === 0 && !loading ? (
          <div className="text-center py-20 border border-dashed border-[var(--color-border)] rounded-2xl">
            <Clock size={48} className="mx-auto mb-4 opacity-30 text-[var(--color-primary)]" />
            <p className="text-[var(--color-text-secondary)] mb-4 font-medium text-[15px]">{t('cronjobs.noJobs')}</p>
            <button
              onClick={openCreateDialog}
              className="text-[var(--color-primary)] hover:underline text-[14px] font-medium"
            >
              {t('cronjobs.clickToCreate')}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {jobs.map((job) => (
              <div
                key={job.id}
                className={`p-5 rounded-2xl border transition-all ${
                  job.enabled
                    ? 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-sm hover:shadow-lg hover:-translate-y-0.5'
                    : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] opacity-60'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-4">
                      {getStatusBadge(job.enabled)}
                      <h3 className="font-semibold text-[15px]">{job.name}</h3>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-[14px]">
                      <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-[var(--color-bg-muted)] text-[var(--color-text-secondary)]">
                        {(job.schedule as any).type === 'delay'
                          ? t('cronjobs.scheduleTypeDelay')
                          : (job.schedule as any).type === 'once'
                            ? t('cronjobs.scheduleTypeOnce')
                            : t('cronjobs.scheduleTypeCron')}
                      </span>
                      <div className="flex items-center gap-2">
                        <Calendar size={14} className="text-[var(--color-text-muted)]" />
                        {(job.schedule as any).type === 'delay' ? (
                          <span>{(job.schedule as any).delay_minutes} {t('cronjobs.delayMinutesLabel')}</span>
                        ) : (job.schedule as any).type === 'once' && (job.schedule as any).schedule_at ? (
                          <span>{new Date((job.schedule as any).schedule_at).toLocaleString()}</span>
                        ) : (
                          <code className="font-mono text-[13px]">{job.schedule.cron}</code>
                        )}
                      </div>
                      {job.last_run_time && (
                        <span className="text-[var(--color-text-muted)] text-[13px]">
                          {t('cronjobs.lastRun')}: {new Date(job.last_run_time).toLocaleString()}
                        </span>
                      )}
                      {job.next_run_time && (
                        <span className="text-[var(--color-text-muted)] text-[13px]">
                          {t('cronjobs.nextRun')}: {new Date(job.next_run_time).toLocaleString()}
                        </span>
                      )}
                    </div>

                    {job.text && (
                      <div className="mt-4 p-3 bg-[var(--color-bg-muted)] rounded-xl text-[14px]">
                        <span className="text-[var(--color-text-muted)]">{t('cronjobs.taskContent')}: </span>
                        <span className="line-clamp-1">{job.text}</span>
                      </div>
                    )}

                    {/* Dispatch targets badges */}
                    {job.dispatch?.targets && job.dispatch.targets.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-3">
                        <span className="text-[11px] text-[var(--color-text-muted)]">{t('cronjobs.dispatchTargets')}:</span>
                        {job.dispatch.targets.map((dt, i) => (
                          <span key={i} className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-muted)] text-[var(--color-text-secondary)]">
                            {dt.type === 'system' && <><Bell size={10} /> {t('cronjobs.dispatchSystem')}</>}
                            {dt.type === 'app' && <><MessageSquare size={10} /> {t('cronjobs.dispatchApp')}</>}
                            {dt.type === 'bot' && <><Send size={10} /> {availableBots.find(b => b.id === dt.bot_id)?.name || dt.bot_id?.slice(0, 8)}{dt.target ? `:${dt.target.slice(0, 8)}...` : ''}</>}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 ml-4">
                    <button
                      onClick={() => handleRun(job.id)}
                      disabled={runningJobs.has(job.id)}
                      className="p-2.5 hover:bg-[var(--color-success)]/10 text-[var(--color-success)] rounded-xl transition-all disabled:opacity-50"
                      title={t('cronjobs.runOnce')}
                    >
                      {runningJobs.has(job.id) ? <RefreshCw size={16} className="animate-spin" /> : <Zap size={16} />}
                    </button>
                    <button
                      onClick={() => handleTogglePause(job.id, job.enabled ?? true)}
                      className="p-2.5 hover:bg-[var(--color-warning)]/10 text-[var(--color-warning)] rounded-xl transition-all"
                      title={job.enabled ? t('cronjobs.pause') : t('cronjobs.resume')}
                    >
                      {job.enabled ? <Pause size={16} /> : <Play size={16} />}
                    </button>
                    <button
                      onClick={() => openEditDialog(job)}
                      className="p-2.5 hover:bg-[var(--color-info)]/10 text-[var(--color-info)] rounded-xl transition-all"
                      title={t('cronjobs.edit')}
                    >
                      <Edit size={16} />
                    </button>
                    <button
                      onClick={() => handleDelete(job.id, job.name)}
                      className="p-2.5 hover:bg-[var(--color-error)]/10 text-[var(--color-error)] rounded-xl transition-all"
                      title={t('cronjobs.delete')}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                {/* Execution history button */}
                <button
                  onClick={() => openExecDialog(job.id, job.name)}
                  className="flex items-center gap-2 mt-4 pt-3 border-t border-[var(--color-border)] text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors w-full"
                >
                  <History size={14} />
                  <span>{t('cronjobs.executionHistory')}</span>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Cron help */}
        <div className="mt-8 p-6 rounded-2xl bg-[var(--color-bg-elevated)] border border-[var(--color-border)] shadow-sm">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-[var(--color-info)]/10 flex items-center justify-center flex-shrink-0">
              <Info size={20} className="text-[var(--color-info)]" />
            </div>
            <div className="text-[14px] text-[var(--color-text-secondary)]">
              <p className="font-medium mb-2 text-[var(--color-text)]">{t('cronjobs.tips.title')}</p>
              <p className="text-[13px] opacity-80 mb-3">
                {t('cronjobs.tips.format')}
              </p>
              <ul className="text-[13px] space-y-1 opacity-70 grid grid-cols-2 md:grid-cols-5 gap-2">
                <li>{t('cronjobs.tips.minute')}</li>
                <li>{t('cronjobs.tips.hour')}</li>
                <li>{t('cronjobs.tips.day')}</li>
                <li>{t('cronjobs.tips.month')}</li>
                <li>{t('cronjobs.tips.weekday')}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Execution history dialog */}
      {execDialog.open && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-[var(--color-bg-elevated)] rounded-3xl w-[80vw] shadow-2xl border border-[var(--color-border)] animate-slide-up flex flex-col" style={{ height: '90vh' }}>
            <div className="flex items-center justify-between p-6 pb-4 border-b border-[var(--color-border)]">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-[var(--color-primary)]/10 flex items-center justify-center">
                  <History size={18} className="text-[var(--color-primary)]" />
                </div>
                <div>
                  <h2 className="font-semibold text-[15px]">{t('cronjobs.executionHistory')}</h2>
                  <p className="text-[12px] text-[var(--color-text-muted)] mt-0.5">{execDialog.jobName}</p>
                </div>
              </div>
              <button
                onClick={() => setExecDialog({ ...execDialog, open: false })}
                className="p-2 hover:bg-[var(--color-bg-muted)] rounded-xl transition-all"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 pt-4">
              {execLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader size={20} className="animate-spin text-[var(--color-text-muted)]" />
                </div>
              ) : executions.length === 0 ? (
                <div className="text-center py-12">
                  <Clock size={32} className="mx-auto mb-3 opacity-20 text-[var(--color-text-muted)]" />
                  <p className="text-[13px] text-[var(--color-text-muted)]">{t('cronjobs.noExecutions')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {executions.map((exec) => (
                    <div
                      key={exec.id}
                      className="rounded-xl border border-[var(--color-border)] overflow-hidden"
                    >
                      {/* Header - clickable */}
                      <button
                        onClick={() => toggleExecExpand(exec.id)}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-bg-muted)] transition-colors text-left"
                      >
                        <div className="flex-shrink-0">
                          {exec.status === 'running' ? (
                            <Loader size={15} className="text-[var(--color-warning)] animate-spin" />
                          ) : exec.status === 'success' ? (
                            <CheckCircle size={15} className="text-[var(--color-success)]" />
                          ) : exec.status === 'partial' ? (
                            <AlertTriangle size={15} className="text-[var(--color-warning)]" />
                          ) : (
                            <XCircle size={15} className="text-[var(--color-error)]" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-[13px] font-medium">
                            {new Date(exec.started_at).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-muted)] text-[var(--color-text-muted)]">
                            {exec.trigger_type === 'manual' ? t('cronjobs.triggerManual') : t('cronjobs.triggerScheduled')}
                          </span>
                          {exec.finished_at && (
                            <span className="text-[11px] text-[var(--color-text-muted)]">
                              {((exec.finished_at - exec.started_at) / 1000).toFixed(1)}s
                            </span>
                          )}
                          {expandedExecs.has(exec.id) ? (
                            <ChevronUp size={14} className="text-[var(--color-text-muted)]" />
                          ) : (
                            <ChevronDown size={14} className="text-[var(--color-text-muted)]" />
                          )}
                        </div>
                      </button>

                      {/* Collapsible result */}
                      {expandedExecs.has(exec.id) && exec.result && (
                        <div className="px-4 pb-3 border-t border-[var(--color-border)]">
                          <pre className="mt-3 text-[13px] text-[var(--color-text-secondary)] whitespace-pre-wrap break-all leading-relaxed max-h-[200px] overflow-y-auto">
                            {exec.result}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create/Edit dialog */}
      {dialog.open && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-[var(--color-bg-elevated)] rounded-3xl p-6 w-full max-w-md shadow-2xl border border-[var(--color-border)] animate-slide-up">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-[15px]">
                {dialog.mode === 'create' ? t('cronjobs.createTitle') : t('cronjobs.editTitle')}
              </h2>
              <button
                onClick={() => setDialog({ ...dialog, open: false })}
                className="p-2 hover:bg-[var(--color-bg-muted)] rounded-xl transition-all"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                  {t('cronjobs.jobName')} *
                </label>
                <input
                  type="text"
                  value={dialog.name}
                  onChange={(e) => setDialog({ ...dialog, name: e.target.value })}
                  placeholder={t('cronjobs.jobNamePlaceholder')}
                  className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[14px]"
                />
              </div>

              <div>
                <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                  Schedule Type
                </label>
                <div className="flex flex-wrap gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="scheduleType"
                      checked={dialog.scheduleType === 'cron'}
                      onChange={() => setDialog({ ...dialog, scheduleType: 'cron' })}
                      className="accent-[var(--color-primary)]"
                    />
                    <span className="text-[14px]">Recurring (Cron)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="scheduleType"
                      checked={dialog.scheduleType === 'delay'}
                      onChange={() => setDialog({ ...dialog, scheduleType: 'delay' })}
                      className="accent-[var(--color-primary)]"
                    />
                    <span className="text-[14px]">Delay (N min)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="scheduleType"
                      checked={dialog.scheduleType === 'once'}
                      onChange={() => setDialog({ ...dialog, scheduleType: 'once' })}
                      className="accent-[var(--color-primary)]"
                    />
                    <span className="text-[14px]">At Specific Time</span>
                  </label>
                </div>
              </div>

              {dialog.scheduleType === 'cron' ? (
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                    {t('cronjobs.cronExpr')} *
                  </label>
                  <input
                    type="text"
                    value={dialog.cron}
                    onChange={(e) => setDialog({ ...dialog, cron: e.target.value })}
                    placeholder={t('cronjobs.cronPlaceholder')}
                    className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] font-mono text-[14px]"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {cronPresets.map((preset) => (
                      <button
                        key={preset.value}
                        onClick={() => setDialog({ ...dialog, cron: preset.value })}
                        className="text-[13px] px-3 py-1.5 border border-[var(--color-border)] hover:bg-[var(--color-bg-muted)] rounded-xl transition-all"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : dialog.scheduleType === 'delay' ? (
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                    Delay (minutes) *
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="10080"
                    value={dialog.delayMinutes}
                    onChange={(e) => setDialog({ ...dialog, delayMinutes: e.target.value })}
                    placeholder="30"
                    className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[14px]"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {[
                      { label: '5 min', value: '5' },
                      { label: '15 min', value: '15' },
                      { label: '30 min', value: '30' },
                      { label: '1 hour', value: '60' },
                      { label: '2 hours', value: '120' },
                    ].map((preset) => (
                      <button
                        key={preset.value}
                        onClick={() => setDialog({ ...dialog, delayMinutes: preset.value })}
                        className="text-[13px] px-3 py-1.5 border border-[var(--color-border)] hover:bg-[var(--color-bg-muted)] rounded-xl transition-all"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                    Schedule At *
                  </label>
                  <input
                    type="datetime-local"
                    value={dialog.scheduleAt}
                    onChange={(e) => setDialog({ ...dialog, scheduleAt: e.target.value })}
                    className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[14px]"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {[
                      { label: 'In 1 hour', value: 1 },
                      { label: 'In 3 hours', value: 3 },
                      { label: 'Tomorrow 9am', value: 24 + 9 },
                      { label: 'Next Monday 9am', value: () => {
                        const now = new Date();
                        const daysUntilMon = (8 - now.getDay() - now.getHours() < 9 ? 1 : 0) % 7 || 7;
                        const hours = daysUntilMon * 24 + 9 - now.getHours();
                        return hours;
                      }},
                    ].map((preset) => {
                      const hoursToAdd = typeof preset.value === 'number' ? preset.value : preset.value();
                      const dt = new Date(Date.now() + hoursToAdd * 60 * 60 * 1000);
                      const isoStr = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                      return (
                        <button
                          key={preset.label}
                          onClick={() => setDialog({ ...dialog, scheduleAt: isoStr })}
                          className="text-[13px] px-3 py-1.5 border border-[var(--color-border)] hover:bg-[var(--color-bg-muted)] rounded-xl transition-all"
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                  {t('cronjobs.taskContent')}
                </label>
                <textarea
                  value={dialog.text}
                  onChange={(e) => setDialog({ ...dialog, text: e.target.value })}
                  placeholder={t('cronjobs.taskContentPlaceholder')}
                  rows={3}
                  className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] resize-none text-[14px]"
                />
              </div>

              {/* Dispatch targets */}
              <div>
                <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                  {t('cronjobs.dispatchTargets')}
                </label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={dialog.dispatchSystem}
                      onChange={(e) => setDialog({ ...dialog, dispatchSystem: e.target.checked })}
                      className="accent-[var(--color-primary)]"
                    />
                    <Bell size={14} className="text-[var(--color-text-muted)]" />
                    <span className="text-[14px]">{t('cronjobs.dispatchSystem')}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={dialog.dispatchApp}
                      onChange={(e) => setDialog({ ...dialog, dispatchApp: e.target.checked })}
                      className="accent-[var(--color-primary)]"
                    />
                    <MessageSquare size={14} className="text-[var(--color-text-muted)]" />
                    <span className="text-[14px]">{t('cronjobs.dispatchApp')}</span>
                  </label>

                  {/* Bot dispatch entries */}
                  {dialog.dispatchBots.map((entry, idx) => (
                    <div key={idx} className="flex items-center gap-2 pl-6">
                      <Send size={14} className="text-[var(--color-text-muted)] flex-shrink-0" />
                      <select
                        value={entry.bot_id}
                        onChange={(e) => {
                          const updated = [...dialog.dispatchBots];
                          updated[idx] = { ...entry, bot_id: e.target.value };
                          setDialog({ ...dialog, dispatchBots: updated });
                        }}
                        className="px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[13px] min-w-[100px]"
                      >
                        <option value="">{t('cronjobs.selectBot')}</option>
                        {availableBots.map(b => (
                          <option key={b.id} value={b.id}>{b.name} ({b.platform})</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={entry.target}
                        onChange={(e) => {
                          const updated = [...dialog.dispatchBots];
                          updated[idx] = { ...entry, target: e.target.value };
                          setDialog({ ...dialog, dispatchBots: updated });
                        }}
                        placeholder={t('cronjobs.botTargetPlaceholder')}
                        className="flex-1 px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[13px]"
                      />
                      <button
                        onClick={() => {
                          const updated = dialog.dispatchBots.filter((_, i) => i !== idx);
                          setDialog({ ...dialog, dispatchBots: updated });
                        }}
                        className="p-1 hover:bg-[var(--color-error)]/10 text-[var(--color-error)] rounded-lg transition-all"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}

                  <button
                    onClick={() => setDialog({
                      ...dialog,
                      dispatchBots: [...dialog.dispatchBots, { bot_id: '', target: '' }],
                    })}
                    className="flex items-center gap-1.5 text-[13px] text-[var(--color-primary)] hover:underline pl-6"
                  >
                    <Plus size={13} />
                    {t('cronjobs.addBotDispatch')}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="enabled"
                  checked={dialog.enabled}
                  onChange={(e) => setDialog({ ...dialog, enabled: e.target.checked })}
                  className="accent-[var(--color-primary)]"
                />
                <label htmlFor="enabled" className="text-[14px]">
                  {t('cronjobs.enableThisTask')}
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setDialog({ ...dialog, open: false })}
                className="px-4 py-2.5 text-[14px] font-medium hover:bg-[var(--color-bg-muted)] rounded-xl transition-all"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSave}
                className="px-5 py-2.5 bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-primary-hover)] hover:shadow-lg text-white rounded-xl text-[14px] font-medium transition-all shadow-md hover:-translate-y-0.5"
              >
                {dialog.mode === 'create' ? t('common.create') : t('cronjobs.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
