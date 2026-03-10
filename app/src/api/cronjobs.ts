// Cron Jobs API
import { invoke } from '@tauri-apps/api/core';

export interface CronJobSchedule {
  type: 'cron' | 'delay' | 'once';
  cron: string;
  timezone?: string;
  delay_minutes?: number;
  schedule_at?: string;
}

export interface DispatchTarget {
  type: 'system' | 'app' | 'bot';
  bot_id?: string;   // bot UUID
  target?: string;   // target ID (channel/group/user)
  channel?: string;  // legacy backward compat
}

export interface CronJobDispatch {
  targets: DispatchTarget[];
}

export interface CronJobRuntime {
  max_concurrency?: number;
  timeout_seconds?: number;
  misfire_grace_seconds?: number;
}

export interface CronJobRequest {
  input: unknown;
  session_id?: string | null;
  user_id?: string | null;
  [key: string]: unknown;
}

export interface CronJobSpec {
  id: string;
  name: string;
  enabled?: boolean;
  schedule: CronJobSchedule;
  task_type?: 'notify' | 'agent';
  text?: string;
  request?: CronJobRequest;
  dispatch?: CronJobDispatch;
  runtime?: CronJobRuntime;
  meta?: Record<string, unknown>;
  next_run_time?: number;
  last_run_time?: number;
}

export async function listCronJobs(): Promise<CronJobSpec[]> {
  return await invoke('list_cronjobs');
}

export async function createCronJob(spec: CronJobSpec): Promise<CronJobSpec> {
  return await invoke('create_cronjob', { spec });
}

export async function updateCronJob(id: string, spec: CronJobSpec): Promise<CronJobSpec> {
  return await invoke('update_cronjob', { id, spec });
}

export async function deleteCronJob(id: string): Promise<void> {
  return await invoke('delete_cronjob', { id });
}

export async function pauseCronJob(id: string): Promise<void> {
  return await invoke('pause_cronjob', { id });
}

export async function resumeCronJob(id: string): Promise<void> {
  return await invoke('resume_cronjob', { id });
}

export async function runCronJob(id: string): Promise<void> {
  return await invoke('run_cronjob', { id });
}

export async function getCronJobState(id: string): Promise<unknown> {
  return await invoke('get_cronjob_state', { id });
}

export interface CronJobExecution {
  id: number;
  job_id: string;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'success' | 'failed' | 'partial';
  result: string | null;
  trigger_type: 'scheduled' | 'manual';
}

export async function listCronJobExecutions(jobId: string, limit?: number): Promise<CronJobExecution[]> {
  return await invoke('list_cronjob_executions', { jobId, limit: limit ?? 20 });
}
