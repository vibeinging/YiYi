//! `SqliteOrchestrator` — the default implementation of
//! `CollaborationOrchestrator`. Persists to the `collaborations` /
//! `collaboration_steps` tables and drives DAG execution via an injected
//! `Executor`.
//!
//! State machine (simplified):
//!
//! ```text
//!                          submit()
//!                              │
//!     ┌────────────────────────┴────────────────┐
//!     │ Manual or 全 SingleAgent → Running       │
//!     │ Dispatched + 含 Parallel/Plan → AwaitingConfirm │
//!     └────────────────────────┬────────────────┘
//!                              │
//!                ┌─────────────┴──────────────┐
//!                │ confirm()                  │
//!         AwaitingConfirm ──────────────► Running ──────► all steps done
//!                              │                              │
//!                              │ abort()                      ▼
//!                              ▼                            Done
//!                           Aborted
//!
//!                Any step Failed (and no retry) → Failed
//! ```

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::params;
use tokio::sync::broadcast;

use super::audit::AuditTrail;
use super::events;
use super::{
    Actor, AuditKind, Collaboration, CollaborationEvent, CollaborationId, CollaborationMode,
    CollaborationOrchestrator, CollaborationPlan, CollaborationStatus, Executor, ExecutorHandle,
    Mutation, Participant, Step, StepId, StepKind, StepOutput, StepStatus,
};
use crate::engine::db::Database;

/// Production orchestrator. Holds:
///   * `db` — persistence backbone
///   * `audit` — every state mutation flows through here
///   * `executor` — Step-level work (LLM calls etc.), pluggable for tests
#[derive(Clone)]
pub struct SqliteOrchestrator {
    db: Arc<Database>,
    audit: AuditTrail,
    executor: ExecutorHandle,
}

impl SqliteOrchestrator {
    pub fn new(db: Arc<Database>, executor: ExecutorHandle) -> Self {
        let audit = AuditTrail::new(db.clone());
        Self { db, audit, executor }
    }

    /// Whether a plan can transition Submit → Running directly. Only plans
    /// where every step is `SingleAgent` skip the confirmation step. Any
    /// parallel jury / DAG / user-confirmation node forces AwaitingConfirm
    /// for explicit user approval — the "摩擦力梯度" rule from the design
    /// doc.
    fn plan_skips_confirmation(plan: &CollaborationPlan) -> bool {
        plan.steps.iter().all(|s| matches!(s.kind, StepKind::SingleAgent))
    }

