use crate::engine::tools::{FunctionCall, ToolCall, ToolDefinition};

use super::retry::send_with_retry;
use super::stream::{process_sse_stream, StreamError};
use super::types::*;

fn apply_native_tools(
    body: &mut serde_json::Value,
    tools: &[ToolDefinition],
    native_tools: &[NativeToolInjection],
) {
    let mut tools_array: Vec<serde_json::Value> = tools
        .iter()
        .filter_map(|t| serde_json::to_value(t).ok())
        .collect();

    for nt in native_tools {
        match nt.inject_mode.as_str() {
            "tools_array" => {
                tools_array.push(nt.config.clone());
            }
            "extra_body" => {
                if let Some(obj) = nt.config.as_object() {
                    for (k, v) in obj {
                        body[k] = v.clone();
                    }
                }
            }
            _ => {}
        }
    }

    if !tools_array.is_empty() {
        body["tools"] = serde_json::json!(tools_array);
    }
}

/// Check if model is an OpenAI reasoning model (o1/o3/o4 series).
/// Only applies to OpenAI's own API — third-party providers (DeepSeek, DashScope, etc.)
/// use the same endpoint format but don't support developer role or max_completion_tokens.
fn is_reasoning_model(config: &LLMConfig) -> bool {
    let is_openai_provider = config.provider_id == "openai"
        || config.base_url.contains("openai.com");
    if !is_openai_provider {
        return false;
    }
    let m = config.model.to_lowercase();
    m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4")
}

/// Prepare messages JSON, remapping system→developer for reasoning models
fn prepare_messages(config: &LLMConfig, messages: &[LLMMessage]) -> serde_json::Value {
    if is_reasoning_model(config) {
        let mut msgs = serde_json::to_value(messages).unwrap_or_default();
        if let Some(arr) = msgs.as_array_mut() {
            for m in arr.iter_mut() {
                if m["role"].as_str() == Some("system") {
                    m["role"] = serde_json::json!("developer");
                }
            }
        }
        msgs
    } else {
        serde_json::to_value(messages).unwrap_or_default()
    }
}

/// Build request body with model-appropriate token limits
fn build_body(config: &LLMConfig, messages_value: serde_json::Value, stream: bool) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages_value,
    });
    if is_reasoning_model(config) {
        body["max_completion_tokens"] = serde_json::json!(16384);
    } else {
        body["max_tokens"] = serde_json::json!(4096);
    }
    if stream {
        body["stream"] = serde_json::json!(true);
        // Request usage data in stream (OpenAI / compatible providers)
        body["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    body
}

/// Send HTTP request with OpenAI auth headers (with shared retry engine)
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
        "LLM",
        || {
            let mut req = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
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

/// OpenAI-compatible chat completion (non-streaming)
pub async fn chat_completion(
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
    native_tools: &[NativeToolInjection],
) -> Result<LLMResponse, String> {
    let client = super::http_client();
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));

    let messages_value = prepare_messages(config, messages);
    let mut body = build_body(config, messages_value, false);
    apply_native_tools(&mut body, tools, native_tools);

    let resp = send_request(client, &url, config, &body, 120).await?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let choice = &json["choices"][0];
    let msg = &choice["message"];
    let content = msg["content"].as_str().map(|s| MessageContent::text(s));
    let tool_calls = parse_tool_calls(&msg["tool_calls"]);

    // Parse OpenAI usage
    let usage = parse_openai_usage(&json["usage"]);

    Ok(LLMResponse {
        message: LLMMessage {
            role: "assistant".into(),
            content,
            tool_calls,
            tool_call_id: None,
        },
        usage,
    })
}

