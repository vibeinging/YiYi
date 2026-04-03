use crate::engine::tools::{FunctionCall, ToolCall, ToolDefinition};

use super::retry::send_with_retry;
use super::stream::{process_anthropic_sse_stream, StreamError};
use super::types::*;

// ── Message conversion ──────────────────────────────────────────────

/// Convert our messages to Anthropic format.
/// Merges consecutive tool_result messages into a single user message.
fn messages_to_anthropic(messages: &[LLMMessage]) -> (Option<String>, Vec<serde_json::Value>) {
    let mut system_prompt: Option<String> = None;
    let mut anthropic_msgs: Vec<serde_json::Value> = Vec::new();
    let mut tool_result_buffer: Vec<serde_json::Value> = Vec::new();

    let flush_tool_results =
        |buf: &mut Vec<serde_json::Value>, out: &mut Vec<serde_json::Value>| {
            if !buf.is_empty() {
                out.push(serde_json::json!({
                    "role": "user",
                    "content": serde_json::Value::Array(buf.drain(..).collect()),
                }));
            }
        };

    for msg in messages {
        if msg.role == "system" {
            let text = msg
                .content
                .as_ref()
                .map(|c| c.as_text().unwrap_or("").to_string())
                .unwrap_or_default();
            if !text.is_empty() {
                system_prompt = Some(match system_prompt {
                    Some(existing) => format!("{}\n\n{}", existing, text),
                    None => text,
                });
            }
            continue;
        }

        if msg.role == "tool" {
            let content = msg
                .content
                .as_ref()
                .map(|c| content_to_anthropic(c))
                .unwrap_or(serde_json::json!(""));
            tool_result_buffer.push(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": msg.tool_call_id.as_deref().unwrap_or_else(|| {
                    log::warn!("Anthropic tool_result missing tool_use_id");
                    ""
                }),
                "content": content,
            }));
            continue;
        }

        flush_tool_results(&mut tool_result_buffer, &mut anthropic_msgs);

        if msg.role == "assistant" {
            if let Some(ref tool_calls) = msg.tool_calls {
                let mut content_blocks: Vec<serde_json::Value> = Vec::new();
                if let Some(ref c) = msg.content {
                    let text = c.as_text().unwrap_or("");
                    if !text.is_empty() {
                        content_blocks
                            .push(serde_json::json!({ "type": "text", "text": text }));
                    }
                }
                for tc in tool_calls {
                    let input: serde_json::Value =
                        serde_json::from_str(&tc.function.arguments)
                            .unwrap_or(serde_json::json!({}));
                    content_blocks.push(serde_json::json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.function.name,
                        "input": input,
                    }));
                }
                anthropic_msgs
                    .push(serde_json::json!({ "role": "assistant", "content": content_blocks }));
                continue;
            }
        }

        let content = msg
            .content
            .as_ref()
            .map(|c| content_to_anthropic(c))
            .unwrap_or(serde_json::json!(""));
        anthropic_msgs.push(serde_json::json!({
            "role": &msg.role,
            "content": content,
        }));
    }

    flush_tool_results(&mut tool_result_buffer, &mut anthropic_msgs);
    (system_prompt, anthropic_msgs)
}

/// Normalize Anthropic stop_reason to our unified finish_reason
fn normalize_stop_reason(stop_reason: &str) -> String {
    match stop_reason {
        "tool_use" => "tool_calls".to_string(),
        "end_turn" | "stop_sequence" => "stop".to_string(),
        other => other.to_string(),
    }
}

/// Convert tool definitions to Anthropic format
fn tools_to_anthropic(tools: &[ToolDefinition]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.function.name,
                "description": t.function.description,
                "input_schema": t.function.parameters,
            })
        })
        .collect()
}

// ── Response parsing ────────────────────────────────────────────────

fn parse_anthropic_response(json: &serde_json::Value) -> Result<LLMResponse, String> {
    let content_blocks = json["content"].as_array();

    let mut text_parts = Vec::new();
    let mut tool_calls = Vec::new();

    if let Some(blocks) = content_blocks {
        for block in blocks {
            match block["type"].as_str() {
                Some("text") => {
                    if let Some(t) = block["text"].as_str() {
                        text_parts.push(t.to_string());
                    }
                }
                Some("tool_use") => {
                    tool_calls.push(ToolCall {
                        id: block["id"].as_str().unwrap_or("").to_string(),
                        r#type: "function".to_string(),
                        function: FunctionCall {
                            name: block["name"].as_str().unwrap_or("").to_string(),
                            arguments: block["input"].to_string(),
                        },
                    });
                }
                _ => {}
            }
        }
    }

    let content = if text_parts.is_empty() {
        None
    } else {
        Some(MessageContent::text(text_parts.join("")))
    };
    Ok(LLMResponse {
        message: LLMMessage {
            role: "assistant".into(),
            content,
            tool_calls: if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls)
            },
            tool_call_id: None,
        },
    })
}

// ── HTTP helpers ────────────────────────────────────────────────────

fn build_request_body(
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
    stream: bool,
) -> serde_json::Value {
    let (system_prompt, anthropic_msgs) = messages_to_anthropic(messages);

    let mut body = serde_json::json!({
        "model": config.model,
        "messages": anthropic_msgs,
        "max_tokens": 4096,
    });
    if stream {
        body["stream"] = serde_json::json!(true);
    }
    if let Some(sys) = system_prompt {
        body["system"] = serde_json::Value::String(sys);
    }
    if !tools.is_empty() {
        body["tools"] = serde_json::Value::Array(tools_to_anthropic(tools));
    }
    body
}