    fn status_label(status: &CollaborationStatus) -> &'static str {
        match status {
            CollaborationStatus::Planning => "planning",
            CollaborationStatus::AwaitingConfirm => "awaiting_confirm",
            CollaborationStatus::Running => "running",
            CollaborationStatus::Done => "done",
            CollaborationStatus::Aborted => "aborted",
            CollaborationStatus::Failed(_) => "failed",
        }
    }

    fn status_from_row(label: &str, reason: Option<String>) -> Result<CollaborationStatus, String> {
        Ok(match label {
            "planning" => CollaborationStatus::Planning,
            "awaiting_confirm" => CollaborationStatus::AwaitingConfirm,
            "running" => CollaborationStatus::Running,
            "done" => CollaborationStatus::Done,
            "aborted" => CollaborationStatus::Aborted,
            "failed" => CollaborationStatus::Failed(reason.unwrap_or_default()),
            other => return Err(format!("unknown collaboration status: {other}")),
        })
    }

    fn step_status_label(s: &StepStatus) -> &'static str {
        match s {
            StepStatus::Pending => "pending",
            StepStatus::Running => "running",
            StepStatus::Completed => "completed",
            StepStatus::Failed => "failed",
            StepStatus::Skipped => "skipped",
        }
    }

    fn step_status_from_label(label: &str) -> Result<StepStatus, String> {
        Ok(match label {
            "pending" => StepStatus::Pending,
            "running" => StepStatus::Running,
            "completed" => StepStatus::Completed,
            "failed" => StepStatus::Failed,
            "skipped" => StepStatus::Skipped,
            other => return Err(format!("unknown step status: {other}")),
        })
    }

    fn step_kind_label(k: &StepKind) -> &'static str {
        match k {
            StepKind::SingleAgent => "single_agent",
            StepKind::ParallelAgents => "parallel_agents",
            StepKind::HostSummarize => "host_summarize",
            StepKind::UserConfirmation => "user_confirmation",
        }
    }

    fn step_kind_from_label(label: &str) -> Result<StepKind, String> {
        Ok(match label {
            "single_agent" => StepKind::SingleAgent,
            "parallel_agents" => StepKind::ParallelAgents,
            "host_summarize" => StepKind::HostSummarize,
            "user_confirmation" => StepKind::UserConfirmation,
            other => return Err(format!("unknown step kind: {other}")),
        })
    }

    /// Insert a fresh collaboration row + all step rows. Returns the new
    /// collaboration id.
    fn persist_new(
        &self,
        chat_session_id: &str,
        intent: &str,
        plan: &CollaborationPlan,
        mode: &CollaborationMode,
        status: &CollaborationStatus,
        parent_id: Option<CollaborationId>,
    ) -> Result<CollaborationId, String> {
        let conn = self
            .db
            .get_conn()
            .ok_or_else(|| "database lock unavailable".to_string())?;
        let mode_json = serde_json::to_string(mode)
            .map_err(|e| format!("serialize mode: {e}"))?;
        let plan_json = serde_json::to_string(plan)
            .map_err(|e| format!("serialize plan: {e}"))?;
        let now = crate::engine::db::now_ts();
        let status_label = Self::status_label(status);
        let status_reason = if let CollaborationStatus::Failed(r) = status {
            Some(r.clone())
        } else {
            None
        };

        conn.execute(
            "INSERT INTO collaborations
                (chat_session_id, intent, mode_json, status, status_reason,
                 plan_json, parent_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                chat_session_id,
                intent,
                mode_json,
                status_label,
                status_reason,
                plan_json,
                parent_id,
                now,
            ],
        )
        .map_err(|e| format!("insert collaboration: {e}"))?;
        let collab_id = conn.last_insert_rowid();

        for (pos, step) in plan.steps.iter().enumerate() {
            self.persist_step(&conn, collab_id, pos as i64, step)?;
        }

        Ok(collab_id)
    }

    fn persist_step(
        &self,
        conn: &rusqlite::Connection,
        collab_id: CollaborationId,
        position: i64,
        step: &Step,
    ) -> Result<(), String> {
        let kind = Self::step_kind_label(&step.kind);
        let participants_json = serde_json::to_string(&step.participants)
            .map_err(|e| format!("serialize participants: {e}"))?;
        let depends_on_json = serde_json::to_string(&step.depends_on)
            .map_err(|e| format!("serialize depends_on: {e}"))?;
        let input_json = serde_json::to_string(&step.input)
            .map_err(|e| format!("serialize input: {e}"))?;
        let output_json = match &step.output {
            Some(o) => Some(serde_json::to_string(o)
                .map_err(|e| format!("serialize output: {e}"))?),
            None => None,
        };
        let status_label = Self::step_status_label(&step.status);
        conn.execute(
            "INSERT INTO collaboration_steps
                (id, collaboration_id, kind, participants_json, depends_on_json,
                 input_json, output_json, status, started_at, finished_at, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                step.id,
                collab_id,
                kind,
                participants_json,
                depends_on_json,
                input_json,
                output_json,
                status_label,
                step.started_at,
                step.finished_at,
                position,
            ],
        )
        .map_err(|e| format!("insert step: {e}"))?;
        Ok(())
    }

    /// Schedule any step whose dependencies are all completed. Idempotent —
    /// already-running / completed steps are skipped. The actual ReAct
    /// loops run on detached tokio tasks; this fn returns immediately.
    async fn schedule_ready_steps(&self, collab_id: CollaborationId) -> Result<(), String> {
        let collab = self
            .get(collab_id)
            .await?
            .ok_or_else(|| format!("collaboration {collab_id} not found"))?;
        if !matches!(collab.status, CollaborationStatus::Running) {
            return Ok(());
        }

        // Lookup table: which steps are already Completed/Skipped/Failed.
        let mut step_status: HashMap<StepId, StepStatus> = HashMap::new();
        let mut step_outputs: HashMap<StepId, StepOutput> = HashMap::new();
        for step in &collab.plan.steps {
            step_status.insert(step.id, step.status.clone());
            if let Some(o) = &step.output {
                step_outputs.insert(step.id, o.clone());
            }
        }

        let mut spawn_list: Vec<Step> = Vec::new();
        for step in &collab.plan.steps {
            if step.status != StepStatus::Pending {
                continue;
            }
            let deps_done = step.depends_on.iter().all(|dep| {
                matches!(
                    step_status.get(dep),
                    Some(StepStatus::Completed) | Some(StepStatus::Skipped)
                )
            });
            if !deps_done {
                continue;
            }
            // UserConfirmation steps pause the协作 — switch back to
            // AwaitingConfirm and bail. They're resolved via confirm().
            if matches!(step.kind, StepKind::UserConfirmation) {
                self.set_status(collab_id, &CollaborationStatus::AwaitingConfirm)?;
                self.audit.emit(
                    collab_id,
                    Actor::System,
                    AuditKind::StepStarted,
                    serde_json::json!({ "step_id": step.id, "paused_for_user_confirmation": true }),
                )?;
                return Ok(());
            }
            spawn_list.push(step.clone());
        }

        // Wrap upstream outputs in Arc so N sibling spawns share one
        // allocation instead of each cloning the full HashMap (which may
        // hold large `full_output` strings).
        let upstream = Arc::new(step_outputs);
        for step in spawn_list {
            self.spawn_step(collab_id, step, Arc::clone(&upstream))?;
        }
        Ok(())
    }

    /// Mark a step Running, dispatch to Executor on a detached task.
    /// On completion: persist output, emit StepCompleted, then re-evaluate
    /// ready steps. On failure: persist Failed, fail the collaboration.
    ///
    /// Synchronous on purpose — it never awaits, and the executor runs on
    /// a detached `tokio::spawn`. Being sync keeps the caller's future
    /// trivially `Send`.
    fn spawn_step(
        &self,
        collab_id: CollaborationId,
        step: Step,
        upstream_outputs: Arc<HashMap<StepId, StepOutput>>,
    ) -> Result<(), String> {
        let step_id = step.id;
        let started_at = crate::engine::db::now_ts();
        // Atomic Pending → Running transition: if another scheduler beat
        // us to it, the affected rows count is 0 and we skip this spawn.
        // Without this guard concurrent `schedule_ready_steps` calls
        // (triggered by sibling completions) can dispatch the same step
        // twice — leading to duplicate executor invocations and audit
        // events.
        let claimed = {
            let conn = self
                .db
                .get_conn()
                .ok_or_else(|| "db lock".to_string())?;
            conn.execute(
                "UPDATE collaboration_steps
                    SET status = 'running', started_at = ?1
                  WHERE collaboration_id = ?2 AND id = ?3 AND status = 'pending'",
                params![started_at, collab_id, step_id],
            )
            .map_err(|e| format!("mark step running: {e}"))?
        };
        if claimed == 0 {
            return Ok(());
        }
        self.audit.emit(
            collab_id,
            Actor::System,
            AuditKind::StepStarted,
            serde_json::json!({ "step_id": step_id }),
        )?;

        let executor = self.executor.clone();
        let orchestrator = self.clone();
        let upstream: Vec<(StepId, StepOutput)> = step
            .depends_on
            .iter()
            .filter_map(|id| upstream_outputs.get(id).cloned().map(|o| (*id, o)))
            .collect();

        tokio::spawn(async move {
            let result = executor.run_step(collab_id, &step, &upstream).await;
            match result {
                Ok(output) => {
                    if let Err(e) = orchestrator.complete_step(collab_id, step_id, output).await {
                        log::error!("complete_step({collab_id}, {step_id}) failed: {e}");
                    }
                }
                Err(err) => {
                    if let Err(e) = orchestrator.fail_step(collab_id, step_id, err).await {
                        log::error!("fail_step({collab_id}, {step_id}) failed: {e}");
                    }
                }
            }
        });
        Ok(())
    }

    async fn complete_step(
        &self,
        collab_id: CollaborationId,
        step_id: StepId,
        output: StepOutput,
    ) -> Result<(), String> {
        let finished_at = crate::engine::db::now_ts();
        let duration_ms = output.duration_ms;
        let tokens_used = output.tokens_used;
        let output_json = serde_json::to_string(&output)
            .map_err(|e| format!("serialize output: {e}"))?;
        {
            let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
            conn.execute(
                "UPDATE collaboration_steps
                    SET status = 'completed', output_json = ?1, finished_at = ?2
                  WHERE collaboration_id = ?3 AND id = ?4",
                params![output_json, finished_at, collab_id, step_id],
            )
            .map_err(|e| format!("mark step completed: {e}"))?;
        }
        self.audit.emit(
            collab_id,
            Actor::System,
            AuditKind::StepCompleted,
            serde_json::json!({
                "step_id": step_id,
                "duration_ms": duration_ms,
                "tokens": tokens_used,
            }),
        )?;

        // Are we done?
        if self.all_steps_terminal(collab_id)? {
            self.finalize(collab_id, CollaborationStatus::Done)?;
        } else {
            self.schedule_ready_steps(collab_id).await?;
        }
        Ok(())
    }

    async fn fail_step(
        &self,
        collab_id: CollaborationId,
        step_id: StepId,
        reason: String,
    ) -> Result<(), String> {
        let finished_at = crate::engine::db::now_ts();
        {
            let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
            conn.execute(
                "UPDATE collaboration_steps
                    SET status = 'failed', error_reason = ?1, finished_at = ?2
                  WHERE collaboration_id = ?3 AND id = ?4",
                params![reason, finished_at, collab_id, step_id],
            )
            .map_err(|e| format!("mark step failed: {e}"))?;
        }
        self.audit.emit(
            collab_id,
            Actor::System,
            AuditKind::StepFailed,
            serde_json::json!({ "step_id": step_id, "reason": reason }),
        )?;
        // A failed step terminates the collaboration unless explicitly retried.
        self.finalize(
            collab_id,
            CollaborationStatus::Failed(format!("step {step_id}: {reason}")),
        )?;
        Ok(())
    }

    fn all_steps_terminal(&self, collab_id: CollaborationId) -> Result<bool, String> {
        let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM collaboration_steps
                 WHERE collaboration_id = ?1
                   AND status NOT IN ('completed', 'failed', 'skipped')",
                params![collab_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("count pending steps: {e}"))?;
        Ok(pending == 0)
    }

    fn set_status(
        &self,
        collab_id: CollaborationId,
        status: &CollaborationStatus,
    ) -> Result<(), String> {
        let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
        let label = Self::status_label(status);
        let reason = if let CollaborationStatus::Failed(r) = status {
            Some(r.clone())
        } else {
            None
        };
        conn.execute(
            "UPDATE collaborations SET status = ?1, status_reason = ?2 WHERE id = ?3",
            params![label, reason, collab_id],
        )
        .map_err(|e| format!("update status: {e}"))?;
        Ok(())
    }

    fn finalize(
        &self,
        collab_id: CollaborationId,
        status: CollaborationStatus,
    ) -> Result<(), String> {
        let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
        let label = Self::status_label(&status);
        let reason = if let CollaborationStatus::Failed(r) = &status {
            Some(r.clone())
        } else {
            None
        };
        let now = crate::engine::db::now_ts();
        conn.execute(
            "UPDATE collaborations
                SET status = ?1, status_reason = ?2, completed_at = ?3
              WHERE id = ?4",
            params![label, reason, now, collab_id],
        )
        .map_err(|e| format!("finalize collaboration: {e}"))?;
        drop(conn);

        // Persist a verdict message into the chat stream so the主精灵
        // sees it on the next turn and a refresh re-hydrates the inline
        // CollaborationMessageCard. Best-effort: log on failure but
        // don't block the finalize.
        if let Err(e) = self.write_verdict_message(collab_id, &status) {
            log::warn!("collab {collab_id}: failed to write verdict message: {e}");
        }

        let kind = match &status {
            CollaborationStatus::Done => AuditKind::CollaborationCompleted,
            CollaborationStatus::Aborted => AuditKind::Aborted,
            CollaborationStatus::Failed(_) => AuditKind::Failed,
            other => unreachable!(
                "finalize() called with non-terminal status {other:?}; this is a bug \
                 in the orchestrator state machine"
            ),
        };
        self.audit.emit(
            collab_id,
            Actor::System,
            kind,
            serde_json::json!({ "final_status": Self::status_label(&status) }),
        )?;
        Ok(())
    }

    /// Write a single verdict message into the host session so the main
    /// agent can read it on subsequent turns and the frontend hydrates
    /// the inline collaboration card. No-op if the message already
    /// exists for this collaboration id (idempotent on retried finalize).
    fn write_verdict_message(
        &self,
        collab_id: CollaborationId,
        status: &CollaborationStatus,
    ) -> Result<(), String> {
        let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
        let chat_session_id: String = conn
            .query_row(
                "SELECT chat_session_id FROM collaborations WHERE id = ?1",
                params![collab_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("read chat_session_id: {e}"))?;

        let text = match status {
            CollaborationStatus::Done => Self::compose_done_verdict(&conn, collab_id)?,
            CollaborationStatus::Failed(reason) => {
                if reason.trim().is_empty() {
                    "（家族协作未完成）".to_string()
                } else {
                    format!("（家族协作未完成）{reason}")
                }
            }
            CollaborationStatus::Aborted => "（家族协作已中止）".to_string(),
            _ => return Ok(()),
        };
        drop(conn);

        self.db
            .upsert_collaboration_message(&chat_session_id, collab_id, &text)?;
        Ok(())
    }

    /// Read all `single_agent` steps in `position` order and stitch the
    /// completed participants' outputs into a verdict block. Falls back
    /// to `summary` if `full_output` is empty.
    fn compose_done_verdict(
        conn: &rusqlite::Connection,
        collab_id: CollaborationId,
    ) -> Result<String, String> {
        let mut stmt = conn
            .prepare(
                "SELECT participants_json, output_json, status FROM collaboration_steps
                 WHERE collaboration_id = ?1 AND kind = 'single_agent'
                 ORDER BY position ASC",
            )
            .map_err(|e| format!("prep verdict query: {e}"))?;

        let rows = stmt
            .query_map(params![collab_id], |row| {
                let p: String = row.get(0)?;
                let o: Option<String> = row.get(1)?;
                let s: String = row.get(2)?;
                Ok((p, o, s))
            })
            .map_err(|e| format!("query verdict steps: {e}"))?;

        let mut parts = Vec::new();
        for r in rows {
            let (p_json, o_json, status) = r.map_err(|e| format!("verdict row: {e}"))?;
            if status != "completed" {
                continue;
            }
            let participants: Vec<Participant> = serde_json::from_str(&p_json)
                .map_err(|e| format!("decode participants: {e}"))?;
            let Some(out_raw) = o_json else { continue };
            let output: StepOutput = serde_json::from_str(&out_raw)
                .map_err(|e| format!("decode output: {e}"))?;
            let Some(participant) = participants.first() else {
                continue;
            };
            let body = if output.full_output.trim().is_empty() {
                output.summary.clone()
            } else {
                output.full_output.clone()
            };
            if body.trim().is_empty() {
                continue;
            }
            parts.push(format!("[{}] {body}", participant.name));
        }

        if parts.is_empty() {
            Ok("（家族协作已完成，但没有可见产出）".to_string())
        } else {
            Ok(parts.join("\n\n"))
        }
    }
}

