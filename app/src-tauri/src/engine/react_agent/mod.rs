mod compaction;
mod core;
mod growth;
mod prompt;

// Re-export all public items to maintain the same external API.
pub use core::{run_react, run_react_with_options, run_react_with_options_persist, run_react_with_options_stream};
pub use growth::{
    build_capability_profile, build_growth_timeline, consolidate_corrections_to_principles,
    detect_skill_opportunity, extract_memories_from_conversation, generate_growth_report,
    generate_morning_reflection, learn_from_feedback, reflect_on_task, CapabilityDimension,
    GrowthMilestone, GrowthReport,
};
pub use prompt::{build_system_prompt, seed_default_templates};

// ---------------------------------------------------------------------------
// Shared types used across sub-modules
// ---------------------------------------------------------------------------

use std::sync::Arc;

/// Events emitted for persisting tool calls to the database.
#[derive(Debug, Clone)]
pub enum ToolPersistEvent {
    /// Assistant message that contains tool_calls
    AssistantWithToolCalls {
        content: String,
        tool_calls_json: String, // serialized [{id, name, arguments}]
    },
    /// Tool result message
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        result_content: String, // truncated
    },
}

pub type PersistToolFn = Arc<dyn Fn(ToolPersistEvent) + Send + Sync>;

/// Classification of growth signals for confidence scoring.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SignalType {
    ExplicitCorrection,   // User said "wrong/不对" → confidence 0.90
    ExplicitPraise,       // User said "perfect/完美" → confidence 0.85
    ToolError,            // Tool returned error → confidence 0.70
    MaxIterations,        // Hit iteration limit → confidence 0.65
    AgentError,           // Agent execution error → confidence 0.70
    SilentCompletion,     // No explicit feedback → confidence 0.35
}

impl SignalType {
    pub fn base_confidence(&self) -> f64 {
        match self {
            Self::ExplicitCorrection => 0.90,
            Self::ExplicitPraise => 0.85,
            Self::ToolError => 0.70,
            Self::MaxIterations => 0.65,
            Self::AgentError => 0.70,
            Self::SilentCompletion => 0.35,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ExplicitCorrection => "explicit_correction",
            Self::ExplicitPraise => "explicit_praise",
            Self::ToolError => "tool_error",
            Self::MaxIterations => "max_iterations",
            Self::AgentError => "agent_error",
            Self::SilentCompletion => "silent_completion",
        }
    }
}

#[derive(Debug, Clone)]
pub enum AgentStreamEvent {
    Token(String),
    Thinking(String),
    ToolStart { name: String, args_preview: String },
    ToolEnd { name: String, result_preview: String },
    Complete,
    Error,
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

pub(crate) const DEFAULT_MAX_ITERATIONS: usize = 200;
/// Token threshold to trigger context compaction.
pub(crate) const COMPACT_THRESHOLD: usize = 80_000;

/// Semaphore to limit concurrent background LLM calls (reflections, feedback learning).
/// Prevents API rate limit exhaustion when many tasks complete simultaneously.
pub(crate) static GROWTH_LLM_SEMAPHORE: std::sync::LazyLock<tokio::sync::Semaphore> =
    std::sync::LazyLock::new(|| tokio::sync::Semaphore::new(3));

/// Compact summary file name within working_dir.
pub(crate) const COMPACT_SUMMARY_FILE: &str = ".compact_summary.txt";

/// Bootstrap completed flag file.
pub(crate) const BOOTSTRAP_COMPLETED: &str = ".bootstrap_completed";