/// Parse OpenAI usage JSON into TokenUsage.
fn parse_openai_usage(v: &serde_json::Value) -> Option<crate::engine::usage::TokenUsage> {
    if v.is_null() { return None; }
    Some(crate::engine::usage::TokenUsage {
        input_tokens: v["prompt_tokens"].as_u64().unwrap_or(0) as u32,
        output_tokens: v["completion_tokens"].as_u64().unwrap_or(0) as u32,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: v["prompt_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0) as u32,
    })
}

/// OpenAI-compatible streaming chat completion — with automatic fallback to
/// non-streaming when the SSE stream dies (idle timeout, connection reset).
pub async fn chat_completion_stream<F>(
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
    native_tools: &[NativeToolInjection],
    on_event: F,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<LLMResponse, String>
where
    F: Fn(StreamEvent) + Send + 'static,
{
    let client = super::http_client();
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));

    let messages_value = prepare_messages(config, messages);
    let mut body = build_body(config, messages_value.clone(), true);
    apply_native_tools(&mut body, tools, native_tools);

    log::info!(
        "LLM stream request [openai]: model={}, url={}, messages={}",
        config.model, url, messages.len()
    );

    let resp = send_request(client, &url, config, &body, 300).await?;

    // --- Try streaming first ---
    match try_stream_openai(resp, cancelled, &on_event).await {
        Ok(response) => Ok(response),
        Err(StreamError::Cancelled) => Err("cancelled".to_string()),
        Err(e) if e.is_fallback_eligible() => {
            // Stream died — fall back to non-streaming
            log::warn!("OpenAI stream failed ({}), falling back to non-streaming", e);
            on_event(StreamEvent::Fallback);

            let mut ns_body = build_body(config, messages_value, false);
            apply_native_tools(&mut ns_body, tools, native_tools);
            let ns_resp = send_request(client, &url, config, &ns_body, 120).await?;
            let json: serde_json::Value = ns_resp.json().await.map_err(|e| e.to_string())?;

            let choice = &json["choices"][0];
            let msg = &choice["message"];
            let content_text = msg["content"].as_str().unwrap_or("").to_string();
            let tool_calls = parse_tool_calls(&msg["tool_calls"]);
            let usage = parse_openai_usage(&json["usage"]);
            let response = build_stream_response(content_text, tool_calls, usage);
            emit_fallback_content(&response, &on_event);
            Ok(response)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Attempt to consume an OpenAI SSE stream, returning the assembled response.
async fn try_stream_openai<F>(
    resp: reqwest::Response,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
    on_event: &F,
) -> Result<LLMResponse, StreamError>
where
    F: Fn(StreamEvent) + Send + 'static,
{
    let mut full_content = String::new();
    let mut finish_reason = "stop".to_string();
    let mut tool_call_acc: std::collections::BTreeMap<u32, (String, String, String)> =
        std::collections::BTreeMap::new();
    let mut stream_usage: Option<crate::engine::usage::TokenUsage> = None;

    {
        let fc = &mut full_content;
        let fr = &mut finish_reason;
        let tca = &mut tool_call_acc;
        let su = &mut stream_usage;

        process_sse_stream(resp, cancelled, |data| {
            let json = match serde_json::from_str::<serde_json::Value>(data) {
                Ok(j) => j,
                Err(e) => {
                    log::warn!("OpenAI SSE JSON parse error: {} — data: {}", e, &data.chars().take(200).collect::<String>());
                    return true;
                }
            };
            {
                if let Some(err) = json.get("error") {
                    let msg = err["message"].as_str().unwrap_or("Unknown stream error");
                    log::error!("OpenAI mid-stream error: {}", msg);
                    *fr = format!("error: {}", msg);
                    return false;
                }
                // Capture usage from stream (usually in last chunk)
                if !json["usage"].is_null() {
                    *su = parse_openai_usage(&json["usage"]);
                }
                let choice = &json["choices"][0];
                if let Some(f) = choice["finish_reason"].as_str() {
                    *fr = f.to_string();
                }
                let delta = &choice["delta"];
                if let Some(reasoning) = delta["reasoning_content"].as_str() {
                    if !reasoning.is_empty() {
                        on_event(StreamEvent::ReasoningDelta(reasoning.to_string()));
                    }
                }
                if let Some(text) = delta["content"].as_str() {
                    if !text.is_empty() {
                        fc.push_str(text);
                        on_event(StreamEvent::ContentDelta(text.to_string()));
                    }
                }
                if let Some(tc_array) = delta["tool_calls"].as_array() {
                    for tc in tc_array {
                        let index = tc["index"].as_u64().unwrap_or(0) as u32;
                        let entry = tca
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
            true
        })
        .await?;
    }

    on_event(StreamEvent::Done);

    let has_tool_calls = !tool_call_acc.is_empty();
    let tool_calls = if !has_tool_calls {
        None
    } else {
        Some(
            tool_call_acc
                .into_values()
                .map(|(id, name, arguments)| {
                    let safe_arguments = if serde_json::from_str::<serde_json::Value>(&arguments).is_ok() {
                        arguments
                    } else if let Some(repaired) = crate::engine::tools::repair_json(&arguments) {
                        log::warn!(
                            "Repaired malformed JSON arguments for tool '{}': {}",
                            name,
                            arguments.chars().take(200).collect::<String>()
                        );
                        serde_json::to_string(&repaired).unwrap_or_else(|_| "{}".to_string())
                    } else {
                        log::warn!(
                            "Tool call '{}' has unrecoverable invalid JSON arguments, defaulting to {{}}: {}",
                            name,
                            arguments.chars().take(200).collect::<String>()
                        );
                        "{}".to_string()
                    };
                    ToolCall {
                        id,
                        r#type: "function".to_string(),
                        function: FunctionCall { name, arguments: safe_arguments },
                    }
                })
                .collect(),
        )
    };

    if full_content.is_empty() && !has_tool_calls {
        log::warn!("LLM stream completed with no content and no tool calls (finish_reason: {})", finish_reason);
    }

    // Usage captured from stream chunks (last chunk usually has it)
    Ok(build_stream_response(full_content, tool_calls, stream_usage))
}

/// Parse tool_calls array from OpenAI response JSON
fn parse_tool_calls(value: &serde_json::Value) -> Option<Vec<ToolCall>> {
    value.as_array().and_then(|calls| {
        let parsed: Vec<ToolCall> = calls
            .iter()
            .filter_map(|c| serde_json::from_value(c.clone()).ok())
            .collect();
        if parsed.is_empty() { None } else { Some(parsed) }
    })
}
