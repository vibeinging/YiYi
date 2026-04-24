use super::compaction::{compact_messages_if_needed, force_compact_messages, sanitize_messages};
use super::{AgentStreamEvent, PersistToolFn, ToolPersistEvent, DEFAULT_MAX_ITERATIONS};
use crate::engine::hooks::{HookRunner, HookConfig, merge_hook_feedback};
use crate::engine::permission_mode::{PermissionMode, PermissionPolicy, PermissionOutcome};

use crate::engine::llm_client::{chat_completion_stream, LLMConfig, LLMMessage, MessageContent, StreamEvent};
use crate::engine::llm_client::retry::parse_context_overflow;
use crate::engine::tools::{builtin_tools, execute_tool, get_current_session_id, resolve_deferred_tools, ToolDefinition};

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
                The above is HISTORICAL context from prior conversations — useful for \
                recognizing the user's preferences and recurring topics, but NOT proof \
                that any task / file / state from that history still exists right now. \
                When the user makes a NEW request (even if it looks similar to a past one), \
                treat it as a fresh request and call the appropriate tools. \
                NEVER claim work is 'already in progress' or 'already done' based solely \
                on this summary — if you need to check current state, call `query_tasks` \
                or the relevant tool to verify.",
                summary.trim()
            ))),
            tool_calls: None,
            tool_call_id: None,
        });
    }
}

// NOTE: `inject_critical_reminder` was removed as part of the Claude Code
// migration plan (see docs/review/2026-04-24_claude-code-migration-plan.md,
// Step 1.4). The reminder is now part of the static system prompt once,
// cached by Anthropic's prompt-cache prefix, instead of being re-appended
// to the message list every ReAct iteration (which busted the cache).

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
/// Delegates to the streaming path with a no-op event handler to ensure
/// all permission checks and hooks are applied consistently.
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
    // Delegate to streaming path to ensure permission + hook enforcement
    run_react_with_options_stream(
        config, system_prompt, user_message, extra_tools,
        history, max_iterations, working_dir,
        |_event| {}, // no-op event handler
        None, persist_fn, None,
    ).await
}

