//! SQLite-backed `LearningSink` implementation.
//!
//! Persists every user intervention to the `learning_signals` table and
//! lets `DispatchStrategy` retrieve recent entries to inject into its
//! system prompt — the feedback loop that lets主小精灵 progressively
//! match user expectations.

use std::sync::Arc;

use rusqlite::params;

use super::{LearningSignal, LearningSink};
use crate::engine::db::Database;

/// SQLite-backed LearningSink. Cheap to clone (just an Arc bump).
#[derive(Clone)]
pub struct SqliteLearningSink {
    db: Arc<Database>,
}

impl SqliteLearningSink {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    fn signal_kind_label(signal: &LearningSignal) -> &'static str {
        match signal {
            LearningSignal::DispatchRecalled { .. } => "dispatch_recalled",
            LearningSignal::DispatchChanged { .. } => "dispatch_changed",
            LearningSignal::VerdictAccepted { .. } => "verdict_accepted",
            LearningSignal::VerdictRejected { .. } => "verdict_rejected",
            LearningSignal::StepRetried { .. } => "step_retried",
            LearningSignal::PlanAborted { .. } => "plan_aborted",
        }
    }

    /// Extract the collaboration_id the signal is associated with, for indexing.
    fn collaboration_id(signal: &LearningSignal) -> Option<i64> {
        match signal {
            LearningSignal::DispatchRecalled { collaboration_id, .. }
            | LearningSignal::DispatchChanged { collaboration_id, .. }
            | LearningSignal::VerdictAccepted { collaboration_id }
            | LearningSignal::VerdictRejected { collaboration_id, .. }
            | LearningSignal::StepRetried { collaboration_id, .. }
            | LearningSignal::PlanAborted { collaboration_id, .. } => Some(*collaboration_id),
        }
    }
}

#[async_trait::async_trait]
impl LearningSink for SqliteLearningSink {
    async fn record(&self, signal: LearningSignal) -> Result<(), String> {
        let kind = Self::signal_kind_label(&signal);
        let collab_id = Self::collaboration_id(&signal);
        let payload = serde_json::to_string(&signal)
            .map_err(|e| format!("serialize learning signal: {e}"))?;
        let now = crate::engine::db::now_ts();

        let conn = self
            .db
            .get_conn()
            .ok_or_else(|| "database lock unavailable".to_string())?;
        conn.execute(
            "INSERT INTO learning_signals (kind, collaboration_id, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![kind, collab_id, payload, now],
        )
        .map_err(|e| format!("insert learning signal: {e}"))?;
        Ok(())
    }

    async fn recent(&self, limit: usize) -> Result<Vec<LearningSignal>, String> {
        let conn = self
            .db
            .get_conn()
            .ok_or_else(|| "database lock unavailable".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT payload_json FROM learning_signals
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?1",
            )
            .map_err(|e| format!("prepare recent signals: {e}"))?;
        let rows = stmt
            .query_map(params![limit as i64], |row| row.get::<_, String>(0))
            .map_err(|e| format!("query recent signals: {e}"))?;
        let mut out = Vec::new();
        for row in rows {
            let json = row.map_err(|e| format!("read signal row: {e}"))?;
            let signal: LearningSignal = serde_json::from_str(&json)
                .map_err(|e| format!("deserialize signal: {e}"))?;
            out.push(signal);
        }
        Ok(out)
    }
}
