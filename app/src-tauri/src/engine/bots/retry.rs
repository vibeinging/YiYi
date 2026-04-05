/// Message send retry with exponential backoff.
///
/// Wraps any async send function and retries on failure up to `MAX_RETRIES`
/// times with exponential backoff (1s → 2s → 4s).
/// Maximum number of retry attempts (excluding the initial attempt).
const MAX_RETRIES: u32 = 3;
/// Base delay between retries in milliseconds.
const BASE_DELAY_MS: u64 = 1000;

/// Result of a send attempt with retry information.
#[derive(Debug, Clone)]
pub struct SendResult {
    pub success: bool,
    pub attempts: u32,
    pub last_error: Option<String>,
}

/// Statistics for retry tracking per bot.
#[derive(Debug, Clone, Default)]
pub struct RetryStats {
    pub total_sends: u64,
    pub total_retries: u64,
    pub total_failures: u64,
}

lazy_static::lazy_static! {
    static ref RETRY_STATS: std::sync::RwLock<std::collections::HashMap<String, RetryStats>> =
        std::sync::RwLock::new(std::collections::HashMap::new());
}

/// Record a send result in the stats.
fn record_stats(bot_id: &str, result: &SendResult) {
    let mut map = RETRY_STATS.write().unwrap();
    let stats = map.entry(bot_id.to_string()).or_default();
    stats.total_sends += 1;
    if result.attempts > 1 {
        stats.total_retries += (result.attempts - 1) as u64;
    }
    if !result.success {
        stats.total_failures += 1;
    }
}

/// Execute a send operation with exponential backoff retry.
///
/// The `send_fn` is called with no arguments and should return `Result<(), String>`.
/// On failure, retries up to `MAX_RETRIES` times with delays of 1s, 2s, 4s.
///
/// Returns `SendResult` with success status, attempt count, and last error.
pub async fn with_retry<F, Fut>(
    bot_id: &str,
    send_fn: F,
) -> SendResult
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let mut last_error = None;

    for attempt in 0..=MAX_RETRIES {
        match send_fn().await {
            Ok(()) => {
                let result = SendResult {
                    success: true,
                    attempts: attempt + 1,
                    last_error: None,
                };
                record_stats(bot_id, &result);
                if attempt > 0 {
                    log::info!(
                        "[Retry] Bot {} send succeeded after {} retries",
                        bot_id, attempt
                    );
                }
                return result;
            }
            Err(e) => {
                last_error = Some(e.clone());

                if attempt < MAX_RETRIES {
                    // Check if error is retryable
                    if !is_retryable(&e) {
                        log::warn!(
                            "[Retry] Bot {} send failed with non-retryable error: {}",
                            bot_id, e
                        );
                        let result = SendResult {
                            success: false,
                            attempts: attempt + 1,
                            last_error: Some(e),
                        };
                        record_stats(bot_id, &result);
                        return result;
                    }

                    let delay_ms = BASE_DELAY_MS * 2u64.pow(attempt);
                    log::warn!(
                        "[Retry] Bot {} send attempt {} failed: {}. Retrying in {}ms...",
                        bot_id, attempt + 1, e, delay_ms
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                } else {
                    log::error!(
                        "[Retry] Bot {} send failed after {} attempts: {}",
                        bot_id, MAX_RETRIES + 1, e
                    );
                }
            }
        }
    }

    let result = SendResult {
        success: false,
        attempts: MAX_RETRIES + 1,
        last_error,
    };
    record_stats(bot_id, &result);
    result
}

/// Determine if an error is retryable.
///
/// Non-retryable errors include:
/// - Authentication failures (401, 403)
/// - Bad request / validation errors (400)
/// - Not found (404)
/// - Message too long / content policy
///
/// Retryable errors include:
/// - Network timeouts
/// - Rate limiting (429)
/// - Server errors (500, 502, 503, 504)
/// - Connection reset / refused
fn is_retryable(error: &str) -> bool {
    let lower = error.to_lowercase();

    // Non-retryable patterns
    let non_retryable = [
        "401", "403", "404",
        "unauthorized", "forbidden", "not found",
        "invalid", "bad request",
        "message is too long",
        "content policy",
    ];
    for pattern in &non_retryable {
        if lower.contains(pattern) {
            // Exception: 429 is retryable even though it contains "4"
            if !lower.contains("429") && !lower.contains("rate limit") {
                return false;
            }
        }
    }

    // Explicitly retryable patterns
    let retryable = [
        "timeout", "timed out",
        "429", "rate limit", "too many requests",
        "500", "502", "503", "504",
        "internal server error", "bad gateway", "service unavailable", "gateway timeout",
        "connection reset", "connection refused", "connection closed",
        "broken pipe", "network",
    ];
    for pattern in &retryable {
        if lower.contains(pattern) {
            return true;
        }
    }

    // Default: retry on unknown errors (conservative approach for network issues)
    true
}

/// Emit a retry failure event to the frontend via Tauri.
pub fn emit_send_failure(
    app_handle: &tauri::AppHandle,
    bot_id: &str,
    target: &str,
    error: &str,
    attempts: u32,
) {
    use tauri::Emitter;
    app_handle.emit("bot://send-failure", serde_json::json!({
        "bot_id": bot_id,
        "target": target,
        "error": error,
        "attempts": attempts,
    })).ok();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn test_retry_succeeds_first_try() {
        let result = with_retry("test-bot", || async { Ok(()) }).await;
        assert!(result.success);
        assert_eq!(result.attempts, 1);
    }

    #[tokio::test]
    async fn test_retry_succeeds_after_failures() {
        let counter = Arc::new(AtomicU32::new(0));
        let c = counter.clone();
        let result = with_retry("test-bot", move || {
            let c = c.clone();
            async move {
                let n = c.fetch_add(1, Ordering::SeqCst);
                if n < 2 {
                    Err("timeout".to_string())
                } else {
                    Ok(())
                }
            }
        }).await;
        assert!(result.success);
        assert_eq!(result.attempts, 3);
    }

    #[tokio::test]
    async fn test_retry_non_retryable_stops_early() {
        let counter = Arc::new(AtomicU32::new(0));
        let c = counter.clone();
        let result = with_retry("test-bot", move || {
            let c = c.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Err("401 Unauthorized".to_string())
            }
        }).await;
        assert!(!result.success);
        assert_eq!(result.attempts, 1); // Should not retry
    }

    #[test]
    fn test_is_retryable() {
        assert!(is_retryable("timeout"));
        assert!(is_retryable("429 Too Many Requests"));
        assert!(is_retryable("502 Bad Gateway"));
        assert!(is_retryable("connection reset"));
        assert!(!is_retryable("401 Unauthorized"));
        assert!(!is_retryable("403 Forbidden"));
        assert!(!is_retryable("404 Not Found"));
    }
}
