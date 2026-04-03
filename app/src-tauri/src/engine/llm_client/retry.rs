//! Shared retry engine for all LLM providers.
//!
//! Extracts the common retry logic (exponential backoff, Retry-After, error
//! classification) that was duplicated across openai.rs / anthropic.rs /
//! google.rs into a single, configurable function.
//!
//! Optionally emits Tauri events (`chat://retry`, `chat://retry-resolved`) so
//! the frontend can show real-time retry status to the user.

use std::time::Duration;

use serde::Serialize;

pub const MAX_RETRIES: u32 = 3;
const BASE_DELAY_MS: u64 = 1000;
const MAX_DELAY_MS: u64 = 32_000;
const JITTER_FACTOR: f64 = 0.25;

// ── Error classification ───────────────────────────────────────────────

/// Categorised API error — drives retry decisions and frontend display.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ApiErrorCategory {
    /// Short-lived server issue (500, 502, 503, 529, connection error).
    /// The retry engine handles these automatically.
    #[serde(rename = "transient")]
    Transient { retry_after_ms: Option<u64> },

    /// Rate-limited (429). `is_quota_exhausted` distinguishes between a brief
    /// spike and a hard quota ceiling (hours-long cooldown).
    #[serde(rename = "rate_limited")]
    RateLimited {
        retry_after_ms: Option<u64>,
        is_quota_exhausted: bool,
    },

    /// Authentication / authorisation failure (401, 403).
    #[serde(rename = "auth_error")]
    AuthError,

    /// Bad request that cannot be fixed by retrying (400, 404).
    #[serde(rename = "client_error")]
    ClientError { message: String },

    /// Model context window exceeded — may be auto-fixable.
    #[serde(rename = "context_overflow")]
    ContextOverflow {
        input_tokens: Option<u64>,
        context_limit: Option<u64>,
    },
}

/// Classify an HTTP status + response body into an `ApiErrorCategory`.
pub fn classify_error(status: u16, body: &str) -> ApiErrorCategory {
    match status {
        429 => {
            // Long retry-after (>60 s) or explicit "quota" / "exceeded" wording
            // → likely quota exhaustion rather than a transient spike.
            let is_quota = body.contains("quota")
                || body.contains("exceeded")
                || body.contains("billing");
            ApiErrorCategory::RateLimited {
                retry_after_ms: None, // filled in by caller from header
                is_quota_exhausted: is_quota,
            }
        }
        401 | 403 => ApiErrorCategory::AuthError,
        400 | 404 => {
            // Check for context overflow pattern
            if let Some((input, limit)) = parse_context_overflow(body) {
                return ApiErrorCategory::ContextOverflow {
                    input_tokens: Some(input),
                    context_limit: Some(limit),
                };
            }
            ApiErrorCategory::ClientError {
                message: sanitize_error_body(body),
            }
        }
        s if s >= 500 => ApiErrorCategory::Transient {
            retry_after_ms: None,
        },
        _ => ApiErrorCategory::ClientError {
            message: sanitize_error_body(body),
        },
    }
}

/// Returns `true` when the error category warrants an automatic retry.
/// Note: `ContextOverflow` is NOT auto-retried — the caller must adjust
/// `max_tokens` before retrying, which requires modifying the request body.
pub fn is_retryable(cat: &ApiErrorCategory) -> bool {
    matches!(
        cat,
        ApiErrorCategory::Transient { .. }
            | ApiErrorCategory::RateLimited {
                is_quota_exhausted: false,
                ..
            }
    )
}

// ── Context-overflow detection ─────────────────────────────────────────

