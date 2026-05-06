import { invoke } from '@tauri-apps/api/core';

export interface UsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_prompt_cache_hit_tokens: number;
  total_prompt_cache_miss_tokens: number;
  total_cost_usd: number;
  call_count: number;
}

export interface SessionUsage {
  session_id: string;
  summary: UsageSummary;
}

export interface DailyUsage {
  date: string;
  summary: UsageSummary;
}

export async function getUsageSummary(since?: number, until?: number): Promise<UsageSummary> {
  return invoke('get_usage_summary', { since, until });
}

export async function getUsageBySession(limit?: number): Promise<SessionUsage[]> {
  return invoke('get_usage_by_session', { limit });
}

export async function getUsageDaily(days?: number): Promise<DailyUsage[]> {
  return invoke('get_usage_daily', { days });
}

/// Drain the process-wide pending-cost pool. Returns USD accrued since the last
/// drain; resets to zero on the backend. Poll once a second for a live counter.
export async function drainPendingCost(): Promise<number> {
  return invoke('drain_pending_cost');
}
