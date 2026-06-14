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
//!     │ 默认 → Running(提交即跑)                 │
//!     │ plan 含显式 UserConfirmation step → AwaitingConfirm │
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
    CollaborationOrchestrator, CollaborationPlan, CollaborationStatus, CompanionProfile, Executor,
    ExecutorHandle, Mutation, Participant, Step, StepId, StepKind, StepOutput, StepStatus,
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

    /// Whether a plan can transition Submit → Running directly. 产品已砍掉
    /// jury 的"拍板确认"卡 —— 群聊派遣(ParallelAgents)、单聊、HostSummarize
    /// 都应提交即跑。**只有显式的 `UserConfirmation` step 才需要暂停等用户**
    /// (该 step 在 `schedule_ready_steps` 里会把状态切回 AwaitingConfirm)。
    ///
    /// 历史:旧实现要求"全 SingleAgent 才跳过确认",但 Dispatched 群聊 plan
    /// 恒为 ParallelAgents → 永远卡在 AwaitingConfirm 且无 confirm() 调用方 →
    /// 群聊从根上无法执行。见 docs/review/2026-05-29_jury-群聊IM心智.md P0-1。
    fn plan_skips_confirmation(plan: &CollaborationPlan) -> bool {
        !plan
            .steps
            .iter()
            .any(|s| matches!(s.kind, StepKind::UserConfirmation))
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
            // CAS:只在 step 仍 running 时写 completed。若被 abort/skip 抢占
            // (affected==0),丢弃这条晚到结果,不再发审计/不再调度后续 ——
            // 防止 abort 后晚到的完成回调把协作翻回 Done(见终态守卫修复)。
            let affected = conn
                .execute(
                    "UPDATE collaboration_steps
                        SET status = 'completed', output_json = ?1, finished_at = ?2
                      WHERE collaboration_id = ?3 AND id = ?4 AND status = 'running'",
                    params![output_json, finished_at, collab_id, step_id],
                )
                .map_err(|e| format!("mark step completed: {e}"))?;
            if affected == 0 {
                return Ok(());
            }
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
            // CAS:同 complete_step —— 被 abort/skip 抢占则丢弃晚到失败,
            // 不再翻协作状态(防 abort 后被翻成 Failed)。
            let affected = conn
                .execute(
                    "UPDATE collaboration_steps
                        SET status = 'failed', error_reason = ?1, finished_at = ?2
                      WHERE collaboration_id = ?3 AND id = ?4 AND status = 'running'",
                    params![reason, finished_at, collab_id, step_id],
                )
                .map_err(|e| format!("mark step failed: {e}"))?;
            if affected == 0 {
                return Ok(());
            }
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

    // ================================================================
    // ConversationDriver 支撑面（Phase 1a —— 群聊对话循环引擎）
    // ================================================================
    // 群聊不是静态 DAG,是开放轮次的对话循环(见 docs/design/2026-05-31 §A)。
    // Driver 直接驱动执行器、**自己持有 finalize** —— 不走 submit→spawn_step→
    // "all-terminal 即自动 finalize" 那套(那套是给静态 plan 的,会和动态续轮
    // 打架,正是 chime-in 补丁 finalize 竞态的根)。下面是 Driver 用的最小面:
    // 建会话 / 追加轮 / await 式跑一轮 / 收口。

    /// 建一个"对话型"协作行(status=Running),持久化初始 plan 的 step 为 pending,
    /// 但**不调度、不 spawn**。执行权归 ConversationDriver。
    pub(crate) fn create_conversation(
        &self,
        chat_session_id: &str,
        intent: &str,
        plan: &CollaborationPlan,
        mode: &CollaborationMode,
        parent_id: Option<CollaborationId>,
    ) -> Result<CollaborationId, String> {
        if plan.steps.is_empty() {
            return Err("conversation must start with at least one round step".into());
        }
        let collab_id = self.persist_new(
            chat_session_id,
            intent,
            plan,
            mode,
            &CollaborationStatus::Running,
            parent_id,
        )?;
        self.audit.emit(
            collab_id,
            Actor::System,
            AuditKind::Submitted,
            serde_json::json!({ "intent": intent, "mode": mode, "plan": plan, "driven": true }),
        )?;
        Ok(collab_id)
    }

    /// 追加一个新轮次的 step(pending),供 Driver 多轮(Phase 1b)/兜底位用。
    pub(crate) fn add_pending_step(
        &self,
        collab_id: CollaborationId,
        step: &Step,
    ) -> Result<(), String> {
        let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
        let position: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM collaboration_steps WHERE collaboration_id = ?1",
                params![collab_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("count steps: {e}"))?;
        self.persist_step(&conn, collab_id, position, step)
    }

    /// 同步跑一个已 pending 的 step 到完成(await 执行器,**不 spawn / 不 finalize /
    /// 不调度后续**)。Driver 借此一轮一轮推进,自己决定下一步。
    /// - 返回 `Some(output)`:正常完成。
    /// - 返回 `None`:被 abort 抢占(CAS affected==0),Driver 应停止循环。
    /// - 返回 `Err`:执行器报错,此 step 已标 failed,Driver 应 finalize(Failed)。
    pub(crate) async fn run_round_step(
        &self,
        collab_id: CollaborationId,
        step: &Step,
        upstream: &[(StepId, StepOutput)],
    ) -> Result<Option<StepOutput>, String> {
        let started_at = crate::engine::db::now_ts();
        let claimed = {
            let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
            conn.execute(
                "UPDATE collaboration_steps SET status = 'running', started_at = ?1
                  WHERE collaboration_id = ?2 AND id = ?3 AND status = 'pending'",
                params![started_at, collab_id, step.id],
            )
            .map_err(|e| format!("mark round running: {e}"))?
        };
        if claimed == 0 {
            return Ok(None);
        }
        self.audit.emit(
            collab_id,
            Actor::System,
            AuditKind::StepStarted,
            serde_json::json!({ "step_id": step.id }),
        )?;

        let output = match self.executor.run_step(collab_id, step, upstream).await {
            Ok(o) => o,
            Err(e) => {
                let finished_at = crate::engine::db::now_ts();
                if let Some(conn) = self.db.get_conn() {
                    let _ = conn.execute(
                        "UPDATE collaboration_steps SET status = 'failed', error_reason = ?1, finished_at = ?2
                          WHERE collaboration_id = ?3 AND id = ?4 AND status = 'running'",
                        params![e, finished_at, collab_id, step.id],
                    );
                }
                self.audit.emit(
                    collab_id,
                    Actor::System,
                    AuditKind::StepFailed,
                    serde_json::json!({ "step_id": step.id, "reason": e }),
                )?;
                return Err(e);
            }
        };

        let finished_at = crate::engine::db::now_ts();
        let output_json =
            serde_json::to_string(&output).map_err(|e| format!("serialize output: {e}"))?;
        let affected = {
            let conn = self.db.get_conn().ok_or_else(|| "db lock".to_string())?;
            conn.execute(
                "UPDATE collaboration_steps SET status = 'completed', output_json = ?1, finished_at = ?2
                  WHERE collaboration_id = ?3 AND id = ?4 AND status = 'running'",
                params![output_json, finished_at, collab_id, step.id],
            )
            .map_err(|e| format!("mark round completed: {e}"))?
        };
        if affected == 0 {
            // 被 abort 抢占(status 已非 running)。丢弃这条产出,Driver 停。
            return Ok(None);
        }
        self.audit.emit(
            collab_id,
            Actor::System,
            AuditKind::StepCompleted,
            serde_json::json!({ "step_id": step.id, "duration_ms": output.duration_ms }),
        )?;
        Ok(Some(output))
    }

    /// Driver 收口 —— 写 verdict + 置终态。语义上由 Driver 拥有(对话循环退出时调)。
    /// 复用 `finalize` 的终态守卫:若已被 abort 抢先则幂等 no-op。
    pub(crate) fn finalize_conversation(
        &self,
        collab_id: CollaborationId,
        status: CollaborationStatus,
    ) -> Result<(), String> {
        self.finalize(collab_id, status)
    }

    /// 显式中止一条协作(R3:work job 逃生门)。复用 `finalize` 的 CAS 终态守卫:已终态则
    /// 幂等 no-op;在跑的步任务收尾时撞守卫,完成回调被静默忽略(不会翻回 Done)。
    /// 注:已在跑的 ReAct 步不被强杀(detached task),只是其结果不再落库 —— v1 取舍。
    pub fn abort_collaboration(&self, collab_id: CollaborationId) -> Result<(), String> {
        self.finalize(collab_id, CollaborationStatus::Aborted)
    }

    /// 插话续轮(2026-06-11,配合 followup 闸 2b「收下不拒绝」):intake 跑的时候用户
    /// 又发了消息 → 这轮收尾后检测积压(本 intake 创建之后的 user 消息),自动续一轮
    /// intake 消费 ——「先处理之前的,再继续处理新的」,不丢话、不打断进行中的活。
    ///
    /// 守卫:job 仍在澄清/待开工才续(开工 running 后的新消息由下一次 followup 正常起
    /// intake;已交付/中止不续)。终止性:续轮 intake 的 created_at 晚于积压消息,它收尾
    /// 时不会再把同批消息当积压。headless(无全局 providers / 无 runtime)→ 静默不续。
    fn resume_intake_if_backlog(&self, collab_id: CollaborationId, session_id: &str) {
        let db = self.db.clone();
        match db.get_work_job_status(session_id).as_deref() {
            Some("clarifying") | Some("pending_commit") => {}
            _ => return,
        }
        let created_at: i64 = {
            let Some(conn) = db.get_conn() else { return };
            match conn.query_row(
                "SELECT created_at FROM collaborations WHERE id = ?1",
                params![collab_id],
                |r| r.get(0),
            ) {
                Ok(ts) => ts,
                Err(_) => return,
            }
        };
        let backlog: Vec<String> = db
            .get_recent_messages(session_id, 10)
            .unwrap_or_default()
            .into_iter()
            .filter(|m| m.role == "user" && m.timestamp > created_at)
            .map(|m| m.content)
            .filter(|c| !c.trim().is_empty())
            .collect();
        if backlog.is_empty() {
            return;
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
        log::info!(
            "work intake {collab_id} 收尾时发现 {} 条插话,自动续一轮",
            backlog.len()
        );
        let session = session_id.to_string();
        rt.spawn(async move {
            let Some(cfg) = crate::engine::tools::resolve_llm_config_from_globals().await else {
                log::warn!("intake 续轮:解析不到 LLM 配置,放弃");
                return;
            };
            let Some(gid) = db.get_session_group(&session) else { return };
            let members: Vec<CompanionProfile> = db
                .list_group_members(gid)
                .into_iter()
                .map(|c| CompanionProfile {
                    id: c.id,
                    name: c.name,
                    avatar_emoji: c.avatar_emoji,
                    color_hex: c.color_hex,
                    description: c.role_label.unwrap_or_else(|| c.agent_definition_name.clone()),
                    agent_definition_name: c.agent_definition_name,
                    last_used_at: c.last_used_at,
                })
                .collect();
            if members.is_empty() {
                return;
            }
            // 牵头者固化:复用 job 记录的 lead;查不到才重选(与 followup 同语义)。
            let lead = match db
                .get_work_job_lead(&session)
                .and_then(|id| members.iter().find(|m| m.id == id).cloned())
            {
                Some(l) => l,
                None => match crate::engine::work::launcher::find_project_lead(&members).await {
                    Some(l) => l.clone(),
                    None => return,
                },
            };
            let combined = format!(
                "(这是你在处理上一轮时用户发来的消息,现在轮到它了)\n{}",
                backlog.join("\n")
            );
            if let Err(e) = crate::engine::work::launcher::launch_intake(
                db.clone(),
                cfg,
                &session,
                gid,
                &lead,
                &members,
                &combined,
            )
            .await
            {
                log::warn!("intake 续轮失败:{e}");
            }
        });
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
        // 终态守卫:只能从**非终态**翻入终态。这是修复 abort 被晚到的
        // complete_step/fail_step 翻回 Done/Failed 的关键 —— abort 先把协作置
        // aborted,之后晚到的回调走到这里 affected==0,直接早返回,不覆盖状态、
        // 不写矛盾的"已完成"裁决、不发重复审计。finalize 由此变幂等。
        let affected = conn
            .execute(
                "UPDATE collaborations
                    SET status = ?1, status_reason = ?2, completed_at = ?3
                  WHERE id = ?4 AND status NOT IN ('done', 'aborted', 'failed')",
                params![label, reason, now, collab_id],
            )
            .map_err(|e| format!("finalize collaboration: {e}"))?;
        drop(conn);
        if affected == 0 {
            // 已是终态(多半被 abort 抢先)。幂等 no-op。
            return Ok(());
        }

        // Persist a verdict message into the chat stream so the主精灵
        // sees it on the next turn and a refresh re-hydrates the inline
        // CollaborationMessageCard. Best-effort: log on failure but
        // don't block the finalize.
        if let Err(e) = self.write_verdict_message(collab_id, &status) {
            log::warn!("collab {collab_id}: failed to write verdict message: {e}");
        }

        // R3:派工协作终态 → 同步 job 级状态机(work_jobs)。intake 协作终态**不**动 job
        // 状态(intake done 只是"牵头者说完这轮话",job 仍在 clarifying/pending_commit —— 把
        // intake done 当"已交付"正是旧 MAX(id) 倒推的 P0 错乱)。best-effort,不阻塞 finalize。
        if let Ok(conn) = self.db.get_conn().ok_or(()) {
            let row: Result<(String, String, String), _> = conn
                .query_row(
                    "SELECT chat_session_id, kind, intent FROM collaborations WHERE id = ?1",
                    params![collab_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                );
            drop(conn);
            if let Ok((session_id, kind, intent)) = row {
                if kind == "work_dispatch" {
                    // 并发安全(2026-06-13 review):同一会话可同时跑多个 work 协作 ——
                    // PM intake + 用户 @ 直达的小任务 + call_teammate 接力。job 状态/交付
                    // 通知/提问撤销都是**会话级**的,只有当本协作是该会话**最后一个**活动
                    // 协作时才把 job 推终态。否则一个直达小任务先完成,会把整个 job 误标
                    // 「已交付」、误发通知、误撤 PM 正在等用户答的提问(三个 review bug 同根)。
                    // list_active_work_collabs 已不含本协作(上面 set_status 已置终态)。
                    let others_active = !self.db.list_active_work_collabs(&session_id).is_empty();
                    let job_status = match &status {
                        // 中止是显式、会话级动作(abort_work_job 会中止全部协作),直接落。
                        CollaborationStatus::Aborted => "aborted",
                        CollaborationStatus::Done if !others_active => "done",
                        CollaborationStatus::Failed(_) if !others_active => "failed",
                        // 还有别的协作在跑 → job 仍进行中,等最后一个收尾再落终态。
                        _ => "running",
                    };
                    if let Err(e) = self.db.set_work_job_status(&session_id, job_status) {
                        log::warn!("collab {collab_id}: sync work job status: {e}");
                    }
                    // 失败收口一致性:job 进终态 → 撤销该会话挂着的未答提问(没人会再收
                    // 答案的提问卡不该留),并唤醒还在内存阻塞的 ask_user 等待者(免其干等
                    // 到 1h 超时占着执行体)。job_status 非终态(others_active)时自动跳过 ——
                    // 这正是「直达任务完成不该撤 PM 正在等的提问」的修复点。
                    if matches!(job_status, "done" | "failed" | "aborted") {
                        let expired = self.db.expire_pending_questions(&session_id);
                        if !expired.is_empty() {
                            log::info!(
                                "collab {collab_id}: job 终态,撤销 {} 条未答提问",
                                expired.len()
                            );
                            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                                rt.spawn(async move {
                                    for rid in expired {
                                        crate::engine::tools::ask_user::respond(
                                            &rid,
                                            "（这项工作已结束,这个问题不用回答了。）".into(),
                                        )
                                        .await;
                                    }
                                });
                            }
                        }
                    }
                    // R6(交付闭环):交付那一刻不再静默 —— 系统通知 + work://job_done 事件
                    // (NavRail 红点/列表即刷)。中止是用户自己点的,不打扰。通知 context 走
                    // 既有 notification://pending 管道(page=chat+session_id),点击跳转由
                    // switchToSession 的 work- 前缀分支接到工作页(R5)。
                    // 通知/红点只在 job 真正落终态时发(others_active 时 job 仍 running,
                    // 不发 —— 否则直达小任务完成就弹「✅ 已交付」而活还没干完)。
                    let notify = match job_status {
                        "done" => Some(("✅ 工作已交付", intent)),
                        "failed" => Some(("⚠️ 工作没做完", intent)),
                        _ => None,
                    };
                    if let Some((title, body)) = notify {
                        crate::engine::scheduler::send_notification_with_context(
                            title,
                            &body,
                            serde_json::json!({ "page": "chat", "session_id": session_id }),
                        );
                    }
                    if matches!(job_status, "done" | "failed" | "aborted") {
                        if let Some(handle) = crate::engine::tools::get_app_handle() {
                            use tauri::Emitter;
                            handle
                                .emit(
                                    "work://job_done",
                                    serde_json::json!({ "session_id": session_id, "status": job_status }),
                                )
                                .ok();
                        }
                    }
                } else if kind == "work_intake"
                    && matches!(
                        status,
                        CollaborationStatus::Done | CollaborationStatus::Failed(_)
                    )
                {
                    // 插话不丢(2026-06-11):intake 跑的时候用户又发了消息(followup 闸 2b
                    // 收下不拒绝)→ 这轮收尾后检测积压,自动续一轮 intake 消费 ——
                    // 「先处理之前的,再继续处理新的」。
                    self.resume_intake_if_backlog(collab_id, &session_id);
                }
            }
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
        let (chat_session_id, kind): (String, String) = conn
            .query_row(
                "SELECT chat_session_id, kind FROM collaborations WHERE id = ?1",
                params![collab_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| format!("read chat_session_id/kind: {e}"))?;

        // §7-P0-1:work job 完成走 **work 交付摘要**(不写群聊「【名字】…」格式),并标
        // context_type=work_job —— 否则 work 完成时仍以群聊身份写回聊天流 = chat 引擎仍在
        // 替 work 写结论(对抗校验抓的"假解耦",decoupled:false 的根)。
        //
        // R3:intake 协作(kind=work_intake)与派工协作(work_dispatch)分治 ——
        // intake done 只是"牵头者说完这轮话"(澄清/提案),**不是交付**:不写「✅ 交付完成」、
        // 不覆盖锚点(否则用户的原始请求被假交付摘要吃掉,且 Work 列表错标"已交付")。
        // 「✅ 交付完成」只属于派工协作 Done。
        let is_work = kind == "work_dispatch" || kind == "work_intake";
        let is_intake = kind == "work_intake";
        let text = match &status {
            CollaborationStatus::Done => {
                if is_intake {
                    return Ok(()); // 牵头者的话已是协作消息本体,无需 verdict、不动锚点
                } else if is_work {
                    Self::compose_work_verdict(&conn, collab_id)?
                } else {
                    Self::compose_done_verdict(&conn, collab_id)?
                }
            }
            CollaborationStatus::Failed(reason) => {
                if is_intake {
                    let label = "牵头者这轮没接上,再发一条消息可以重新唤起";
                    if reason.trim().is_empty() {
                        format!("（{label}）")
                    } else {
                        format!("（{label}）{reason}")
                    }
                } else if is_work {
                    // 结构化失败报告(卡在哪 + 编号选项 + 推荐):失败时刻正是用户最
                    // 需要被引导的时刻,一行「工作未完成」只制造无助感。
                    crate::engine::work::worker::compose_work_failure(reason)
                } else if reason.trim().is_empty() {
                    "（群协作未完成）".to_string()
                } else {
                    format!("（群协作未完成）{reason}")
                }
            }
            CollaborationStatus::Aborted => {
                (if is_work { "（工作已中止）" } else { "（群协作已中止）" }).to_string()
            }
            _ => return Ok(()),
        };
        drop(conn);

        let ctx = if is_work { "work_job" } else { "collab" };
        self.db
            .upsert_collaboration_message_ctx(&chat_session_id, collab_id, &text, ctx)?;
        Ok(())
    }

    /// §7-P0-1:work job 完成的交付摘要(对照 `compose_done_verdict` 的 chat 群聊版)。
    /// 读 collab 的 intent 当标题 + 各**完成步**的 (牵头者/队友名, StepOutput),交给
    /// `work::worker::compose_work_summary` 拼成"✅ 交付完成"结构,而非群聊气泡拼接。
    fn compose_work_verdict(
        conn: &rusqlite::Connection,
        collab_id: CollaborationId,
    ) -> Result<String, String> {
        let title: String = conn
            .query_row(
                "SELECT intent FROM collaborations WHERE id = ?1",
                params![collab_id],
                |r| r.get(0),
            )
            .unwrap_or_default();
        let mut stmt = conn
            .prepare(
                "SELECT participants_json, output_json, status FROM collaboration_steps
                 WHERE collaboration_id = ?1 ORDER BY position ASC",
            )
            .map_err(|e| format!("prep work verdict query: {e}"))?;
        let rows = stmt
            .query_map(params![collab_id], |row| {
                let p: String = row.get(0)?;
                let o: Option<String> = row.get(1)?;
                let s: String = row.get(2)?;
                Ok((p, o, s))
            })
            .map_err(|e| format!("query work verdict steps: {e}"))?;
        let mut outputs: Vec<(String, StepOutput)> = Vec::new();
        let mut completed_ids: Vec<i64> = Vec::new();
        for r in rows {
            let (p_json, o_json, status) = r.map_err(|e| format!("work verdict row: {e}"))?;
            if status != "completed" {
                continue;
            }
            let Some(out_raw) = o_json else { continue };
            let output: StepOutput =
                serde_json::from_str(&out_raw).map_err(|e| format!("decode output: {e}"))?;
            let participants: Vec<Participant> =
                serde_json::from_str(&p_json).map_err(|e| format!("decode participants: {e}"))?;
            if let Some(p0) = participants.first() {
                completed_ids.push(p0.companion_id);
            }
            let name = participants
                .first()
                .map(|p| p.name.clone())
                .unwrap_or_else(|| "成员".into());
            outputs.push((name, output));
        }
        let mut summary = crate::engine::work::worker::compose_work_summary(&title, &outputs);
        // #2 验证门:完成步里有没有测试/评审角色把关过?没有 → 交付摘要诚实标「未验证」
        //(团队没 QA 时 dispatch 不会自动追加验证步,这里如实告诉用户没人验过)。
        let verified = completed_ids.iter().any(|&id| {
            conn.query_row(
                "SELECT agent_definition_name FROM companions WHERE id = ?1",
                params![id],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .map(|slug| crate::engine::work::plan::is_reviewer_slug(&slug))
            .unwrap_or(false)
        });
        if !verified {
            summary.push_str(
                "\n\n> ⚠️ 未经测试/评审把关 —— 团队里没有 QA 角色,交付物没人验证过,请自行确认。",
            );
        }
        Ok(summary)
    }

    /// 把一个已完成协作的可见产出拼成 verdict 文本 —— 写回 chat stream,主精灵
    /// 下一轮据此读到"群里刚刚聊了什么/给了什么结论"。
    ///
    /// 此前只读 `single_agent`,导致**群聊(parallel_agents)/群讨论(host_summarize)
    /// 的产出全部丢失**,verdict 落成"没有可见产出"占位 —— 主精灵的跨轮上下文断裂。
    /// 见陪审团 2026-05-30 P0。现在读全部 kind:
    /// - 有 `host_summarize`(群讨论的 YiYi 结论) → **优先以它为 verdict 主体**
    ///   (它本就是对全程的收口)。
    /// - 否则 → 按 position 拼 `parallel_agents` / `single_agent` 的发言。
    ///
    /// `parallel_agents` 的 `full_output` 已是「【名字】内容」多成员拼接块,直接用;
    /// `single_agent` 单成员,前缀其名。空 / 纯 `<pass>`(成员选择不发言)跳过。
    fn compose_done_verdict(
        conn: &rusqlite::Connection,
        collab_id: CollaborationId,
    ) -> Result<String, String> {
        let mut stmt = conn
            .prepare(
                "SELECT kind, participants_json, output_json, status FROM collaboration_steps
                 WHERE collaboration_id = ?1
                 ORDER BY position ASC",
            )
            .map_err(|e| format!("prep verdict query: {e}"))?;

        let rows = stmt
            .query_map(params![collab_id], |row| {
                let k: String = row.get(0)?;
                let p: String = row.get(1)?;
                let o: Option<String> = row.get(2)?;
                let s: String = row.get(3)?;
                Ok((k, p, o, s))
            })
            .map_err(|e| format!("query verdict steps: {e}"))?;

        // 是否成员发言 = 空 / 纯 <pass> 视为"没发言",不进 verdict。
        fn is_blank(body: &str) -> bool {
            let t = body.trim();
            t.is_empty() || t == "<pass>"
        }

        let mut host_conclusion: Option<String> = None;
        let mut parts: Vec<String> = Vec::new();
        for r in rows {
            let (kind, p_json, o_json, status) = r.map_err(|e| format!("verdict row: {e}"))?;
            if status != "completed" {
                continue;
            }
            let participants: Vec<Participant> = serde_json::from_str(&p_json)
                .map_err(|e| format!("decode participants: {e}"))?;
            let Some(out_raw) = o_json else { continue };
            let output: StepOutput = serde_json::from_str(&out_raw)
                .map_err(|e| format!("decode output: {e}"))?;
            let body = if output.full_output.trim().is_empty() {
                output.summary.clone()
            } else {
                output.full_output.clone()
            };
            if is_blank(&body) {
                continue;
            }
            match kind.as_str() {
                // 群讨论结论 —— 优先作为 verdict 主体。
                "host_summarize" => host_conclusion = Some(body),
                // 多成员同框,full_output 已是「【名字】…」拼好的块,直接用。
                "parallel_agents" => parts.push(body),
                // 单成员(@召唤 / 私聊),前缀其名。
                _ => {
                    let name = participants
                        .first()
                        .map(|p| p.name.as_str())
                        .unwrap_or("成员");
                    parts.push(format!("[{name}] {body}"));
                }
            }
        }

        if let Some(conclusion) = host_conclusion {
            return Ok(conclusion);
        }
        if parts.is_empty() {
            Ok("（群协作已完成，但没有可见产出）".to_string())
        } else {
            Ok(parts.join("\n\n"))
        }
    }
}

impl SqliteOrchestrator {
    /// submit 的 kinded 版本(R3):`collaborations.kind` 在**调度前**钉死。旧流程
    /// (submit 后补 `set_collaboration_kind`)有竞态 —— 步骤秒败时 finalize 已按默认
    /// chat_group 写了群聊式终态。work 调用方(launch_intake / commit_work_plan)用本方法;
    /// trait 的 `submit` 委托到这里(kind=None → 默认 'chat_group')。
    pub async fn submit_kinded(
        &self,
        chat_session_id: String,
        intent: String,
        plan: CollaborationPlan,
        mode: CollaborationMode,
        parent_id: Option<CollaborationId>,
        kind: Option<&str>,
    ) -> Result<CollaborationId, String> {
        if plan.steps.is_empty() {
            return Err("plan must contain at least one step".into());
        }

        // Initial status: 默认 Running(提交即跑)。只有 plan 含显式
        // UserConfirmation step 才进 AwaitingConfirm。Manual 模式恒 Running
        // —— 用户已用 "@阿狸 ..." 预确认。
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
        if let Some(k) = kind {
            self.db.set_collaboration_kind(collab_id, k)?;
        }

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
        self.submit_kinded(chat_session_id, intent, plan, mode, parent_id, None)
            .await
    }

    /// 释放一个 `AwaitingConfirm` 协作。注意:产品砍掉 jury 拍板卡后,`AwaitingConfirm`
    /// 只由显式 `UserConfirmation` step 触发,而 `StepKind::UserConfirmation` 目前
    /// **无任何生产构造点**(只在测试里用)。因此本方法及其 Tauri 命令
    /// `confirm_collaboration` / 前端 `confirmCollaboration` 当前是预留机制,等
    /// jury 拍板形态回归时复用 —— 暂不删,保留待用。见 P0-1 修复。
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
            // Failed 协作:重试或**跳过**失败步都是合法的「复活」操作(#3:跳过卡住的步
            // 让下游继续)。Done / Aborted 仍真终态。
            CollaborationStatus::Failed(_) => {
                matches!(mutation, Mutation::RetryStep { .. } | Mutation::SkipStep { .. })
            }
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
                    // CAS:只有 failed/skipped 的步可重试。没有这个条件时,连点「重叫一次」
                    // 会把已被上一次重试拉回 running 的步再次重置成 pending → schedule 的
                    // pending→running 守卫再次放行 → 同一步 N 路并发执行体同跑(实测用户
                    // 连点 4 下 = 4 个「交互设计师」并发互踩)。affected==0 = 已在重跑,拒绝。
                    let affected = conn
                        .execute(
                            "UPDATE collaboration_steps
                                SET status = 'pending', output_json = NULL,
                                    error_reason = NULL, started_at = NULL, finished_at = NULL
                              WHERE collaboration_id = ?1 AND id = ?2
                                AND status IN ('failed', 'skipped')",
                            params![id, step_id],
                        )
                        .map_err(|e| format!("reset step: {e}"))?;
                    if affected == 0 {
                        return Err("这一步已在重跑(或不在可重试状态),别再点了".into());
                    }
                }
                if matches!(collab.status, CollaborationStatus::Failed(_)) {
                    self.set_status(id, &CollaborationStatus::Running)?;
                    // work 派工协作:job 状态机同步回 running —— 否则 Work 列表停在
                    // 「未完成」而团队明明在重跑,状态精神分裂。
                    if self.db.get_collaboration_kind(id).as_deref() == Some("work_dispatch") {
                        if let Some(sid) = self.db.collaboration_session_id(id) {
                            let _ = self.db.set_work_job_status(&sid, "running");
                        }
                    }
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
                // 跳过让协作回到 Running:① UserConfirmation 闸被跳过 = "user 拍板";
                // ② Failed 协作跳过卡住的失败步 = 让下游 DAG 继续(#3)。两种都从非 Running
                // 态放回 Running,并同步 work job(否则 Work 列表停在「未完成」却在跑)。
                if matches!(
                    collab.status,
                    CollaborationStatus::AwaitingConfirm | CollaborationStatus::Failed(_)
                ) {
                    self.set_status(id, &CollaborationStatus::Running)?;
                    if self.db.get_collaboration_kind(id).as_deref() == Some("work_dispatch") {
                        if let Some(sid) = self.db.collaboration_session_id(id) {
                            let _ = self.db.set_work_job_status(&sid, "running");
                        }
                    }
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
