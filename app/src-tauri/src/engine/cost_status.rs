//! Process-wide cost accrual side-channel.
//!
//! Ported from DeepSeek-TUI (`crates/tui/src/cost_status.rs`).
//!
//! Why a side-channel?
//! Background LLM calls (meditation / growth / heartbeat / compaction /
//! subagent / buddy) don't go through the user-facing ReAct streaming loop,
//! so the live "session cost" UI never saw them. SQLite aggregation catches
//! them eventually, but the user wants a live USD counter that ticks every
//! time *anything* spends tokens — including the silent stuff.
//!
//! Mechanism: every callsite that records usage also calls `report(model,
//! usage)`. We compute USD via `pricing::calculate_turn_cost_from_usage` and
//! accumulate into a process-global pool. The UI polls `drain_pending_cost`
//! once a second and adds the returned amount to its local "live cost" state.
//! Drain-and-reset semantics keep the math simple: each tick reflects new
//! spend since the last tick.

use std::sync::{Mutex, OnceLock};

use crate::engine::pricing;
use crate::engine::usage::TokenUsage;

fn pool() -> &'static Mutex<f64> {
    static PENDING: OnceLock<Mutex<f64>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(0.0))
}

/// Add this call's USD cost to the pending pool.
///
/// No-op when the model is unknown (returns `None` from pricing) or the cost
/// rounds to zero — keeps the counter honest and avoids polluting the pool
/// with non-DeepSeek models.
pub fn report(model: &str, usage: &TokenUsage) {
    let cost = match pricing::calculate_turn_cost_from_usage(model, usage) {
        Some(c) if c > 0.0 => c,
        _ => return,
    };
    if let Ok(mut g) = pool().lock() {
        *g += cost;
    }
}

/// Drain the pool: return accumulated USD and reset to zero.
///
/// Always returns 0.0 if the mutex is poisoned (which shouldn't happen — no
/// panics inside the critical section — but better than panicking the UI tick).
pub fn drain() -> f64 {
    match pool().lock() {
        Ok(mut g) => {
            let v = *g;
            *g = 0.0;
            v
        }
        Err(_) => 0.0,
    }
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;
    use serial_test::serial;

    fn reset() {
        let _ = drain();
    }

    #[test]
    #[serial]
    fn report_then_drain_returns_cost() {
        reset();
        let usage = TokenUsage {
            input_tokens: 1_000_000,
            output_tokens: 0,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 1_000_000,
        };
        report("deepseek-v4-flash", &usage);
        let v = drain();
        assert!(v > 0.0, "expected positive cost, got {v}");
        // Drained — second drain is zero.
        assert_eq!(drain(), 0.0);
    }

    #[test]
    #[serial]
    fn multiple_reports_accumulate() {
        reset();
        let usage = TokenUsage {
            input_tokens: 100_000,
            output_tokens: 0,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 100_000,
        };
        report("deepseek-v4-flash", &usage);
        report("deepseek-v4-flash", &usage);
        report("deepseek-v4-flash", &usage);
        let total = drain();
        // Three identical reports → 3× single-report cost.
        let single = pricing::calculate_turn_cost_from_usage("deepseek-v4-flash", &usage).unwrap();
        assert!((total - 3.0 * single).abs() < 1e-12, "got {total}, want {}", 3.0 * single);
    }

    #[test]
    #[serial]
    fn unknown_model_is_noop() {
        reset();
        let usage = TokenUsage {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            ..Default::default()
        };
        report("gpt-5", &usage);
        report("claude-opus-9", &usage);
        assert_eq!(drain(), 0.0);
    }

    #[test]
    #[serial]
    fn zero_usage_is_noop() {
        reset();
        report("deepseek-v4-flash", &TokenUsage::default());
        assert_eq!(drain(), 0.0);
    }
}