// ---------------------------------------------------------------------------


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

    // Sync MCP tools into the global registry before building tool list
    if let Some(registry) = crate::engine::tool_registry_global::global_registry() {
        crate::engine::tool_registry_global::sync_mcp_tools(registry).await;
    }

    let mut tools = if let Some(ovr) = tools_override {
        ovr
    } else {
        // Unified: get all tools from GlobalToolRegistry (built-in + plugin + MCP)
        let mut t = crate::engine::tool_registry_global::global_registry()
            .map(|r| r.all_definitions())
            .unwrap_or_else(|| builtin_tools()); // startup-only fallback
        t.extend(extra_tools.iter().cloned());
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

    // Persona (AGENTS.md / SOUL.md) is prepended to the FIRST user message
    // of a fresh session instead of sitting in the system prompt. System
    // prompt stays stable across users / sessions so Anthropic prompt-cache
    // prefix can be shared; persona lives in conversation history from turn 2
    // onwards (retained by the compaction summarizer, re-injected fresh on
    // session restart when history is empty again). See
    // docs/review/2026-04-24_claude-code-migration-plan.md Step 1.3.
    let effective_user_message = if history.is_empty() {
        if let Some(wd) = working_dir {
            let ws = crate::engine::tools::get_effective_workspace();
            let persona_prefix = super::prompt::build_persona_prefix(wd, Some(&ws)).await;
            if persona_prefix.is_empty() {
                user_message.to_string()
            } else {
                format!("{}{}", persona_prefix, user_message)
            }
        } else {
            user_message.to_string()
        }
    } else {
        user_message.to_string()
    };

    messages.push(LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(&effective_user_message)),
        tool_calls: None,
        tool_call_id: None,
    });

    sanitize_messages(&mut messages);
    compact_messages_if_needed(&mut messages, config, working_dir).await;

    // Hook runner for pre/post tool use (borrowed from Claw Code design)
    let hook_runner = HookRunner::new(load_hook_config());
    // Permission policy (three-level mode borrowed from Claw Code)
    let permission_policy = PermissionPolicy::new(load_permission_mode());
    // Token usage tracking
    let mut usage_tracker = crate::engine::usage::UsageTracker::new();

    const MAX_EMPTY_RETRIES: usize = 3;
    let mut consecutive_empty = 0u8;

    for iteration in 0..max_iter {
        log::info!("ReAct stream iteration {}/{}", iteration + 1, max_iter);

        // Critical behavior reminder is now part of the static system prompt
        // (see prompt.rs end of build_system_prompt), so we don't re-inject
        // per iteration — that would defeat prompt-cache.

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

        // Track token usage
        if let Some(u) = response.usage {
            usage_tracker.record(u);
        }

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

            // ── Phase 1: Sequential pre-checks (permission + pre-hook) ──
            // These may require UI interaction so must be sequential.
            struct PreparedCall {
                call: crate::engine::tools::ToolCall,
                effective_call: crate::engine::tools::ToolCall,
                pre_messages: Vec<String>,
                denied: Option<String>, // Some = blocked, None = proceed
            }

            let mut prepared: Vec<PreparedCall> = Vec::with_capacity(tool_calls.len());

            for call in tool_calls {
                let tool_name = &call.function.name;
                let tool_input = &call.function.arguments;

                // Permission mode check.
                //
                // IMPORTANT: the deny messages we construct here flow back to
                // the LLM as tool_result content. They MUST be stable short
                // machine codes, never natural-language sentences — otherwise
                // the LLM parrots them back to the user ("此操作需要更高权限，
                // 请确认是否允许执行" was the original bug, see 45f2097). The
                // `reason` string kept on PermissionOutcome / PermissionRequest
                // is for the frontend dialog copy; the LLM-facing tool_result
                // stays a code.
                let perm_outcome = permission_policy.is_allowed(tool_name);
                if let PermissionOutcome::Deny { reason } = &perm_outcome {
                    log::info!("Permission denied for tool {}: {}", tool_name, reason);
                    prepared.push(PreparedCall {
                        call: call.clone(), effective_call: call.clone(),
                        pre_messages: vec![],
                        denied: Some(format!(
                            "Error: permission_denied (tool={} mode_required=higher). \
                             Do not repeat this message to the user; suggest they raise \
                             permission mode in settings if they want to run it.",
                            tool_name
                        )),
                    });
                    continue;
                }

                if let PermissionOutcome::NeedsConfirmation { reason } = &perm_outcome {
                    // Buddy hosted mode: auto-approve non-destructive tools
                    let high_risk = matches!(tool_name.as_str(),
                        "execute_shell" | "delete_file" | "computer_control");
                    if crate::engine::buddy_delegate::is_hosted() && !high_risk {
                        let friendly = humanize_tool_action(tool_name, tool_input);
                        log::info!("Buddy auto-approved: {}", friendly);
                        // Proceed without asking user
                    } else {
                        let friendly_desc = humanize_tool_action(tool_name, tool_input);
                        let req = crate::engine::tools::permission_gate::PermissionRequest {
                            request_id: uuid::Uuid::new_v4().to_string(),
                            permission_type: "permission_mode".into(),
                            path: friendly_desc,
                            parent_folder: String::new(),
                            reason: reason.clone(),
                            risk_level: "medium".into(),
                        };
                        if !crate::engine::tools::permission_gate::request_permission(req).await {
                            prepared.push(PreparedCall {
                                call: call.clone(), effective_call: call.clone(),
                                pre_messages: vec![],
                                denied: Some(format!(
                                    "Error: user_denied (tool={}). The user rejected \
                                     this tool call via the permission dialog. Do NOT \
                                     ask them again in chat — acknowledge and move on, \
                                     or ask a clarifying question about what they'd \
                                     like to do instead.",
                                    tool_name
                                )),
                            });
                            continue;
                        }
                    }
                }

                // Pre-hook (run in blocking thread to avoid thread::sleep on async runtime)
                let hr = hook_runner.clone();
                let tn = tool_name.clone();
                let ti = tool_input.clone();
                let pre_result = tokio::task::spawn_blocking(move || {
                    hr.run_pre_tool_use(&tn, &ti, None)
                }).await.unwrap_or_else(|_| crate::engine::hooks::HookRunResult::allow(vec![]));
                if pre_result.is_blocked() {
                    let reason = pre_result.messages().join("; ");
                    let msg = if reason.is_empty() { format!("Tool '{}' blocked by hook", tool_name) } else { reason };
                    prepared.push(PreparedCall {
                        call: call.clone(), effective_call: call.clone(),
                        pre_messages: pre_result.messages().to_vec(), denied: Some(msg),
                    });
                    continue;
                }

                let mut effective_call = call.clone();
                if let Some(updated) = pre_result.updated_input() {
                    effective_call.function.arguments = updated.to_string();
                }
                prepared.push(PreparedCall {
                    call: call.clone(), effective_call,
                    pre_messages: pre_result.messages().to_vec(), denied: None,
                });
            }

            if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
                return Err("cancelled".to_string());
            }

            // ── Phase 2: Partitioned tool execution ──
            // Read-only tools run in parallel; write tools run sequentially after.
            let mut concurrent_batch: Vec<(usize, &PreparedCall)> = Vec::new();
            let mut sequential_batch: Vec<(usize, &PreparedCall)> = Vec::new();
            for (i, p) in prepared.iter().enumerate() {
                if p.denied.is_some() || crate::engine::tools::is_tool_concurrency_safe(&p.effective_call.function.name) {
                    concurrent_batch.push((i, p));
                } else {
                    sequential_batch.push((i, p));
                }
            }

            let mut results: Vec<(String, Vec<String>, bool)> = vec![("".into(), vec![], false); prepared.len()];

            // Run concurrent-safe tools in parallel
            if !concurrent_batch.is_empty() {
                let futs: Vec<_> = concurrent_batch.iter().map(|(_, p)| {
                    let denied_msg = p.denied.clone();
                    let eff_call = p.effective_call.clone();
                    async move {
                        if let Some(msg) = denied_msg {
                            (msg, vec![], true)
                        } else {
                            let r = execute_tool(&eff_call).await;
                            (r.content, r.images, false)
                        }
                    }
                }).collect();
                let batch_results = futures::future::join_all(futs).await;
                for ((idx, _), res) in concurrent_batch.iter().zip(batch_results) {
                    results[*idx] = res;
                }
            }

            // Run write/mutating tools sequentially
            for (idx, p) in &sequential_batch {
                if let Some(ref msg) = p.denied {
                    results[*idx] = (msg.clone(), vec![], true);
                } else {
                    let r = execute_tool(&p.effective_call).await;
                    results[*idx] = (r.content, r.images, false);
                }
            }

            if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
                return Err("cancelled".to_string());
            }

            // ── Phase 3: Sequential post-processing (post-hook + emit + persist + push) ──
            // Also detect tool_search results for dynamic tool injection (Claw Code pattern).
            let mut discovered_tool_names: Vec<String> = Vec::new();

            for (prep, (mut output, images, mut is_error)) in prepared.iter().zip(results.into_iter()) {
                let tool_name = &prep.call.function.name;
                let effective_input = &prep.effective_call.function.arguments;

                // Merge pre-hook feedback
                if !prep.pre_messages.is_empty() && !is_error {
                    output = merge_hook_feedback(&prep.pre_messages, output, false);
                }

                // Post-hook (skip for denied tools, run in blocking thread)
                if prep.denied.is_none() {
                    let hr = hook_runner.clone();
                    let tn = tool_name.clone();
                    let ei = effective_input.to_string();
                    let out = output.clone();
                    let err = is_error;
                    let post_result = tokio::task::spawn_blocking(move || {
                        if err {
                            hr.run_post_tool_use_failure(&tn, &ei, &out, None)
                        } else {
                            hr.run_post_tool_use(&tn, &ei, &out, false, None)
                        }
                    }).await.unwrap_or_else(|_| crate::engine::hooks::HookRunResult::allow(vec![]));
                    if post_result.is_blocked() { is_error = true; }
                    output = merge_hook_feedback(post_result.messages(), output, post_result.is_blocked());
                }

                // Detect tool_search results: parse [TOOLS_DISCOVERED:name1,name2] tag
                if tool_name == "tool_search" && !is_error {
                    let tag = crate::engine::tools::TOOLS_DISCOVERED_TAG;
                    if let Some(start) = output.find(tag) {
                        if let Some(end) = output[start..].find(']') {
                            let tag_content = &output[start + tag.len()..start + end];
                            for name in tag_content.split(',') {
                                let name = name.trim();
                                if !name.is_empty() {
                                    discovered_tool_names.push(name.to_string());
                                }
                            }
                        }
                    }
                }

                // Emit ToolEnd. 2000 chars: must be large enough for structured
                // JSON payloads (e.g. create_task ~260 bytes, pty_spawn_interactive)
                // so the frontend can parse __type to render inline cards.
                on_event(AgentStreamEvent::ToolEnd {
                    name: tool_name.clone(),
                    result_preview: output.chars().take(2000).collect(),
                });

                // Persist
                if let Some(ref pfn) = persist_fn {
                    pfn(ToolPersistEvent::ToolResult {
                        tool_call_id: prep.call.id.clone(),
                        tool_name: tool_name.clone(),
                        result_content: output.chars().take(2000).collect(),
                    });
                }

                // Push to messages
                let content = if images.is_empty() {
                    MessageContent::text(output)
                } else {
                    MessageContent::with_images(&output, &images)
                };
                messages.push(LLMMessage {
                    role: "tool".into(),
                    content: Some(content),
                    tool_calls: None,
                    tool_call_id: Some(prep.call.id.clone()),
                });
            }

            // ── Dynamic tool injection (Claw Code pattern) ──
            // When tool_search discovers tools, inject their full definitions into
            // the tools list so the LLM can call them in subsequent iterations.
            if !discovered_tool_names.is_empty() {
                let names_ref: Vec<&str> = discovered_tool_names.iter().map(|s| s.as_str()).collect();
                let new_tools = resolve_deferred_tools(&names_ref);
                // Collect existing names as owned strings to avoid borrow conflict
                let existing_names: std::collections::HashSet<String> = tools.iter()
                    .map(|t| t.function.name.clone())
                    .collect();
                for tool in new_tools {
                    if !existing_names.contains(&tool.function.name) {
                        log::info!("Dynamic tool injection: adding '{}' to active tools", tool.function.name);
                        tools.push(tool);
                    }
                }
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
                emit_usage(&on_event, &usage_tracker, config);
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
                emit_usage(&on_event, &usage_tracker, config);
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

    emit_usage(&on_event, &usage_tracker, config);
    let err = format!("Agent reached maximum iterations ({})", max_iter);
    on_event(AgentStreamEvent::Error);
    Err(err)
}

