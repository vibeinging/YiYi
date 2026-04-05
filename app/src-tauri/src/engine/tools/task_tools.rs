use tauri::Emitter;

/// Task management tool definitions.
pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "create_task",
            "创建后台任务。任何需要创建/写入文件或设置定时任务的请求都必须使用此工具。任务在独立工作空间中后台执行，不影响主对话。不适用于纯问答、翻译等不产生文件的操作。",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "任务标题，简短描述任务内容"
                    },
                    "description": {
                        "type": "string",
                        "description": "任务的详细描述和需求"
                    },
                    "plan": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "执行阶段列表，如 ['初始化项目', '编写代码', '测试']"
                    }
                },
                "required": ["title", "description"]
            }),
        ),
        super::tool_def(
            "create_workspace_dir",
            "Create a workspace directory for task file outputs. Call this BEFORE writing any files when the task will produce files (HTML, code, documents, etc.). The directory is created under the user's workspace (~/Documents/YiYi/).",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "dir_name": {
                        "type": "string",
                        "description": "Meaningful directory name related to the task (e.g. '个人作品集网站', 'Q1数据分析报告')"
                    }
                },
                "required": ["dir_name"]
            }),
        ),
        super::tool_def(
            "report_progress",
            "Report task progress. Call this after completing a significant sub-step.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "step_title": { "type": "string", "description": "Title of the completed step" },
                    "status": { "type": "string", "enum": ["completed", "in_progress", "blocked"], "description": "Status of this step" },
                    "summary": { "type": "string", "description": "Brief summary of what was done" }
                },
                "required": ["step_title", "status", "summary"]
            }),
        ),
        super::tool_def(
            "query_tasks",
            "查询后台任务列表和状态。可按状态过滤（running/completed/failed/pending 等）。用于回答用户关于任务进度的问题，如「刚才那个任务怎么样了」「统计发票的任务结束了吗」。",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "description": "Filter by status: 'running', 'completed', 'failed', 'pending', 'paused', 'cancelled'. Omit to list all."
                    },
                    "keyword": {
                        "type": "string",
                        "description": "Search keyword to match against task title/description. Omit to list all."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max number of tasks to return. Default 10."
                    }
                }
            }),
        ),
        super::tool_def(
            "request_continuation",
            "Signal that the current task is not yet complete and requires another round to finish. \
            Call this when you have completed a meaningful sub-step but more work remains. \
            Do NOT call this for simple questions, single-step tasks, or when the task is already complete.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Brief description of what remains to be done in the next round"
                    }
                },
                "required": ["reason"]
            }),
        ),
    ]
}

pub(super) async fn create_task_tool(args: &serde_json::Value) -> String {
    // Prevent nested task creation
    let current_sid = super::get_current_session_id();
    if current_sid.starts_with("task:") {
        return serde_json::json!({
            "error": "已在任务执行上下文中，不能创建嵌套任务。请直接使用 write_file/edit_file/execute_shell 等工具完成工作。"
        }).to_string();
    }

    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled Task");
    let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("");
    let plan: Vec<String> = args
        .get("plan")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let task_id = uuid::Uuid::new_v4().to_string();
    let session_id = format!("task:{}", task_id);
    let total_stages = plan.len() as i32;

    // Get parent session id from task-local context
    let parent_session_id = super::get_current_session_id();

    let now = chrono::Utc::now().timestamp();

    // 1. Create task session and task record in DB
    if let Some(db) = super::DATABASE.get() {
        // Create a session for this task
        if let Err(e) = db.ensure_session(&session_id, title, "task", Some(&task_id)) {
            return format!("Error creating task session: {}", e);
        }

        // Build plan JSON if provided
        let plan_json = if plan.is_empty() {
            None
        } else {
            Some(
                serde_json::to_string(
                    &plan
                        .iter()
                        .map(|s| serde_json::json!({"title": s, "status": "pending"}))
                        .collect::<Vec<_>>(),
                )
                .unwrap_or_default(),
            )
        };

        // Create task record in tasks table
        if let Err(e) = db.create_task(
            &task_id,
            title,
            Some(description),
            "pending",
            &session_id,
            Some(&parent_session_id),
            plan_json.as_deref(),
            total_stages,
            now,
        ) {
            return format!("Error creating task record: {}", e);
        }
    } else {
        return "Error: database not available".into();
    }

    // 2. Emit event to notify frontend
    if let Some(app) = super::APP_HANDLE.get() {
        let _ = app.emit(
            "task://created",
            serde_json::json!({
                "task_id": task_id,
                "session_id": session_id,
                "parent_session_id": parent_session_id,
                "title": title,
                "description": description,
                "plan": plan,
                "total_stages": total_stages,
                "source": "tool",
            }),
        );
    }

    // 3. Spawn async task execution
    super::spawn_task_execution(
        task_id.clone(),
        session_id.clone(),
        title.to_string(),
        description.to_string(),
        plan.clone(),
        total_stages,
    );

    // Return result to the main conversation
    serde_json::json!({
        "__type": "create_task",
        "id": task_id,
        "task_id": task_id,
        "session_id": session_id,
        "status": "created",
        "message": format!("任务「{}」已创建并开始执行。任务 ID: {}", title, task_id)
    })
    .to_string()
}

