use serde::{Deserialize, Serialize};

use crate::engine::tools::ToolCall;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeToolInjection {
    pub config: serde_json::Value,
    pub inject_mode: String,
}

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
    pub fn text(s: impl Into<String>) -> Self {
        MessageContent::Text(s.into())
    }

    pub fn as_text(&self) -> Option<&str> {
        match self {
            MessageContent::Text(s) => Some(s),
            MessageContent::Parts(parts) => parts.iter().find_map(|p| match p {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            }),
        }
    }

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
    pub provider_id: String,
    pub native_tools: Vec<NativeToolInjection>,
}

#[derive(Debug)]
pub struct LLMResponse {
    pub message: LLMMessage,
}

#[derive(Debug, Clone)]
pub enum StreamEvent {
    ContentDelta(String),
    ReasoningDelta(String),
    /// Stream died; falling back to non-streaming request.
    Fallback,
    Done,
}

// ── Content conversion helpers ──────────────────────────────────────

/// Parse a `data:` URI into (media_type, base64_data). Returns None if not a valid base64 data URI.
fn parse_data_uri(url: &str) -> Option<(String, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (mime_part, data) = rest.split_once(',')?;
    // Only handle base64-encoded data URIs
    if !mime_part.ends_with(";base64") {
        return None;
    }
    let media_type = mime_part.strip_suffix(";base64")?.to_string();
    Some((media_type, data))
}

/// Guess image MIME type from URL extension
fn guess_image_mime(url: &str) -> &'static str {
    let lower = url.to_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { "image/jpeg" }
    else if lower.ends_with(".png") { "image/png" }
    else if lower.ends_with(".gif") { "image/gif" }
    else if lower.ends_with(".webp") { "image/webp" }
    else if lower.ends_with(".svg") { "image/svg+xml" }
    else { "image/png" } // fallback
}

/// Convert MessageContent to Anthropic content blocks (handles images)
pub fn content_to_anthropic(content: &MessageContent) -> serde_json::Value {
    match content {
        MessageContent::Text(s) => serde_json::json!(s),
        MessageContent::Parts(parts) => {
            let blocks: Vec<serde_json::Value> = parts
                .iter()
                .map(|p| match p {
                    ContentPart::Text { text } => {
                        serde_json::json!({ "type": "text", "text": text })
                    }
                    ContentPart::ImageUrl { image_url } => {
                        if let Some((media_type, data)) = parse_data_uri(&image_url.url) {
                            return serde_json::json!({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": data,
                                }
                            });
                        }
                        serde_json::json!({
                            "type": "image",
                            "source": { "type": "url", "url": image_url.url }
                        })
                    }
                })
                .collect();
            serde_json::json!(blocks)
        }
    }
}

/// Convert MessageContent to Gemini parts (handles images)
pub fn content_to_gemini_parts(content: &MessageContent) -> Vec<serde_json::Value> {
    match content {
        MessageContent::Text(s) => vec![serde_json::json!({ "text": s })],
        MessageContent::Parts(parts) => parts
            .iter()
            .map(|p| match p {
                ContentPart::Text { text } => serde_json::json!({ "text": text }),
                ContentPart::ImageUrl { image_url } => {
                    if let Some((mime_type, data)) = parse_data_uri(&image_url.url) {
                        return serde_json::json!({
                            "inlineData": {
                                "mimeType": mime_type,
                                "data": data,
                            }
                        });
                    }
                    // URL-based: try to guess MIME from extension
                    let mime = guess_image_mime(&image_url.url);
                    serde_json::json!({
                        "fileData": {
                            "fileUri": image_url.url,
                            "mimeType": mime,
                        }
                    })
                }
            })
            .collect(),
    }
}

/// Emit fallback response content as stream events (used when falling back from
/// streaming to non-streaming — emits the full response as a single delta).
pub fn emit_fallback_content<F: Fn(StreamEvent)>(response: &LLMResponse, on_event: &F) {
    if let Some(ref c) = response.message.content {
        if let Some(text) = c.as_text() {
            if !text.is_empty() {
                on_event(StreamEvent::ContentDelta(text.to_string()));
            }
        }
    }
    on_event(StreamEvent::Done);
}

/// Build an LLMResponse from accumulated streaming state
pub fn build_stream_response(
    full_content: String,
    tool_calls: Option<Vec<ToolCall>>,
) -> LLMResponse {
    let has_tool_calls = tool_calls.as_ref().map_or(false, |t| !t.is_empty());
    let content = if full_content.is_empty() {
        None
    } else {
        Some(MessageContent::text(full_content))
    };
    LLMResponse {
        message: LLMMessage {
            role: "assistant".into(),
            content,
            tool_calls: if has_tool_calls { tool_calls } else { None },
            tool_call_id: None,
        },
    }
}
