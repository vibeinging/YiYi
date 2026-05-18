//! Dispatch strategy — the brain that decides who in the family should
//! handle a given user intent. Pluggable so Phase 5 can introduce
//! hybrid / rule-based / user-customised strategies without touching the
//! orchestrator.

use super::{DispatchContext, DispatchDecision};

pub mod llm_strategy;

/// Decision policy for converting a user intent into a协作 plan.
///
/// Implementations should be deterministic given the same `ctx` so audit
/// trails are replayable. LLM-backed strategies record both the inputs
/// and the parsed decision into the audit log; callers don't have to.
#[async_trait::async_trait]
pub trait DispatchStrategy: Send + Sync {
    async fn judge(&self, ctx: &DispatchContext) -> Result<DispatchDecision, String>;
}