pub(super) async fn create_workspace_dir_tool(args: &serde_json::Value) -> String {
    let raw_name = args.get("dir_name").and_then(|v| v.as_str()).unwrap_or("task_output");
    // Sanitize: strip path separators and parent-dir references
    let dir_name: String = raw_name
        .replace(['/', '\\'], "_")
        .replace("..", "_")
        .trim()
        .to_string();
    let dir_name = if dir_name.is_empty() { "task_output".to_string() } else { dir_name };

    // Get user workspace directory
    let workspace_base = super::USER_WORKSPACE
        .get()
        .cloned()
        .unwrap_or_else(|| {
            dirs::document_dir()
                .unwrap_or_else(|| dirs::home_dir().unwrap_or_default())
                .join("YiYi")
        });

    // Create directory with dedup suffix if needed (max 100 attempts)
    let mut target = workspace_base.join(&dir_name);
    if target.exists() {
        let mut suffix = 2;
        while suffix <= 100 {
            target = workspace_base.join(format!("{}-{}", dir_name, suffix));
            if !target.exists() {
                break;
            }
            suffix += 1;
        }
    }

    if let Err(e) = std::fs::create_dir_all(&target) {
        format!("Failed to create workspace directory: {}", e)
    } else {
        let abs_path = target.to_string_lossy().to_string();

        // Store in per-session map
        let session_id = super::get_current_session_id();
        if !session_id.is_empty() {
            let mut map = super::task_workspace_map().lock().await;
            map.insert(session_id.clone(), abs_path.clone());
        }

        // Persist workspace_path to DB for the task (so open_task_folder can find it)
        if session_id.starts_with("task:") {
            let task_id = &session_id["task:".len()..];
            if let Some(db) = super::DATABASE.get() {
                let _ = db.update_task_workspace_path(task_id, &abs_path);
            }
        }

        format!("Workspace directory created: {}\nAll task output files should be written to this directory.", abs_path)
    }
}

pub(super) async fn report_progress_tool(args: &serde_json::Value) -> String {
    let step_title = args["step_title"].as_str().unwrap_or("Unknown step");
    let status = args["status"].as_str().unwrap_or("in_progress");
    let summary = args["summary"].as_str().unwrap_or("");

    // Find task for current session
    let session_id = super::get_current_session_id();
    let task_info = if let Some(db) = super::DATABASE.get() {
        db.list_tasks(None, Some("running"))
            .unwrap_or_default()
            .into_iter()
            .find(|t| t.session_id == session_id)
    } else {
        None
    };

    if let Some(task) = &task_info {
        // Update progress.json
        if let Some(wd) = super::WORKING_DIR.get() {
            let progress_dir = wd.join("tasks").join(&task.id);
            std::fs::create_dir_all(&progress_dir).ok();
            let progress = serde_json::json!({
                "task_id": task.id,
                "session_id": session_id,
                "status": "running",
                "current_step": step_title,
                "step_status": status,
                "step_summary": summary,
                "current_stage": task.current_stage,
                "total_stages": task.total_stages,
                "updated_at": chrono::Utc::now().timestamp(),
            });
            super::write_progress_json(&progress_dir, &progress);
        }

        // Emit step progress event
        if let Some(handle) = super::APP_HANDLE.get() {
            handle.emit("task://step_progress", serde_json::json!({
                "taskId": task.id,
                "stepTitle": step_title,
                "status": status,
                "summary": summary,
            })).ok();
        }
    }

    format!("Progress reported: [{}] {} - {}", status, step_title, summary)
}