#[async_trait::async_trait]
impl CollaborationOrchestrator for SqliteOrchestrator {
    async fn submit(
        &self,
        chat_session_id: String,
        intent: String,
        plan: CollaborationPlan,
        mode: CollaborationMode,
        parent_id: Option<CollaborationId>,
    ) -> Result<CollaborationId, String> {
        if plan.steps.is_empty() {
            return Err("plan must contain at least one step".into());
        }

        // Initial status: AwaitingConfirm if plan has parallel/host/confirmation
        // nodes, Running otherwise. Manual mode always defaults to Running —
        // user already pre-confirmed by saying "@阿狸 ..." or `/jury ...`.
        let initial_status = match mode {
            CollaborationMode::Manual => CollaborationStatus::Running,
            CollaborationMode::Dispatched(_) => {
                if Self::plan_skips_confirmation(&plan) {
                    CollaborationStatus::Running
                } else {
                    CollaborationStatus::AwaitingConfirm
                }
            }
        };

        let collab_id = self.persist_new(
            &chat_session_id,
            &intent,
            &plan,
            &mode,
            &initial_status,
            parent_id,
        )?;

        self.audit.emit(
            collab_id,
            Actor::System,
            AuditKind::Submitted,
            serde_json::json!({
                "intent": &intent,
                "mode": &mode,
                "plan": &plan,
                "initial_status": Self::status_label(&initial_status),
            }),
        )?;

        if matches!(initial_status, CollaborationStatus::Running) {
            self.schedule_ready_steps(collab_id).await?;
        }
        Ok(collab_id)
    }

