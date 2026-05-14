use serde::Serialize;
use tauri::State;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct UsageSummaryResponse {
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_prompt_cache_hit_tokens: i64,
    pub total_prompt_cache_miss_tokens: i64,
    pub total_cost_usd: f64,
    pub call_count: i64,
}

#[derive(Debug, Serialize)]
pub struct SessionUsageResponse {
    pub session_id: String,
    pub summary: UsageSummaryResponse,
}

#[derive(Debug, Serialize)]
pub struct DailyUsageResponse {
    pub date: String,
    pub summary: UsageSummaryResponse,
}

fn to_response(s: crate::engine::db::usage::UsageSummary) -> UsageSummaryResponse {
    UsageSummaryResponse {
        total_input_tokens: s.total_input_tokens,
        total_output_tokens: s.total_output_tokens,
        total_prompt_cache_hit_tokens: s.total_prompt_cache_hit_tokens,
        total_prompt_cache_miss_tokens: s.total_prompt_cache_miss_tokens,
        total_cost_usd: s.total_cost_usd,
        call_count: s.call_count,
    }
}

pub fn get_usage_summary_impl(
    state: &AppState,
    since: Option<i64>,
    until: Option<i64>,
) -> Result<UsageSummaryResponse, String> {
    let summary = state.db.get_usage_summary(since, until);
    Ok(to_response(summary))
}

/// Get global usage summary, optionally filtered by time range (millis).
#[tauri::command]
pub fn get_usage_summary(
    state: State<'_, AppState>,
    since: Option<i64>,
    until: Option<i64>,
) -> Result<UsageSummaryResponse, String> {
    get_usage_summary_impl(&*state, since, until)
}

pub fn get_usage_by_session_impl(
    state: &AppState,
    limit: Option<usize>,
) -> Result<Vec<SessionUsageResponse>, String> {
    let rows = state.db.get_usage_by_session(limit.unwrap_or(20));
    Ok(rows.into_iter().map(|(sid, s)| SessionUsageResponse {
        session_id: sid,
        summary: to_response(s),
    }).collect())
}

/// Get per-session usage breakdown (top N by cost).
#[tauri::command]
pub fn get_usage_by_session(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<SessionUsageResponse>, String> {
    get_usage_by_session_impl(&*state, limit)
}

pub fn get_usage_daily_impl(
    state: &AppState,
    days: Option<i64>,
) -> Result<Vec<DailyUsageResponse>, String> {
    let rows = state.db.get_usage_daily(days.unwrap_or(30));
    Ok(rows.into_iter().map(|(date, s)| DailyUsageResponse {
        date,
        summary: to_response(s),
    }).collect())
}

/// Get daily usage for the last N days.
#[tauri::command]
pub fn get_usage_daily(
    state: State<'_, AppState>,
    days: Option<i64>,
) -> Result<Vec<DailyUsageResponse>, String> {
    get_usage_daily_impl(&*state, days)
}

/// Drain the process-wide pending-cost pool and return the accrued USD.
///
/// The UI polls this once a second to keep a live "session cost" counter in
/// sync with background LLM calls (meditation / growth / heartbeat / etc.)
/// that don't surface through the streaming ReAct loop.
#[tauri::command]
pub fn drain_pending_cost() -> f64 {
    crate::engine::cost_status::drain()
}

/// Snapshot of process-wide prefix-cache health.
///
/// Returns DeepSeek's `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
/// accumulated since process start, plus cache-break event counters. The
/// Cost / Settings UI can divide hit / (hit + miss) to show the user how
/// well YiYi is exploiting the 120× hit-vs-miss price gap, and an
/// unusually high `unexpected_breaks` count is a smoke alarm for a
/// regression in the static-prefix layout.
///
/// Read-only; safe to poll.
#[tauri::command]
pub fn get_prompt_cache_stats() -> crate::engine::prompt_cache::CacheStats {
    crate::engine::prompt_cache::snapshot_stats()
}
