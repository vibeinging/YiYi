//! Token usage tracking and cost estimation.
//!
//! Two layers:
//!   (1) `UsageTracker` — in-memory per-session accumulator used by the
//!       streaming ReAct loop to show "you used X tokens this turn".
//!   (2) `record_llm_usage()` — fire-and-forget write to SQLite
//!       `llm_usage_log` table, tagged by `UsageSource`, so we can finally
//!       answer "where did this month's bill actually go?".
//!
//! Before this split, UsageTracker only covered the main ReAct loop and
//! silently dropped every token spent in meditation / growth reflection /
//! compaction / subagent spawning (see the cost jury report: account was
//! 30-50% off). Call sites that spend tokens outside the main loop now
//! call `record_llm_usage(source, usage, model)` directly.

use serde::{Deserialize, Serialize};

/// Which part of YiYi's pipeline spent these tokens.
///
/// Used both for routing (future: route Meditation → cheap tier) and for
/// accounting (SQLite log + BuddyPanel cost breakdown).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageSource {
    /// The user-facing ReAct chat loop.
    Main,
    /// Dream/reflection engine (`engine/mem/meditation.rs`).
    Meditation,
    /// Context-overflow summarization (`engine/react_agent/compaction.rs`).
    Compaction,
    /// Sub-agent spawned by `spawn_agents` tool.
    Subagent,
    /// Growth reflection / skill extraction (`engine/react_agent/growth.rs`).
    Growth,
    /// Background heartbeat (`engine/heartbeat.rs`).
    Heartbeat,
    /// Buddy digital-twin agent (`engine/buddy_delegate.rs`).
    BuddyDelegate,
    /// Quick "test connection" ping from Settings UI.
    TestConnection,
    /// Evals harness (`tests/evals_runner.rs`).
    Eval,
    /// Anything else — caller didn't specify.
    Other,
}

impl UsageSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            UsageSource::Main => "main",
            UsageSource::Meditation => "meditation",
            UsageSource::Compaction => "compaction",
            UsageSource::Subagent => "subagent",
            UsageSource::Growth => "growth",
            UsageSource::Heartbeat => "heartbeat",
            UsageSource::BuddyDelegate => "buddy_delegate",
            UsageSource::TestConnection => "test_connection",
            UsageSource::Eval => "eval",
            UsageSource::Other => "other",
        }
    }
}

/// Token usage from a single API call.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    #[serde(default)]
    pub cache_creation_input_tokens: u32,
    #[serde(default)]
    pub cache_read_input_tokens: u32,
}

impl TokenUsage {
    #[allow(dead_code)]
    pub fn total_tokens(&self) -> u32 {
        self.input_tokens + self.output_tokens
    }

    /// True if there's anything worth recording (any non-zero field).
    pub fn is_any(&self) -> bool {
        self.input_tokens
            + self.output_tokens
            + self.cache_creation_input_tokens
            + self.cache_read_input_tokens
            > 0
    }
}

impl std::ops::AddAssign for TokenUsage {
    fn add_assign(&mut self, rhs: Self) {
        self.input_tokens += rhs.input_tokens;
        self.output_tokens += rhs.output_tokens;
        self.cache_creation_input_tokens += rhs.cache_creation_input_tokens;
        self.cache_read_input_tokens += rhs.cache_read_input_tokens;
    }
}

/// Tracks cumulative usage across turns in-memory (per ReAct-loop session).
pub struct UsageTracker {
    latest_turn: TokenUsage,
    cumulative: TokenUsage,
    turns: u32,
}

impl UsageTracker {
    pub fn new() -> Self {
        Self {
            latest_turn: TokenUsage::default(),
            cumulative: TokenUsage::default(),
            turns: 0,
        }
    }

    pub fn record(&mut self, usage: TokenUsage) {
        self.latest_turn = usage;
        self.cumulative += usage;
        self.turns += 1;
    }

    #[allow(dead_code)]
    pub fn current_turn_usage(&self) -> TokenUsage { self.latest_turn }
    pub fn cumulative_usage(&self) -> TokenUsage { self.cumulative }
    #[allow(dead_code)]
    pub fn turns(&self) -> u32 { self.turns }
}

// ─────────────────────────────────────────────────────────────────────────
// Persistent per-call log (SQLite)
// ─────────────────────────────────────────────────────────────────────────

/// Log one LLM call's usage to the SQLite `llm_usage_log` table.
///
/// Fire-and-forget: failures are logged but never propagate to the caller —
/// accounting must not break the primary flow. Safe to call from anywhere,
/// including background tasks.
pub fn record_llm_usage(source: UsageSource, usage: TokenUsage, model: &str) {
    if !usage.is_any() {
        return; // Skip zero-token calls (errors, empty streams)
    }

    let db = match crate::engine::tools::get_database() {
        Some(d) => d,
        None => {
            log::debug!("record_llm_usage: no DB yet, dropping usage for {}", source.as_str());
            return;
        }
    };

    // Background calls (meditation/compaction/growth/etc) don't carry a
    // session id — pass the source as the session identifier so they still
    // aggregate into the right bucket for the pie chart.
    let session_placeholder = format!("_{}", source.as_str());
    let cost = estimate_cost(&usage, model).unwrap_or(0.0);
    db.record_usage_with_source(
        &session_placeholder,
        source.as_str(),
        model,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_input_tokens,
        usage.cache_creation_input_tokens,
        cost,
    );
}