    async fn confirm(
        &self,
        id: CollaborationId,
        edited_plan: Option<CollaborationPlan>,
    ) -> Result<(), String> {
        let collab = self
            .get(id)
            .await?
            .ok_or_else(|| format!("collaboration {id} not found"))?;
        if !matches!(collab.status, CollaborationStatus::AwaitingConfirm) {
            return Err(format!(
                "cannot confirm collaboration in status {}",
                Self::status_label(&collab.status)
            ));
        }

        // If user edited the plan, persist the new version (replaces steps).
        if let Some(plan) = edited_plan.as_ref() {
            self.replace_plan(id, plan)?;
        }
        self.set_status(id, &CollaborationStatus::Running)?;
        self.audit.emit(
            id,
            Actor::User,
            AuditKind::Confirmed,
            serde_json::json!({ "plan": edited_plan.as_ref().unwrap_or(&collab.plan) }),
        )?;
        self.schedule_ready_steps(id).await?;
        Ok(())
    }

    async fn abort(&self, id: CollaborationId) -> Result<(), String> {
        let collab = self
            .get(id)
            .await?
            .ok_or_else(|| format!("collaboration {id} not found"))?;
        if collab.status.is_terminal() {
            return Err(format!(
                "cannot abort collaboration in terminal status {}",
                Self::status_label(&collab.status)
            ));
        }
        self.finalize(id, CollaborationStatus::Aborted)?;
        Ok(())
    }

