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
/// Server-busy / queue-style 5xx (DeepSeek peak-hour, "Server busy, please
/// try again later") cool down on the order of seconds — a 1s base wastes
/// retries inside the same congestion window.
const SERVER_BUSY_BASE_DELAY_MS: u64 = 5000;
const MAX_DELAY_MS: u64 = 32_000;
const JITTER_FACTOR: f64 = 0.25;

// ── Error classification ───────────────────────────────────────────────

/// Categorised API error — drives retry decisions and frontend display.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ApiErrorCategory {
    /// Short-lived server issue (500, 502, 503, 529, connection error).
    /// The retry engine handles these automatically.
    ///
    /// `is_server_busy` is true when the body indicates a queue/capacity
    /// signal ("Server busy", "服务繁忙", DeepSeek peak-hour pattern) — the
    /// retry engine uses a longer base delay so we don't burn all retries
    /// inside the congestion window.
    #[serde(rename = "transient")]
    Transient {
        retry_after_ms: Option<u64>,
        #[serde(default)]
        is_server_busy: bool,
    },

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

/// Detect server-busy / queue-style signals in the response body. Common
/// across OpenAI-compatible providers — DeepSeek surfaces this most often
/// during peak hours with `"Server busy, please try again later"`.
fn looks_server_busy(body: &str) -> bool {
    let lower = body.to_lowercase();
    lower.contains("server busy")
        || lower.contains("server is busy")
        || body.contains("服务繁忙")
        || body.contains("服务忙")
        || lower.contains("please retry")
        || lower.contains("please try again later")
}

/// Detect insufficient-balance / payment-required signals. DeepSeek and
/// other Chinese providers commonly return HTTP 402 or a 200/4xx body
/// containing these markers when the user's account is out of credit.
fn looks_insufficient_balance(body: &str) -> bool {
    let lower = body.to_lowercase();
    lower.contains("insufficient_balance")
        || lower.contains("insufficient balance")
        || body.contains("余额不足")
        || body.contains("账户余额")
}

/// Classify an HTTP status + response body into an `ApiErrorCategory`.
pub fn classify_error(status: u16, body: &str) -> ApiErrorCategory {
    match status {
        // 402 Payment Required is DeepSeek's primary "out of credit" signal.
        // Treat as a hard quota ceiling so retry stops and the user sees a
        // clear "top up" message instead of a generic 4xx.
        402 => ApiErrorCategory::RateLimited {
            retry_after_ms: None,
            is_quota_exhausted: true,
        },
        429 => {
            // Long retry-after (>60 s) or explicit "quota" / "exceeded" wording
            // → likely quota exhaustion rather than a transient spike.
            let is_quota = body.contains("quota")
                || body.contains("exceeded")
                || body.contains("billing")
                || looks_insufficient_balance(body);
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
            is_server_busy: looks_server_busy(body),
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

/// Compute the wait duration for a given attempt, respecting `Retry-After`
/// and provider hints (server-busy uses a longer base delay).
pub fn retry_delay(
    attempt: u32,
    retry_after_header: Option<&str>,
    category: &ApiErrorCategory,
) -> Duration {
    // Retry-After header takes priority
    if let Some(header) = retry_after_header {
        if let Ok(secs) = header.parse::<u64>() {
            return Duration::from_secs(secs);
        }
    }
    let base_delay_ms = match category {
        ApiErrorCategory::Transient { is_server_busy: true, .. } => SERVER_BUSY_BASE_DELAY_MS,
        _ => BASE_DELAY_MS,
    };
    let base = (base_delay_ms * 2u64.pow(attempt)).min(MAX_DELAY_MS);
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
    #[allow(dead_code)]
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
                            ApiErrorCategory::Transient { retry_after_ms, .. } => {
                                *retry_after_ms = Some(secs * 1000)
                            }
                            _ => {}
                        }
                    }
                }

                if is_retryable(&category) && attempt < MAX_RETRIES {
                    let delay = retry_delay(attempt, retry_after.as_deref(), &category);
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
                    last_err = humanize_api_error(status, &body, &category);
                    continue;
                }

                // Non-retryable or retries exhausted
                let err_msg = humanize_api_error(status, &body, &category);
                log::error!("{}", err_msg);
                return Err((err_msg, category));
            }
            Err(e) => {
                // Network / timeout errors are always retryable
                if attempt < MAX_RETRIES {
                    let category = ApiErrorCategory::Transient {
                        retry_after_ms: None,
                        is_server_busy: false,
                    };
                    let delay = retry_delay(attempt, None, &category);
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
                        is_server_busy: false,
                    },
                ));
            }
        }
    }

    Err((
        last_err,
        ApiErrorCategory::Transient {
            retry_after_ms: None,
            is_server_busy: false,
        },
    ))
}

// ── Context overflow recovery ──────────────────────────────────────────

/// Minimum output tokens we'll accept when auto-adjusting for context overflow.
#[allow(dead_code)]
const FLOOR_OUTPUT_TOKENS: u64 = 3000;

/// Given a context overflow error, compute a safe `max_tokens` value.
/// Returns `None` if the remaining space is too small to be useful.
#[allow(dead_code)]
pub fn compute_adjusted_max_tokens(input_tokens: u64, context_limit: u64) -> Option<u64> {
    let safety_buffer = 1000u64;
    let available = context_limit.saturating_sub(input_tokens + safety_buffer);
    if available < FLOOR_OUTPUT_TOKENS {
        return None; // too little room — needs compaction instead
    }
    Some(available.max(FLOOR_OUTPUT_TOKENS))
}