/// Aggregate usage totals for the current calendar month, grouped by source.
/// Used by the BuddyPanel cost breakdown pie chart.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageAggregateRow {
    pub source: String,
    pub calls: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub estimated_usd: f64,
}

// ─────────────────────────────────────────────────────────────────────────
// Pricing
// ─────────────────────────────────────────────────────────────────────────

/// Model pricing (USD per million tokens).
#[derive(Debug, Clone, Copy)]
pub struct ModelPricing {
    pub input_cost_per_million: f64,
    pub output_cost_per_million: f64,
    pub cache_creation_cost_per_million: f64,
    pub cache_read_cost_per_million: f64,
}

/// Estimate cost for a given model name.
pub fn estimate_cost(usage: &TokenUsage, model: &str) -> Option<f64> {
    let pricing = pricing_for_model(model)?;
    let cost = cost_for_tokens(usage.input_tokens, pricing.input_cost_per_million)
        + cost_for_tokens(usage.output_tokens, pricing.output_cost_per_million)
        + cost_for_tokens(usage.cache_creation_input_tokens, pricing.cache_creation_cost_per_million)
        + cost_for_tokens(usage.cache_read_input_tokens, pricing.cache_read_cost_per_million);
    Some(cost)
}

fn cost_for_tokens(tokens: u32, usd_per_million: f64) -> f64 {
    (tokens as f64 / 1_000_000.0) * usd_per_million
}

fn pricing_for_model(model: &str) -> Option<ModelPricing> {
    let m = model.to_lowercase();
    if m.contains("haiku") {
        Some(ModelPricing {
            input_cost_per_million: 1.0,
            output_cost_per_million: 5.0,
            cache_creation_cost_per_million: 1.25,
            cache_read_cost_per_million: 0.1,
        })
    } else if m.contains("opus") {
        Some(ModelPricing {
            input_cost_per_million: 15.0,
            output_cost_per_million: 75.0,
            cache_creation_cost_per_million: 18.75,
            cache_read_cost_per_million: 1.5,
        })
    } else if m.contains("sonnet") || m.contains("claude") {
        Some(ModelPricing {
            input_cost_per_million: 3.0,
            output_cost_per_million: 15.0,
            cache_creation_cost_per_million: 3.75,
            cache_read_cost_per_million: 0.3,
        })
    } else if m.contains("qwen-turbo") {
        // ¥0.003/1k in, ¥0.006/1k out → ~USD 0.4/1M in, 0.85/1M out @ 7 CNY/USD
        Some(ModelPricing {
            input_cost_per_million: 0.42,
            output_cost_per_million: 0.85,
            cache_creation_cost_per_million: 0.42,
            cache_read_cost_per_million: 0.04,
        })
    } else if m.contains("qwen-plus") {
        Some(ModelPricing {
            input_cost_per_million: 1.15,
            output_cost_per_million: 3.42,
            cache_creation_cost_per_million: 1.15,
            cache_read_cost_per_million: 0.11,
        })
    } else if m.contains("qwen-max") || m.contains("qwen") {
        Some(ModelPricing {
            input_cost_per_million: 2.85,
            output_cost_per_million: 8.57,
            cache_creation_cost_per_million: 2.85,
            cache_read_cost_per_million: 0.28,
        })
    } else if m.contains("gpt-5-mini") || m.contains("gpt-4.1-mini") || m.contains("gpt-4o-mini") {
        Some(ModelPricing {
            input_cost_per_million: 0.25,
            output_cost_per_million: 2.0,
            cache_creation_cost_per_million: 0.25,
            cache_read_cost_per_million: 0.025,
        })
    } else if m.contains("gpt-5") || m.contains("gpt-4") {
        Some(ModelPricing {
            input_cost_per_million: 5.0,
            output_cost_per_million: 15.0,
            cache_creation_cost_per_million: 5.0,
            cache_read_cost_per_million: 0.5,
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_strings_are_stable() {
        assert_eq!(UsageSource::Main.as_str(), "main");
        assert_eq!(UsageSource::Meditation.as_str(), "meditation");
        assert_eq!(UsageSource::Compaction.as_str(), "compaction");
        assert_eq!(UsageSource::Growth.as_str(), "growth");
    }

    #[test]
    fn is_any_zeroes_dont_record() {
        assert!(!TokenUsage::default().is_any());
        assert!(TokenUsage { input_tokens: 1, ..Default::default() }.is_any());
    }

    #[test]
    fn qwen_pricing_present() {
        assert!(estimate_cost(
            &TokenUsage { input_tokens: 1_000_000, output_tokens: 0, ..Default::default() },
            "qwen-turbo"
        ).is_some());
    }
}