    async fn mutate(&self, id: CollaborationId, mutation: Mutation) -> Result<(), String> {
        let collab = self
            .get(id)
            .await?
            .ok_or_else(|| format!("collaboration {id} not found"))?;
        // Failed is terminal but should still allow RetryStep — retry is
        // the canonical "revive" path. Done / Aborted remain truly terminal.
        let mutate_allowed = match &collab.status {
            CollaborationStatus::Done | CollaborationStatus::Aborted => false,
            CollaborationStatus::Failed(_) => matches!(mutation, Mutation::RetryStep { .. }),
            _ => true,
        };
        if !mutate_allowed {
            return Err(format!(
                "cannot mutate collaboration in status {:?} with {:?}",
                collab.status, mutation
            ));
        }

        match mutation {
            Mutation::AddStep { step } => {
                let position: i64 = collab.plan.steps.len() as i64;
                {
                    let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
                    self.persist_step(&conn, id, position, &step)?;
                }
                self.audit.emit(
                    id,
                    Actor::User,
                    AuditKind::StepAdded,
                    serde_json::json!({ "step": step }),
                )?;
                self.schedule_ready_steps(id).await?;
            }
            Mutation::RetryStep { step_id } => {
                {
                    let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
                    conn.execute(
                        "UPDATE collaboration_steps
                            SET status = 'pending', output_json = NULL,
                                error_reason = NULL, started_at = NULL, finished_at = NULL
                          WHERE collaboration_id = ?1 AND id = ?2",
                        params![id, step_id],
                    )
                    .map_err(|e| format!("reset step: {e}"))?;
                }
                if matches!(collab.status, CollaborationStatus::Failed(_)) {
                    self.set_status(id, &CollaborationStatus::Running)?;
                }
                self.audit.emit(
                    id,
                    Actor::User,
                    AuditKind::StepRetried,
                    serde_json::json!({ "step_id": step_id }),
                )?;
                self.schedule_ready_steps(id).await?;
            }
            Mutation::SkipStep { step_id } => {
                {
                    let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
                    let now = crate::engine::db::now_ts();
                    conn.execute(
                        "UPDATE collaboration_steps
                            SET status = 'skipped', finished_at = ?1
                          WHERE collaboration_id = ?2 AND id = ?3",
                        params![now, id, step_id],
                    )
                    .map_err(|e| format!("skip step: {e}"))?;
                }
                self.audit.emit(
                    id,
                    Actor::User,
                    AuditKind::StepSkipped,
                    serde_json::json!({ "step_id": step_id }),
                )?;
                // If we were paused at a UserConfirmation gate, skipping that
                // gate is the equivalent of "user 拍板" — release back to
                // Running so the rest of the DAG can flow.
                if matches!(collab.status, CollaborationStatus::AwaitingConfirm) {
                    self.set_status(id, &CollaborationStatus::Running)?;
                }
                if self.all_steps_terminal(id)? {
                    self.finalize(id, CollaborationStatus::Done)?;
                } else {
                    self.schedule_ready_steps(id).await?;
                }
            }
            Mutation::ChangeParticipant {
                step_id,
                participant,
            } => {
                let participants_json = serde_json::to_string(&vec![participant.clone()])
                    .map_err(|e| format!("serialize participant: {e}"))?;
                {
                    let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
                    conn.execute(
                        "UPDATE collaboration_steps
                            SET participants_json = ?1
                          WHERE collaboration_id = ?2 AND id = ?3",
                        params![participants_json, id, step_id],
                    )
                    .map_err(|e| format!("change participant: {e}"))?;
                }
                self.audit.emit(
                    id,
                    Actor::User,
                    AuditKind::UserCorrected,
                    serde_json::json!({ "step_id": step_id, "participant": participant }),
                )?;
            }
        }
        Ok(())
    }

