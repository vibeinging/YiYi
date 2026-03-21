use super::compaction::{compact_messages_if_needed, sanitize_messages};
use super::{AgentStreamEvent, PersistToolFn, ToolPersistEvent, DEFAULT_MAX_ITERATIONS, COMPACT_SUMMARY_FILE};
use crate::engine::llm_client::{chat_completion, chat_completion_stream, LLMConfig, LLMMessage, MessageContent, StreamEvent};
use crate::engine::tools::{builtin_tools, execute_tool, ToolDefinition};

/// Run a ReAct agent loop (single-turn, no history).
/// Used by channels, scheduler, heartbeat, cronjobs.
pub async fn run_react(
    config: &LLMConfig,
    system_prompt: &str,
    user_message: &str,
    extra_tools: &[ToolDefinition],
) -> Result<String, String> {
    run_react_with_options(config, system_prompt, user_message, extra_tools, &[], None, None).await
}

/// Run ReAct loop with conversation history, configurable max iterations,
/// and optional working_dir for persisting compact summaries.
pub async fn run_react_with_options(
    config: &LLMConfig,
    system_prompt: &str,
    user_message: &str,
    extra_tools: &[ToolDefinition],
    history: &[LLMMessage],
    max_iterations: Option<usize>,
    working_dir: Option<&std::path::Path>,
) -> Result<String, String> {
    run_react_with_options_persist(config, system_prompt, user_message, extra_tools, history, max_iterations, working_dir, None).await
}

/// Run ReAct loop with optional tool persistence callback.
pub async fn run_react_with_options_persist(
    config: &LLMConfig,
    system_prompt: &str,
    user_message: &str,
    extra_tools: &[ToolDefinition],
    history: &[LLMMessage],
    max_iterations: Option<usize>,
    working_dir: Option<&std::path::Path>,
    persist_fn: Option<PersistToolFn>,
) -> Result<String, String> {
    let max_iter = max_iterations.unwrap_or(DEFAULT_MAX_ITERATIONS);
    let mut tools = builtin_tools();
    tools.extend(extra_tools.iter().cloned());

    let mut messages: Vec<LLMMessage> = vec![
        LLMMessage {
            role: "system".into(),
            content: Some(MessageContent::text(system_prompt)),
            tool_calls: None,
            tool_call_id: None,
        },
    ];

    // Load persisted compact summary as system message
    if let Some(dir) = working_dir {
        let summary_path = dir.join(COMPACT_SUMMARY_FILE);
        if let Ok(summary) = tokio::fs::read_to_string(&summary_path).await {
            if !summary.trim().is_empty() {
                messages.push(LLMMessage {
                    role: "system".into(),
                    content: Some(MessageContent::text(format!(
                        "<previous-summary>\n{}\n</previous-summary>\n\
                        The above is a summary of previous conversation. \
                        Use it as context to maintain continuity.",
                        summary.trim()
                    ))),
                    tool_calls: None,
                    tool_call_id: None,
                });
            }
        }
    }

    // Insert conversation history between system prompt and current user message
    if !history.is_empty() {
        messages.extend(history.iter().cloned());
    }

    messages.push(LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(user_message)),
        tool_calls: None,
        tool_call_id: None,
    });

    // Sanitize history messages (fix orphan tool results from previous sessions)
    sanitize_messages(&mut messages);

    // Pre-compact if history made context too large before first LLM call
    compact_messages_if_needed(&mut messages, config, working_dir).await;

    const MAX_EMPTY_RETRIES: usize = 3;
    let mut consecutive_empty = 0u8;

    for iteration in 0..max_iter {
        log::info!("ReAct iteration {}/{}", iteration + 1, max_iter);

        let response = chat_completion(config, &messages, &tools).await?;

        // Add assistant message to history
        messages.push(response.message.clone());

        // Determine whether we got valid tool calls
        let has_tool_calls = response.message.tool_calls.as_ref()
            .map_or(false, |tc| !tc.is_empty());

        if has_tool_calls {
            consecutive_empty = 0;
            let tool_calls = response.message.tool_calls.as_ref().unwrap();

            // Persist assistant message with tool_calls
            if let Some(ref pfn) = persist_fn {
                let content_text = response.message.content.as_ref()
                    .map(|c| c.as_text().unwrap_or("").to_string())
                    .unwrap_or_default();
                let tc_json: Vec<serde_json::Value> = tool_calls.iter().map(|tc| {
                    serde_json::json!({
                        "id": tc.id,
                        "name": tc.function.name,
                        "arguments": tc.function.arguments.chars().take(500).collect::<String>(),
                    })
                }).collect();
                pfn(ToolPersistEvent::AssistantWithToolCalls {
                    content: content_text,
                    tool_calls_json: serde_json::to_string(&tc_json).unwrap_or_default(),
                });
            }

            // Execute all tool calls concurrently, preserving original order
            for call in tool_calls {
                log::info!(
                    "Tool call: {}({})",
                    call.function.name,
                    call.function.arguments.chars().take(100).collect::<String>()
                );
            }

            let futures: Vec<_> = tool_calls
                .iter()
                .map(|call| async move { execute_tool(call).await })
                .collect();
            let results = futures::future::join_all(futures).await;

            for (call, result) in tool_calls.iter().zip(results.into_iter()) {
                log::info!(
                    "Tool result ({}): {}...",
                    call.function.name,
                    result.content.chars().take(200).collect::<String>()
                );

                // Persist tool result
                if let Some(ref pfn) = persist_fn {
                    pfn(ToolPersistEvent::ToolResult {
                        tool_call_id: result.tool_call_id.clone(),
                        tool_name: call.function.name.clone(),
                        result_content: result.content.chars().take(2000).collect(),
                    });
                }

                let content = if result.images.is_empty() {
                    MessageContent::text(result.content)
                } else {
                    MessageContent::with_images(&result.content, &result.images)
                };
                messages.push(LLMMessage {
                    role: "tool".into(),
                    content: Some(content),
                    tool_calls: None,
                    tool_call_id: Some(result.tool_call_id),
                });
            }
        } else {
            // No tool calls — check if we got a text response
            let text = response.message.content
                .map(|c| c.into_text())
                .unwrap_or_default();
            let text = text.trim().to_string();

            if !text.is_empty() {
                // Valid final text response
                return Ok(text);
            }

            // Empty response — retry with a nudge
            consecutive_empty += 1;
            log::warn!(
                "LLM returned empty response (retry {}/{})",
                consecutive_empty, MAX_EMPTY_RETRIES
            );

            if (consecutive_empty as usize) >= MAX_EMPTY_RETRIES {
                log::error!("LLM returned empty response {} times, giving up", MAX_EMPTY_RETRIES);
                return Ok(String::new());
            }

            // Remove the empty assistant message we just pushed
            messages.pop();

            // Push a nudge to coax the LLM into responding
            messages.push(LLMMessage {
                role: "user".into(),
                content: Some(MessageContent::text(
                    "Please provide your response. Summarize what was done or answer the question."
                )),
                tool_calls: None,
                tool_call_id: None,
            });
        }

        // After executing tool calls, always continue the loop so the LLM
        // can produce a final text response based on tool results.
        // Do NOT check finish_reason here — some providers return "stop"
        // even when tool_calls are present, and the content would be None.

        compact_messages_if_needed(&mut messages, config, working_dir).await;
    }

    Err(format!(
        "Agent reached maximum iterations ({})",
        max_iter
    ))
}

