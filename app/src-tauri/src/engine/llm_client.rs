use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use super::tools::{ToolCall, ToolDefinition};

// ── Multimodal content types (OpenAI Vision API compatible) ─────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String, // "data:image/png;base64,..." or a URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>, // "auto", "low", "high"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrl },
}

/// Message content: either a plain string or multimodal parts array.
/// Serializes as a string when Text, as an array when Parts — matching OpenAI format.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl Serialize for MessageContent {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            MessageContent::Text(s) => serializer.serialize_str(s),
            MessageContent::Parts(parts) => parts.serialize(serializer),
        }
    }
}

impl MessageContent {
    /// Create a plain text content.
    pub fn text(s: impl Into<String>) -> Self {
        MessageContent::Text(s.into())
    }

    /// Extract text string (for plain text messages or first text part).
    pub fn as_text(&self) -> Option<&str> {
        match self {
            MessageContent::Text(s) => Some(s),
            MessageContent::Parts(parts) => parts.iter().find_map(|p| match p {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            }),
        }
    }

    /// Convert to owned text string (joins text parts, ignores images).
    pub fn into_text(self) -> String {
        match self {
            MessageContent::Text(s) => s,
            MessageContent::Parts(parts) => parts
                .into_iter()
                .filter_map(|p| match p {
                    ContentPart::Text { text } => Some(text),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(""),
        }
    }

    /// Build multimodal content from text + base64 image data URIs.
    pub fn with_images(text: &str, image_data_uris: &[String]) -> Self {
        let mut parts = vec![ContentPart::Text {
            text: text.to_string(),
        }];
        for uri in image_data_uris {
            parts.push(ContentPart::ImageUrl {
                image_url: ImageUrl {
                    url: uri.clone(),
                    detail: None,
                },
            });
        }
        MessageContent::Parts(parts)
    }
}

// ── LLM Message ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<MessageContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LLMConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Debug)]
pub struct LLMResponse {
    pub message: LLMMessage,
    pub finish_reason: String,
}

#[derive(Debug, Clone)]
pub enum StreamEvent {
    ContentDelta(String),
    Done(String),
}

/// Call LLM with tool definitions (OpenAI-compatible API)
pub async fn chat_completion(
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
) -> Result<LLMResponse, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/chat/completions",
        config.base_url.trim_end_matches('/')
    );

    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "max_tokens": 4096,
    });

    // Only include tools if non-empty
    if !tools.is_empty() {
        body["tools"] = serde_json::to_value(tools).unwrap_or_default();
    }

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| format!("LLM request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("LLM API error ({}): {}", status, text));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let choice = &json["choices"][0];
    let finish_reason = choice["finish_reason"]
        .as_str()
        .unwrap_or("stop")
        .to_string();

    let msg = &choice["message"];
    let content = msg["content"].as_str().map(|s| MessageContent::text(s));

    let tool_calls = if let Some(calls) = msg["tool_calls"].as_array() {
        let parsed: Vec<ToolCall> = calls
            .iter()
            .filter_map(|c| serde_json::from_value(c.clone()).ok())
            .collect();
        if parsed.is_empty() {
            None
        } else {
            Some(parsed)
        }
    } else {
        None
    };

    Ok(LLMResponse {
        message: LLMMessage {
            role: "assistant".into(),
            content,
            tool_calls,
            tool_call_id: None,
        },
        finish_reason,
    })
}

/// Streaming chat completion via SSE.
/// Calls `on_event` for each content delta. Returns the full LLMResponse when done.
/// If `cancelled` is provided and set to true, the stream will be aborted early.
pub async fn chat_completion_stream<F>(
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
    on_event: F,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<LLMResponse, String>
where
    F: Fn(StreamEvent) + Send + 'static,
{
    let client = reqwest::Client::new();
    let url = format!(
        "{}/chat/completions",
        config.base_url.trim_end_matches('/')
    );

    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "max_tokens": 4096,
        "stream": true,
    });

    if !tools.is_empty() {
        body["tools"] = serde_json::to_value(tools).unwrap_or_default();
    }

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("LLM stream request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("LLM API error ({}): {}", status, text));
    }

    let mut stream = resp.bytes_stream();
    let mut full_content = String::new();
    let mut finish_reason = "stop".to_string();
    let mut buffer = String::new();

    // For accumulating tool calls by index
    // Each entry: (id, function_name, arguments_buffer)
    let mut tool_call_acc: std::collections::BTreeMap<u32, (String, String, String)> =
        std::collections::BTreeMap::new();

    while let Some(chunk_result) = stream.next().await {
        if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            return Err("cancelled".to_string());
        }
        let chunk = chunk_result.map_err(|e| format!("Stream read error: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete SSE lines
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                let data = data.trim();
                if data == "[DONE]" {
                    on_event(StreamEvent::Done(full_content.clone()));
                    break;
                }

                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    let choice = &json["choices"][0];

                    if let Some(fr) = choice["finish_reason"].as_str() {
                        finish_reason = fr.to_string();
                    }

                    let delta = &choice["delta"];

                    // Content delta
                    if let Some(text) = delta["content"].as_str() {
                        if !text.is_empty() {
                            full_content.push_str(text);
                            on_event(StreamEvent::ContentDelta(text.to_string()));
                        }
                    }

                    // Tool call deltas
                    if let Some(tc_array) = delta["tool_calls"].as_array() {
                        for tc in tc_array {
                            let index = tc["index"].as_u64().unwrap_or(0) as u32;
                            let entry = tool_call_acc
                                .entry(index)
                                .or_insert_with(|| (String::new(), String::new(), String::new()));

                            if let Some(id) = tc["id"].as_str() {
                                entry.0 = id.to_string();
                            }
                            if let Some(name) = tc["function"]["name"].as_str() {
                                entry.1.push_str(name);
                            }
                            if let Some(args) = tc["function"]["arguments"].as_str() {
                                entry.2.push_str(args);
                            }
                        }
                    }
                }
            }
        }
    }

    // Build tool calls from accumulated data
    let tool_calls = if tool_call_acc.is_empty() {
        None
    } else {
        let calls: Vec<ToolCall> = tool_call_acc
            .into_values()
            .map(|(id, name, arguments)| ToolCall {
                id,
                r#type: "function".to_string(),
                function: super::tools::FunctionCall {
                    name,
                    arguments,
                },
            })
            .collect();
        Some(calls)
    };

    let content = if full_content.is_empty() {
        None
    } else {
        Some(MessageContent::text(full_content))
    };

    Ok(LLMResponse {
        message: LLMMessage {
            role: "assistant".into(),
            content,
            tool_calls,
            tool_call_id: None,
        },
        finish_reason,
    })
}