    fn subscribe_all(&self) -> broadcast::Receiver<CollaborationEvent> {
        events::subscribe()
    }

    async fn get(&self, id: CollaborationId) -> Result<Option<Collaboration>, String> {
        // Delegate to the sync helper — keeps the MutexGuard out of the
        // async future state machine so the trait method stays Send.
        self.load(id)
    }
}

impl SqliteOrchestrator {
    /// Synchronous flavour of `get` for internal use. Lets the orchestrator's
    /// async methods read collaboration state without dragging a
    /// `MutexGuard<Connection>` across an await point (which would make the
    /// trait method non-Send).
    pub(crate) fn load(&self, id: CollaborationId) -> Result<Option<Collaboration>, String> {
        let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
        let row = conn
            .query_row(
                "SELECT chat_session_id, intent, mode_json, status, status_reason,
                        plan_json, parent_id, created_at, completed_at
                 FROM collaborations WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                    ))
                },
            )
            .ok();
        let Some((
            chat_session_id,
            intent,
            mode_json,
            status_label,
            status_reason,
            _plan_json,
            parent_id,
            created_at,
            completed_at,
        )) = row
        else {
            return Ok(None);
        };

        let mode: CollaborationMode = serde_json::from_str(&mode_json)
            .map_err(|e| format!("deserialize mode: {e}"))?;
        let status = Self::status_from_row(&status_label, status_reason)?;

        // Reconstruct the live plan from collaboration_steps rather than
        // plan_json — that way mutations (AddStep, RetryStep) reflect in the
        // returned plan without rewriting the cached blob.
        let mut step_stmt = conn
            .prepare(
                "SELECT id, kind, participants_json, depends_on_json, input_json,
                        output_json, status, started_at, finished_at
                 FROM collaboration_steps
                 WHERE collaboration_id = ?1
                 ORDER BY position ASC, id ASC",
            )
            .map_err(|e| format!("prepare step query: {e}"))?;
        let rows = step_stmt
            .query_map(params![id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                ))
            })
            .map_err(|e| format!("query steps: {e}"))?;
        let mut steps = Vec::new();
        for r in rows {
            let (sid, kind, parts_j, deps_j, input_j, output_j, status_j, started, finished) =
                r.map_err(|e| format!("read step row: {e}"))?;
            let kind = Self::step_kind_from_label(&kind)?;
            let participants = serde_json::from_str(&parts_j)
                .map_err(|e| format!("deserialize participants: {e}"))?;
            let depends_on = serde_json::from_str(&deps_j)
                .map_err(|e| format!("deserialize depends_on: {e}"))?;
            let input = serde_json::from_str(&input_j)
                .map_err(|e| format!("deserialize input: {e}"))?;
            let output = match output_j {
                Some(j) => Some(
                    serde_json::from_str(&j)
                        .map_err(|e| format!("deserialize output: {e}"))?,
                ),
                None => None,
            };
            let status = Self::step_status_from_label(&status_j)?;
            steps.push(Step {
                id: sid,
                kind,
                participants,
                depends_on,
                input,
                output,
                status,
                started_at: started,
                finished_at: finished,
            });
        }

        Ok(Some(Collaboration {
            id,
            chat_session_id,
            intent,
            mode,
            status,
            plan: CollaborationPlan { steps },
            parent_id,
            created_at,
            completed_at,
        }))
    }
}

