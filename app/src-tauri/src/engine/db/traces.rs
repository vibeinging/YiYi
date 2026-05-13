//! Turn-level agent trace storage.
//!
//! Persists raw ShareGPT-format turns (role, content, reasoning, tool_calls,
//! tool_call_id, model) to SQLite — separate from the user-facing `messages`
//! table which only stores display content.
//!
//! **Privacy**: this table holds the full conversation including tool inputs
//! and outputs. It is **OPT-IN** — gated by `config.tracing.enabled` (default
//! false). Users can clear it at any time via [`clear_traces`].
//!
//! **Purpose**: gives a data path for offline fine-tuning of DeepSeek V4 once
//! the API supports it. Until then, the table just accumulates idle.
//!
//! Daily GC drops rows older than `config.tracing.max_age_days` (default 30).

use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTrace {
    pub id: i64,
    pub session_id: String,
    pub task_id: Option<String>,
    pub turn_index: i64,
    pub role: String,
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_calls_json: Option<String>,
    pub tool_call_id: Option<String>,
    pub model: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Default)]
pub struct NewAgentTrace<'a> {
    pub session_id: &'a str,
    pub task_id: Option<&'a str>,
    pub turn_index: i64,
    pub role: &'a str,
    pub content: Option<&'a str>,
    pub reasoning_content: Option<&'a str>,
    pub tool_calls_json: Option<&'a str>,
    pub tool_call_id: Option<&'a str>,
    pub model: Option<&'a str>,
}

impl super::Database {
    /// Append a single trace row. Caller is expected to have checked the
    /// `tracing.enabled` config flag — this function does not gate itself,
    /// it just writes whatever it's given.
    pub fn record_trace(&self, t: &NewAgentTrace<'_>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "INSERT INTO agent_traces
                (session_id, task_id, turn_index, role, content,
                 reasoning_content, tool_calls_json, tool_call_id, model, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                t.session_id,
                t.task_id,
                t.turn_index,
                t.role,
                t.content,
                t.reasoning_content,
                t.tool_calls_json,
                t.tool_call_id,
                t.model,
                now,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("record_trace: {}", e))
    }

    /// Count rows (for UI display / metrics).
    pub fn count_traces(&self) -> i64 {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row("SELECT COUNT(*) FROM agent_traces", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0)
    }

    /// Delete every trace row. Used by the "clear trace data" Settings action.
    pub fn clear_traces(&self) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute("DELETE FROM agent_traces", [])
            .map_err(|e| format!("clear_traces: {}", e))
    }

    /// Drop trace rows older than `max_age_days`. Called from the daily
    /// idle-tick maintenance loop alongside inbox GC.
    pub fn gc_old_traces(&self, max_age_days: i64) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let cutoff = super::now_ts() - max_age_days * 86_400_000;
        conn.execute("DELETE FROM agent_traces WHERE created_at < ?1", params![cutoff])
            .map_err(|e| format!("gc_old_traces: {}", e))
    }

    /// Load all traces for a session, ordered by turn — used by the future
    /// export-to-ShareGPT command. Returns an empty Vec if none.
    pub fn list_traces_for_session(&self, session_id: &str) -> Vec<AgentTrace> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT id, session_id, task_id, turn_index, role, content,
                    reasoning_content, tool_calls_json, tool_call_id, model, created_at
             FROM agent_traces
             WHERE session_id = ?1
             ORDER BY turn_index ASC, id ASC",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        stmt.query_map(params![session_id], |row| {
            Ok(AgentTrace {
                id: row.get(0)?,
                session_id: row.get(1)?,
                task_id: row.get(2)?,
                turn_index: row.get(3)?,
                role: row.get(4)?,
                content: row.get(5)?,
                reasoning_content: row.get(6)?,
                tool_calls_json: row.get(7)?,
                tool_call_id: row.get(8)?,
                model: row.get(9)?,
                created_at: row.get(10)?,
            })
        })
        .map(|it| it.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }
}