/// Try to extract `(input_tokens, context_limit)` from an error body.
pub fn parse_context_overflow(body: &str) -> Option<(u64, u64)> {
    // Anthropic: "... prompt is too long: 123456 tokens > 100000 maximum ..."
    // OpenAI:    "... maximum context length is 128000 tokens ... you requested 130000 ..."
    let lower = body.to_lowercase();
    if !(lower.contains("context") || lower.contains("prompt is too long") || lower.contains("token")) {
        return None;
    }
    // Pull all numbers from the message
    let nums: Vec<u64> = body
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|s| s.parse::<u64>().ok())
        .filter(|&n| n > 100) // ignore tiny numbers
        .collect();
    if nums.len() >= 2 {
        let (a, b) = (nums[0], nums[1]);
        // The bigger number is usually the limit
        if a > b {
            Some((b, a))
        } else {
            Some((a, b))
        }
    } else {
        None
    }
}

// ── Retry delay calculation ────────────────────────────────────────────

/// Compute the wait duration for a given attempt, respecting `Retry-After`.
pub fn retry_delay(attempt: u32, retry_after_header: Option<&str>) -> Duration {
    // Retry-After header takes priority
    if let Some(header) = retry_after_header {
        if let Ok(secs) = header.parse::<u64>() {
            return Duration::from_secs(secs);
        }
    }
    // Exponential backoff with jitter
    let base = (BASE_DELAY_MS * 2u64.pow(attempt)).min(MAX_DELAY_MS);
    let jitter = (base as f64 * JITTER_FACTOR * rand_f64()) as u64;
    Duration::from_millis(base + jitter)
}

/// Cheap pseudo-random f64 in [0, 1) — avoids pulling in the `rand` crate.
/// Uses an atomic counter to ensure distinct values even within the same millisecond.
fn rand_f64() -> f64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut h);
    COUNTER.fetch_add(1, Ordering::Relaxed).hash(&mut h);
    (h.finish() % 10_000) as f64 / 10_000.0
}

// ── Retry event payloads (Tauri) ───────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct RetryEvent {
    pub attempt: u32,
    pub max_retries: u32,
    pub delay_ms: u64,
    pub error_category: ApiErrorCategory,
    pub provider: String,
}

/// Emit `chat://retry` via the global Tauri app handle (best-effort).
pub fn emit_retry_event(event: &RetryEvent) {
    if let Some(handle) = crate::engine::tools::get_app_handle() {
        use tauri::Emitter;
        let _ = handle.emit("chat://retry", event);
    }
}

/// Emit `chat://retry-resolved` to tell the frontend the retry succeeded.
pub fn emit_retry_resolved() {
    if let Some(handle) = crate::engine::tools::get_app_handle() {
        use tauri::Emitter;
        let _ = handle.emit("chat://retry-resolved", serde_json::json!({}));
    }
}

// ── Core retry wrapper ─────────────────────────────────────────────────

/// Result of `send_with_retry` — either an OK response or a classified error.
pub struct RetryOutcome {
    pub response: reqwest::Response,
    /// True when at least one retry happened before success.
    pub did_retry: bool,
}

