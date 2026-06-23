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
/// and stripping image content parts for text-only providers.
///
/// DeepSeek V4 is text-only — it rejects requests where any message has a
/// `content` part of type `image_url` (returns "unknown variant `image_url`,
/// expected `text`"). We still let vision-capable providers (which the
/// agent's screenshot tools target) receive raw images, but for DeepSeek we
/// flatten image parts to a `[image attached: <url-or-data-uri-prefix>]`
/// text placeholder so multi-turn history stays valid.
fn prepare_messages(config: &LLMConfig, messages: &[LLMMessage]) -> serde_json::Value {
    let mut msgs = serde_json::to_value(messages).unwrap_or_default();

    if is_deepseek_model(config) {
        if let Some(arr) = msgs.as_array_mut() {
            for m in arr.iter_mut() {
                flatten_image_parts(m);
            }
        }
    }

    if is_reasoning_model(config) {
        if let Some(arr) = msgs.as_array_mut() {
            for m in arr.iter_mut() {
                if m["role"].as_str() == Some("system") {
                    m["role"] = serde_json::json!("developer");
                }
            }
        }
    }

    msgs
}

/// In-place replace any `{"type":"image_url", ...}` content parts on the
/// given message with a `{"type":"text", "text":"[image attached: ...]"}`
/// placeholder. If the resulting parts array is text-only, also collapse it
/// to a plain string (DeepSeek's preferred shape — it accepts arrays but
/// strings are cheaper and more cache-friendly).
fn flatten_image_parts(msg: &mut serde_json::Value) {
    let content = match msg.get_mut("content") {
        Some(c) if c.is_array() => c,
        _ => return,
    };
    let arr = match content.as_array_mut() {
        Some(a) => a,
        None => return,
    };
    let mut text_only = true;
    let mut had_image = false;
    for part in arr.iter_mut() {
        match part.get("type").and_then(|t| t.as_str()) {
            Some("text") => {}
            Some("image_url") => {
                had_image = true;
                let hint = part
                    .get("image_url")
                    .and_then(|iu| iu.get("url"))
                    .and_then(|u| u.as_str())
                    .map(short_image_hint)
                    .unwrap_or_else(|| "unknown".to_string());
                *part = serde_json::json!({
                    "type": "text",
                    "text": format!("[image attached: {hint}]"),
                });
            }
            _ => {
                // Unknown part type — keep as-is; not text so don't collapse.
                text_only = false;
            }
        }
    }
    if !had_image {
        return; // Nothing to do.
    }
    if text_only {
        // Concatenate all text parts into one string.
        let joined: String = arr
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" ");
        msg["content"] = serde_json::json!(joined);
    }
}

/// Build a short, non-PII hint from an image URL/data URI for the placeholder.
fn short_image_hint(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("data:") {
        // "data:image/png;base64,..." → "image/png base64"
        let head = rest.split(',').next().unwrap_or(rest);
        return head.replace(';', " ");
    }
    // Plain URL — keep at most 80 chars so we don't bloat history.
    let trimmed: String = url.chars().take(80).collect();
    trimmed
}

/// 全局默认思考设置 `(enabled, effort)`,effort ∈ {"high","max"};默认 `(false,"high")`
/// —— 思考默认关(用户决策:DeepSeek V4 不思考也够强,省时省钱;要深思在 UI/会话开关里开)。
fn global_thinking_default() -> (bool, String) {
    let default = (false, "high".to_string());
    let handle = match crate::engine::tools::APP_HANDLE.get() {
        Some(h) => h,
        None => return default,
    };
    use tauri::Manager;
    let app_state = handle.state::<crate::state::AppState>();
    let config = match app_state.config.try_read() {
        Ok(c) => c,
        Err(_) => return default,
    };
    let enabled = config.agents.enable_thinking.unwrap_or(false);
    let effort = match config.agents.reasoning_effort.as_deref() {
        Some("max") => "max",
        _ => "high",
    };
    (enabled, effort.to_string())
}

