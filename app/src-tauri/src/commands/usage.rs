use serde::Serialize;
use tauri::State;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct UsageSummaryResponse {
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_read_tokens: i64,
    pub total_cache_write_tokens: i64,
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
        total_cache_read_tokens: s.total_cache_read_tokens,
        total_cache_write_tokens: s.total_cache_write_tokens,
        total_cost_usd: s.total_cost_usd,
        call_count: s.call_count,
    }
}

/// Get global usage summary, optionally filtered by time range (millis).
#[tauri::command]
pub fn get_usage_summary(
    state: State<'_, AppState>,
    since: Option<i64>,
    until: Option<i64>,
) -> Result<UsageSummaryResponse, String> {
    let summary = state.db.get_usage_summary(since, until);
    Ok(to_response(summary))
}

/// Get per-session usage breakdown (top N by cost).
#[tauri::command]
pub fn get_usage_by_session(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<SessionUsageResponse>, String> {
    let rows = state.db.get_usage_by_session(limit.unwrap_or(20));
    Ok(rows.into_iter().map(|(sid, s)| SessionUsageResponse {
        session_id: sid,
        summary: to_response(s),
    }).collect())
}

/// Get daily usage for the last N days.
#[tauri::command]
pub fn get_usage_daily(
    state: State<'_, AppState>,
    days: Option<i64>,
) -> Result<Vec<DailyUsageResponse>, String> {
    let rows = state.db.get_usage_daily(days.unwrap_or(30));
    Ok(rows.into_iter().map(|(date, s)| DailyUsageResponse {
        date,
        summary: to_response(s),
    }).collect())
}