// ---------------------------------------------------------------------------
// Streaming ReAct agent
// ---------------------------------------------------------------------------

/// Streaming version of run_react_with_options.
/// Calls `on_event` for each stream event (tokens, tool status, completion).
pub async fn run_react_with_options_stream<F>(
    config: &LLMConfig,
    system_prompt: &str,
    user_message: &str,
    extra_tools: &[ToolDefinition],
    history: &[LLMMessage],
    max_iterations: Option<usize>,
    working_dir: Option<&std::path::Path>,
    on_event: F,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
    persist_fn: Option<PersistToolFn>,
) -> Result<String, String>
where
    F: Fn(AgentStreamEvent) + Send + Clone + 'static,
{
    let max_iter = max_iterations.unwrap_or(DEFAULT_MAX_ITERATIONS);
    let mut tools = builtin_tools();
    tools.extend(extra_tools.iter().cloned());

    let mut messages: Vec<LLMMessage> = vec![LLMMessage {
        role: "system".into(),
        content: Some(MessageContent::text(system_prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    // Load persisted compact summary
    if let Some(dir) = working_dir {
        let summary_path = dir.join(COMPACT_SUMMARY_FILE);
        if let Ok(summary) = tokio::fs::read_to_string(&summary_path).await {
            if !summary.trim().is_empty() {
                messages.push(LLMMessage {
                    role: "system".into(),
                    content: Some(MessageContent::text(format!(
                        "<previous-summary>\n{}\n</previous-summary>\n\
                        The above is a summary of previous conversation. \
                        Use it as context to maintain continuity.",
                        summary.trim()
                    ))),
                    tool_calls: None,
                    tool_call_id: None,
                });
            }
        }
    }

    if !history.is_empty() {
        messages.extend(history.iter().cloned());
    }

    messages.push(LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(user_message)),
        tool_calls: None,
        tool_call_id: None,
    });

    sanitize_messages(&mut messages);
    compact_messages_if_needed(&mut messages, config, working_dir).await;

    const MAX_EMPTY_RETRIES: usize = 3;
    let mut consecutive_empty = 0u8;

    for iteration in 0..max_iter {
        log::info!("ReAct stream iteration {}/{}", iteration + 1, max_iter);

        let cb = on_event.clone();
        // Check cancellation before each LLM call
        if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            return Err("cancelled".to_string());
        }

        let response = chat_completion_stream(config, &messages, &tools, move |evt| {
            match evt {
                StreamEvent::ContentDelta(text) => cb(AgentStreamEvent::Token(text)),
                StreamEvent::ReasoningDelta(text) => cb(AgentStreamEvent::Thinking(text)),
                _ => {}
            }
        }, cancelled)
        .await?;

        messages.push(response.message.clone());

        // Determine whether we got valid tool calls
        let has_tool_calls = response.message.tool_calls.as_ref()
            .map_or(false, |tc| !tc.is_empty());

        if has_tool_calls {
            consecutive_empty = 0;
            let tool_calls = response.message.tool_calls.as_ref().unwrap();

            // Persist assistant message with tool_calls
            if let Some(ref pfn) = persist_fn {
                let content_text = response.message.content.as_ref()
                    .map(|c| c.as_text().unwrap_or("").to_string())
                    .unwrap_or_default();
                let tc_json: Vec<serde_json::Value> = tool_calls.iter().map(|tc| {
                    serde_json::json!({
                        "id": tc.id,
                        "name": tc.function.name,
                        "arguments": tc.function.arguments.chars().take(500).collect::<String>(),
                    })
                }).collect();
                pfn(ToolPersistEvent::AssistantWithToolCalls {
                    content: content_text,
                    tool_calls_json: serde_json::to_string(&tc_json).unwrap_or_default(),
                });
            }

            // Emit all ToolStart events upfront
            for call in tool_calls {
                let args_preview: String = call.function.arguments.chars().take(100).collect();
                on_event(AgentStreamEvent::ToolStart {
                    name: call.function.name.clone(),
                    args_preview,
                });
            }

            // Check cancellation before starting tool execution
            if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
                return Err("cancelled".to_string());
            }

            // Execute all tool calls concurrently, preserving original order
            let futures: Vec<_> = tool_calls
                .iter()
                .map(|call| async move { execute_tool(call).await })
                .collect();
            let results = futures::future::join_all(futures).await;

            // Check cancellation after tool execution, before feeding results back to LLM
            if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
                return Err("cancelled".to_string());
            }

            // Emit ToolEnd events and push results in order
            for (call, result) in tool_calls.iter().zip(results.into_iter()) {
                let result_preview: String = result.content.chars().take(200).collect();
                on_event(AgentStreamEvent::ToolEnd {
                    name: call.function.name.clone(),
                    result_preview,
                });

                // Persist tool result
                if let Some(ref pfn) = persist_fn {
                    pfn(ToolPersistEvent::ToolResult {
                        tool_call_id: result.tool_call_id.clone(),
                        tool_name: call.function.name.clone(),
                        result_content: result.content.chars().take(2000).collect(),
                    });
                }

                let content = if result.images.is_empty() {
                    MessageContent::text(result.content)
                } else {
                    MessageContent::with_images(&result.content, &result.images)
                };
                messages.push(LLMMessage {
                    role: "tool".into(),
                    content: Some(content),
                    tool_calls: None,
                    tool_call_id: Some(result.tool_call_id),
                });
            }
        } else {
            // No tool calls — check if we got a text response
            let text = response.message.content
                .map(|c| c.into_text())
                .unwrap_or_default();
            let text = text.trim().to_string();

            if !text.is_empty() {
                // Valid final text response
                on_event(AgentStreamEvent::Complete);
                return Ok(text);
            }

            // Empty response — retry with a nudge
            consecutive_empty += 1;
            log::warn!(
                "LLM returned empty response (retry {}/{})",
                consecutive_empty, MAX_EMPTY_RETRIES
            );

            if (consecutive_empty as usize) >= MAX_EMPTY_RETRIES {
                log::error!("LLM returned empty response {} times, giving up", MAX_EMPTY_RETRIES);
                on_event(AgentStreamEvent::Complete);
                return Ok(String::new());
            }

            // Remove the empty assistant message we just pushed
            messages.pop();

            // Push a nudge to coax the LLM into responding
            messages.push(LLMMessage {
                role: "user".into(),
                content: Some(MessageContent::text(
                    "Please provide your response. Summarize what was done or answer the question."
                )),
                tool_calls: None,
                tool_call_id: None,
            });
        }

        // After executing tool calls, always continue the loop so the LLM
        // can produce a final text response based on tool results.
        // Do NOT check finish_reason here — some providers return "stop"
        // even when tool_calls are present, and the content would be None.

        compact_messages_if_needed(&mut messages, config, working_dir).await;
    }

    let err = format!("Agent reached maximum iterations ({})", max_iter);
    on_event(AgentStreamEvent::Error);
    Err(err)
}
