mod compaction;
mod core;
mod growth;
mod prompt;
pub mod verification;

// Re-export all public items to maintain the same external API.
pub use core::{run_react, run_react_with_options, run_react_with_options_persist, run_react_with_options_stream};
pub use growth::{
    build_capability_profile, build_growth_timeline, consolidate_corrections_to_principles,
    detect_skill_opportunity, generate_growth_report,
    generate_morning_reflection, improve_skill_from_experience, learn_from_feedback,
    reflect_on_task, should_reflect_silent, update_user_model, SILENT_REFLECT_SAMPLE_EVERY,
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
    /// Context overflow detected — UI should reset streamed content before retry.
    ContextOverflowRetry,
    /// Cumulative token usage for this agent run.
    Usage {
        input_tokens: u32,
        output_tokens: u32,
        cache_read_tokens: u32,
        estimated_cost_usd: Option<f64>,
    },
    Complete,
    Error,
}

// ---------------------------------------------------------------------------
// Sub-Agent context isolation (inspired by Claude Code's createSubagentContext)
// ---------------------------------------------------------------------------

/// Tool access policy for sub-agents. Controls which tools a sub-agent can use.
#[derive(Debug, Clone)]
pub enum ToolFilter {
    /// All tools allowed (default for general-purpose agents).
    All,
    /// Only the named tools are allowed (whitelist).
    Allow(Vec<String>),
    /// All tools except the named ones (blacklist — for read-only agents, etc.).
    Deny(Vec<String>),
}

impl ToolFilter {
    /// Read-only preset: deny all write/destructive tools.
    pub fn read_only() -> Self {
        ToolFilter::Deny(vec![
            "edit_file".into(), "write_file".into(), "delete_file".into(),
            "create_directory".into(), "execute_shell".into(),
            "run_python".into(), "run_python_script".into(),
            "manage_cronjob".into(), "manage_skill".into(),
            "manage_bot".into(), "send_bot_message".into(),
            "create_task".into(), "pip_install".into(),
        ])
    }

    /// Check if a specific tool is allowed by this filter.
    pub fn is_allowed(&self, tool_name: &str) -> bool {
        match self {
            ToolFilter::All => true,
            ToolFilter::Allow(names) => names.iter().any(|n| n == tool_name),
            ToolFilter::Deny(names) => !names.iter().any(|n| n == tool_name),
        }
    }

    /// Apply filter to a tool list, returning only the allowed tools.
    pub fn apply(&self, tools: &[crate::engine::tools::ToolDefinition]) -> Vec<crate::engine::tools::ToolDefinition> {
        match self {
            ToolFilter::All => tools.to_vec(),
            ToolFilter::Allow(names) => tools.iter()
                .filter(|t| names.iter().any(|n| n == &t.function.name))
                .cloned().collect(),
            ToolFilter::Deny(names) => tools.iter()
                .filter(|t| !names.iter().any(|n| n == &t.function.name))
                .cloned().collect(),
        }
    }
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

/// Bootstrap completed flag file.
pub(crate) const BOOTSTRAP_COMPLETED: &str = ".bootstrap_completed";
