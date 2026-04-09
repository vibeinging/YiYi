//! Prompt cache with dual TTL, LRU eviction, cache-break detection, and
//! session persistence — inspired by Claw Code's prompt_cache design.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
const MAX_ENTRIES: usize = 100;

/// Default TTL for completion (short-lived) cache entries — 30 seconds.
const DEFAULT_COMPLETION_TTL_MS: i64 = 30_000;
/// Default TTL for prompt (long-lived) cache entries — 5 minutes.
const DEFAULT_PROMPT_TTL_MS: i64 = 5 * 60 * 1_000;
/// Minimum token drop to consider a cache break — 2 000 tokens.
const DEFAULT_BREAK_MIN_DROP: u32 = 2_000;

// ── Cache entry types ─────────────────────────────────────────────────

/// Which TTL tier this entry belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CacheType {
    /// Short-lived: API completion responses (default 30 s).
    Completion,
    /// Long-lived: prompt / system-prompt fragments (default 5 min).
    Prompt,
}

/// A single cached prompt response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    pub fingerprint: u64,
    pub response_text: String,
    pub created_at: i64,
    pub ttl_ms: i64,
    pub cache_type: CacheType,
    /// Tracks recency for LRU eviction (higher = more recent).
    last_accessed: u64,
}

impl CacheEntry {
    fn is_expired(&self, now_ms: i64) -> bool {
        // Use >= so that a TTL of 0 expires immediately.
        now_ms - self.created_at >= self.ttl_ms
    }
}

// ── Cache break detection ─────────────────────────────────────────────

/// Describes a detected cache break between two consecutive API calls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheBreakEvent {
    /// `true` when the break has no obvious explanation (fingerprint stable).
    pub unexpected: bool,
    /// Human-readable reason.
    pub reason: String,
    pub previous_cache_read_tokens: u32,
    pub current_cache_read_tokens: u32,
    pub token_drop: u32,
}

// ── Statistics ─────────────────────────────────────────────────────────

/// Aggregate cache statistics — persisted across sessions.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    /// Number of entries written (put / put_*).
    pub writes: u64,
    /// Cache breaks that have a known cause (model/prompt changed, TTL expired).
    pub expected_invalidations: u64,
    /// Cache breaks with no obvious explanation.
    pub unexpected_breaks: u64,
    /// Running total of cache-creation tokens reported by the API.
    pub total_cache_creation_tokens: u64,
    /// Running total of cache-read tokens reported by the API.
    pub total_cache_read_tokens: u64,
}

// ── Prompt cache ──────────────────────────────────────────────────────

/// In-memory prompt cache with dual TTL, LRU eviction, cache-break
/// detection, and optional session persistence.
#[derive(Debug)]
pub struct PromptCache {
    entries: HashMap<u64, CacheEntry>,
    stats: CacheStats,
    access_counter: u64,
    /// Completion-tier TTL in ms.
    completion_ttl_ms: i64,
    /// Prompt-tier TTL in ms.
    prompt_ttl_ms: i64,
    /// Minimum token-drop threshold to flag a cache break.
    break_min_drop: u32,
    /// Previous cache-read token count — used for break detection.
    previous_cache_read_tokens: Option<u32>,
    /// Previous fingerprint — used to classify expected vs. unexpected breaks.
    previous_fingerprint: Option<u64>,
}

impl Default for PromptCache {
    fn default() -> Self {
        Self::new()
    }
}

