use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
const DEFAULT_TTL_MS: i64 = 30_000;
const MAX_ENTRIES: usize = 100;

/// A single cached prompt response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    pub fingerprint: u64,
    pub response_text: String,
    pub created_at: i64,
    pub ttl_ms: i64,
    /// Tracks recency for LRU eviction (higher = more recent).
    last_accessed: u64,
}

impl CacheEntry {
    fn is_expired(&self, now_ms: i64) -> bool {
        now_ms - self.created_at > self.ttl_ms
    }
}

/// Aggregate cache statistics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

/// In-memory prompt cache with TTL expiration and LRU eviction.
#[derive(Debug)]
pub struct PromptCache {
    entries: HashMap<u64, CacheEntry>,
    stats: CacheStats,
    access_counter: u64,
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
        }
    }

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

    /// Store a response with the default TTL (30 seconds).
    pub fn put(&mut self, fingerprint: u64, response: String) {
        self.put_with_ttl(fingerprint, response, DEFAULT_TTL_MS);
    }

    /// Store a response with a custom TTL in milliseconds.
    pub fn put_with_ttl(&mut self, fingerprint: u64, response: String, ttl_ms: i64) {
        // Evict expired entries first.
        self.evict_expired();

        // If still at capacity, evict the least-recently-used entry.
        if self.entries.len() >= MAX_ENTRIES && !self.entries.contains_key(&fingerprint) {
            self.evict_lru();
        }

        self.access_counter += 1;
        let entry = CacheEntry {
            fingerprint,
            response_text: response,
            created_at: now_epoch_ms(),
            ttl_ms,
            last_accessed: self.access_counter,
        };
        self.entries.insert(fingerprint, entry);
    }

    /// Return current cache statistics.
    #[must_use]
    pub fn stats(&self) -> CacheStats {
        self.stats.clone()
    }

    /// Remove all expired entries.
    pub fn evict_expired(&mut self) {
        let now_ms = now_epoch_ms();
        let before = self.entries.len();
        self.entries.retain(|_, entry| !entry.is_expired(now_ms));
        let removed = before - self.entries.len();
        self.stats.evictions += removed as u64;
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
        cache.put_with_ttl(fp, "old".to_string(), 0); // TTL=0 → immediately expired
        assert_eq!(cache.get(fp), None);
        assert_eq!(cache.stats().evictions, 1);
    }

    #[test]
    fn lru_eviction_when_full() {
        let mut cache = PromptCache::new();
        // Fill to capacity.
        for i in 0..MAX_ENTRIES {
            cache.put(i as u64, format!("val-{i}"));
        }
        assert_eq!(cache.len(), MAX_ENTRIES);

        // Access entry 50 to make it recently used.
        let _ = cache.get(50);

        // Insert one more — should evict the LRU (entry 0, which was inserted first and not accessed).
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
}
