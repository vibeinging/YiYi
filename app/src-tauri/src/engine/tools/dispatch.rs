//! `execute_tool` — single entry point the ReAct loop calls for every tool
//! invocation. Routes by name into the appropriate built-in implementation,
//! falls back to MCP for unknown names, and reports touched paths to the
//! turn-level checkpoint system.
//!
//! Adding a new built-in tool is mechanical: add an arm to the `match` block.
//! Adding a new MCP-only tool needs no change here — it flows through the
//! `_` arm via `GlobalToolRegistry` / `try_mcp_tool`.

use super::super::llm_client;
use super::internal::{repair_json, try_mcp_tool};
use super::state::{
    get_current_session_id, is_ready, is_task_cancelled, AGENT_TOOL_FILTER, APP_HANDLE,
    CONTINUATION_REQUESTED, MCP_RUNTIME,
};
use super::types::{ToolCall, ToolResult};
use super::{
    bot_tools, browser_tools, canvas_tools, cheap_browser, cron_tools, file_tools, flash_tools,
    git_tools, lsp_tools, memory_tools, skill_tools, snapshot_tools, spawn_tools, system_tools,
    task_tools, web_tools,
};

/// After a tool returns, report touched paths into the session dirty-set
/// so the agent loop can decide whether to checkpoint this turn. No-op
/// for non-mutating tools, failed calls, or when no session is active.
fn record_dirty_path(name: &str, args: &serde_json::Value, content: &str) {
    // Cheap match first — most tool calls are reads and exit immediately
    // before allocating a session-id string.
    let is_pathful = matches!(
        name,
        "write_file" | "edit_file" | "append_file" | "delete_file" | "undo_edit"
    );
    let is_shell = matches!(
        name,
        "execute_shell" | "run_python" | "run_python_script" | "pip_install"
    );
    if !is_pathful && !is_shell {
        return;
    }
    // YiYi tool convention: errors begin with "Error" (case-sensitive).
    if content.starts_with("Error") {
        return;
    }
    let session = get_current_session_id();
    if session.is_empty() {
        return;
    }
    if is_pathful {
        if let Some(p) = args
            .get("path")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            crate::engine::checkpoint::report_dirty(&session, p);
        }
    } else {
        crate::engine::checkpoint::report_unknown(&session);
    }
}

