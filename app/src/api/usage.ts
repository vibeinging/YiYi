import { invoke } from '@tauri-apps/api/core';

export interface UsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
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
