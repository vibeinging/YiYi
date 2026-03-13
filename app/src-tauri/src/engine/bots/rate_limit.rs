/// Token bucket rate limiter for API calls.
///
/// Each platform has its own bucket with configurable capacity and refill rate.
/// Before sending a message, callers should `acquire()` a token. If no token
/// is available, the call waits until one is refilled.
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Instant;

/// Configuration for a platform's rate limit bucket.
#[derive(Debug, Clone)]
pub struct BucketConfig {
    /// Maximum tokens in the bucket (burst capacity).
    pub capacity: u32,
    /// Tokens added per second (sustained rate).
    pub refill_rate: f64,
}

/// A token bucket instance.
struct TokenBucket {
    config: BucketConfig,
    tokens: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(config: BucketConfig) -> Self {
        let tokens = config.capacity as f64;
        Self {
            config,
            tokens,
            last_refill: Instant::now(),
        }
    }

    /// Refill tokens based on elapsed time since last refill.
    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.config.refill_rate)
            .min(self.config.capacity as f64);
        self.last_refill = now;
    }

    /// Try to consume one token. Returns true if successful.
    fn try_acquire(&mut self) -> bool {
        self.refill();
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Time in milliseconds until the next token is available.
    fn wait_time_ms(&mut self) -> u64 {
        self.refill();
        if self.tokens >= 1.0 {
            return 0;
        }
        let deficit = 1.0 - self.tokens;
        let wait_secs = deficit / self.config.refill_rate;
        (wait_secs * 1000.0).ceil() as u64
    }
}

lazy_static::lazy_static! {
    /// Global rate limiter registry: key = "{platform}:{bot_id}" or just "{platform}" for shared limits.
    static ref RATE_LIMITERS: RwLock<HashMap<String, TokenBucket>> = RwLock::new(HashMap::new());
}

/// Get the default rate limit configuration for a platform.
///
/// These defaults are based on each platform's documented API limits:
/// - Discord: 5 messages/5s per channel → ~1/s with burst of 5
/// - Telegram: 30 messages/s global, 1 message/s per chat → 1/s per bot
/// - QQ: ~5 messages/s (official bot API)
/// - DingTalk: ~20 messages/min via webhook → ~0.33/s
/// - Feishu: ~5 messages/s (IM API)
fn default_config(platform: &str) -> BucketConfig {
    match platform {
        "discord" => BucketConfig { capacity: 5, refill_rate: 1.0 },
        "telegram" => BucketConfig { capacity: 3, refill_rate: 1.0 },
        "qq" => BucketConfig { capacity: 5, refill_rate: 2.0 },
        "dingtalk" => BucketConfig { capacity: 3, refill_rate: 0.33 },
        "feishu" => BucketConfig { capacity: 5, refill_rate: 2.0 },
        _ => BucketConfig { capacity: 10, refill_rate: 5.0 }, // generous default
    }
}

/// Acquire a rate limit token for the given platform and bot.
///
/// If no token is immediately available, waits until one is refilled.
/// Maximum wait time is capped at 30 seconds to prevent indefinite blocking.
pub async fn acquire(platform: &str, bot_id: &str) {
    let key = format!("{}:{}", platform, bot_id);
    let max_wait_ms: u64 = 30_000;
    let mut total_waited: u64 = 0;

    loop {
        let wait_ms = {
            let mut limiters = RATE_LIMITERS.write().unwrap();
            let bucket = limiters
                .entry(key.clone())
                .or_insert_with(|| TokenBucket::new(default_config(platform)));

            if bucket.try_acquire() {
                return; // Token acquired
            }
            bucket.wait_time_ms()
        };

        if total_waited >= max_wait_ms {
            log::warn!(
                "[RateLimit] {}:{} waited {}ms, proceeding anyway",
                platform, bot_id, total_waited
            );
            return;
        }

        let sleep_ms = wait_ms.min(max_wait_ms - total_waited).max(10);
        log::debug!(
            "[RateLimit] {}:{} waiting {}ms for token",
            platform, bot_id, sleep_ms
        );
        tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
        total_waited += sleep_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_bucket_basic() {
        let config = BucketConfig { capacity: 3, refill_rate: 1.0 };
        let mut bucket = TokenBucket::new(config);

        // Should have 3 initial tokens
        assert!(bucket.try_acquire());
        assert!(bucket.try_acquire());
        assert!(bucket.try_acquire());
        // Bucket empty
        assert!(!bucket.try_acquire());
    }

    #[test]
    fn test_token_bucket_refill() {
        let config = BucketConfig { capacity: 2, refill_rate: 100.0 }; // fast refill for testing
        let mut bucket = TokenBucket::new(config);

        // Drain all tokens
        bucket.try_acquire();
        bucket.try_acquire();
        assert!(!bucket.try_acquire());

        // Manually advance time by simulating refill
        bucket.last_refill = Instant::now() - std::time::Duration::from_millis(100);
        bucket.refill();

        // Should have refilled
        assert!(bucket.tokens >= 1.0);
        assert!(bucket.try_acquire());
    }

    #[test]
    fn test_token_bucket_no_overflow() {
        let config = BucketConfig { capacity: 2, refill_rate: 100.0 };
        let mut bucket = TokenBucket::new(config);

        // Wait a long time - should not exceed capacity
        bucket.last_refill = Instant::now() - std::time::Duration::from_secs(10);
        bucket.refill();
        assert!(bucket.tokens <= 2.0);
    }

    #[test]
    fn test_wait_time_calculation() {
        let config = BucketConfig { capacity: 1, refill_rate: 2.0 }; // 2 tokens/s
        let mut bucket = TokenBucket::new(config);

        // Drain the bucket
        bucket.try_acquire();
        assert!(!bucket.try_acquire());

        // Wait time should be ~500ms (1 token / 2 tokens per second)
        let wait = bucket.wait_time_ms();
        assert!(wait > 0 && wait <= 600, "wait was {}ms", wait);
    }

    #[tokio::test]
    async fn test_acquire_immediate() {
        // Fresh bucket should acquire immediately
        acquire("test_platform", "test_bot_immediate").await;
        // If we get here, it didn't block forever — that's the test
    }

    #[test]
    fn test_default_configs() {
        // Verify all platforms have reasonable defaults
        for platform in &["discord", "telegram", "qq", "dingtalk", "feishu", "unknown"] {
            let config = default_config(platform);
            assert!(config.capacity > 0, "{} capacity should be > 0", platform);
            assert!(config.refill_rate > 0.0, "{} refill_rate should be > 0", platform);
        }
    }
}
