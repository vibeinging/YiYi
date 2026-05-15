//! Collaboration — first-class concept covering every form of family协作:
//! single-companion 召唤、jury (parallel agents)、dispatch、plan DAG.
//!
//! All协作 modes share the same data model (`Collaboration` + `Step` DAG)
//! and the same state machine (`SqliteOrchestrator`). Specific modes are
//! just particular plan shapes, not separate code paths. See
//! `docs/design/2026-05-15_jury-collaboration-design.md`.
//!
//! Phase 2A delivers the abstraction layer and traits. Phase 2B onwards
//! instantiates concrete modes.

use serde::{Deserialize, Serialize};

pub mod dispatch;
pub mod learning;

use std::sync::{Arc, OnceLock};
use tokio::sync::{broadcast, Semaphore};

/// Max in-flight participant ReAct loops across all collaborations.
/// Matches the BotManager worker pool (4) for consistency with the rest
/// of the system. Mirrored from `docs/design/2026-05-15_jury-collaboration-design.md` §6.5.
const COLLABORATION_MAX_CONCURRENCY: usize = 4;

/// Module-wide concurrency cap. `Executor::run_parallel` acquires before
/// dispatching each participant future. Sharing across all collaborations
/// (rather than per-collab) keeps two concurrent juries from doubling the
/// load on the LLM provider.
pub fn collab_semaphore() -> Arc<Semaphore> {
    static SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEMAPHORE
        .get_or_init(|| Arc::new(Semaphore::new(COLLABORATION_MAX_CONCURRENCY)))
        .clone()
}

// ── Identifiers & basic types ─────────────────────────────────────────

/// Database row id for a collaboration.
pub type CollaborationId = i64;

/// Step id, scoped within a collaboration. Independent of DB row id so
/// the plan can be authored client-side before persistence.
pub type StepId = i64;

/// Stable companion id (already used in the companions table).
pub type CompanionId = i64;

// ── Collaboration ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collaboration {
    pub id: CollaborationId,
    pub chat_session_id: String,
    /// User intent as captured at submit time. Stable through the协作 life.
    pub intent: String,
    pub mode: CollaborationMode,
    pub status: CollaborationStatus,
    pub plan: CollaborationPlan,
    /// `Some(parent_id)` when this is a "再开一轮" / `expand_verdict` follow-up.
    pub parent_id: Option<CollaborationId>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

/// Who initiated the协作.
///
/// `Manual` — user explicitly requested (e.g. `@阿狸 ...`, `/jury ...`).
/// `Dispatched` — a host (typically主小精灵 in family mode) chose to
/// delegate. Always carries the dispatcher's identity for audit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind", content = "by")]
pub enum CollaborationMode {
    Manual,
    Dispatched(CompanionId),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "state", content = "reason")]
pub enum CollaborationStatus {
    /// Dispatch strategy is拆解中.
    Planning,
    /// Plan ready, awaiting user拍板 (jury / plan modes only).
    AwaitingConfirm,
    /// Steps are executing.
    Running,
    Done,
    /// User-initiated cancel.
    Aborted,
    /// System-side terminal failure. Reason explains what blew up.
    Failed(String),
}

impl CollaborationStatus {
    /// Whether this is a终态 (no further state transitions possible).
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Done | Self::Aborted | Self::Failed(_))
    }
}

// ── Plan & Step ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CollaborationPlan {
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub id: StepId,
    pub kind: StepKind,
    pub participants: Vec<Participant>,
    /// Upstream step ids; empty = immediately executable.
    pub depends_on: Vec<StepId>,
    pub input: StepInput,
    pub output: Option<StepOutput>,
    pub status: StepStatus,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