// ── Helpers ────────────────────────────────────────────────────────────

const MSG_INSUFFICIENT_BALANCE: &str =
    "DeepSeek 账户余额不足，请前往 platform.deepseek.com 充值后重试";

/// Convert a classified API error into a user-friendly message. Reuses
/// `category`'s already-parsed signals so we don't rescan the body.
fn humanize_api_error(status: u16, body: &str, category: &ApiErrorCategory) -> String {
    match (status, category) {
        (402, _) => MSG_INSUFFICIENT_BALANCE.into(),
        (429, ApiErrorCategory::RateLimited { is_quota_exhausted: true, .. }) => {
            // 429 with the quota flag covers both DeepSeek balance and other
            // providers' "monthly quota exceeded". The balance copy points
            // users at the right fix; quota-exceeded users will recognise it.
            MSG_INSUFFICIENT_BALANCE.into()
        }
        (429, _) => "请求过于频繁，请稍后再试".into(),
        (401, _) => "API 密钥无效或已过期，请在设置中检查".into(),
        (403, _) => "API 访问被拒绝，请检查密钥权限".into(),
        (500 | 502 | 503, ApiErrorCategory::Transient { is_server_busy: true, .. }) => {
            "DeepSeek 服务繁忙，正在自动排队重试…".into()
        }
        (500 | 502 | 503, _) => "AI 服务暂时不可用，请稍后再试".into(),
        (408 | 504, _) => "请求超时，请稍后再试".into(),
        _ => {
            // Try to extract a human-readable message from JSON body
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(body) {
                if let Some(msg) = json["error"]["message"].as_str()
                    .or(json["message"].as_str())
                    .or(json["error"].as_str())
                {
                    return msg.to_string();
                }
            }
            format!("API 错误 ({})", status)
        }
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_error_502_with_server_busy_marks_transient_busy() {
        let body = r#"{"error":{"message":"Server busy, please try again later"}}"#;
        match classify_error(503, body) {
            ApiErrorCategory::Transient { is_server_busy: true, .. } => {}
            other => panic!("expected Transient {{ is_server_busy: true }}, got {:?}", other),
        }
    }

    #[test]
    fn classify_error_500_without_busy_marker_stays_transient_normal() {
        match classify_error(500, "Internal Server Error") {
            ApiErrorCategory::Transient { is_server_busy: false, .. } => {}
            other => panic!("expected non-busy Transient, got {:?}", other),
        }
    }

    #[test]
    fn classify_error_chinese_busy_phrase_detected() {
        match classify_error(503, "服务繁忙，请稍后重试") {
            ApiErrorCategory::Transient { is_server_busy: true, .. } => {}
            other => panic!("expected Transient busy on Chinese phrase, got {:?}", other),
        }
    }

    #[test]
    fn classify_error_402_treated_as_quota_exhausted() {
        match classify_error(402, "Insufficient Balance") {
            ApiErrorCategory::RateLimited { is_quota_exhausted: true, .. } => {}
            other => panic!("expected quota-exhausted RateLimited, got {:?}", other),
        }
    }

    #[test]
    fn is_retryable_402_balance_error_is_not_retried() {
        let cat = classify_error(402, "");
        assert!(!is_retryable(&cat), "402 must not auto-retry");
    }

    #[test]
    fn retry_delay_uses_longer_base_when_server_busy() {
        let busy = ApiErrorCategory::Transient { retry_after_ms: None, is_server_busy: true };
        // Same attempt; busy delay must dominate normal delay even with jitter.
        // Lower bound for busy at attempt=0 is SERVER_BUSY_BASE_DELAY_MS;
        // upper bound for normal at attempt=0 is BASE_DELAY_MS * (1 + JITTER_FACTOR).
        let busy_delay = retry_delay(0, None, &busy).as_millis() as u64;
        let normal_delay_max = (BASE_DELAY_MS as f64 * (1.0 + JITTER_FACTOR)) as u64;
        assert!(busy_delay >= SERVER_BUSY_BASE_DELAY_MS, "busy={busy_delay}");
        assert!(busy_delay > normal_delay_max, "busy {busy_delay} ≤ normal-max {normal_delay_max}");
    }

    #[test]
    fn humanize_402_mentions_topup() {
        let cat = classify_error(402, "");
        let msg = humanize_api_error(402, "", &cat);
        assert!(msg.contains("余额不足"), "got: {msg}");
        assert!(msg.contains("platform.deepseek.com"), "got: {msg}");
    }

    #[test]
    fn humanize_503_busy_uses_deepseek_specific_copy() {
        let body = "Server busy, please try again later";
        let cat = classify_error(503, body);
        let msg = humanize_api_error(503, body, &cat);
        assert!(msg.contains("DeepSeek"), "got: {msg}");
        assert!(msg.contains("繁忙"), "got: {msg}");
    }

    #[test]
    fn humanize_500_without_busy_marker_falls_back_to_generic_copy() {
        let cat = classify_error(500, "Internal Server Error");
        let msg = humanize_api_error(500, "Internal Server Error", &cat);
        assert!(!msg.contains("DeepSeek"), "should not surface DeepSeek copy: {msg}");
        assert!(msg.contains("AI 服务"), "got: {msg}");
    }
}
