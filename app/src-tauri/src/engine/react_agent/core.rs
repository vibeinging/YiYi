use super::compaction::{compact_messages_if_needed, force_compact_messages, sanitize_messages};
use super::prompt::critical_system_reminder;
use super::{AgentStreamEvent, PersistToolFn, ToolPersistEvent, DEFAULT_MAX_ITERATIONS};
use crate::engine::hooks::{HookRunner, HookConfig, merge_hook_feedback};
use crate::engine::usage::UsageTracker;
use crate::engine::compact;
use crate::engine::permission_mode::{PermissionMode, PermissionPolicy, PermissionOutcome};

/// Auto-compaction threshold: compress when estimated tokens exceed this.
const AUTO_COMPACT_TOKEN_THRESHOLD: usize = 80_000;
use crate::engine::llm_client::{chat_completion, chat_completion_stream, LLMConfig, LLMMessage, MessageContent, StreamEvent};
use crate::engine::llm_client::retry::parse_context_overflow;
use crate::engine::tools::{builtin_tools, execute_tool, get_current_session_id, ToolDefinition};

/// Load hook configuration from plugins + app config.
fn load_hook_config() -> HookConfig {
    get_plugin_hook_config().unwrap_or_default()
}

/// Helper: access PluginRegistry and extract hook config.
fn get_plugin_hook_config() -> Option<HookConfig> {
    let handle = crate::engine::tools::APP_HANDLE.get()?;
    use tauri::Manager;
    let app_state = handle.state::<crate::state::AppState>();
    let reg = app_state.inner().plugin_registry.read().unwrap();
    let plugin_hooks = reg.aggregated_hooks();
    if plugin_hooks.is_empty() {
        None
    } else {
        log::debug!("Loaded {} pre-hooks, {} post-hooks from plugins",
            plugin_hooks.pre_tool_use.len(), plugin_hooks.post_tool_use.len());
        Some(plugin_hooks.to_hook_config())
    }
}

/// Helper: get plugin tool definitions.
fn get_plugin_tool_definitions() -> Vec<ToolDefinition> {
    let handle = match crate::engine::tools::APP_HANDLE.get() {
        Some(h) => h,
        None => return vec![],
    };
    use tauri::Manager;
    let app_state = handle.state::<crate::state::AppState>();
    let reg = app_state.inner().plugin_registry.read().unwrap();
    reg.all_tool_definitions()
}

/// Load permission mode — derived from agent tool filter context.
/// ReadOnly agents → ReadOnly mode; others → Standard.
fn load_permission_mode() -> PermissionMode {
    if let Some(filter) = crate::engine::tools::current_tool_filter() {
        use super::ToolFilter;
        if let ToolFilter::Allow(ref names) = filter {
            // Use PermissionPolicy as single source of truth for tool mode requirements
            let policy = PermissionPolicy::new(PermissionMode::ReadOnly);
            let all_readonly = names.iter().all(|n| {
                policy.required_mode_for(n) == PermissionMode::ReadOnly
            });
            if all_readonly {
                return PermissionMode::ReadOnly;
            }
        }
    }
    PermissionMode::Standard
}

/// Check if an LLM error is a context overflow that we can recover from
/// by force-compacting the conversation history.
fn is_context_overflow_error(err: &str) -> bool {
    parse_context_overflow(err).is_some()
        || err.contains("context length")
        || err.contains("prompt is too long")
        || err.contains("maximum context")
}

