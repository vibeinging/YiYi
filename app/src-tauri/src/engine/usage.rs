//! Token usage tracking and cost estimation.
//!
//! Tracks per-turn and cumulative token usage across a conversation session.
//! Supports cost estimation for Anthropic Claude models.

use serde::{Deserialize, Serialize};

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
}

impl std::ops::AddAssign for TokenUsage {
    fn add_assign(&mut self, rhs: Self) {
        self.input_tokens += rhs.input_tokens;
        self.output_tokens += rhs.output_tokens;
        self.cache_creation_input_tokens += rhs.cache_creation_input_tokens;
        self.cache_read_input_tokens += rhs.cache_read_input_tokens;
    }
}

/// Tracks cumulative usage across turns.
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
    } else {
        None
    }
}