impl PromptCache {
    #[must_use]
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            stats: CacheStats::default(),
            access_counter: 0,
            completion_ttl_ms: DEFAULT_COMPLETION_TTL_MS,
            prompt_ttl_ms: DEFAULT_PROMPT_TTL_MS,
            break_min_drop: DEFAULT_BREAK_MIN_DROP,
            previous_cache_read_tokens: None,
            previous_fingerprint: None,
        }
    }

    /// Create a cache with custom TTLs.
    #[must_use]
    pub fn with_ttls(completion_ttl_ms: i64, prompt_ttl_ms: i64) -> Self {
        Self {
            completion_ttl_ms,
            prompt_ttl_ms,
            ..Self::new()
        }
    }

    // ── Fingerprinting ────────────────────────────────────────────────

    /// Compute an FNV-1a fingerprint from a system prompt and a messages summary.
    #[must_use]
    pub fn fingerprint(system_prompt: &str, messages_summary: &str) -> u64 {
        let mut hash = FNV_OFFSET_BASIS;
        for byte in system_prompt.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        // Separator to avoid collisions between prompt/summary boundaries.
        hash ^= 0xFF;
        hash = hash.wrapping_mul(FNV_PRIME);
        for byte in messages_summary.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        hash
    }

    // ── Lookup ────────────────────────────────────────────────────────

    /// Look up a cached response by fingerprint. Returns `None` if missing or expired.
    pub fn get(&mut self, fingerprint: u64) -> Option<&str> {
        let now_ms = now_epoch_ms();
        // Check expiration first (need to remove if expired).
        if let Some(entry) = self.entries.get(&fingerprint) {
            if entry.is_expired(now_ms) {
                self.entries.remove(&fingerprint);
                self.stats.evictions += 1;
                self.stats.misses += 1;
                return None;
            }
        } else {
            self.stats.misses += 1;
            return None;
        }

        // Entry exists and is valid — update access counter.
        self.access_counter += 1;
        let counter = self.access_counter;
        if let Some(entry) = self.entries.get_mut(&fingerprint) {
            entry.last_accessed = counter;
            self.stats.hits += 1;
            Some(&entry.response_text)
        } else {
            self.stats.misses += 1;
            None
        }
    }

    // ── Storage ───────────────────────────────────────────────────────

    /// Store a **completion** response (short TTL — 30 s by default).
    pub fn put(&mut self, fingerprint: u64, response: String) {
        self.put_typed(fingerprint, response, CacheType::Completion);
    }

    /// Store a **prompt** fragment (long TTL — 5 min by default).
    pub fn put_prompt(&mut self, fingerprint: u64, response: String) {
        self.put_typed(fingerprint, response, CacheType::Prompt);
    }

    /// Store a response with an explicit TTL in milliseconds.
    pub fn put_with_ttl(&mut self, fingerprint: u64, response: String, ttl_ms: i64) {
        self.insert_entry(fingerprint, response, ttl_ms, CacheType::Completion);
    }

    /// Internal: store with a cache-type-derived TTL.
    fn put_typed(&mut self, fingerprint: u64, response: String, cache_type: CacheType) {
        let ttl = match cache_type {
            CacheType::Completion => self.completion_ttl_ms,
            CacheType::Prompt => self.prompt_ttl_ms,
        };
        self.insert_entry(fingerprint, response, ttl, cache_type);
    }

    fn insert_entry(
        &mut self,
        fingerprint: u64,
        response: String,
        ttl_ms: i64,
        cache_type: CacheType,
    ) {
        self.evict_expired();

        if self.entries.len() >= MAX_ENTRIES && !self.entries.contains_key(&fingerprint) {
            self.evict_lru();
        }

        self.access_counter += 1;
        let entry = CacheEntry {
            fingerprint,
            response_text: response,
            created_at: now_epoch_ms(),
            ttl_ms,
            cache_type,
            last_accessed: self.access_counter,
        };
        self.entries.insert(fingerprint, entry);
        self.stats.writes += 1;
    }

    // ── Cache break detection ─────────────────────────────────────────

    /// Feed the token counts returned by the API after each call.
    /// Returns a `CacheBreakEvent` when a significant drop is detected.
    pub fn record_api_usage(
        &mut self,
        fingerprint: u64,
        cache_creation_tokens: u32,
        cache_read_tokens: u32,
    ) -> Option<CacheBreakEvent> {
        self.stats.total_cache_creation_tokens += u64::from(cache_creation_tokens);
        self.stats.total_cache_read_tokens += u64::from(cache_read_tokens);

        let event = self.detect_cache_break(fingerprint, cache_read_tokens);
        if let Some(ref evt) = event {
            if evt.unexpected {
                self.stats.unexpected_breaks += 1;
                log::warn!("Unexpected cache break: {} (drop: {} tokens)", evt.reason, evt.token_drop);
            } else {
                self.stats.expected_invalidations += 1;
                log::info!("Expected cache invalidation: {}", evt.reason);
            }
        }

        self.previous_cache_read_tokens = Some(cache_read_tokens);
        self.previous_fingerprint = Some(fingerprint);
        event
    }

    /// Compare current usage against the previous call and classify any break.
    fn detect_cache_break(
        &self,
        fingerprint: u64,
        cache_read_tokens: u32,
    ) -> Option<CacheBreakEvent> {
        let prev_tokens = self.previous_cache_read_tokens?;
        let token_drop = prev_tokens.saturating_sub(cache_read_tokens);

        if token_drop < self.break_min_drop {
            return None;
        }

        let fingerprint_changed = self
            .previous_fingerprint
            .map_or(true, |prev| prev != fingerprint);

        let (unexpected, reason) = if fingerprint_changed {
            (false, "prompt fingerprint changed (model/system/messages)".to_string())
        } else {
            (
                true,
                "cache read tokens dropped while prompt fingerprint remained stable".to_string(),
            )
        };

        Some(CacheBreakEvent {
            unexpected,
            reason,
            previous_cache_read_tokens: prev_tokens,
            current_cache_read_tokens: cache_read_tokens,
            token_drop,
        })
    }

    // ── Session persistence ───────────────────────────────────────────

    /// Persist current stats to a JSON file.
    pub fn save_stats(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec_pretty(&self.stats)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(path, json)
    }

    /// Load stats from a JSON file, merging into the current instance.
    /// Returns `Ok(true)` when stats were loaded, `Ok(false)` when the file
    /// didn't exist, and `Err` on I/O or parse failure.
    pub fn load_stats(&mut self, path: &Path) -> std::io::Result<bool> {
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e),
        };
        let loaded: CacheStats = serde_json::from_slice(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        self.stats = loaded;
        Ok(true)
    }

    // ── Accessors ─────────────────────────────────────────────────────

    /// Return current cache statistics.
    #[must_use]
    pub fn stats(&self) -> CacheStats {
        self.stats.clone()
    }

    /// Number of entries currently stored.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the cache is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    // ── Eviction ──────────────────────────────────────────────────────

    /// Remove all expired entries.
    pub fn evict_expired(&mut self) {
        let now_ms = now_epoch_ms();
        let before = self.entries.len();
        self.entries.retain(|_, entry| !entry.is_expired(now_ms));
        let removed = before - self.entries.len();
        self.stats.evictions += removed as u64;
    }

    /// Evict the least-recently-used entry.
    fn evict_lru(&mut self) {
        if let Some((&lru_key, _)) = self
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.last_accessed)
        {
            self.entries.remove(&lru_key);
            self.stats.evictions += 1;
        }
    }
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable() {
        let a = PromptCache::fingerprint("sys", "msg");
        let b = PromptCache::fingerprint("sys", "msg");
        assert_eq!(a, b);
    }

    #[test]
    fn fingerprint_differs_for_different_inputs() {
        let a = PromptCache::fingerprint("sys", "msg1");
        let b = PromptCache::fingerprint("sys", "msg2");
        assert_ne!(a, b);
    }

    #[test]
    fn put_and_get_round_trip() {
        let mut cache = PromptCache::new();
        let fp = PromptCache::fingerprint("hello", "world");
        cache.put(fp, "response".to_string());
        assert_eq!(cache.get(fp), Some("response"));
        assert_eq!(cache.stats().hits, 1);
        assert_eq!(cache.stats().writes, 1);
    }

    #[test]
    fn missing_key_counts_as_miss() {
        let mut cache = PromptCache::new();
        assert_eq!(cache.get(999), None);
        assert_eq!(cache.stats().misses, 1);
    }

    #[test]
    fn expired_entry_is_evicted_on_get() {
        let mut cache = PromptCache::new();
        let fp = PromptCache::fingerprint("a", "b");
        cache.put_with_ttl(fp, "old".to_string(), 0); // TTL=0 -> immediately expired
        assert_eq!(cache.get(fp), None);
        assert_eq!(cache.stats().evictions, 1);
    }

    #[test]
    fn lru_eviction_when_full() {
        let mut cache = PromptCache::new();
        for i in 0..MAX_ENTRIES {
            cache.put(i as u64, format!("val-{i}"));
        }
        assert_eq!(cache.len(), MAX_ENTRIES);

        // Access entry 50 to make it recently used.
        let _ = cache.get(50);

        // Insert one more — should evict the LRU.
        cache.put(MAX_ENTRIES as u64, "new".to_string());
        assert_eq!(cache.len(), MAX_ENTRIES);
        assert!(cache.stats().evictions >= 1);
    }

    #[test]
    fn evict_expired_removes_stale_entries() {
        let mut cache = PromptCache::new();
        cache.put_with_ttl(1, "a".to_string(), 0);
        cache.put_with_ttl(2, "b".to_string(), 0);
        cache.put(3, "c".to_string()); // default TTL, should survive
        cache.evict_expired();
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.stats().evictions, 2);
    }

    // ── Dual TTL tests ────────────────────────────────────────────────

    #[test]
    fn prompt_cache_type_gets_longer_ttl() {
        let mut cache = PromptCache::new();
        let fp = PromptCache::fingerprint("system", "msgs");
        cache.put_prompt(fp, "prompt-data".to_string());

        let entry = cache.entries.get(&fp).unwrap();
        assert_eq!(entry.cache_type, CacheType::Prompt);
        assert_eq!(entry.ttl_ms, DEFAULT_PROMPT_TTL_MS);
    }

    #[test]
    fn completion_cache_type_gets_shorter_ttl() {
        let mut cache = PromptCache::new();
        let fp = PromptCache::fingerprint("system", "msgs");
        cache.put(fp, "completion-data".to_string());

        let entry = cache.entries.get(&fp).unwrap();
        assert_eq!(entry.cache_type, CacheType::Completion);
        assert_eq!(entry.ttl_ms, DEFAULT_COMPLETION_TTL_MS);
    }

    #[test]
    fn custom_ttls_are_applied() {
        let mut cache = PromptCache::with_ttls(10_000, 120_000);
        let fp1 = 1u64;
        let fp2 = 2u64;
        cache.put(fp1, "c".to_string());
        cache.put_prompt(fp2, "p".to_string());
        assert_eq!(cache.entries.get(&fp1).unwrap().ttl_ms, 10_000);
        assert_eq!(cache.entries.get(&fp2).unwrap().ttl_ms, 120_000);
    }

    // ── Cache break detection tests ───────────────────────────────────

    #[test]
    fn detects_unexpected_cache_break() {
        let mut cache = PromptCache::new();
        let fp = PromptCache::fingerprint("sys", "msg");
        // First call: high read tokens.
        assert!(cache.record_api_usage(fp, 100, 6000).is_none());
        // Second call: same fingerprint, big drop.
        let event = cache.record_api_usage(fp, 200, 1000).unwrap();
        assert!(event.unexpected);
        assert_eq!(event.token_drop, 5000);
        assert_eq!(cache.stats().unexpected_breaks, 1);
    }

    #[test]
    fn expected_break_when_fingerprint_changes() {
        let mut cache = PromptCache::new();
        let fp1 = PromptCache::fingerprint("sys", "msg1");
        let fp2 = PromptCache::fingerprint("sys", "msg2");
        assert!(cache.record_api_usage(fp1, 100, 6000).is_none());
        let event = cache.record_api_usage(fp2, 200, 1000).unwrap();
        assert!(!event.unexpected);
        assert_eq!(cache.stats().expected_invalidations, 1);
    }

    #[test]
    fn no_break_when_drop_is_small() {
        let mut cache = PromptCache::new();
        let fp = PromptCache::fingerprint("sys", "msg");
        assert!(cache.record_api_usage(fp, 100, 6000).is_none());
        // Drop of only 500 — below threshold.
        assert!(cache.record_api_usage(fp, 200, 5500).is_none());
    }

    #[test]
    fn token_totals_are_accumulated() {
        let mut cache = PromptCache::new();
        let fp = PromptCache::fingerprint("sys", "msg");
        cache.record_api_usage(fp, 100, 200);
        cache.record_api_usage(fp, 50, 300);
        assert_eq!(cache.stats().total_cache_creation_tokens, 150);
        assert_eq!(cache.stats().total_cache_read_tokens, 500);
    }

    // ── Session persistence tests ─────────────────────────────────────

    #[test]
    fn save_and_load_stats_round_trip() {
        let temp = std::env::temp_dir().join(format!(
            "yiyi-prompt-cache-test-{}-{}.json",
            std::process::id(),
            now_epoch_ms(),
        ));

        let mut cache = PromptCache::new();
        cache.put(1, "a".to_string());
        let _ = cache.get(1);
        cache.record_api_usage(1, 100, 200);
        cache.save_stats(&temp).expect("save should succeed");

        let mut cache2 = PromptCache::new();
        let loaded = cache2.load_stats(&temp).expect("load should succeed");
        assert!(loaded);
        assert_eq!(cache2.stats().hits, 1);
        assert_eq!(cache2.stats().writes, 1);
        assert_eq!(cache2.stats().total_cache_creation_tokens, 100);

        let _ = fs::remove_file(&temp);
    }

    #[test]
    fn load_stats_returns_false_when_missing() {
        let mut cache = PromptCache::new();
        let ok = cache
            .load_stats(Path::new("/tmp/does-not-exist-yiyi-test.json"))
            .expect("should not error");
        assert!(!ok);
    }
}