/// Inject MemMe context as a system message if available.
async fn inject_memme_context(messages: &mut Vec<LLMMessage>) {
    let session_id = get_current_session_id();
    if let Some(summary) = super::compaction::load_memme_context(&session_id).await {
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

/// Inject the critical system reminder as a system message.
/// Replaces any previous reminder to avoid unbounded growth.
fn inject_critical_reminder(messages: &mut Vec<LLMMessage>) {
    const REMINDER_MARKER: &str = "[System Reminder]";
    // Remove any previous critical reminder to prevent accumulation
    messages.retain(|m| {
        !(m.role == "system"
            && m.content
                .as_ref()
                .map_or(false, |c| c.as_text().map_or(false, |t| t.starts_with(REMINDER_MARKER))))
    });
    messages.push(LLMMessage {
        role: "system".into(),
        content: Some(MessageContent::text(critical_system_reminder())),
        tool_calls: None,
        tool_call_id: None,
    });
}

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

    // Load context summary from MemMe for continuity
    inject_memme_context(&mut messages).await;

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

        // Re-inject critical constraints every iteration after the first to prevent
        // the model from drifting past safety boundaries in long tool-use sessions.
        if iteration > 0 {
            inject_critical_reminder(&mut messages);
        }

        let response = match chat_completion(config, &messages, &tools).await {
            Ok(r) => r,
            Err(e) if is_context_overflow_error(&e) => {
                log::warn!("Context overflow detected, force-compacting and retrying: {}", &e[..e.len().min(200)]);
                force_compact_messages(&mut messages, config, working_dir).await;
                chat_completion(config, &messages, &tools).await?
            }
            Err(e) => return Err(e),
        };

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
///
/// When `tools_override` is `Some`, it replaces the default builtin + extra tool set.
/// This is used by `run_subagent_stream` to inject a pre-filtered tool list.
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
    tools_override: Option<Vec<ToolDefinition>>,
) -> Result<String, String>
where
    F: Fn(AgentStreamEvent) + Send + Clone + 'static,
{
    let max_iter = max_iterations.unwrap_or(DEFAULT_MAX_ITERATIONS);
    let tools = if let Some(ovr) = tools_override {
        ovr
    } else {
        let mut t = builtin_tools();
        t.extend(extra_tools.iter().cloned());
        // Inject plugin custom tools
        t.extend(get_plugin_tool_definitions());
        t
    };

    let mut messages: Vec<LLMMessage> = vec![LLMMessage {
        role: "system".into(),
        content: Some(MessageContent::text(system_prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    // Load context summary from MemMe for continuity
    inject_memme_context(&mut messages).await;

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

    // Hook runner for pre/post tool use (borrowed from Claw Code design)
    let hook_runner = HookRunner::new(load_hook_config());
    // Permission policy (three-level mode borrowed from Claw Code)
    let permission_policy = PermissionPolicy::new(load_permission_mode());

    const MAX_EMPTY_RETRIES: usize = 3;
    let mut consecutive_empty = 0u8;

    for iteration in 0..max_iter {
        log::info!("ReAct stream iteration {}/{}", iteration + 1, max_iter);

        if iteration > 0 {
            inject_critical_reminder(&mut messages);
        }

        // Check cancellation before each LLM call
        if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            return Err("cancelled".to_string());
        }

        let response = match chat_completion_stream(config, &messages, &tools, {
            let cb = on_event.clone();
            move |evt| {
                match evt {
                    StreamEvent::ContentDelta(text) => cb(AgentStreamEvent::Token(text)),
                    StreamEvent::ReasoningDelta(text) => cb(AgentStreamEvent::Thinking(text)),
                    _ => {}
                }
            }
        }, cancelled).await {
            Ok(r) => r,
            Err(e) if is_context_overflow_error(&e) => {
                log::warn!("Context overflow in stream, force-compacting and retrying: {}", &e[..e.len().min(200)]);
                on_event(AgentStreamEvent::ContextOverflowRetry);
                force_compact_messages(&mut messages, config, working_dir).await;
                let cb2 = on_event.clone();
                chat_completion_stream(config, &messages, &tools, move |evt| {
                    match evt {
                        StreamEvent::ContentDelta(text) => cb2(AgentStreamEvent::Token(text)),
                        StreamEvent::ReasoningDelta(text) => cb2(AgentStreamEvent::Thinking(text)),
                        _ => {}
                    }
                }, cancelled).await?
            }
            Err(e) => return Err(e),
        };

        messages.push(response.message.clone());

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

            if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
                return Err("cancelled".to_string());
            }

            // Execute tool calls with hook integration (pre → execute → post)
            for call in tool_calls {
                let tool_name = &call.function.name;
                let tool_input = &call.function.arguments;

                // ── Permission mode check ──
                let perm_outcome = permission_policy.is_allowed(tool_name);
                if let PermissionOutcome::Deny { reason } = &perm_outcome {
                    log::info!("Permission denied for tool {}: {}", tool_name, reason);
                    let result_preview = reason.chars().take(200).collect::<String>();
                    on_event(AgentStreamEvent::ToolEnd {
                        name: tool_name.clone(),
                        result_preview: result_preview.clone(),
                    });
                    messages.push(LLMMessage {
                        role: "tool".into(),
                        content: Some(MessageContent::text(format!("Error: {reason}"))),
                        tool_calls: None,
                        tool_call_id: Some(call.id.clone()),
                    });
                    continue;
                }

                // NeedsConfirmation: delegate to existing permission_gate
                if let PermissionOutcome::NeedsConfirmation { reason } = &perm_outcome {
                    let req = crate::engine::tools::permission_gate::PermissionRequest {
                        request_id: uuid::Uuid::new_v4().to_string(),
                        permission_type: "permission_mode".into(),
                        path: format!("{}({})", tool_name, tool_input.chars().take(100).collect::<String>()),
                        parent_folder: String::new(),
                        reason: reason.clone(),
                        risk_level: "medium".into(),
                    };
                    if !crate::engine::tools::permission_gate::request_permission(req).await {
                        let deny_msg = format!("User denied: {reason}");
                        on_event(AgentStreamEvent::ToolEnd {
                            name: tool_name.clone(),
                            result_preview: deny_msg.clone(),
                        });
                        messages.push(LLMMessage {
                            role: "tool".into(),
                            content: Some(MessageContent::text(format!("Error: {deny_msg}"))),
                            tool_calls: None,
                            tool_call_id: Some(call.id.clone()),
                        });
                        continue;
                    }
                }

                // ── Pre-hook: can modify input, deny, or override permissions ──
                let pre_result = hook_runner.run_pre_tool_use(tool_name, tool_input, None);

                let (result_content, result_images, is_error) = if pre_result.is_blocked() {
                    // Hook denied/failed/cancelled this tool call
                    let reason = pre_result.messages().join("; ");
                    let msg = if reason.is_empty() {
                        format!("Tool '{}' blocked by hook", tool_name)
                    } else {
                        reason
                    };
                    log::info!("Hook blocked tool {}: {}", tool_name, msg);
                    (msg, vec![], true)
                } else {
                    // Use potentially modified input from hook
                    let effective_input = pre_result.updated_input()
                        .unwrap_or(tool_input)
                        .to_string();

                    let mut effective_call = call.clone();
                    if pre_result.updated_input().is_some() {
                        effective_call.function.arguments = effective_input.clone();
                    }

                    // ── Execute tool ──
                    let result = execute_tool(&effective_call).await;
                    let mut output = result.content;
                    let images = result.images;
                    let mut err = false;

                    // Merge pre-hook feedback into output
                    output = merge_hook_feedback(pre_result.messages(), output, false);

                    // ── Post-hook: can modify output or inject feedback ──
                    let post_result = if err {
                        hook_runner.run_post_tool_use_failure(tool_name, &effective_input, &output, None)
                    } else {
                        hook_runner.run_post_tool_use(tool_name, &effective_input, &output, false, None)
                    };

                    if post_result.is_blocked() {
                        err = true;
                    }
                    output = merge_hook_feedback(post_result.messages(), output, post_result.is_blocked());

                    (output, images, err)
                };

                // Emit ToolEnd
                let result_preview: String = result_content.chars().take(200).collect();
                on_event(AgentStreamEvent::ToolEnd {
                    name: tool_name.clone(),
                    result_preview,
                });

                // Persist tool result
                if let Some(ref pfn) = persist_fn {
                    pfn(ToolPersistEvent::ToolResult {
                        tool_call_id: call.id.clone(),
                        tool_name: tool_name.clone(),
                        result_content: result_content.chars().take(2000).collect(),
                    });
                }

                let content = if result_images.is_empty() {
                    MessageContent::text(result_content)
                } else {
                    MessageContent::with_images(&result_content, &result_images)
                };
                messages.push(LLMMessage {
                    role: "tool".into(),
                    content: Some(content),
                    tool_calls: None,
                    tool_call_id: Some(call.id.clone()),
                });
            }

            // Check cancellation after all tool executions
            if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
                return Err("cancelled".to_string());
            }
        } else {
            let text = response.message.content
                .map(|c| c.into_text())
                .unwrap_or_default();
            let text = text.trim().to_string();

            if !text.is_empty() {
                on_event(AgentStreamEvent::Complete);
                return Ok(text);
            }

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

            messages.pop();
            messages.push(LLMMessage {
                role: "user".into(),
                content: Some(MessageContent::text(
                    "Please provide your response. Summarize what was done or answer the question."
                )),
                tool_calls: None,
                tool_call_id: None,
            });
        }

        compact_messages_if_needed(&mut messages, config, working_dir).await;
    }

    let err = format!("Agent reached maximum iterations ({})", max_iter);
    on_event(AgentStreamEvent::Error);
    Err(err)
}

// ---------------------------------------------------------------------------
// Sub-agent runner with tool filtering (context isolation)
// ---------------------------------------------------------------------------

/// Run a sub-agent with tool access control via `ToolFilter`.
/// This is the primary API for spawning isolated sub-agents.
///
/// - **Isolated**: conversation history (fresh), tool set (filtered), iteration limit
/// - **Shared (penetrating)**: AppHandle, Database, MCP runtime, StreamingState
pub async fn run_subagent_stream<F>(
    config: &LLMConfig,
    system_prompt: &str,
    user_message: &str,
    extra_tools: &[ToolDefinition],
    tool_filter: &super::ToolFilter,
    max_iterations: Option<usize>,
    working_dir: Option<&std::path::Path>,
    on_event: F,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, String>
where
    F: Fn(AgentStreamEvent) + Send + Clone + 'static,
{
    let mut tools = builtin_tools();
    tools.extend(extra_tools.iter().cloned());
    let filtered = tool_filter.apply(&tools);

    run_react_with_options_stream(
        config, system_prompt, user_message, &[], &[],
        max_iterations, working_dir, on_event, cancelled, None,
        Some(filtered),
    ).await
}