/// Generic retry wrapper for any LLM HTTP request.
///
/// `build_request` is called on each attempt so the caller can rebuild the
/// request (required because `reqwest::RequestBuilder` is consumed on send).
pub async fn send_with_retry<F>(
    provider_name: &str,
    mut build_request: F,
    timeout: Duration,
) -> Result<RetryOutcome, (String, ApiErrorCategory)>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    let mut last_err = String::new();
    let mut did_retry = false;

    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 {
            did_retry = true;
            log::warn!("{} request retry {}/{}", provider_name, attempt, MAX_RETRIES);
        }

        match build_request()
            .timeout(timeout)
            .send()
            .await
        {
            Ok(resp) => {
                if resp.status().is_success() {
                    if did_retry {
                        emit_retry_resolved();
                    }
                    return Ok(RetryOutcome {
                        response: resp,
                        did_retry,
                    });
                }

                let status = resp.status().as_u16();
                let retry_after = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let body = resp.text().await.unwrap_or_default();

                let mut category = classify_error(status, &body);

                // Inject Retry-After into the category when available
                if let Some(ref ra) = retry_after {
                    if let Ok(secs) = ra.parse::<u64>() {
                        match &mut category {
                            ApiErrorCategory::RateLimited {
                                retry_after_ms, ..
                            } => *retry_after_ms = Some(secs * 1000),
                            ApiErrorCategory::Transient { retry_after_ms } => {
                                *retry_after_ms = Some(secs * 1000)
                            }
                            _ => {}
                        }
                    }
                }

                if is_retryable(&category) && attempt < MAX_RETRIES {
                    let delay = retry_delay(attempt, retry_after.as_deref());
                    let evt = RetryEvent {
                        attempt: attempt + 1,
                        max_retries: MAX_RETRIES,
                        delay_ms: delay.as_millis() as u64,
                        error_category: category.clone(),
                        provider: provider_name.to_string(),
                    };
                    log::warn!(
                        "{} API error ({}), retry {}/{} after {:?}: {}",
                        provider_name,
                        status,
                        attempt + 1,
                        MAX_RETRIES,
                        delay,
                        &body.chars().take(200).collect::<String>()
                    );
                    emit_retry_event(&evt);
                    tokio::time::sleep(delay).await;
                    last_err = format!("{} API error ({}): {}", provider_name, status, body);
                    continue;
                }

                // Non-retryable or retries exhausted
                let err_msg = format!("{} API error ({}): {}", provider_name, status, body);
                log::error!("{}", err_msg);
                return Err((err_msg, category));
            }
            Err(e) => {
                // Network / timeout errors are always retryable
                if attempt < MAX_RETRIES {
                    let delay = retry_delay(attempt, None);
                    let category = ApiErrorCategory::Transient {
                        retry_after_ms: None,
                    };
                    let evt = RetryEvent {
                        attempt: attempt + 1,
                        max_retries: MAX_RETRIES,
                        delay_ms: delay.as_millis() as u64,
                        error_category: category,
                        provider: provider_name.to_string(),
                    };
                    log::warn!(
                        "{} request failed (attempt {}), retry after {:?}: {}",
                        provider_name,
                        attempt + 1,
                        delay,
                        e
                    );
                    emit_retry_event(&evt);
                    tokio::time::sleep(delay).await;
                    last_err = format!("{} request failed: {}", provider_name, e);
                    continue;
                }
                let err_msg = format!(
                    "{} request failed after {} retries: {}",
                    provider_name, MAX_RETRIES, e
                );
                return Err((
                    err_msg,
                    ApiErrorCategory::Transient {
                        retry_after_ms: None,
                    },
                ));
            }
        }
    }

    Err((
        last_err,
        ApiErrorCategory::Transient {
            retry_after_ms: None,
        },
    ))
}

// ── Context overflow recovery ──────────────────────────────────────────

/// Minimum output tokens we'll accept when auto-adjusting for context overflow.
const FLOOR_OUTPUT_TOKENS: u64 = 3000;

/// Given a context overflow error, compute a safe `max_tokens` value.
/// Returns `None` if the remaining space is too small to be useful.
pub fn compute_adjusted_max_tokens(input_tokens: u64, context_limit: u64) -> Option<u64> {
    let safety_buffer = 1000u64;
    let available = context_limit.saturating_sub(input_tokens + safety_buffer);
    if available < FLOOR_OUTPUT_TOKENS {
        return None; // too little room — needs compaction instead
    }
    Some(available.max(FLOOR_OUTPUT_TOKENS))
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Truncate & clean an error body for user display.
/// If it's HTML (e.g. Cloudflare error page), extract the <title>.
fn sanitize_error_body(body: &str) -> String {
    if body.contains("<!DOCTYPE html") || body.contains("<html") {
        // Extract <title> like Claude Code does
        if let Some(start) = body.find("<title>") {
            let rest = &body[start + 7..];
            if let Some(end) = rest.find("</title>") {
                return rest[..end].trim().to_string();
            }
        }
        return "Server returned an HTML error page".to_string();
    }
    // Truncate long bodies
    if body.len() > 500 {
        format!("{}...", &body[..500])
    } else {
        body.to_string()
    }
}
