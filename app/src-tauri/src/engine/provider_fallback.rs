//! API provider fallback — automatically switches to a backup provider when
//! the primary one fails with retryable error codes (429, 500, 503, etc.).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ── Configuration ─────────────────────────────────────────────────────

/// Top-level fallback configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderFallbackConfig {
    /// Ordered list of fallback providers (first = highest priority).
    pub fallback_providers: Vec<FallbackEntry>,
    /// How many consecutive failures on a single provider before we move on.
    pub max_retries_before_fallback: u32,
    /// HTTP status codes that trigger a fallback (e.g. 429, 500, 503).
    pub error_codes_to_fallback: Vec<u32>,
}

impl Default for ProviderFallbackConfig {
    fn default() -> Self {
        Self {
            fallback_providers: Vec::new(),
            max_retries_before_fallback: 3,
            error_codes_to_fallback: vec![429, 500, 502, 503, 529],
        }
    }
}

/// A single fallback provider entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FallbackEntry {
    pub provider_id: String,
    pub model: String,
    pub priority: u32,
}

// ── Manager ───────────────────────────────────────────────────────────

/// Tracks provider health and decides when to fall back.
#[derive(Debug)]
pub struct ProviderFallbackManager {
    config: ProviderFallbackConfig,
    /// Index into the sorted provider list pointing to the active provider.
    current_index: usize,
    /// Per-provider consecutive failure count.
    consecutive_failures: HashMap<String, u32>,
}

impl ProviderFallbackManager {
    /// Create a new manager. Providers are sorted by ascending priority so
    /// the lowest-numbered priority is tried first.
    #[must_use]
    pub fn new(mut config: ProviderFallbackConfig) -> Self {
        config.fallback_providers.sort_by_key(|e| e.priority);
        Self {
            config,
            current_index: 0,
            consecutive_failures: HashMap::new(),
        }
    }

    /// Returns `true` when the given error justifies moving to the next
    /// provider — either because the status code is in the fallback set, or
    /// the provider has exceeded `max_retries_before_fallback`.
    #[must_use]
    pub fn should_fallback(&self, error_code: Option<u32>, provider_id: &str) -> bool {
        // Status-code match
        if let Some(code) = error_code {
            if self.config.error_codes_to_fallback.contains(&code) {
                return true;
            }
        }
        // Consecutive-failure threshold
        let count = self.consecutive_failures.get(provider_id).copied().unwrap_or(0);
        count >= self.config.max_retries_before_fallback
    }

    /// Advance to the next provider in priority order.
    /// Returns `None` when all providers have been exhausted.
    pub fn next_provider(&mut self) -> Option<&FallbackEntry> {
        let next = self.current_index + 1;
        if next >= self.config.fallback_providers.len() {
            return None;
        }
        self.current_index = next;
        log::info!(
            "Falling back to provider: {} (model: {})",
            self.config.fallback_providers[next].provider_id,
            self.config.fallback_providers[next].model,
        );
        Some(&self.config.fallback_providers[self.current_index])
    }

    /// Record a successful call — resets the failure counter for that provider.
    pub fn record_success(&mut self, provider_id: &str) {
        self.consecutive_failures.remove(provider_id);
    }

    /// Record a failed call, optionally with an HTTP status code.
    pub fn record_failure(&mut self, provider_id: &str, error_code: Option<u32>) {
        let count = self.consecutive_failures.entry(provider_id.to_string()).or_insert(0);
        *count += 1;
        log::warn!(
            "Provider {} failure #{} (code: {:?})",
            provider_id,
            count,
            error_code,
        );
    }

    /// Reset all state — useful when starting a fresh conversation turn.
    pub fn reset(&mut self) {
        self.current_index = 0;
        self.consecutive_failures.clear();
    }

    /// The provider we should try right now, or `None` if the list is empty.
    #[must_use]
    pub fn current_provider(&self) -> Option<&FallbackEntry> {
        self.config.fallback_providers.get(self.current_index)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> ProviderFallbackConfig {
        ProviderFallbackConfig {
            fallback_providers: vec![
                FallbackEntry { provider_id: "primary".into(), model: "claude-sonnet".into(), priority: 1 },
                FallbackEntry { provider_id: "secondary".into(), model: "gpt-4o".into(), priority: 2 },
                FallbackEntry { provider_id: "tertiary".into(), model: "gemini-pro".into(), priority: 3 },
            ],
            max_retries_before_fallback: 2,
            error_codes_to_fallback: vec![429, 500, 503],
        }
    }

    #[test]
    fn starts_with_highest_priority() {
        let mgr = ProviderFallbackManager::new(sample_config());
        let current = mgr.current_provider().unwrap();
        assert_eq!(current.provider_id, "primary");
        assert_eq!(current.priority, 1);
    }

    #[test]
    fn should_fallback_on_matching_status_code() {
        let mgr = ProviderFallbackManager::new(sample_config());
        assert!(mgr.should_fallback(Some(429), "primary"));
        assert!(mgr.should_fallback(Some(503), "primary"));
        assert!(!mgr.should_fallback(Some(400), "primary"));
        assert!(!mgr.should_fallback(None, "primary"));
    }

    #[test]
    fn should_fallback_after_consecutive_failures() {
        let mut mgr = ProviderFallbackManager::new(sample_config());
        assert!(!mgr.should_fallback(None, "primary"));
        mgr.record_failure("primary", Some(400));
        assert!(!mgr.should_fallback(None, "primary"));
        mgr.record_failure("primary", Some(400));
        // Now at threshold (2)
        assert!(mgr.should_fallback(None, "primary"));
    }

    #[test]
    fn next_provider_advances_and_exhausts() {
        let mut mgr = ProviderFallbackManager::new(sample_config());
        assert_eq!(mgr.current_provider().unwrap().provider_id, "primary");

        let next = mgr.next_provider().unwrap();
        assert_eq!(next.provider_id, "secondary");

        let next = mgr.next_provider().unwrap();
        assert_eq!(next.provider_id, "tertiary");

        assert!(mgr.next_provider().is_none());
    }

    #[test]
    fn record_success_resets_failure_count() {
        let mut mgr = ProviderFallbackManager::new(sample_config());
        mgr.record_failure("primary", None);
        mgr.record_failure("primary", None);
        assert!(mgr.should_fallback(None, "primary"));
        mgr.record_success("primary");
        assert!(!mgr.should_fallback(None, "primary"));
    }

    #[test]
    fn reset_clears_all_state() {
        let mut mgr = ProviderFallbackManager::new(sample_config());
        mgr.record_failure("primary", None);
        mgr.next_provider();
        mgr.reset();
        assert_eq!(mgr.current_provider().unwrap().provider_id, "primary");
        assert!(!mgr.should_fallback(None, "primary"));
    }
}