/// Emit cumulative usage event if any tokens were tracked.
fn emit_usage<F: Fn(AgentStreamEvent)>(
    on_event: &F,
    tracker: &crate::engine::usage::UsageTracker,
    config: &LLMConfig,
) {
    let cum = tracker.cumulative_usage();
    if cum.input_tokens == 0 && cum.output_tokens == 0 {
        return;
    }
    let cost = crate::engine::usage::estimate_cost(&cum, &config.model);
    on_event(AgentStreamEvent::Usage {
        input_tokens: cum.input_tokens,
        output_tokens: cum.output_tokens,
        cache_read_tokens: cum.cache_read_input_tokens,
        estimated_cost_usd: cost,
    });
}

/// Translate internal tool name + args into a human-readable action description.
fn humanize_tool_action(tool_name: &str, tool_input: &str) -> String {
    let args: serde_json::Value = serde_json::from_str(tool_input).unwrap_or_default();
    match tool_name {
        "browser_use" => {
            let action = args["action"].as_str().unwrap_or("operate");
            let url = args["url"].as_str().unwrap_or("");
            match action {
                "start" => "打开浏览器".into(),
                "goto" | "open" => format!("打开网页: {}", truncate(url, 60)),
                "click" => "点击网页元素".into(),
                "type" | "input" => "在网页中输入文字".into(),
                "screenshot" | "snapshot" => "截取网页截图".into(),
                "stop" => "关闭浏览器".into(),
                _ => format!("浏览器操作: {}", action),
            }
        }
        "execute_shell" => {
            let cmd = args["command"].as_str().unwrap_or("命令");
            format!("执行命令: {}", truncate(cmd, 80))
        }
        "write_file" => {
            let path = args["path"].as_str().unwrap_or("文件");
            format!("写入文件: {}", truncate(path, 60))
        }
        "edit_file" => {
            let path = args["path"].as_str().unwrap_or("文件");
            format!("编辑文件: {}", truncate(path, 60))
        }
        "delete_file" => {
            let path = args["path"].as_str().unwrap_or("文件");
            format!("删除文件: {}", truncate(path, 60))
        }
        "computer_control" => {
            let action = args["action"].as_str().unwrap_or("操作");
            format!("电脑控制: {}", action)
        }
        "spawn_agents" => "启动子智能体".into(),
        "manage_bot" => "管理 Bot 配置".into(),
        "manage_cronjob" => "管理定时任务".into(),
        "pip_install" => {
            let pkg = args["package"].as_str().unwrap_or("包");
            format!("安装 Python 包: {}", pkg)
        }
        "git_commit" => {
            let msg = args["message"].as_str().unwrap_or("");
            format!("Git 提交: {}", truncate(msg, 50))
        }
        "git_create_branch" => {
            let name = args["name"].as_str().unwrap_or("分支");
            format!("创建 Git 分支: {}", name)
        }
        _ => {
            // Fallback: still better than raw tool_name(json)
            let desc = tool_name.replace('_', " ");
            format!("执行操作: {}", desc)
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() }
    else { format!("{}…", s.chars().take(max).collect::<String>()) }
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
