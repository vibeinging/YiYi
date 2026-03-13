use futures_util::StreamExt;

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

/// Process standard SSE byte stream (OpenAI/Gemini format: `data: {...}` lines).
/// Calls `on_line` for each complete data payload. Return false from on_line to stop.
pub async fn process_sse_stream(
    resp: reqwest::Response,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
    mut on_line: impl FnMut(&str) -> bool,
) -> Result<(), String> {
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut decoder = Utf8Decoder::new();

    while let Some(chunk_result) = stream.next().await {
        if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            return Err("cancelled".to_string());
        }
        let chunk = chunk_result.map_err(|e| format!("Stream read error: {}", e))?;

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
    Ok(())
}

/// Process Anthropic SSE stream (uses `event:` + `data:` two-line format).
/// Calls `on_event` with (event_type, json_data) for each complete event.
pub async fn process_anthropic_sse_stream(
    resp: reqwest::Response,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
    mut on_event: impl FnMut(&str, &serde_json::Value) -> Result<bool, String>,
) -> Result<(), String> {
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut decoder = Utf8Decoder::new();
    let mut current_event_type = String::new();

    while let Some(chunk_result) = stream.next().await {
        if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            return Err("cancelled".to_string());
        }
        let chunk = chunk_result.map_err(|e| format!("Stream read error: {}", e))?;

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
                        log::warn!("SSE JSON parse error (event={}): {} — data: {}", current_event_type, e, &data[..data.len().min(200)]);
                    }
                    Ok(json) => match on_event(&current_event_type, &json)? {
                        true => {}
                        false => return Ok(()),
                    }
                }
            }
        }
    }
    Ok(())
}