/// Which physical协作 shape a step encodes. The orchestrator dispatches
/// to `executor` by matching on this enum — adding a new mode means
/// extending the enum and one match arm, no other surgery.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    /// One participant does one thing. The bread-and-butter case
    /// (单 companion 召唤).
    SingleAgent,
    /// N participants tackle the same prompt in parallel. Their outputs are
    /// independent — typically followed by a HostSummarize step (陪审团).
    ParallelAgents,
    /// Single host participant aggregates outputs from upstream steps.
    /// Host只 reads `summary` of upstream步, not `full_output`, to avoid
    /// blowing the context window.
    HostSummarize,
    /// The flow pauses here until the user makes a decision. Lets plan-style
    /// DAGs have mid-flow checkpoints without the orchestrator special-casing
    /// confirm logic.
    UserConfirmation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    #[default]
    Pending,
    Running,
    Completed,
    Failed,
    /// User chose to skip via `collaboration_mutate`. Treated as Completed
    /// for downstream dependency resolution but distinguishable in audit.
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Participant {
    pub companion_id: CompanionId,
    /// Display name snapshot — kept on the step so renaming a companion
    /// doesn't rewrite history.
    pub name: String,
    pub avatar_emoji: String,
    pub color_hex: String,
    /// Memory bucket scope inherited from the companion's AgentDefinition
    /// at submit time. Frozen for the duration of the step.
    pub memory_scope: crate::engine::agents::MemoryScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepInput {
    /// Prompt text the participant sees. May reference upstream step outputs
    /// via `${step:<id>}` placeholders — Executor resolves them before
    /// invoking the agent.
    pub prompt: String,
    /// Optional structured metadata (e.g. confidence thresholds for chair).
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepOutput {
    /// Short summary suitable for downstream HostSummarize input. Authored
    /// by the participant in their own voice. ≤ 500 chars by convention.
    pub summary: String,
    /// Full verbatim output — kept for audit / "let X re-elaborate" but
    /// never auto-injected into downstream prompts.
    pub full_output: String,
    pub tokens_used: TokenUsage,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input: u32,
    pub output: u32,
}

// ── Audit ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub collaboration_id: CollaborationId,
    pub timestamp: i64,
    pub actor: Actor,
    pub kind: AuditKind,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind", content = "id")]
pub enum Actor {
    System,
    User,
    Companion(CompanionId),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuditKind {
    /// Initial submission. Payload includes the full plan.
    Submitted,
    /// User confirmed (possibly with an edited plan). Payload includes the
    /// final plan as confirmed.
    Confirmed,
    Aborted,
    Failed,
    StepStarted,
    StepCompleted,
    StepFailed,
    StepSkipped,
    /// Mid-flow plan mutation: add / retry / skip step.
    StepAdded,
    StepRetried,
    /// `DispatchStrategy.judge` ran. Payload contains the input context summary
    /// and the resulting decision — replayable.
    DispatchJudged,
    /// User召回 a dispatched step during the 1.5s window.
    UserRecalled,
    /// User changed the plan before / during execution.
    UserCorrected,
    /// User reacted to the final verdict (accept / reject / re-elaborate).
    UserVerdictReaction,
}

// ── Dispatch ──────────────────────────────────────────────────────────

/// Context passed to a `DispatchStrategy::judge` call.
///
/// Strategies see the current user intent plus the family roster plus
/// recent corrections — but **not** any companion's MemMe content; the
/// dispatch judgment is fast and uses only the structured signal, not
/// the persistent memory layer.
#[derive(Debug, Clone)]
pub struct DispatchContext {
    pub user_intent: String,
    pub chat_history: Vec<ChatTurnSummary>,
    pub family: Vec<CompanionProfile>,
    pub recent_corrections: Vec<learning::LearningSignal>,
}

#[derive(Debug, Clone)]
pub struct ChatTurnSummary {
    pub role: String,
    pub text: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone)]
pub struct CompanionProfile {
    pub id: CompanionId,
    pub name: String,
    pub agent_definition_name: String,
    pub avatar_emoji: String,
    pub color_hex: String,
    /// One-line role description (e.g. "代码评审员 — 找硬伤、找漏洞").
    pub description: String,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct DispatchDecision {
    pub plan: CollaborationPlan,
    /// Human-readable explanation shown in the dispatch bubble.
    pub reason: String,
    /// 0.0–1.0. Strategy decides what threshold matters. Below 0.5 the
    /// orchestrator falls back to `Self`-mode (主小精灵 directly answers).
    pub confidence: f64,
}

// ── Mutations ─────────────────────────────────────────────────────────

/// Argument for `collaboration_mutate`. Lets the协作 evolve at runtime —
/// adding a juror, retrying a failed step, or skipping a stuck one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Mutation {
    AddStep { step: Step },
    RetryStep { step_id: StepId },
    SkipStep { step_id: StepId },
    ChangeParticipant { step_id: StepId, participant: Participant },
}

// ── Events ────────────────────────────────────────────────────────────

/// Real-time event for a single协作. Emitted by `AuditTrail.emit` and
/// streamed to the front-end via `Orchestrator::watch`. The discriminator
/// mirrors `AuditKind` but the payload is typed for stream consumers
/// instead of opaque JSON.
///
/// Token chunks are a separate variant because they fire 10–100×/sec and
/// don't need the full audit ceremony.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum CollaborationEvent {
    /// Mirror of an `AuditEvent` write. Carries the full record so the
    /// front-end can render or replay without a second DB hit.
    Audit(AuditEvent),
    /// Streaming token for a step's participant. High-frequency, must not
    /// pass through the audit table.
    Token {
        collaboration_id: CollaborationId,
        step_id: StepId,
        companion_id: CompanionId,
        delta: String,
    },
}

// ── Orchestrator ──────────────────────────────────────────────────────

/// High-level协作 engine. Owns the state machine, persistence, and event
/// broadcast. Concrete implementations live in `orchestrator.rs`
/// (`SqliteOrchestrator`); tests use mock impls.
///
/// All协作 modes — single companion 召唤, jury, dispatch, plan DAG —
/// go through this trait. The mode is encoded in the plan, not the API.
#[async_trait::async_trait]
pub trait CollaborationOrchestrator: Send + Sync {
    /// Submit a new协作 for execution. Returns the assigned collaboration
    /// id. The orchestrator decides whether to transition to `Running`
    /// directly (Manual mode or pure SingleAgent plans) or to
    /// `AwaitingConfirm` (jury / plan modes requiring user拍板).
    async fn submit(
        &self,
        chat_session_id: String,
        intent: String,
        plan: CollaborationPlan,
        mode: CollaborationMode,
        parent_id: Option<CollaborationId>,
    ) -> Result<CollaborationId, String>;

    /// User拍板 a `AwaitingConfirm` collaboration. `edited_plan` allows the
    /// user to tweak before execution starts.
    async fn confirm(
        &self,
        id: CollaborationId,
        edited_plan: Option<CollaborationPlan>,
    ) -> Result<(), String>;

    /// User-initiated cancel. Sets status to `Aborted`, signals all in-flight
    /// steps to stop, and emits the matching audit event.
    async fn abort(&self, id: CollaborationId) -> Result<(), String>;

    /// Mutate an in-flight collaboration: add a step, retry, skip, swap a
    /// participant. Used for "再叫一个人加入" / "让 X 重做" UX.
    async fn mutate(&self, id: CollaborationId, mutation: Mutation) -> Result<(), String>;

    /// Subscribe to live events for one collaboration. Returns a broadcast
    /// receiver scoped to that id (the implementation filters out other
    /// collaborations).
    fn watch(&self, id: CollaborationId) -> broadcast::Receiver<CollaborationEvent>;

    /// Read the current persisted state (for UI hydration, replay).
    async fn get(&self, id: CollaborationId) -> Result<Option<Collaboration>, String>;
}

/// Type alias for the trait object commonly stored in AppState.
pub type OrchestratorHandle = Arc<dyn CollaborationOrchestrator>;

// ── Memory bucket resolution ──────────────────────────────────────────

/// MemMe user_id reserved for cross-companion family context. All
/// companions whose `memory_scope` is `Family` read/write here.
pub const FAMILY_SHARED_USER_ID: &str = "family_shared";

/// Resolve which MemMe bucket a step's participant should use.
///
/// `Private` → companion's own isolated bucket.
/// `Shared` → main user bucket (`DEFAULT_MEMME_USER_ID`). Used by the host
/// in a jury (the host represents the user's perspective when summarising).
/// `Family` → `FAMILY_SHARED_USER_ID`, visible to every companion.
pub fn resolve_memme_user_id(
    scope: crate::engine::agents::MemoryScope,
    companion_memory_user_id: &str,
) -> String {
    use crate::engine::agents::MemoryScope;
    match scope {
        MemoryScope::Private => companion_memory_user_id.to_string(),
        MemoryScope::Shared => crate::engine::tools::DEFAULT_MEMME_USER_ID.to_string(),
        MemoryScope::Family => FAMILY_SHARED_USER_ID.to_string(),
    }
}

#[cfg(test)]
mod resolve_memme_tests {
    use super::*;
    use crate::engine::agents::MemoryScope;

    #[test]
    fn private_returns_companion_specific_bucket() {
        let result = resolve_memme_user_id(MemoryScope::Private, "companion_42_ali");
        assert_eq!(result, "companion_42_ali");
    }

    #[test]
    fn shared_returns_default_user() {
        let result = resolve_memme_user_id(MemoryScope::Shared, "ignored");
        assert_eq!(result, crate::engine::tools::DEFAULT_MEMME_USER_ID);
    }

    #[test]
    fn family_returns_family_shared() {
        let result = resolve_memme_user_id(MemoryScope::Family, "ignored");
        assert_eq!(result, FAMILY_SHARED_USER_ID);
    }

    #[test]
    fn family_shared_constant_is_stable() {
        // Persisted MemMe data keyed by this string; never rename without a
        // migration.
        assert_eq!(FAMILY_SHARED_USER_ID, "family_shared");
    }
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collaboration_status_terminal_detection() {
        assert!(!CollaborationStatus::Planning.is_terminal());
        assert!(!CollaborationStatus::AwaitingConfirm.is_terminal());
        assert!(!CollaborationStatus::Running.is_terminal());
        assert!(CollaborationStatus::Done.is_terminal());
        assert!(CollaborationStatus::Aborted.is_terminal());
        assert!(CollaborationStatus::Failed("x".into()).is_terminal());
    }

    #[test]
    fn collaboration_mode_serializes_with_kind_tag() {
        let m = CollaborationMode::Dispatched(42);
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["kind"], "dispatched");
        assert_eq!(json["by"], 42);

        let m2 = CollaborationMode::Manual;
        let json2 = serde_json::to_value(&m2).unwrap();
        assert_eq!(json2["kind"], "manual");
    }

    #[test]
    fn step_kind_round_trips_snake_case() {
        for k in [
            StepKind::SingleAgent,
            StepKind::ParallelAgents,
            StepKind::HostSummarize,
            StepKind::UserConfirmation,
        ] {
            let j = serde_json::to_value(&k).unwrap();
            let back: StepKind = serde_json::from_value(j).unwrap();
            assert_eq!(k, back);
        }
    }

    #[test]
    fn actor_serializes_with_id_payload() {
        let a = Actor::Companion(7);
        let j = serde_json::to_value(&a).unwrap();
        assert_eq!(j["kind"], "companion");
        assert_eq!(j["id"], 7);

        let a2 = Actor::System;
        let j2 = serde_json::to_value(&a2).unwrap();
        assert_eq!(j2["kind"], "system");
    }

    #[test]
    fn mutation_round_trips() {
        let m = Mutation::RetryStep { step_id: 5 };
        let j = serde_json::to_string(&m).unwrap();
        let back: Mutation = serde_json::from_str(&j).unwrap();
        assert!(matches!(back, Mutation::RetryStep { step_id: 5 }));
    }
}