/// Background task that executes a created task via a ReAct Agent.
/// Separated from `create_task_tool` to ensure the async block is Send + 'static.
pub fn spawn_task_execution(
    task_id: String,
    session_id: String,
    title: String,
    description: String,
    plan: Vec<String>,
    total_stages: i32,
) {
    let sid = session_id.clone();
    tokio::spawn(super::with_session_id(sid, async move {
        // Resolve LLM config
        let llm_config = match super::resolve_llm_config_from_globals().await {
            Some(cfg) => cfg,
            None => {
                log::error!("Task {}: No active model configured", task_id);
                fail_task(&task_id, &session_id, "No active model configured");
                return;
            }
        };

        let working_dir = match super::WORKING_DIR.get() {
            Some(wd) => wd.clone(),
            None => {
                log::error!("Task {}: Working directory not set", task_id);
                fail_task(&task_id, &session_id, "Working directory not set");
                return;
            }
        };

        let app_handle = super::APP_HANDLE.get().cloned();

        // Create cancellation signal via APP_HANDLE -> AppState
        let cancel_signal: Option<std::sync::Arc<std::sync::atomic::AtomicBool>> = if let Some(ref handle) = app_handle {
            use tauri::Manager;
            if let Some(state) = handle.try_state::<crate::state::AppState>() {
                Some(state.get_or_create_task_cancel(&task_id))
            } else {
                None
            }
        } else {
            None
        };

        // Update task status to "running"
        if let Some(db) = super::DATABASE.get() {
            db.update_task_status(&task_id, "running").ok();
        }

        // Emit running event
        if let Some(ref handle) = app_handle {
            handle.emit("task://progress", serde_json::json!({
                "task_id": task_id,
                "session_id": session_id,
                "status": "running",
                "current_stage": 0,
                "progress": 0.0,
            })).ok();
        }

        // Load skill index + always-active skills
        let skills_dir = working_dir.join("active_skills");
        let mut skill_index = Vec::new();
        let mut always_active_skills = Vec::new();
        if let Ok(mut entries) = tokio::fs::read_dir(&skills_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                let skill_md = path.join("SKILL.md");
                if let Ok(content) = tokio::fs::read_to_string(&skill_md).await {
                    let name = path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let (description_opt, is_always_active) = crate::commands::agent::parse_skill_frontmatter(&content);
                    if is_always_active {
                        always_active_skills.push(content);
                    } else {
                        skill_index.push(crate::commands::agent::SkillIndexEntry {
                            name,
                            description: description_opt.unwrap_or_default(),
                        });
                    }
                }
            }
        }

        // Load MCP tools
        let (mcp_tools_list, unavailable_servers) = if let Some(runtime) = super::MCP_RUNTIME.get() {
            runtime.get_all_tools_with_status().await
        } else {
            (vec![], vec![])
        };
        let skill_overrides = std::collections::HashMap::new();
        let mcp_extra: Vec<super::ToolDefinition> = super::mcp_tools_as_definitions(&mcp_tools_list, &skill_overrides);

        let mcp_ref = if mcp_tools_list.is_empty() { None } else { Some(mcp_tools_list.as_slice()) };
        let unavail_ref = if unavailable_servers.is_empty() { None } else { Some(unavailable_servers.as_slice()) };

        // Build system prompt
        let base_prompt = super::react_agent::build_system_prompt(
            &working_dir, None, &skill_index, &always_active_skills, None, mcp_ref, unavail_ref,
        ).await;

        let plan_text = if plan.is_empty() {
            String::new()
        } else {
            let steps: Vec<String> = plan.iter().enumerate()
                .map(|(i, s)| format!("{}. {}", i + 1, s))
                .collect();
            format!("\n执行计划：\n{}\n", steps.join("\n"))
        };

        let system_prompt = format!(
            "你正在执行一个独立任务。\n\n\
            任务标题：{title}\n\
            任务描述：{description}\n\
            {plan_text}\n\
            请按计划逐步执行每个阶段。每完成一个阶段，请在输出中明确标记 [STAGE_COMPLETE: N]（N 为阶段编号，从 1 开始）来指示进度。\n\
            完成所有阶段后，总结执行结果。\n\n\
            {base_prompt}",
            title = title,
            description = description,
            plan_text = plan_text,
            base_prompt = base_prompt,
        );

        // Load conversation history from task session
        let history: Vec<super::llm_client::LLMMessage> = if let Some(db) = super::DATABASE.get() {
            let msgs = db.get_recent_messages(&session_id, 50).unwrap_or_default();
            msgs.iter().filter_map(|m| {
                if m.role == "system" {
                    None
                } else {
                    Some(super::llm_client::LLMMessage {
                        role: m.role.clone(),
                        content: Some(super::llm_client::MessageContent::text(&m.content)),
                        tool_calls: None,
                        tool_call_id: None,
                    })
                }
            }).collect()
        } else {
            vec![]
        };

        // Use the last user message from history if available, otherwise generate one
        let user_message = if let Some(last_user) = history.iter().rev().find(|m| m.role == "user") {
            last_user.content.as_ref()
                .and_then(|c| c.as_text())
                .unwrap_or(&format!("开始执行任务「{}」。请按照计划逐步完成。", title))
                .to_string()
        } else {
            format!("开始执行任务「{}」。请按照计划逐步完成。", title)
        };
        let task_history: Vec<super::llm_client::LLMMessage> = if !history.is_empty() {
            let mut h = history;
            if let Some(pos) = h.iter().rposition(|m| m.role == "user") {
                h.remove(pos);
            }
            h
        } else {
            vec![]
        };

        // Track progress from agent output
        let task_id_for_cb = task_id.clone();
        let session_id_for_cb = session_id.clone();
        let total_stages_for_cb = total_stages;
        let app_handle_for_cb = app_handle.clone();

        let on_event = move |evt: super::react_agent::AgentStreamEvent| {
            match &evt {
                super::react_agent::AgentStreamEvent::Token(text) => {
                    // Strip [STAGE_COMPLETE: N] markers before sending to frontend
                    let clean_text = strip_stage_markers(text);
                    if !clean_text.is_empty() {
                        if let Some(ref handle) = app_handle_for_cb {
                            handle.emit("task://stream_chunk", serde_json::json!({
                                "taskId": task_id_for_cb,
                                "text": clean_text,
                            })).ok();
                        }
                    }

                    // Check for [STAGE_COMPLETE: N] markers
                    if let Some(stage) = parse_stage_complete(text) {
                        let progress = if total_stages_for_cb > 0 {
                            (stage as f64 / total_stages_for_cb as f64 * 100.0).min(100.0)
                        } else {
                            0.0
                        };

                        // Update DB progress
                        if let Some(db) = super::DATABASE.get() {
                            db.update_task_progress(&task_id_for_cb, stage, total_stages_for_cb, progress).ok();
                        }

                        // Emit progress event (camelCase for consistency)
                        if let Some(ref handle) = app_handle_for_cb {
                            handle.emit("task://progress", serde_json::json!({
                                "taskId": task_id_for_cb,
                                "sessionId": session_id_for_cb,
                                "status": "running",
                                "currentStage": stage,
                                "totalStages": total_stages_for_cb,
                                "progress": progress,
                            })).ok();
                        }
                    }
                }
                super::react_agent::AgentStreamEvent::ToolStart { name, args_preview } => {
                    if let Some(ref handle) = app_handle_for_cb {
                        handle.emit("task://tool_start", serde_json::json!({
                            "taskId": task_id_for_cb,
                            "name": name,
                            "preview": args_preview,
                        })).ok();
                    }
                }
                super::react_agent::AgentStreamEvent::ToolEnd { name, result_preview } => {
                    if let Some(ref handle) = app_handle_for_cb {
                        handle.emit("task://tool_end", serde_json::json!({
                            "taskId": task_id_for_cb,
                            "name": name,
                            "preview": result_preview,
                        })).ok();
                    }
                }
                _ => {}
            }
        };

        // Build persist callback for task session using global DATABASE reference
        let persist_fn = {
            let sid = session_id.clone();
            Some(std::sync::Arc::new(move |evt: super::react_agent::ToolPersistEvent| {
                let Some(db) = super::DATABASE.get() else { return };
                match evt {
                    super::react_agent::ToolPersistEvent::AssistantWithToolCalls { content, tool_calls_json } => {
                        let metadata = serde_json::json!({
                            "tool_calls": serde_json::from_str::<serde_json::Value>(&tool_calls_json).unwrap_or_default()
                        }).to_string();
                        db.push_message_with_metadata(&sid, "assistant", &content, Some(&metadata)).ok();
                    }
                    super::react_agent::ToolPersistEvent::ToolResult { tool_call_id, tool_name, result_content } => {
                        let metadata = serde_json::json!({
                            "tool_call_id": tool_call_id,
                            "tool_name": tool_name,
                        }).to_string();
                        db.push_message_with_metadata(&sid, "tool", &result_content, Some(&metadata)).ok();
                    }
                }
            }) as super::react_agent::PersistToolFn)
        };

        // Execute the agent
        let result: Result<String, String> = if let Some(ref cancel) = cancel_signal {
            super::with_cancelled(cancel.clone(), Box::pin(
                super::react_agent::run_react_with_options_stream(
                    &llm_config, &system_prompt, &user_message, &mcp_extra,
                    &task_history, None, Some(&working_dir), on_event,
                    Some(cancel.as_ref()), persist_fn, None,
                )
            )).await
        } else {
            super::react_agent::run_react_with_options_stream(
                &llm_config, &system_prompt, &user_message, &mcp_extra,
                &task_history, None, Some(&working_dir), on_event,
                None, persist_fn, None,
            ).await
        };

        // Handle result
        let (was_successful, result_text) = match result {
            Ok(ref reply) => {
                // Save result to DB
                if let Some(db) = super::DATABASE.get() {
                    db.update_task_status(&task_id, "completed").ok();
                    db.update_task_progress(&task_id, total_stages, total_stages, 100.0).ok();
                    db.push_message(&session_id, "assistant", reply).ok();
                }

                if let Some(ref handle) = app_handle {
                    handle.emit("task://completed", serde_json::json!({
                        "taskId": task_id,
                        "sessionId": session_id,
                        "status": "completed",
                        "result": super::truncate_output(reply, 3000),
                    })).ok();
                }

                log::info!("Task {} completed successfully", task_id);
                (true, reply.clone())
            }
            Err(ref e) => {
                let error_msg = if e == "cancelled" {
                    "任务已被取消"
                } else {
                    e.as_str()
                };
                let status = if e == "cancelled" { "cancelled" } else { "failed" };

                fail_task_with_status(&task_id, &session_id, error_msg, status);
                log::warn!("Task {} {}: {}", task_id, status, error_msg);
                (false, error_msg.to_string())
            }
        };

        // Growth System: post-task reflection (background, non-blocking)
        {
            let config = llm_config.clone();
            let tid = task_id.clone();
            let sid = session_id.clone();
            let desc = description.clone();
            let res = result_text;
            tokio::spawn(async move {
                super::react_agent::reflect_on_task(
                    &config,
                    Some(&tid),
                    Some(&sid),
                    &desc,
                    &res,
                    was_successful,
                    if was_successful {
                        super::react_agent::SignalType::SilentCompletion
                    } else {
                        super::react_agent::SignalType::ToolError
                    },
                ).await;
            });
        }

        // Cleanup cancel signal
        if let Some(ref handle) = app_handle {
            use tauri::Manager;
            if let Some(state) = handle.try_state::<crate::state::AppState>() {
                state.cleanup_task_signal(&task_id);
            }
        }
    }));
}

