use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::engine::tools::{FunctionCall, ToolCall, ToolDefinition};

use super::stream::process_sse_stream;
use super::types::*;

/// Global counter for generating unique tool call IDs across turns
static TOOL_CALL_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_tool_call_id() -> String {
    let id = TOOL_CALL_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("gemini_call_{}", id)
}

// ── Message conversion ──────────────────────────────────────────────

/// Convert our messages to Gemini format.
/// Builds tool_call_id→function_name map, merges consecutive tool results.
fn messages_to_gemini(
    messages: &[LLMMessage],
) -> (Option<String>, Vec<serde_json::Value>) {
    let mut system_instruction: Option<String> = None;
    let mut contents = Vec::new();

    // Build id→name mapping from assistant tool calls
    let mut id_to_name: HashMap<String, String> = HashMap::new();
    for msg in messages {
        if let Some(ref tool_calls) = msg.tool_calls {
            for tc in tool_calls {
                id_to_name.insert(tc.id.clone(), tc.function.name.clone());
            }
        }
    }

    let mut tool_parts_buffer: Vec<serde_json::Value> = Vec::new();

    let flush_tool_parts =
        |buf: &mut Vec<serde_json::Value>, out: &mut Vec<serde_json::Value>| {
            if !buf.is_empty() {
                out.push(serde_json::json!({
                    "role": "user",
                    "parts": serde_json::Value::Array(buf.drain(..).collect()),
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
                system_instruction = Some(match system_instruction {
                    Some(existing) => format!("{}\n\n{}", existing, text),
                    None => text,
                });
            }
            continue;
        }

        if msg.role == "tool" {
            let content_text = msg
                .content
                .as_ref()
                .map(|c| c.as_text().unwrap_or("").to_string())
                .unwrap_or_default();
            let response_val: serde_json::Value = serde_json::from_str(&content_text)
                .unwrap_or(serde_json::json!({ "result": content_text }));
            let func_name = msg
                .tool_call_id
                .as_ref()
                .and_then(|id| {
                    let name = id_to_name.get(id);
                    if name.is_none() {
                        log::warn!("Gemini: no function name found for tool_call_id={}, using fallback", id);
                    }
                    name
                })
                .map(|s| s.as_str())
                .unwrap_or("unknown");
            tool_parts_buffer.push(serde_json::json!({
                "functionResponse": {
                    "name": func_name,
                    "response": response_val,
                }
            }));
            continue;
        }

        // Non-tool message: flush buffer
        flush_tool_parts(&mut tool_parts_buffer, &mut contents);

        if msg.role == "assistant" {
            if let Some(ref tool_calls) = msg.tool_calls {
                let mut parts: Vec<serde_json::Value> = Vec::new();
                if let Some(ref c) = msg.content {
                    let text = c.as_text().unwrap_or("");
                    if !text.is_empty() {
                        parts.push(serde_json::json!({ "text": text }));
                    }
                }
                for tc in tool_calls {
                    let args: serde_json::Value =
                        serde_json::from_str(&tc.function.arguments)
                            .unwrap_or(serde_json::json!({}));
                    parts.push(serde_json::json!({
                        "functionCall": {
                            "name": tc.function.name,
                            "args": args,
                        }
                    }));
                }
                contents.push(serde_json::json!({ "role": "model", "parts": parts }));
                continue;
            }
        }

        let role = match msg.role.as_str() {
            "assistant" => "model",
            _ => "user",
        };
        let parts = msg
            .content
            .as_ref()
            .map(|c| content_to_gemini_parts(c))
            .unwrap_or_else(|| vec![serde_json::json!({ "text": "" })]);
        contents.push(serde_json::json!({ "role": role, "parts": parts }));
    }

    flush_tool_parts(&mut tool_parts_buffer, &mut contents);
    (system_instruction, contents)
}

fn tools_to_gemini(tools: &[ToolDefinition]) -> Vec<serde_json::Value> {
    let declarations: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.function.name,
                "description": t.function.description,
                "parameters": t.function.parameters,
            })
        })
        .collect();
    vec![serde_json::json!({ "functionDeclarations": declarations })]
}

// ── Response parsing ────────────────────────────────────────────────