impl SqliteOrchestrator {
    /// List the most recent N collaborations for one chat session,
    /// newest first. Powers the history-replay double-line bubbles in
    /// Chat. Reuses `load` per collab — small N (UI shows ≤ 20) so the
    /// per-row JSON cost is dominated by network/IPC.
    pub fn list_recent_by_session(
        &self,
        chat_session_id: &str,
        limit: usize,
    ) -> Result<Vec<Collaboration>, String> {
        let mut ids: Vec<CollaborationId> = Vec::new();
        {
            let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
            let mut stmt = conn
                .prepare(
                    "SELECT id FROM collaborations
                     WHERE chat_session_id = ?1
                     ORDER BY created_at DESC
                     LIMIT ?2",
                )
                .map_err(|e| format!("prepare list_recent: {e}"))?;
            let rows = stmt
                .query_map(params![chat_session_id, limit as i64], |row| {
                    row.get::<_, CollaborationId>(0)
                })
                .map_err(|e| format!("query list_recent: {e}"))?;
            for row in rows {
                if let Ok(id) = row {
                    ids.push(id);
                }
            }
        }
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(c) = self.load(id)? {
                out.push(c);
            }
        }
        Ok(out)
    }

    /// Replace the persisted plan with a user-edited version (called from
    /// `confirm` when `edited_plan` is supplied). Drops all existing step
    /// rows for the collab and re-inserts.
    fn replace_plan(
        &self,
        id: CollaborationId,
        plan: &CollaborationPlan,
    ) -> Result<(), String> {
        let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
        conn.execute(
            "DELETE FROM collaboration_steps WHERE collaboration_id = ?1",
            params![id],
        )
        .map_err(|e| format!("clear old steps: {e}"))?;
        let plan_json = serde_json::to_string(plan)
            .map_err(|e| format!("serialize plan: {e}"))?;
        conn.execute(
            "UPDATE collaborations SET plan_json = ?1 WHERE id = ?2",
            params![plan_json, id],
        )
        .map_err(|e| format!("update plan_json: {e}"))?;
        for (pos, step) in plan.steps.iter().enumerate() {
            self.persist_step(&conn, id, pos as i64, step)?;
        }
        Ok(())
    }
}
