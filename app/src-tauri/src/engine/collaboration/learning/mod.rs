//! Learning signals — the unified pipeline for every user intervention
//! against an AI decision(召回 / 改 plan / 否决结论 / 重试 / 中止),持久化到
//! `learning_signals` 表。本意是"用户纠正 → 系统变好"的反馈回路。
//!
//! TODO(待重连成长回路):当前**孤儿** —— 旧消费方 `DispatchStrategy::judge` 已随
//! dispatch/claim 模块退役,生产方 `recent_corrections` 也在群聊改对话引擎时移除,
//! 故 `record()` / `recent()` 暂无 live 调用。**保留不删**:这是 CLAUDE.md Design
//! Principle 3「白盒共建·双向训练:用户纠正 → corrections → 候选 lesson」的底层基建。
//! 待重新接线:中止群聊→`PlanAborted`、重试成员→`StepRetried`、(将来)用户对群结论
//! 说"不对"→`VerdictRejected` 喂进 Inbox 候选 lesson。见 docs/design/2026-05-31 §8。

use serde::{Deserialize, Serialize};

use super::{CollaborationId, CollaborationPlan, StepId};

pub mod sqlite_sink;

/// A single user intervention worth remembering. The discriminator stays
/// open-ended (additional variants don't require schema migrations
/// thanks to JSON payload storage) but every variant must carry enough
/// context to be replayable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum LearningSignal {
    /// User召回 a dispatched step within the 1.5s window (or before it
    /// started executing). Indicates the dispatch judgment was off.
    DispatchRecalled {
        collaboration_id: CollaborationId,
        original_plan: CollaborationPlan,
    },
    /// User edited the proposed plan before confirming. The diff between
    /// `original` and `edited` is the highest-signal training data.
    DispatchChanged {
        collaboration_id: CollaborationId,
        original_plan: CollaborationPlan,
        edited_plan: CollaborationPlan,
    },
    /// User accepted the协作 verdict as-is. Positive signal.
    VerdictAccepted {
        collaboration_id: CollaborationId,
    },
    /// User explicitly disagreed. Note carries the rationale they typed
    /// in — high-signal for principle / correction learning.
    VerdictRejected {
        collaboration_id: CollaborationId,
        user_note: String,
    },
    /// User retried a specific step. May indicate either a flaky run
    /// (no learning signal) or genuine dissatisfaction with the participant
    /// (DispatchStrategy should consider replacing on retry).
    StepRetried {
        collaboration_id: CollaborationId,
        step_id: StepId,
    },
    /// User aborted the whole协作. If `at_step` is `Some`, it tells us
    /// where the user gave up.
    PlanAborted {
        collaboration_id: CollaborationId,
        at_step: Option<StepId>,
    },
}

/// Persistence sink for learning signals.
///
/// Backed in production by a SQLite implementation (see
/// `sqlite_sink.rs`). The trait lets us swap in an in-memory mock during
/// tests and lets Phase 5 add federation / sync sinks transparently.
#[async_trait::async_trait]
pub trait LearningSink: Send + Sync {
    async fn record(&self, signal: LearningSignal) -> Result<(), String>;

    /// Retrieve the most recent N signals, ordered newest-first. Used by
    /// `DispatchStrategy` to seed its context with recent corrections.
    async fn recent(&self, limit: usize) -> Result<Vec<LearningSignal>, String>;
}
