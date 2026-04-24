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
    // Parse Anthropic usage data
    let usage = parse_usage(&json["usage"]);

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
        usage,
    })
}

/// Parse Anthropic usage JSON into TokenUsage.
fn parse_usage(v: &serde_json::Value) -> Option<crate::engine::usage::TokenUsage> {
    if v.is_null() { return None; }
    Some(crate::engine::usage::TokenUsage {
        input_tokens: v["input_tokens"].as_u64().unwrap_or(0) as u32,
        output_tokens: v["output_tokens"].as_u64().unwrap_or(0) as u32,
        cache_creation_input_tokens: v["cache_creation_input_tokens"].as_u64().unwrap_or(0) as u32,
        cache_read_input_tokens: v["cache_read_input_tokens"].as_u64().unwrap_or(0) as u32,
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
        // Anthropic prompt caching: `cache_control: ephemeral` on a content
        // block marks everything UP TO AND INCLUDING that block as the
        // cache key. If we put one marker on the full prompt, the cache key
        // includes per-session variables (workspace path, git context,
        // MCP status, bootstrap…) — cache misses every session.
        //
        // `build_system_prompt` (engine/react_agent/prompt.rs) emits a
        // literal `<!-- yiyi:cache_boundary -->` at the seam between the
        // fully-static cross-user prefix (~3,385 tokens) and the dynamic
        // tail (~150-1500 tokens per session). We split here and put the
        // marker only on the static block so the static prefix is cached
        // across all users and all sessions. The dynamic tail runs at full
        // price — but it's small and per-session anyway.
        const CACHE_BOUNDARY: &str = "<!-- yiyi:cache_boundary -->";
        let blocks: Vec<serde_json::Value> =
            if let Some((static_part, dynamic_part)) = sys.split_once(CACHE_BOUNDARY) {
                let mut v = vec![serde_json::json!({
                    "type": "text",
                    "text": static_part,
                    "cache_control": {"type": "ephemeral"}
                })];
                let trimmed_tail = dynamic_part.trim_start_matches(['\n', ' ']);
                if !trimmed_tail.is_empty() {
                    v.push(serde_json::json!({
                        "type": "text",
                        "text": trimmed_tail,
                    }));
                }
                v
            } else {
                // Fallback — caller didn't produce a boundary (e.g. a custom
                // system_prompt from a test). Cache the whole thing like we
                // used to.
                vec![serde_json::json!({
                    "type": "text",
                    "text": sys,
                    "cache_control": {"type": "ephemeral"}
                })]
            };
        body["system"] = serde_json::Value::Array(blocks);
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
                .header("anthropic-beta", "prompt-caching-2024-07-31")
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
    let mut stream_usage: Option<crate::engine::usage::TokenUsage> = None;

    {
        let fc = &mut full_content;
        let fr = &mut finish_reason;
        let tcs = &mut tool_calls;
        let ct_id = &mut current_tool_id;
        let ct_name = &mut current_tool_name;
        let ct_input = &mut current_tool_input;
        let su = &mut stream_usage;

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
                "message_start" => {
                    // Anthropic sends input usage in message_start.usage
                    if let Some(u) = parse_usage(&json["message"]["usage"]) {
                        *su = Some(u);
                    }
                }
                "message_delta" => {
                    if let Some(sr) = json["delta"]["stop_reason"].as_str() {
                        *fr = normalize_stop_reason(sr);
                    }
                    // Anthropic sends output_tokens in message_delta.usage
                    if let Some(out) = json["usage"]["output_tokens"].as_u64() {
                        if let Some(ref mut u) = su {
                            u.output_tokens = out as u32;
                        }
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
    Ok(build_stream_response(full_content, tool_calls_opt, stream_usage))
}

#[cfg(test)]
mod cache_split_tests {
    use super::*;
    use crate::engine::llm_client::types::{LLMMessage, MessageContent};

    fn msg(role: &str, text: &str) -> LLMMessage {
        LLMMessage {
            role: role.into(),
            content: Some(MessageContent::text(text)),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    fn cfg() -> LLMConfig {
        LLMConfig {
            base_url: "https://api.anthropic.com/v1/messages".into(),
            api_key: "sk-ant-test".into(),
            model: "claude-sonnet-4-6".into(),
            provider_id: "anthropic".into(),
            native_tools: vec![],
        }
    }

    #[test]
    fn system_prompt_with_boundary_splits_into_two_blocks() {
        let sys = "STATIC part here\n\n<!-- yiyi:cache_boundary -->\n\nDYNAMIC part here";
        let messages = vec![msg("system", sys), msg("user", "hi")];
        let body = build_request_body(&cfg(), &messages, &[], false);

        let system = body.get("system").expect("system must be present");
        let arr = system.as_array().expect("system must be an array");
        assert_eq!(arr.len(), 2, "expected 2 blocks (static + dynamic)");

        let first = &arr[0];
        assert_eq!(first["type"], "text");
        assert!(first["text"].as_str().unwrap().starts_with("STATIC part"));
        assert_eq!(first["cache_control"]["type"], "ephemeral",
            "static block MUST carry cache_control");

        let second = &arr[1];
        assert_eq!(second["type"], "text");
        assert!(second["text"].as_str().unwrap().starts_with("DYNAMIC part"));
        assert!(second.get("cache_control").is_none(),
            "dynamic block must NOT carry cache_control (would bust cache key)");
    }

    #[test]
    fn system_prompt_without_boundary_caches_whole_thing() {
        let sys = "One big static prompt with no boundary marker.";
        let messages = vec![msg("system", sys), msg("user", "hi")];
        let body = build_request_body(&cfg(), &messages, &[], false);

        let arr = body["system"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn empty_dynamic_tail_is_dropped() {
        // If the prompt ends exactly at the boundary marker (no dynamic
        // content), don't emit a second empty block — Anthropic rejects
        // empty text blocks.
        let sys = "STATIC only\n\n<!-- yiyi:cache_boundary -->\n\n";
        let messages = vec![msg("system", sys), msg("user", "hi")];
        let body = build_request_body(&cfg(), &messages, &[], false);

        let arr = body["system"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "empty dynamic tail should be dropped");
        assert!(arr[0]["text"].as_str().unwrap().starts_with("STATIC only"));
    }
}