async fn send_request(
    client: &reqwest::Client,
    url: &str,
    config: &LLMConfig,
    body: &serde_json::Value,
    timeout_secs: u64,
) -> Result<reqwest::Response, String> {
    let url = url.to_string();
    let api_key = config.api_key.clone();
    let body = body.clone();
    let needs_ua = super::needs_coding_agent_ua(&url);
    let client = client.clone();

    let outcome = send_with_retry(
        "Anthropic",
        || {
            let mut req = client
                .post(&url)
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .header("Content-Type", "application/json");
            if needs_ua {
                req = req.header("User-Agent", super::CODING_AGENT_UA);
            }
            req.json(&body)
        },
        std::time::Duration::from_secs(timeout_secs),
    )
    .await
    .map_err(|(msg, _cat)| msg)?;

    Ok(outcome.response)
}

// ── Public API ──────────────────────────────────────────────────────

pub async fn chat_completion(
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
) -> Result<LLMResponse, String> {
    let client = super::http_client();
    let url = format!("{}/v1/messages", config.base_url.trim_end_matches('/'));
    let body = build_request_body(config, messages, tools, false);

    let resp = send_request(client, &url, config, &body, 120).await?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    parse_anthropic_response(&json)
}

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
    let client = super::http_client();
    let url = format!("{}/v1/messages", config.base_url.trim_end_matches('/'));
    let body = build_request_body(config, messages, tools, true);

    log::info!(
        "LLM stream request [anthropic]: model={}, url={}",
        config.model, url
    );

    let resp = send_request(client, &url, config, &body, 300).await?;

    // --- Try streaming first ---
    match try_stream_anthropic(resp, cancelled, &on_event).await {
        Ok(response) => Ok(response),
        Err(StreamError::Cancelled) => Err("cancelled".to_string()),
        Err(e) if e.is_fallback_eligible() => {
            // Stream died — fall back to non-streaming
            log::warn!("Anthropic stream failed ({}), falling back to non-streaming", e);
            on_event(StreamEvent::Fallback);

            let ns_body = build_request_body(config, messages, tools, false);
            let ns_resp = send_request(client, &url, config, &ns_body, 120).await?;
            let json: serde_json::Value = ns_resp.json().await.map_err(|e| e.to_string())?;
            let response = parse_anthropic_response(&json)?;
            emit_fallback_content(&response, &on_event);
            Ok(response)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Attempt to consume an Anthropic SSE stream, returning the assembled response.
async fn try_stream_anthropic<F>(
    resp: reqwest::Response,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
    on_event: &F,
) -> Result<LLMResponse, StreamError>
where
    F: Fn(StreamEvent) + Send + 'static,
{
    let mut full_content = String::new();
    let mut finish_reason = "stop".to_string();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut current_tool_id = String::new();
    let mut current_tool_name = String::new();
    let mut current_tool_input = String::new();

    {
        let fc = &mut full_content;
        let fr = &mut finish_reason;
        let tcs = &mut tool_calls;
        let ct_id = &mut current_tool_id;
        let ct_name = &mut current_tool_name;
        let ct_input = &mut current_tool_input;

        process_anthropic_sse_stream(resp, cancelled, |event_type, json| {
            match event_type {
                "content_block_start" => {
                    let cb = &json["content_block"];
                    if cb["type"].as_str() == Some("tool_use") {
                        *ct_id = cb["id"].as_str().unwrap_or("").to_string();
                        *ct_name = cb["name"].as_str().unwrap_or("").to_string();
                        ct_input.clear();
                    }
                }
                "content_block_delta" => {
                    let delta = &json["delta"];
                    match delta["type"].as_str() {
                        Some("text_delta") => {
                            if let Some(text) = delta["text"].as_str() {
                                if !text.is_empty() {
                                    fc.push_str(text);
                                    on_event(StreamEvent::ContentDelta(text.to_string()));
                                }
                            }
                        }
                        Some("input_json_delta") => {
                            if let Some(partial) = delta["partial_json"].as_str() {
                                ct_input.push_str(partial);
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    if !ct_id.is_empty() {
                        tcs.push(ToolCall {
                            id: ct_id.clone(),
                            r#type: "function".to_string(),
                            function: FunctionCall {
                                name: ct_name.clone(),
                                arguments: ct_input.clone(),
                            },
                        });
                        ct_id.clear();
                        ct_name.clear();
                        ct_input.clear();
                    }
                }
                "message_delta" => {
                    if let Some(sr) = json["delta"]["stop_reason"].as_str() {
                        *fr = normalize_stop_reason(sr);
                    }
                }
                "error" => {
                    let err_msg = json["error"]["message"]
                        .as_str()
                        .or_else(|| json["message"].as_str())
                        .unwrap_or("Unknown Anthropic stream error");
                    log::error!("Anthropic stream error event: {}", err_msg);
                    return Err(format!("Anthropic stream error: {}", err_msg));
                }
                _ => {}
            }
            Ok(true)
        })
        .await?;
    }

    on_event(StreamEvent::Done);

    if full_content.is_empty() && tool_calls.is_empty() {
        log::warn!(
            "Anthropic stream completed with no content and no tool calls (model: {})",
            "anthropic"
        );
    }

    let tool_calls_opt = if tool_calls.is_empty() {
        None
    } else {
        Some(tool_calls)
    };
    Ok(build_stream_response(full_content, tool_calls_opt))
}
