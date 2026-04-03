use std::time::Duration;

use futures_util::StreamExt;
use tokio::time::Instant;

/// Default idle timeout for SSE streams — if no chunk arrives within this
/// window the stream is considered dead and we abort.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Safely decode bytes into UTF-8 string, handling split multi-byte sequences at chunk boundaries
pub struct Utf8Decoder {
    incomplete: Vec<u8>,
}

impl Utf8Decoder {
    pub fn new() -> Self {
        Self { incomplete: Vec::new() }
    }

    /// Feed raw bytes and return decoded string. Incomplete trailing sequences are buffered.
    pub fn decode(&mut self, chunk: &[u8]) -> Option<String> {
        self.incomplete.extend_from_slice(chunk);
        // Validate in-place without cloning the buffer
        match std::str::from_utf8(&self.incomplete) {
            Ok(_) => {
                // All bytes are valid UTF-8 — take ownership efficiently
                let s = unsafe { String::from_utf8_unchecked(std::mem::take(&mut self.incomplete)) };
                Some(s)
            }
            Err(e) => {
                let valid_up_to = e.valid_up_to();
                if valid_up_to > 0 {
                    // Safe: bytes [0..valid_up_to] are guaranteed valid UTF-8
                    let valid = unsafe {
                        std::str::from_utf8_unchecked(&self.incomplete[..valid_up_to])
                    }.to_owned();
                    self.incomplete = self.incomplete[valid_up_to..].to_vec();
                    // Max UTF-8 sequence is 4 bytes; anything longer is corrupted
                    if self.incomplete.len() > 4 {
                        let flushed = String::from_utf8_lossy(&self.incomplete).into_owned();
                        self.incomplete.clear();
                        return Some(format!("{}{}", valid, flushed));
                    }
                    Some(valid)
                } else if self.incomplete.len() > 4 {
                    let flushed = String::from_utf8_lossy(&self.incomplete).into_owned();
                    self.incomplete.clear();
                    Some(flushed)
                } else {
                    None // wait for more data
                }
            }
        }
    }
}

// ── Stream error type ──────────────────────────────────────────────────

/// Errors that can occur during SSE stream processing.
#[derive(Debug)]
pub enum StreamError {
    /// Normal error (parse failure, mid-stream API error, etc.)
    Normal(String),
    /// The stream was idle for too long — eligible for non-streaming fallback.
    IdleTimeout,
    /// User cancelled.
    Cancelled,
}

impl std::fmt::Display for StreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StreamError::Normal(s) => write!(f, "{}", s),
            StreamError::IdleTimeout => write!(f, "Stream idle timeout ({}s)", STREAM_IDLE_TIMEOUT.as_secs()),
            StreamError::Cancelled => write!(f, "cancelled"),
        }
    }
}

impl StreamError {
    /// Returns `true` when falling back to non-streaming might recover.
    pub fn is_fallback_eligible(&self) -> bool {
        matches!(self, StreamError::IdleTimeout)
    }
}

// ── OpenAI / Gemini SSE processor (data: lines) ────────────────────────

/// Process standard SSE byte stream (OpenAI/Gemini format: `data: {...}` lines).
/// Calls `on_line` for each complete data payload. Return false from on_line to stop.
///
/// Features a watchdog timer: if no bytes arrive within `STREAM_IDLE_TIMEOUT`,
/// returns `StreamError::IdleTimeout` so the caller can fall back to non-streaming.
pub async fn process_sse_stream(
    resp: reqwest::Response,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
    mut on_line: impl FnMut(&str) -> bool,
) -> Result<(), StreamError> {
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut decoder = Utf8Decoder::new();
    let mut idle_deadline = Instant::now() + STREAM_IDLE_TIMEOUT;

    loop {
        // Check cancellation
        if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            return Err(StreamError::Cancelled);
        }

        tokio::select! {
            chunk_opt = stream.next() => {
                match chunk_opt {
                    None => return Ok(()), // stream ended normally
                    Some(Err(e)) => return Err(StreamError::Normal(format!("Stream read error: {}", e))),
                    Some(Ok(chunk)) => {
                        // Reset watchdog on every successful chunk
                        idle_deadline = Instant::now() + STREAM_IDLE_TIMEOUT;

                        if let Some(decoded) = decoder.decode(&chunk) {
                            buffer.push_str(&decoded);
                        } else {
                            continue;
                        }

                        while let Some(line_end) = buffer.find('\n') {
                            let line = buffer[..line_end].trim().to_string();
                            buffer = buffer[line_end + 1..].to_string();

                            if line.is_empty() || line.starts_with(':') {
                                continue;
                            }

                            if let Some(data) = line.strip_prefix("data: ") {
                                let data = data.trim();
                                if data == "[DONE]" {
                                    return Ok(());
                                }
                                if !on_line(data) {
                                    return Ok(());
                                }
                            }
                        }
                    }
                }
            }
            _ = tokio::time::sleep_until(idle_deadline) => {
                log::warn!("SSE stream idle timeout after {}s — no data received", STREAM_IDLE_TIMEOUT.as_secs());
                return Err(StreamError::IdleTimeout);
            }
        }
    }
}

/// Process Anthropic SSE stream (uses `event:` + `data:` two-line format).
/// Calls `on_event` with (event_type, json_data) for each complete event.
///
/// Also protected by the idle watchdog timer.
pub async fn process_anthropic_sse_stream(
    resp: reqwest::Response,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
    mut on_event: impl FnMut(&str, &serde_json::Value) -> Result<bool, String>,
) -> Result<(), StreamError> {
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut decoder = Utf8Decoder::new();
    let mut current_event_type = String::new();
    let mut idle_deadline = Instant::now() + STREAM_IDLE_TIMEOUT;

    loop {
        if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            return Err(StreamError::Cancelled);
        }

        tokio::select! {
            chunk_opt = stream.next() => {
                match chunk_opt {
                    None => return Ok(()),
                    Some(Err(e)) => return Err(StreamError::Normal(format!("Stream read error: {}", e))),
                    Some(Ok(chunk)) => {
                        idle_deadline = Instant::now() + STREAM_IDLE_TIMEOUT;

                        if let Some(decoded) = decoder.decode(&chunk) {
                            buffer.push_str(&decoded);
                        } else {
                            continue;
                        }

                        while let Some(line_end) = buffer.find('\n') {
                            let line = buffer[..line_end].trim().to_string();
                            buffer = buffer[line_end + 1..].to_string();

                            if line.is_empty() {
                                current_event_type.clear();
                                continue;
                            }

                            if let Some(evt) = line.strip_prefix("event: ") {
                                current_event_type = evt.trim().to_string();
                                continue;
                            }

                            if let Some(data) = line.strip_prefix("data: ") {
                                let data = data.trim();
                                match serde_json::from_str::<serde_json::Value>(data) {
                                    Err(e) => {
                                        log::warn!("SSE JSON parse error (event={}): {} — data: {}", current_event_type, e, &data.chars().take(200).collect::<String>());
                                    }
                                    Ok(json) => match on_event(&current_event_type, &json) {
                                        Ok(true) => {}
                                        Ok(false) => return Ok(()),
                                        Err(e) => return Err(StreamError::Normal(e)),
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ = tokio::time::sleep_until(idle_deadline) => {
                log::warn!("Anthropic SSE stream idle timeout after {}s", STREAM_IDLE_TIMEOUT.as_secs());
                return Err(StreamError::IdleTimeout);
            }
        }
    }
}