/// 解析本次请求的思考设置:**会话级覆盖(cfg 字段)> 全局默认**。
/// effort 归一到 {"high","max"}。
fn resolve_thinking_settings(config: &LLMConfig) -> (bool, String) {
    let (g_enabled, g_effort) = global_thinking_default();
    let enabled = config.enable_thinking.unwrap_or(g_enabled);
    let effort = match config.reasoning_effort.as_deref().unwrap_or(&g_effort) {
        "max" => "max",
        _ => "high",
    };
    (enabled, effort.to_string())
}

/// Whether the current model is a DeepSeek model (the only provider that
/// honours `enable_thinking`). Other OpenAI-compatible providers ignore
/// unknown request params, but we still gate to keep request bodies clean.
fn is_deepseek_model(config: &LLMConfig) -> bool {
    config.provider_id.to_lowercase().contains("deepseek")
        || config.base_url.contains("deepseek")
        || config.model.to_lowercase().contains("deepseek")
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
    // OpenAI defaults this to true, but DeepSeek-compatible endpoints have been
    // observed serializing tool_calls without it set explicitly.
    body["parallel_tool_calls"] = serde_json::json!(true);
    // DeepSeek 思考模式(官方格式)。仅对 DeepSeek 发;其它 OpenAI 兼容端会忽略。
    //   开关: `thinking: {type: "enabled"/"disabled"}`
    //   程度: 顶层 `reasoning_effort: "high"/"max"`(仅 enabled 时发)
    // 注意:此前发的顶层 `enable_thinking` 布尔不是官方参数(关也关不掉),已纠正。
    if is_deepseek_model(config) {
        let (enabled, effort) = resolve_thinking_settings(config);
        body["thinking"] = serde_json::json!({ "type": if enabled { "enabled" } else { "disabled" } });
        if enabled {
            body["reasoning_effort"] = serde_json::json!(effort);
        }
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
    let reasoning_content = msg["reasoning_content"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // Parse OpenAI usage
    let usage = parse_openai_usage(&json["usage"]);

    Ok(LLMResponse {
        message: LLMMessage {
            role: "assistant".into(),
            content,
            tool_calls,
            tool_call_id: None,
            reasoning_content,
        },
        usage,
    })
}

/// Parse OpenAI-compatible usage JSON into TokenUsage.
///
/// Handles both DeepSeek and standard OpenAI shapes:
///   * DeepSeek surfaces `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`
///     at the top level of `usage`.
///   * OpenAI / others use `prompt_tokens_details.cached_tokens`.
/// Miss is derived as `prompt_tokens - hit` when not reported explicitly.
fn parse_openai_usage(v: &serde_json::Value) -> Option<crate::engine::usage::TokenUsage> {
    if v.is_null() { return None; }
    let input_tokens = v["prompt_tokens"].as_u64().unwrap_or(0) as u32;
    let output_tokens = v["completion_tokens"].as_u64().unwrap_or(0) as u32;

    // DeepSeek-specific fields take precedence; fall back to OpenAI's nested shape.
    let hit = v["prompt_cache_hit_tokens"]
        .as_u64()
        .or_else(|| v["prompt_tokens_details"]["cached_tokens"].as_u64())
        .unwrap_or(0) as u32;
    let miss = v["prompt_cache_miss_tokens"]
        .as_u64()
        .map(|n| n as u32)
        .unwrap_or_else(|| input_tokens.saturating_sub(hit));

    Some(crate::engine::usage::TokenUsage {
        input_tokens,
        output_tokens,
        prompt_cache_miss_tokens: miss,
        prompt_cache_hit_tokens: hit,
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

    // 首响应(headers)超时(#4 2026-06-14):send_request 的总超时本是 300s == work 步
    // idle 看门狗 → deepseek 偶发不回 response headers 时,请求挂满 300s、看门狗先把整步砍了、
    // 连带整个 job 失败(实测:请求发出后 307s 零日志、零 token —— 流根本没开始)。封顶首响应
    // 90s:headers 没在 90s 内到 = 请求卡住 → 走非流式兜底(重新发一次)。body 流起来后由
    // process_sse_stream 的 60s 逐块 idle 超时管,不卡正经的长流。
    let resp = match tokio::time::timeout(
        std::time::Duration::from_secs(90),
        send_request(client, &url, config, &body, 300),
    )
    .await
    {
        Ok(r) => r?,
        Err(_) => {
            log::warn!("LLM stream request stalled (no response headers in 90s) — non-streaming fallback");
            on_event(StreamEvent::Fallback);
            return non_streaming_fallback(client, &url, config, messages_value, tools, native_tools, &on_event).await;
        }
    };

    // --- Try streaming first ---
    match try_stream_openai(resp, cancelled, &on_event).await {
        Ok(response) => Ok(response),
        Err(StreamError::Cancelled) => Err("cancelled".to_string()),
        Err(e) if e.is_fallback_eligible() => {
            // Stream died (mid-stream idle / connection reset) — fall back to non-streaming.
            log::warn!("OpenAI stream failed ({}), falling back to non-streaming", e);
            on_event(StreamEvent::Fallback);
            non_streaming_fallback(client, &url, config, messages_value, tools, native_tools, &on_event).await
        }
        Err(e) => Err(e.to_string()),
    }
}

/// 非流式兜底:流式拿不到响应(首响应卡住 / 中途流死)时,重发一次普通(非流式)请求,
/// 一次性拿完整回复并补发给 UI。非流式请求自带 120s 总超时(< work 看门狗 300s)。
async fn non_streaming_fallback<F>(
    client: &reqwest::Client,
    url: &str,
    config: &LLMConfig,
    messages_value: serde_json::Value,
    tools: &[ToolDefinition],
    native_tools: &[NativeToolInjection],
    on_event: &F,
) -> Result<LLMResponse, String>
where
    F: Fn(StreamEvent) + Send + 'static,
{
    let mut ns_body = build_body(config, messages_value, false);
    apply_native_tools(&mut ns_body, tools, native_tools);
    let ns_resp = send_request(client, url, config, &ns_body, 120).await?;
    let json: serde_json::Value = ns_resp.json().await.map_err(|e| e.to_string())?;

    let choice = &json["choices"][0];
    let msg = &choice["message"];
    let content_text = msg["content"].as_str().unwrap_or("").to_string();
    let tool_calls = parse_tool_calls(&msg["tool_calls"]);
    let usage = parse_openai_usage(&json["usage"]);
    let reasoning = msg["reasoning_content"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if let Some(ref r) = reasoning {
        on_event(StreamEvent::ReasoningDelta(r.clone()));
    }
    let response = build_stream_response(content_text, tool_calls, usage, reasoning);
    emit_fallback_content(&response, on_event);
    Ok(response)
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
    let mut full_reasoning = String::new();
    let mut finish_reason = "stop".to_string();
    let mut tool_call_acc: std::collections::BTreeMap<u32, (String, String, String)> =
        std::collections::BTreeMap::new();
    let mut stream_usage: Option<crate::engine::usage::TokenUsage> = None;

    {
        let fc = &mut full_content;
        let fre = &mut full_reasoning;
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
                        fre.push_str(reasoning);
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
                    } else if let Some(mut repaired) = crate::engine::tools::repair_json(&arguments) {
                        log::warn!(
                            "Repaired malformed JSON arguments for tool '{}': {}",
                            name,
                            arguments.chars().take(200).collect::<String>()
                        );
                        // 标记"这份参数是修复出来的"——大参数场景几乎必是输出上限截断
                        // (content 尾部被腰斩,修复只是补闭合,内容仍残缺)。write_file 等
                        // 内容敏感工具据此拒绝把残缺内容写进文件(写出去 = 静默交付半个
                        // 文件,模型发现后重写一遍又截断,死循环耗尽迭代)。
                        if let Some(obj) = repaired.as_object_mut() {
                            obj.insert("__yiyi_repaired".into(), serde_json::Value::Bool(true));
                        }
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
    let reasoning_opt = if full_reasoning.is_empty() {
        None
    } else {
        Some(full_reasoning)
    };
    Ok(build_stream_response(full_content, tool_calls, stream_usage, reasoning_opt))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn deepseek_cfg() -> LLMConfig {
        LLMConfig {
            base_url: "https://api.deepseek.com/v1".into(),
            api_key: "sk-test".into(),
            model: "deepseek-v4-pro".into(),
            provider_id: "deepseek".into(),
            native_tools: vec![],
            ..Default::default()
        }
    }

    /// V4 is text-only; image parts in tool messages must be replaced with a
    /// text placeholder before sending, otherwise the API rejects with
    /// "unknown variant `image_url`, expected `text`".
    #[test]
    fn deepseek_strips_image_parts_to_text_placeholder() {
        let msg = LLMMessage {
            role: "tool".into(),
            content: Some(MessageContent::with_images(
                "Screenshot saved to /tmp/x.png",
                &["data:image/png;base64,iVBORw0KGgo...".into()],
            )),
            tool_calls: None,
            tool_call_id: Some("call_1".into()),
            reasoning_content: None,
        };
        let prepared = prepare_messages(&deepseek_cfg(), &[msg]);
        let m = &prepared[0];
        // Content collapsed to a plain string (no array, no image_url part).
        assert!(m["content"].is_string(), "content should collapse to string");
        let text = m["content"].as_str().unwrap();
        assert!(text.contains("Screenshot saved to /tmp/x.png"));
        assert!(text.contains("[image attached:"), "placeholder must be present");
        assert!(!text.contains("image_url"));
    }

    #[test]
    fn deepseek_keeps_pure_text_messages_intact() {
        let msg = LLMMessage {
            role: "user".into(),
            content: Some(MessageContent::text("hello world")),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        };
        let prepared = prepare_messages(&deepseek_cfg(), &[msg]);
        assert_eq!(prepared[0]["content"], "hello world");
    }

    /// Vision-capable providers (e.g. a future deepseek-vl or non-DeepSeek
    /// configs) must NOT have their image parts stripped — `flatten_image_parts`
    /// is gated by `is_deepseek_model`, but base_url alone keys the check.
    #[test]
    fn non_deepseek_keeps_image_parts() {
        let cfg = LLMConfig {
            base_url: "https://api.openai.com/v1".into(),
            api_key: "sk-x".into(),
            model: "gpt-4o-mini".into(),
            provider_id: "openai".into(),
            native_tools: vec![],
            ..Default::default()
        };
        let msg = LLMMessage {
            role: "tool".into(),
            content: Some(MessageContent::with_images(
                "shot",
                &["data:image/png;base64,abcd".into()],
            )),
            tool_calls: None,
            tool_call_id: Some("c1".into()),
            reasoning_content: None,
        };
        let prepared = prepare_messages(&cfg, &[msg]);
        // Should remain as an array with image_url part.
        assert!(prepared[0]["content"].is_array());
        let parts = prepared[0]["content"].as_array().unwrap();
        assert!(parts.iter().any(|p| p["type"] == "image_url"));
    }

    #[test]
    fn short_image_hint_truncates_data_uri() {
        let hint = short_image_hint("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...");
        assert_eq!(hint, "image/png base64");
    }

    #[test]
    fn short_image_hint_caps_url_length() {
        let url = format!("https://example.com/{}", "a".repeat(200));
        let hint = short_image_hint(&url);
        assert_eq!(hint.chars().count(), 80);
    }
}