fn parse_gemini_response(json: &serde_json::Value) -> Result<LLMResponse, String> {
    let candidate = &json["candidates"][0];
    let finish_reason_raw = candidate["finishReason"].as_str().unwrap_or("STOP");

    // Safety filter detection
    if finish_reason_raw == "SAFETY" {
        let ratings = candidate["safetyRatings"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|r| {
                        let cat = r["category"].as_str()?;
                        let prob = r["probability"].as_str()?;
                        Some(format!("{}: {}", cat, prob))
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        return Err(format!(
            "Gemini blocked by safety filter. Ratings: {}",
            ratings
        ));
    }

    let parts = candidate["content"]["parts"].as_array();
    let mut text_parts = Vec::new();
    let mut tool_calls = Vec::new();

    if let Some(parts) = parts {
        for (_i, part) in parts.iter().enumerate() {
            if let Some(t) = part["text"].as_str() {
                text_parts.push(t.to_string());
            }
            if let Some(fc) = part.get("functionCall") {
                tool_calls.push(ToolCall {
                    id: next_tool_call_id(),
                    r#type: "function".to_string(),
                    function: FunctionCall {
                        name: fc["name"].as_str().unwrap_or("").to_string(),
                        arguments: fc["args"].to_string(),
                    },
                });
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

fn build_body(
    _config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
) -> (serde_json::Value, Vec<serde_json::Value>) {
    let (system_instruction, contents) = messages_to_gemini(messages);

    let mut body = serde_json::json!({
        "contents": contents,
        "generationConfig": { "maxOutputTokens": 8192 },
    });
    if let Some(sys) = system_instruction {
        body["systemInstruction"] = serde_json::json!({ "parts": [{ "text": sys }] });
    }
    if !tools.is_empty() {
        body["tools"] = serde_json::Value::Array(tools_to_gemini(tools));
    }
    (body, contents)
}

async fn send_request(
    client: &reqwest::Client,
    url: &str,
    config: &LLMConfig,
    body: &serde_json::Value,
    timeout_secs: u64,
) -> Result<reqwest::Response, String> {
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("x-goog-api-key", &config.api_key)
        .json(body)
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        log::error!("Gemini API error ({}): {}", status, text);
        return Err(format!("Gemini API error ({}): {}", status, text));
    }
    Ok(resp)
}

// ── Public API ──────────────────────────────────────────────────────

pub async fn chat_completion(
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
) -> Result<LLMResponse, String> {
    let client = super::http_client();
    let url = format!(
        "{}/models/{}:generateContent",
        config.base_url.trim_end_matches('/'),
        config.model,
    );

    let (body, _) = build_body(config, messages, tools);
    let resp = send_request(client, &url, config, &body, 120).await?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    parse_gemini_response(&json)
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
    let url = format!(
        "{}/models/{}:streamGenerateContent?alt=sse",
        config.base_url.trim_end_matches('/'),
        config.model,
    );

    let (body, contents) = build_body(config, messages, tools);

    log::info!(
        "LLM stream request [google]: model={}, messages={}",
        config.model,
        contents.len()
    );

    let resp = send_request(client, &url, config, &body, 300).await?;

    let mut full_content = String::new();
    let mut finish_reason = "stop".to_string();
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    {
        let fc = &mut full_content;
        let fr = &mut finish_reason;
        let tcs = &mut tool_calls;

        process_sse_stream(resp, cancelled, |data| {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                let candidate = &json["candidates"][0];
                if let Some(fr_raw) = candidate["finishReason"].as_str() {
                    match fr_raw {
                        "SAFETY" => {
                            log::error!("Gemini safety filter triggered during streaming");
                            *fr = "safety".to_string();
                            return false; // stop stream, will be reported as error below
                        }
                        "STOP" => *fr = "stop".to_string(),
                        other => *fr = other.to_lowercase(),
                    };
                }
                if let Some(parts) = candidate["content"]["parts"].as_array() {
                    for part in parts {
                        if let Some(text) = part["text"].as_str() {
                            if !text.is_empty() {
                                fc.push_str(text);
                                on_event(StreamEvent::ContentDelta(text.to_string()));
                            }
                        }
                        if let Some(fc_obj) = part.get("functionCall") {
                            let name = fc_obj["name"].as_str().unwrap_or("").to_string();
                            let args = fc_obj["args"].to_string();
                            tcs.push(ToolCall {
                                id: next_tool_call_id(),
                                r#type: "function".to_string(),
                                function: FunctionCall { name, arguments: args },
                            });
                            *fr = "tool_calls".to_string();
                        }
                    }
                }
            }
            true
        })
        .await?;
    }

    // Check for safety filter before emitting Done
    if finish_reason == "safety" {
        return Err("Gemini blocked by safety filter during streaming".to_string());
    }

    on_event(StreamEvent::Done);

    if full_content.is_empty() && tool_calls.is_empty() {
        log::warn!(
            "Gemini stream completed with no content and no tool calls (model: {})",
            config.model
        );
    }

    let tool_calls_opt = if tool_calls.is_empty() {
        None
    } else {
        Some(tool_calls)
    };
    Ok(build_stream_response(
        full_content,
        tool_calls_opt,
    ))
}
