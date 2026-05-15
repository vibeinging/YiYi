//! V4-only build: auto-route between DeepSeek V4 Pro (orchestrator) and V4 Flash (worker).
//!
//! Design: the user doesn't pick a model. The engine decides based on the call site:
//!  * Main ReAct loop, sub-agents, eval, buddy delegate → Pro (heavy reasoning).
//!  * Compaction, meditation, growth reflections, heartbeat, test ping → Flash (cheap, fast).
//!
//! Only applies when the active provider is DeepSeek. Other providers (e.g. a future
//! custom OpenAI-compatible URL) keep whatever model is configured.

use super::types::LLMConfig;
use crate::engine::usage::UsageSource;

pub const PRO_MODEL: &str = "deepseek-v4-pro";
pub const FLASH_MODEL: &str = "deepseek-v4-flash";
pub const DEEPSEEK_PROVIDER_ID: &str = "deepseek";

/// Explicit routing hint — used by tools that want Flash regardless of call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteHint {
    /// Heavy reasoning, long context — pick Pro.
    Heavy,
    /// Quick/cheap sub-task — pick Flash.
    Light,
    /// Defer to call-site heuristic (UsageSource).
    Auto,
}

/// Map a `UsageSource` to a recommended model. Returns `None` to mean "don't override".
pub fn model_for_source(source: UsageSource) -> &'static str {
    match source {
        UsageSource::Main => PRO_MODEL,
        UsageSource::Subagent => PRO_MODEL,
        UsageSource::BuddyDelegate => PRO_MODEL,
        UsageSource::Eval => PRO_MODEL,
        UsageSource::Other => PRO_MODEL,
        UsageSource::Compaction => FLASH_MODEL,
        UsageSource::Meditation => FLASH_MODEL,
        UsageSource::Growth => FLASH_MODEL,
        UsageSource::Heartbeat => FLASH_MODEL,
        UsageSource::TestConnection => FLASH_MODEL,
        // Collaboration: jurors and dispatch judgment run cheap (persona work
        // doesn't need long-range planning, dispatch is a quick classifier);
        // host summarize needs strong reasoning over N verdict outputs.
        UsageSource::CollabWorker => FLASH_MODEL,
        UsageSource::CollabDispatch => FLASH_MODEL,
        UsageSource::CollabHost => PRO_MODEL,
    }
}

/// Mutate `config.model` to match the routing hint, but only when bound to DeepSeek.
/// For non-DeepSeek custom providers (if any in the future), leave the model alone.
pub fn apply_hint(config: &mut LLMConfig, hint: RouteHint) {
    if config.provider_id != DEEPSEEK_PROVIDER_ID {
        return;
    }
    config.model = match hint {
        RouteHint::Heavy => PRO_MODEL.to_string(),
        RouteHint::Light => FLASH_MODEL.to_string(),
        RouteHint::Auto => return, // Auto without source context = leave default (active_llm).
    };
}

/// Apply routing for a `UsageSource` to the config (DeepSeek only).
pub fn apply_source(config: &mut LLMConfig, source: UsageSource) {
    if config.provider_id != DEEPSEEK_PROVIDER_ID {
        return;
    }
    config.model = model_for_source(source).to_string();
}
