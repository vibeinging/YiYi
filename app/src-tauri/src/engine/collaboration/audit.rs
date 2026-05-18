//! AuditTrail — every state-changing operation on a Collaboration goes
//! through here. Two effects per call:
//!   1. Append to the `collaboration_audit` table (durable, replayable).
//!   2. Broadcast to subscribers via `events::emit` (real-time UI).
//!
//! The two are inseparable: `Orchestrator` calls `AuditTrail::emit` once
//! and trusts that both effects happen.

use std::sync::Arc;

use rusqlite::params;

use super::events;
use super::{Actor, AuditEvent, AuditKind, CollaborationEvent, CollaborationId};
use crate::engine::db::Database;

/// Persistent + live event channel for collaboration audit records.
///
/// Cheap to clone — both inner fields are `Arc`-backed.
#[derive(Clone)]
pub struct AuditTrail {
    db: Arc<Database>,
}

impl AuditTrail {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// Record an audit event. Returns the new audit row id.
    ///
    /// Both effects (DB write + broadcast) must succeed for callers to
    /// trust that the audit is durable. If the DB write fails, the event
    /// is **not** broadcast — that way UI never shows an event we
    /// couldn't persist.
    pub fn emit(
        &self,
        collaboration_id: CollaborationId,
        actor: Actor,
        kind: AuditKind,
        payload: serde_json::Value,
    ) -> Result<i64, String> {
        let timestamp = crate::engine::db::now_ts();
        let actor_json = serde_json::to_string(&actor)
            .map_err(|e| format!("serialize actor: {e}"))?;
        let kind_str = audit_kind_label(&kind);
        let payload_str = serde_json::to_string(&payload)
            .map_err(|e| format!("serialize payload: {e}"))?;

        let row_id = {
            let conn = self
                .db
                .get_conn()
                .ok_or_else(|| "database lock unavailable".to_string())?;
            conn.execute(
                "INSERT INTO collaboration_audit
                    (collaboration_id, timestamp, actor_json, kind, payload_json)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![collaboration_id, timestamp, actor_json, kind_str, payload_str],
            )
            .map_err(|e| format!("insert audit row: {e}"))?;
            conn.last_insert_rowid()
        };

        let event = CollaborationEvent::Audit {
            event: AuditEvent {
                collaboration_id,
                timestamp,
                actor,
                kind,
                payload,
            },
        };
        events::emit(event);
        Ok(row_id)
    }

    /// Default cap for `list` — a single协作 should never realistically
    /// hit this many audit rows (a 10-step jury with retries is ≲ 50).
    /// Acts as a backstop against pathological cases blowing up the UI.
    /// Callers that need the full log use `list_paged`.
    pub const DEFAULT_LIST_LIMIT: usize = 500;

    /// Replay the most recent `DEFAULT_LIST_LIMIT` audit events for one
    /// collaboration, oldest first. UI uses this to render a "replay
    /// this协作" timeline.
    pub fn list(&self, collaboration_id: CollaborationId) -> Result<Vec<AuditEvent>, String> {
        self.list_paged(collaboration_id, Self::DEFAULT_LIST_LIMIT)
    }

    /// Same as `list` with an explicit limit. Use for archive / debug
    /// tooling that needs the unbounded log.
    pub fn list_paged(
        &self,
        collaboration_id: CollaborationId,
        limit: usize,
    ) -> Result<Vec<AuditEvent>, String> {
        let conn = self
            .db
            .get_conn()
            .ok_or_else(|| "database lock unavailable".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT timestamp, actor_json, kind, payload_json
                 FROM collaboration_audit
                 WHERE collaboration_id = ?1
                 ORDER BY timestamp ASC, id ASC
                 LIMIT ?2",
            )
            .map_err(|e| format!("prepare audit list: {e}"))?;
        let rows = stmt
            .query_map(params![collaboration_id, limit as i64], |row| {
                let timestamp: i64 = row.get(0)?;
                let actor_json: String = row.get(1)?;
                let kind_str: String = row.get(2)?;
                let payload_json: String = row.get(3)?;
                Ok((timestamp, actor_json, kind_str, payload_json))
            })
            .map_err(|e| format!("query audit: {e}"))?;

        let mut out = Vec::new();
        for row in rows {
            let (timestamp, actor_json, kind_str, payload_json) =
                row.map_err(|e| format!("read audit row: {e}"))?;
            let actor: Actor = serde_json::from_str(&actor_json)
                .map_err(|e| format!("deserialize actor: {e}"))?;
            let kind = audit_kind_from_label(&kind_str)
                .ok_or_else(|| format!("unknown audit kind: {kind_str}"))?;
            let payload: serde_json::Value = serde_json::from_str(&payload_json)
                .map_err(|e| format!("deserialize payload: {e}"))?;
            out.push(AuditEvent {
                collaboration_id,
                timestamp,
                actor,
                kind,
                payload,
            });
        }
        Ok(out)
    }
}

fn audit_kind_label(kind: &AuditKind) -> &'static str {
    match kind {
        AuditKind::Submitted => "submitted",
        AuditKind::Confirmed => "confirmed",
        AuditKind::CollaborationCompleted => "collaboration_completed",
        AuditKind::Aborted => "aborted",
        AuditKind::Failed => "failed",
        AuditKind::StepStarted => "step_started",
        AuditKind::StepCompleted => "step_completed",
        AuditKind::StepFailed => "step_failed",
        AuditKind::StepSkipped => "step_skipped",
        AuditKind::StepAdded => "step_added",
        AuditKind::StepRetried => "step_retried",
        AuditKind::DispatchJudged => "dispatch_judged",
        AuditKind::UserRecalled => "user_recalled",
        AuditKind::UserCorrected => "user_corrected",
        AuditKind::UserVerdictReaction => "user_verdict_reaction",
    }
}

fn audit_kind_from_label(label: &str) -> Option<AuditKind> {
    Some(match label {
        "submitted" => AuditKind::Submitted,
        "confirmed" => AuditKind::Confirmed,
        "collaboration_completed" => AuditKind::CollaborationCompleted,
        "aborted" => AuditKind::Aborted,
        "failed" => AuditKind::Failed,
        "step_started" => AuditKind::StepStarted,
        "step_completed" => AuditKind::StepCompleted,
        "step_failed" => AuditKind::StepFailed,
        "step_skipped" => AuditKind::StepSkipped,
        "step_added" => AuditKind::StepAdded,
        "step_retried" => AuditKind::StepRetried,
        "dispatch_judged" => AuditKind::DispatchJudged,
        "user_recalled" => AuditKind::UserRecalled,
        "user_corrected" => AuditKind::UserCorrected,
        "user_verdict_reaction" => AuditKind::UserVerdictReaction,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_kind_labels_round_trip() {
        for kind in [
            AuditKind::Submitted,
            AuditKind::Confirmed,
            AuditKind::CollaborationCompleted,
            AuditKind::Aborted,
            AuditKind::Failed,
            AuditKind::StepStarted,
            AuditKind::StepCompleted,
            AuditKind::StepFailed,
            AuditKind::StepSkipped,
            AuditKind::StepAdded,
            AuditKind::StepRetried,
            AuditKind::DispatchJudged,
            AuditKind::UserRecalled,
            AuditKind::UserCorrected,
            AuditKind::UserVerdictReaction,
        ] {
            let label = audit_kind_label(&kind);
            let back = audit_kind_from_label(label).expect("round-trip");
            assert_eq!(kind, back);
        }
    }
}
