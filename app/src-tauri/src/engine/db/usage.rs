use rusqlite::params;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct UsageRecord {
    pub session_id: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub estimated_cost_usd: f64,
    pub recorded_at: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct UsageSummary {
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_read_tokens: i64,
    pub total_cache_write_tokens: i64,
    pub total_cost_usd: f64,
    pub call_count: i64,
}

impl super::Database {
    /// Record a single API call's token usage. Used by the main ReAct path
    /// (where session_id is meaningful) and callers that already had a
    /// session.
    pub fn record_usage(
        &self,
        session_id: &str,
        model: &str,
        input_tokens: u32,
        output_tokens: u32,
        cache_read_tokens: u32,
        cache_write_tokens: u32,
        estimated_cost_usd: f64,
    ) {
        self.record_usage_with_source(
            session_id,
            "main",
            model,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            estimated_cost_usd,
        );
    }

    /// Record usage with an explicit source classification (see
    /// `engine/usage.rs::UsageSource`). Lets us answer "how much did
    /// meditation cost this month?" — previously all background LLM calls
    /// (meditation / growth / compaction / subagent) silently bypassed the
    /// main `record_usage` path, so the UI under-reported the bill.
    pub fn record_usage_with_source(
        &self,
        session_id: &str,
        source: &str,
        model: &str,
        input_tokens: u32,
        output_tokens: u32,
        cache_read_tokens: u32,
        cache_write_tokens: u32,
        estimated_cost_usd: f64,
    ) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, recorded_at, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, now, source],
        ).ok();
    }

    /// Aggregate usage grouped by `source` within a time window.
    /// `since` and `until` are epoch-millis; `None` means unbounded.
    pub fn get_usage_by_source(
        &self,
        since: Option<i64>,
        until: Option<i64>,
    ) -> Vec<(String, UsageSummary)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT source, SUM(input_tokens), SUM(output_tokens), \
             SUM(cache_read_tokens), SUM(cache_write_tokens), \
             SUM(estimated_cost_usd), COUNT(*) \
             FROM token_usage \
             WHERE (?1 IS NULL OR recorded_at >= ?1) AND (?2 IS NULL OR recorded_at <= ?2) \
             GROUP BY source \
             ORDER BY SUM(estimated_cost_usd) DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![since, until], |row| {
            Ok((
                row.get::<_, String>(0)?,
                UsageSummary {
                    total_input_tokens: row.get(1)?,
                    total_output_tokens: row.get(2)?,
                    total_cache_read_tokens: row.get(3)?,
                    total_cache_write_tokens: row.get(4)?,
                    total_cost_usd: row.get(5)?,
                    call_count: row.get(6)?,
                },
            ))
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Get aggregated usage summary (global or filtered by time range).
    pub fn get_usage_summary(&self, since: Option<i64>, until: Option<i64>) -> UsageSummary {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), \
             COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(cache_write_tokens),0), \
             COALESCE(SUM(estimated_cost_usd),0.0), COUNT(*) \
             FROM token_usage WHERE (?1 IS NULL OR recorded_at >= ?1) AND (?2 IS NULL OR recorded_at <= ?2)",
            params![since, until],
            |row| {
                Ok(UsageSummary {
                    total_input_tokens: row.get(0)?,
                    total_output_tokens: row.get(1)?,
                    total_cache_read_tokens: row.get(2)?,
                    total_cache_write_tokens: row.get(3)?,
                    total_cost_usd: row.get(4)?,
                    call_count: row.get(5)?,
                })
            },
        ).unwrap_or_default()
    }

    /// Get per-session usage breakdown.
    pub fn get_usage_by_session(&self, limit: usize) -> Vec<(String, UsageSummary)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT session_id, SUM(input_tokens), SUM(output_tokens), \
             SUM(cache_read_tokens), SUM(cache_write_tokens), \
             SUM(estimated_cost_usd), COUNT(*) \
             FROM token_usage GROUP BY session_id \
             ORDER BY SUM(estimated_cost_usd) DESC LIMIT ?1"
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                UsageSummary {
                    total_input_tokens: row.get(1)?,
                    total_output_tokens: row.get(2)?,
                    total_cache_read_tokens: row.get(3)?,
                    total_cache_write_tokens: row.get(4)?,
                    total_cost_usd: row.get(5)?,
                    call_count: row.get(6)?,
                },
            ))
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Get daily usage for chart display.
    pub fn get_usage_daily(&self, days: i64) -> Vec<(String, UsageSummary)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let since = super::now_ts() - days * 86400 * 1000;
        let mut stmt = match conn.prepare(
            "SELECT date(recorded_at/1000, 'unixepoch', 'localtime') as day, \
             SUM(input_tokens), SUM(output_tokens), \
             SUM(cache_read_tokens), SUM(cache_write_tokens), \
             SUM(estimated_cost_usd), COUNT(*) \
             FROM token_usage WHERE recorded_at >= ?1 \
             GROUP BY day ORDER BY day ASC"
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![since], |row| {
            Ok((
                row.get::<_, String>(0)?,
                UsageSummary {
                    total_input_tokens: row.get(1)?,
                    total_output_tokens: row.get(2)?,
                    total_cache_read_tokens: row.get(3)?,
                    total_cache_write_tokens: row.get(4)?,
                    total_cost_usd: row.get(5)?,
                    call_count: row.get(6)?,
                },
            ))
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }
}
