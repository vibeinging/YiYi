//! Learning signals — the unified pipeline for every user intervention
//! against an AI decision. Feeds `DispatchStrategy` so the system gets
//! progressively better at matching user expectations.

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