/// Strip `[STAGE_COMPLETE: N]` markers from text so they don't appear in frontend.
pub fn strip_stage_markers(text: &str) -> String {
    let mut result = text.to_string();
    while let Some(start) = result.find("[STAGE_COMPLETE:") {
        if let Some(end) = result[start..].find(']') {
            result.replace_range(start..start + end + 1, "");
        } else {
            break;
        }
    }
    result
}

/// Parse `[STAGE_COMPLETE: N]` marker from text, returning the stage number.
fn parse_stage_complete(text: &str) -> Option<i32> {
    let marker = "[STAGE_COMPLETE:";
    if let Some(start) = text.find(marker) {
        let rest = &text[start + marker.len()..];
        let num_str: String = rest.chars()
            .skip_while(|c| c.is_whitespace())
            .take_while(|c| c.is_ascii_digit())
            .collect();
        num_str.parse::<i32>().ok()
    } else {
        None
    }
}

/// Helper: mark task as failed with default "failed" status.
pub(super) fn fail_task(task_id: &str, session_id: &str, error_message: &str) {
    fail_task_with_status(task_id, session_id, error_message, "failed");
}

/// Helper: mark task as failed/cancelled and emit event.
fn fail_task_with_status(task_id: &str, session_id: &str, error_message: &str, status: &str) {
    if let Some(db) = super::DATABASE.get() {
        db.update_task_error(task_id, status, error_message).ok();
    }

    if let Some(app) = super::APP_HANDLE.get() {
        let event_name = if status == "cancelled" { "task://cancelled" } else { "task://failed" };
        app.emit(event_name, serde_json::json!({
            "taskId": task_id,
            "sessionId": session_id,
            "status": status,
            "error": error_message,
        })).ok();
    }
}

