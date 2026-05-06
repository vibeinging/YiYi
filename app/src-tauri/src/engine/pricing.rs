//! Cost estimation for DeepSeek V4 API usage.
//!
//! Pricing source: https://api-docs.deepseek.com/quick_start/pricing
//! V4 Pro is on a 75% promotional discount through 2026-05-31 15:59 UTC.
//!
//! DeepSeek's `usage` object exposes:
//!   * `prompt_cache_hit_tokens` — input tokens served from the prefix cache (cheap)
//!   * `prompt_cache_miss_tokens` — input tokens that missed the cache (full price)
//!   * `prompt_tokens` (== input_tokens here) — total prompt tokens (hit + miss)
//!   * `completion_tokens` (== output_tokens) — generated tokens (full price)
//!
//! The 120× cache hit/miss price gap on V4 Pro makes prefix-cache awareness
//! critical for accurate cost reporting.

use chrono::{DateTime, TimeZone, Utc};

use crate::engine::usage::TokenUsage;

/// Per-million-token pricing for a model.
#[derive(Debug, Clone, Copy)]
pub struct ModelPricing {
    pub input_cache_hit_per_million: f64,
    pub input_cache_miss_per_million: f64,
    pub output_per_million: f64,
}

/// 75% promotional discount on V4 Pro ends at this UTC instant. After this,
/// Pro pricing reverts to standard rates.
fn v4_pro_discount_ends_at() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 5, 31, 15, 59, 0)
        .single()
        .expect("valid DeepSeek V4 Pro discount end timestamp")
}

/// Look up pricing for a model name (case-insensitive substring match).
pub fn pricing_for_model(model: &str) -> Option<ModelPricing> {
    pricing_for_model_at(model, Utc::now())
}

fn pricing_for_model_at(model: &str, now: DateTime<Utc>) -> Option<ModelPricing> {
    let lower = model.to_lowercase();
    if !lower.contains("deepseek") {
        return None;
    }
    if lower.contains("v4-pro") || lower.contains("v4pro") {
        if now <= v4_pro_discount_ends_at() {
            // 75% off through 2026-05-31 15:59 UTC.
            return Some(ModelPricing {
                input_cache_hit_per_million: 0.003625,
                input_cache_miss_per_million: 0.435,
                output_per_million: 0.87,
            });
        }
        Some(ModelPricing {
            input_cache_hit_per_million: 0.0145,
            input_cache_miss_per_million: 1.74,
            output_per_million: 3.48,
        })
    } else {
        // deepseek-v4-flash (default for any deepseek-v4-* / legacy ID).
        Some(ModelPricing {
            input_cache_hit_per_million: 0.0028,
            input_cache_miss_per_million: 0.14,
            output_per_million: 0.28,
        })
    }
}

/// Calculate cost from a `TokenUsage`, honoring prefix-cache fields when present.
///
/// Logic:
///   * `hit_tokens` is taken from `usage.prompt_cache_hit_tokens` (0 if absent)
///   * `miss_tokens` is `usage.prompt_cache_miss_tokens`, falling back to
///     `input_tokens - hit_tokens` when miss is not reported
///   * Any input_tokens not accounted for by hit + miss is added to miss
///     (defensive — keeps the total honest for providers that under-report)
pub fn calculate_turn_cost_from_usage(model: &str, usage: &TokenUsage) -> Option<f64> {
    let pricing = pricing_for_model(model)?;
    let hit = usage.prompt_cache_hit_tokens;
    let miss = if usage.prompt_cache_miss_tokens > 0 {
        usage.prompt_cache_miss_tokens
    } else {
        usage.input_tokens.saturating_sub(hit)
    };
    let accounted = hit.saturating_add(miss);
    let extra = usage.input_tokens.saturating_sub(accounted);

    let hit_cost = (hit as f64 / 1_000_000.0) * pricing.input_cache_hit_per_million;
    let miss_cost = ((miss.saturating_add(extra)) as f64 / 1_000_000.0) * pricing.input_cache_miss_per_million;
    let output_cost = (usage.output_tokens as f64 / 1_000_000.0) * pricing.output_per_million;

    Some(hit_cost + miss_cost + output_cost)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flash_pricing_known() {
        let p = pricing_for_model("deepseek-v4-flash").unwrap();
        assert!((p.output_per_million - 0.28).abs() < 1e-9);
    }

    #[test]
    fn pro_discount_active_today() {
        // The discount runs into mid-2026. Until 2026-05-31 the discounted
        // rate must apply. Use a fixed point well within the window.
        let inside_window = Utc.with_ymd_and_hms(2026, 4, 1, 0, 0, 0).unwrap();
        let p = pricing_for_model_at("deepseek-v4-pro", inside_window).unwrap();
        assert!((p.output_per_million - 0.87).abs() < 1e-9);
    }

    #[test]
    fn pro_full_price_after_window() {
        let after = Utc.with_ymd_and_hms(2026, 7, 1, 0, 0, 0).unwrap();
        let p = pricing_for_model_at("deepseek-v4-pro", after).unwrap();
        assert!((p.output_per_million - 3.48).abs() < 1e-9);
    }

    #[test]
    fn cost_uses_hit_and_miss() {
        let usage = TokenUsage {
            input_tokens: 1_000_000,
            output_tokens: 0,
            prompt_cache_hit_tokens: 800_000,
            prompt_cache_miss_tokens: 200_000,
        };
        let inside = Utc.with_ymd_and_hms(2026, 4, 1, 0, 0, 0).unwrap();
        let p = pricing_for_model_at("deepseek-v4-pro", inside).unwrap();
        let expected = 0.8 * p.input_cache_hit_per_million + 0.2 * p.input_cache_miss_per_million;
        let got = calculate_turn_cost_from_usage("deepseek-v4-pro", &usage).unwrap();
        assert!((got - expected).abs() < 1e-9, "got {got} expected {expected}");
    }

    #[test]
    fn non_deepseek_returns_none() {
        assert!(pricing_for_model("gpt-5").is_none());
    }
}