pub async fn execute_tool(call: &ToolCall) -> ToolResult {
    // Startup readiness check — reject tool calls if subsystem not yet initialized
    if !is_ready() {
        return ToolResult {
            tool_call_id: call.id.clone(),
            content: "Error: Tool subsystem not yet initialized. Please wait for app startup to complete.".into(),
            images: vec![],
        };
    }

    if is_task_cancelled() {
        return ToolResult {
            tool_call_id: call.id.clone(),
            content: "[已取消]".to_string(),
            images: vec![],
        };
    }

    // Runtime tool filter enforcement — prevents prompt-injection bypass
    if let Ok(filter) = AGENT_TOOL_FILTER.try_with(|f| f.clone()) {
        if !filter.is_allowed(&call.function.name) {
            return ToolResult {
                tool_call_id: call.id.clone(),
                content: format!(
                    "Error: Tool '{}' is not available to this agent.",
                    call.function.name
                ),
                images: vec![],
            };
        }
    }

    // Defense-in-depth: PermissionPolicy check at tool dispatch level
    // Even if the caller forgot to check, this prevents ReadOnly agents from writing
    {
        use crate::engine::permission_mode::{PermissionMode, PermissionOutcome, PermissionPolicy};
        let mode = if let Ok(filter) = AGENT_TOOL_FILTER.try_with(|f| f.clone()) {
            // Derive mode from tool filter (same logic as core.rs)
            if let super::super::react_agent::ToolFilter::Allow(ref names) = filter {
                let policy = PermissionPolicy::new(PermissionMode::ReadOnly);
                if names
                    .iter()
                    .all(|n| policy.required_mode_for(n) == PermissionMode::ReadOnly)
                {
                    PermissionMode::ReadOnly
                } else {
                    PermissionMode::Standard
                }
            } else {
                PermissionMode::Standard
            }
        } else {
            PermissionMode::Standard
        };
        let policy = PermissionPolicy::new(mode);
        if let PermissionOutcome::Deny { reason } = policy.is_allowed(&call.function.name) {
            return ToolResult {
                tool_call_id: call.id.clone(),
                content: format!("Error: {reason}"),
                images: vec![],
            };
        }
    }

    let args: serde_json::Value = match serde_json::from_str(&call.function.arguments) {
        Ok(v) => v,
        Err(_) => {
            // Try lightweight JSON repair before giving up
            match repair_json(&call.function.arguments) {
                Some(repaired) => {
                    log::warn!(
                        "Repaired malformed JSON for tool '{}': {}",
                        call.function.name,
                        call.function
                            .arguments
                            .chars()
                            .take(200)
                            .collect::<String>()
                    );
                    repaired
                }
                None => {
                    // Return error to model so it can self-correct
                    log::warn!(
                        "Invalid JSON arguments for tool '{}': {}",
                        call.function.name,
                        call.function
                            .arguments
                            .chars()
                            .take(200)
                            .collect::<String>()
                    );
                    return ToolResult {
                        tool_call_id: call.id.clone(),
                        content: format!(
                            "Error: Invalid JSON in tool arguments. Please retry with valid JSON.\n\
                            Tool: {}\nReceived: {}",
                            call.function.name,
                            call.function.arguments.chars().take(500).collect::<String>()
                        ),
                        images: vec![],
                    };
                }
            }
        }
    };

    let content = match call.function.name.as_str() {
        "execute_shell" => system_tools::execute_shell_tool(&args).await,
        "read_file" => file_tools::read_file_tool(&args).await,
        "write_file" => file_tools::write_file_tool(&args).await,
        "edit_file" => file_tools::edit_file_tool(&args).await,
        "append_file" => file_tools::append_file_tool(&args).await,
        "delete_file" => file_tools::delete_file_tool(&args).await,
        "undo_edit" => file_tools::undo_edit_tool(&args).await,
        "project_tree" => file_tools::project_tree_tool(&args).await,
        "list_directory" => file_tools::list_directory_tool(&args).await,
        "grep_search" => file_tools::grep_search_tool(&args).await,
        "glob_search" => file_tools::glob_search_tool(&args).await,
        "web_search" => web_tools::web_search_tool(&args).await,
        "get_current_time" => system_tools::get_current_time_tool().await,
        "desktop_screenshot" => {
            let (content, images) = system_tools::desktop_screenshot_tool().await;
            return ToolResult {
                tool_call_id: call.id.clone(),
                content,
                images,
            };
        }
        "browser_use" => {
            let (content, images) = browser_tools::browser_use_tool(&args).await;
            return ToolResult {
                tool_call_id: call.id.clone(),
                content,
                images,
            };
        }
        "browser_screenshot" => {
            let (content, images) = cheap_browser::browser_screenshot_tool(&args).await;
            return ToolResult {
                tool_call_id: call.id.clone(),
                content,
                images,
            };
        }
        "browser_fetch" => cheap_browser::browser_fetch_tool(&args).await,
        "run_python" => system_tools::run_python_tool(&args).await,
        "run_python_script" => system_tools::run_python_script_tool(&args).await,
        "pip_install" => system_tools::pip_install_tool(&args).await,
        "read_pdf" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = super::access_check(path, false).await {
                format!("Error: {}", e)
            } else {
                super::super::doc_tools::read_pdf_text(path)
            }
        }
        "read_spreadsheet" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = super::access_check(path, false).await {
                format!("Error: {}", e)
            } else {
                let sheet = args["sheet"].as_str();
                let max_rows = args["max_rows"].as_u64().map(|n| n as usize);
                super::super::doc_tools::read_spreadsheet(path, sheet, max_rows)
            }
        }
        "create_spreadsheet" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = super::access_check(path, true).await {
                format!("Error: {}", e)
            } else {
                let data = &args["data"];
                let sheet_name = args["sheet_name"].as_str();
                super::super::doc_tools::create_spreadsheet(path, data, sheet_name)
            }
        }
        "read_docx" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = super::access_check(path, false).await {
                format!("Error: {}", e)
            } else {
                super::super::doc_tools::read_docx_text(path)
            }
        }
        "create_docx" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = super::access_check(path, true).await {
                format!("Error: {}", e)
            } else {
                let content = args["content"].as_str().unwrap_or("");
                super::super::doc_tools::create_docx(path, content)
            }
        }
        "memory_add" => memory_tools::memory_add_tool(&args).await,
        "memory_search" => memory_tools::memory_search_tool(&args).await,
        "memory_delete" => memory_tools::memory_delete_tool(&args).await,
        "memory_list" => memory_tools::memory_list_tool(&args).await,
        "diary_write" => match memory_tools::diary_write_tool(&args).await {
            Ok(s) => s,
            Err(e) => {
                return ToolResult {
                    tool_call_id: call.id.clone(),
                    content: e,
                    images: vec![],
                }
            }
        },
        "diary_read" => match memory_tools::diary_read_tool(&args).await {
            Ok(s) => s,
            Err(e) => {
                return ToolResult {
                    tool_call_id: call.id.clone(),
                    content: e,
                    images: vec![],
                }
            }
        },
        "memory_read" => match memory_tools::memory_read_tool().await {
            Ok(s) => s,
            Err(e) => {
                return ToolResult {
                    tool_call_id: call.id.clone(),
                    content: e,
                    images: vec![],
                }
            }
        },
        "memory_write" => match memory_tools::memory_write_tool(&args).await {
            Ok(s) => s,
            Err(e) => {
                return ToolResult {
                    tool_call_id: call.id.clone(),
                    content: e,
                    images: vec![],
                }
            }
        },
        "manage_cronjob" => cron_tools::manage_cronjob_tool(&args).await,
        "manage_quick_action" => skill_tools::manage_quick_action_tool(&args).await,
        "list_bot_conversations" => bot_tools::list_bot_conversations_tool(&args).await,
        "manage_skill" => skill_tools::manage_skill_tool(&args).await,
        "activate_skills" => skill_tools::activate_skills_tool(&args).await,
        "register_code" => skill_tools::register_code_tool(&args).await,
        "search_my_code" => skill_tools::search_my_code_tool(&args).await,
        "request_continuation" => {
            CONTINUATION_REQUESTED
                .try_with(|c| c.store(true, std::sync::atomic::Ordering::Relaxed))
                .ok();
            let reason = args["reason"].as_str().unwrap_or("unspecified");
            format!("Continuation scheduled. Remaining work: {}", reason)
        }
        "send_bot_message" => bot_tools::send_bot_message_tool(&args).await,
        "manage_bot" => bot_tools::manage_bot_tool(&args).await,
        "send_notification" => system_tools::send_notification_tool(&args),
        "add_calendar_event" => system_tools::add_calendar_event_tool(&args).await,
        // "claude_code" removed — YiYi handles coding natively
        "send_file_to_user" => system_tools::send_file_to_user_tool(&args).await,
        "create_task" => task_tools::create_task_tool(&args).await,
        "inline_task" => task_tools::inline_task_tool(&args).await,
        "detach_to_background" => task_tools::detach_to_background_tool(&args).await,
        "render_canvas" => canvas_tools::render_canvas_tool(&args).await,
        "spawn_agents" => spawn_tools::spawn_agents_tool(args.clone()).await,
        "create_workspace_dir" => task_tools::create_workspace_dir_tool(&args).await,
        "report_progress" => task_tools::report_progress_tool(&args).await,
        "query_tasks" => task_tools::query_tasks_tool(&args).await,
        "pty_open" => system_tools::pty_spawn_interactive_tool(&args).await,
        "pty_write" => system_tools::pty_send_input_tool(&args).await,
        "pty_read" => system_tools::pty_read_output_tool(&args).await,
        "pty_close" => system_tools::pty_close_session_tool(&args).await,
        "git_commit" => git_tools::git_commit_tool(&args).await,
        "git_create_branch" => git_tools::git_create_branch_tool(&args).await,
        "git_diff" => git_tools::git_diff_tool(&args).await,
        "git_log" => git_tools::git_log_tool(&args).await,
        "git_status" => git_tools::git_status_tool(&args).await,
        "code_intelligence" => lsp_tools::code_intelligence_tool(&args).await,
        "compact_context" => flash_tools::compact_context_tool(&args).await,
        "parallel_analyze" => flash_tools::parallel_analyze_tool(&args).await,
        "ask_buddy" => {
            let question = args["question"].as_str().unwrap_or("");
            let ctx = args["context"].as_str().unwrap_or("");
            if question.is_empty() {
                "Error: question is required".into()
            } else {
                // Resolve LLM config via APP_HANDLE
                let cfg = if let Some(handle) = APP_HANDLE.get() {
                    use tauri::Manager;
                    let state = handle.state::<crate::state::AppState>();
                    let providers = state.providers.read().await;
                    llm_client::resolve_config_from_providers(&providers).ok()
                } else {
                    None
                };
                match cfg {
                    Some(cfg) => {
                        match crate::engine::buddy_delegate::delegate(
                            &cfg,
                            question,
                            crate::engine::buddy_delegate::DelegateContext::TaskDecision,
                            ctx,
                        )
                        .await
                        {
                            Some(result) => serde_json::json!({
                                "answer": result.answer,
                                "confidence": result.confidence,
                                "needs_review": result.needs_review,
                            })
                            .to_string(),
                            None => {
                                "Buddy 暂时无法回答（用户画像尚未建立）。请直接询问用户。"
                                    .into()
                            }
                        }
                    }
                    None => "Error: no LLM configured".into(),
                }
            }
        }
        "tool_search" => super::catalog::execute_tool_search(&args),
        "revert_turn" => snapshot_tools::revert_turn_tool(&args).await,
        _ => {
            // Deferred-MCP stub interception: if the tool name belongs to
            // an MCP server that's waiting on a missing prerequisite, ask
            // the user (via the InstallDialog) to install instead of
            // failing with an opaque "Unknown tool" error.
            if let Some(server_id) =
                crate::engine::infra::deferred_mcp::find_stub_owner(&call.function.name)
            {
                if let Some(entry) = crate::engine::infra::deferred_mcp::get_deferred(&server_id) {
                    if let Some(handle) = APP_HANDLE.get() {
                        use tauri::Emitter;
                        let _ = handle.emit(
                            "mcp://needs_install",
                            serde_json::json!({
                                "server_id": &entry.server_id,
                                "server_name": &entry.server_name,
                                "missing": &entry.missing,
                                "triggered_by_tool": &call.function.name,
                            }),
                        );
                    }
                    return ToolResult {
                        tool_call_id: call.id.clone(),
                        content: format!(
                            "[deferred_mcp_install_requested] Tool `{}` belongs to the `{}` MCP server, \
                             which needs prerequisites the user hasn't installed yet. \
                             A consent dialog is now open in the app. Wait for the user; \
                             once they confirm install + restart, retry this exact tool call.",
                            call.function.name, entry.server_name
                        ),
                        images: vec![],
                    };
                }
            }

            // Unified dispatch: look up in GlobalToolRegistry first
            if let Some(registry) = crate::engine::tool_registry_global::global_registry() {
                let tool_name = &call.function.name;
                // Check registry for dispatch routing
                if let Some(entry) = registry.get(tool_name) {
                    match &entry.source {
                        crate::engine::tool_registry_global::ToolSource::Plugin { .. } => {
                            // Route to plugin executor using dispatch_name (may have plugin__ prefix)
                            if let Some(handle) = APP_HANDLE.get() {
                                use tauri::Manager;
                                let state: tauri::State<'_, crate::state::AppState> =
                                    handle.state();
                                let plugin_reg = state.plugin_registry.read().unwrap();
                                match plugin_reg.execute_tool(&entry.dispatch_name, &args) {
                                    Ok(result) => result,
                                    Err(e) => format!("Plugin tool error: {e}"),
                                }
                            } else {
                                format!("Plugin tool unavailable: no app handle")
                            }
                        }
                        crate::engine::tool_registry_global::ToolSource::Mcp { .. } => {
                            // Route to MCP runtime
                            if let Some(runtime) = MCP_RUNTIME.get() {
                                match try_mcp_tool(runtime, &entry.dispatch_name, &args).await {
                                    Some(result) => result,
                                    None => format!("MCP tool '{}' failed", tool_name),
                                }
                            } else {
                                format!("MCP runtime not available")
                            }
                        }
                        crate::engine::tool_registry_global::ToolSource::BuiltIn => {
                            // Shouldn't reach here (built-ins handled above), but fallback
                            format!("Unknown built-in tool: {}", tool_name)
                        }
                    }
                }
                // Legacy fallback: try prefix-based routing for backward compat
                else if call.function.name.starts_with("plugin__") {
                    if let Some(handle) = APP_HANDLE.get() {
                        use tauri::Manager;
                        let state: tauri::State<'_, crate::state::AppState> = handle.state();
                        let plugin_reg = state.plugin_registry.read().unwrap();
                        match plugin_reg.execute_tool(&call.function.name, &args) {
                            Ok(result) => result,
                            Err(e) => format!("Plugin tool error: {e}"),
                        }
                    } else {
                        format!("Plugin tool unavailable")
                    }
                } else if let Some(runtime) = MCP_RUNTIME.get() {
                    match try_mcp_tool(runtime, &call.function.name, &args).await {
                        Some(result) => result,
                        None => format!("Unknown tool: {}", call.function.name),
                    }
                } else {
                    format!("Unknown tool: {}", call.function.name)
                }
            } else {
                format!("Tool registry not initialized: {}", call.function.name)
            }
        }
    };

    record_dirty_path(&call.function.name, &args, &content);

    ToolResult {
        tool_call_id: call.id.clone(),
        content,
        images: vec![],
    }
}