/// Query tasks by status and/or keyword.
pub(super) async fn query_tasks_tool(args: &serde_json::Value) -> String {
    let status = args["status"].as_str();
    let keyword = args["keyword"].as_str().unwrap_or("");
    let limit = args["limit"].as_u64().unwrap_or(10) as usize;

    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return format!("Error: {}", e),
    };

    let tasks = match db.list_tasks(None, status) {
        Ok(tasks) => tasks,
        Err(e) => return format!("Error querying tasks: {}", e),
    };

    // Filter by keyword if provided
    let filtered: Vec<_> = if keyword.is_empty() {
        tasks.into_iter().take(limit).collect()
    } else {
        let kw = keyword.to_lowercase();
        tasks.into_iter()
            .filter(|t| {
                t.title.to_lowercase().contains(&kw)
                    || t.description.as_deref().unwrap_or("").to_lowercase().contains(&kw)
            })
            .take(limit)
            .collect()
    };

    if filtered.is_empty() {
        return if let Some(s) = status {
            format!("No tasks found with status '{}'.", s)
        } else if !keyword.is_empty() {
            format!("No tasks matching '{}'.", keyword)
        } else {
            "No tasks found.".into()
        };
    }

    // Format results
    let mut result = format!("Found {} task(s):\n\n", filtered.len());
    for t in &filtered {
        let elapsed = if t.status == "running" {
            let secs = chrono::Utc::now().timestamp() - t.created_at;
            format!(", running for {}m", secs / 60)
        } else {
            String::new()
        };
        result.push_str(&format!(
            "- **{}** [{}{}]\n  ID: {}\n  {}\n",
            t.title,
            t.status,
            elapsed,
            t.id,
            t.description.as_deref().unwrap_or("").chars().take(100).collect::<String>(),
        ));
        if let Some(ref err) = t.error_message {
            result.push_str(&format!("  Error: {}\n", err.chars().take(200).collect::<String>()));
        }
        if t.progress > 0.0 {
            result.push_str(&format!("  Progress: {:.0}%\n", t.progress * 100.0));
        }
        result.push('\n');
    }
    result
}
