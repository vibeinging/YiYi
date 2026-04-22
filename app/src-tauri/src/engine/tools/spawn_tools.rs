use serde::Deserialize;
use tauri::{Emitter, Manager};

// Depth counter for spawn_agents to prevent infinite recursion.
tokio::task_local! {
    pub(super) static DELEGATION_DEPTH: u32;
}

/// Maximum delegation depth to prevent infinite loops.
const MAX_DELEGATION_DEPTH: u32 = 3;

/// A single agent specification from the spawn_agents tool call.
#[derive(Debug, Deserialize)]
struct AgentSpec {
    name: String,
    task: String,
    #[serde(default)]
    skills: Vec<String>,
    /// If true, this agent is read-only (no write tools). Defaults to false.
    #[serde(default)]
    read_only: bool,
    /// Named agent type from the registry (e.g. "explore", "planner", "desktop_operator").
    /// When set, overrides read_only and skills with the agent definition's config.
    #[serde(default)]
    agent_type: Option<String>,
    /// Optional wall-clock timeout (seconds). `None` means no timeout — only
    /// `max_iterations` will bail the agent out. Use this for agents that
    /// might spin on a slow LLM or misbehaving tool.
    #[serde(default)]
    timeout_secs: Option<u64>,
}

/// Spawn agents tool definitions.
pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "spawn_agents",
            "Dynamically create and run a team of temporary agents to handle complex tasks in parallel. Each agent works independently on its assigned task, and all results are collected and returned.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "agents": {
                        "type": "array",
                        "description": "Array of agent specifications to spawn in parallel",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string", "description": "Agent name/role (e.g., 'Researcher', 'Analyst')" },
                                "task": { "type": "string", "description": "Detailed task description for this agent" },
                                "skills": {
                                    "type": "array",
                                    "items": { "type": "string" },
                                    "description": "Optional array of skill names to load for this agent"
                                },
                                "agent_type": {
                                    "type": "string",
                                    "description": "Named agent type: 'explore' (fast read-only search), 'planner' (structured planning), 'desktop_operator' (GUI automation), 'memory_curator' (memory management), 'bot_coordinator' (bot operations). Overrides read_only and skills."
                                },
                                "timeout_secs": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "description": "Optional wall-clock timeout in seconds. If the agent is still running after this many seconds it is cancelled and a timeout error is returned. Omit for no timeout."
                                }
                            },
                            "required": ["name", "task"]
                        }
                    }
                },
                "required": ["agents"]
            }),
        ),
    ]
}

pub(super) async fn spawn_agents_tool(args: serde_json::Value) -> String {
    let specs: Vec<AgentSpec> = match serde_json::from_value(args["agents"].clone()) {
        Ok(v) => v,
        Err(e) => return format!("Error: invalid agents parameter: {}", e),
    };
    if specs.is_empty() {
        return "Error: agents array must not be empty".into();
    }

    // Check delegation depth
    let current_depth = DELEGATION_DEPTH.try_with(|d| *d).unwrap_or(0);
    if current_depth >= MAX_DELEGATION_DEPTH {
        return format!(
            "Error: Maximum delegation depth ({}) reached. Cannot spawn further agents to prevent infinite loops.",
            MAX_DELEGATION_DEPTH
        );
    }

    // Resolve LLM config (use global active LLM — same as parent)
    let llm_config = match super::resolve_llm_config_from_globals().await {
        Some(cfg) => cfg,
        None => return "Error: No active model configured".into(),
    };

    let working_dir = match super::WORKING_DIR.get() {
        Some(wd) => wd.clone(),
        None => return "Error: Working directory not set".into(),
    };

    // Grab the global app handle for streaming events (may be None in non-UI contexts)
    let app_handle = super::APP_HANDLE.get().cloned();

    // Capture session ID for event filtering and DB persistence
    let session_id = super::get_current_session_id();

    // Emit spawn_start event with agent list and session_id
    if let Some(ref handle) = app_handle {
        let agents_info: Vec<serde_json::Value> = specs
            .iter()
            .map(|s| serde_json::json!({ "name": s.name, "task": s.task }))
            .collect();
        handle
            .emit("chat://spawn_start", serde_json::json!({ "agents": agents_info, "session_id": session_id }))
            .ok();
    }

    // Update streaming snapshot with spawn agent entries
    if let Some(ss_arc) = super::STREAMING_STATE.get() {
        if let Ok(mut ss) = ss_arc.lock() {
            if let Some(snap) = ss.get_mut(&session_id) {
                snap.spawn_agents = specs.iter().map(|s| {
                    crate::state::app_state::SpawnAgentSnapshot {
                        name: s.name.clone(),
                        task: s.task.clone(),
                        status: "running".into(),
                        content: String::new(),
                        tools: vec![],
                        full_error: None,
                        duration_ms: None,
                    }
                }).collect();
            }
        }
    }

    // Load skill index + always-active skills (cached for 30s to avoid redundant disk I/O)
    let (all_skill_index, all_always_active) = load_cached_skills(&working_dir).await;

    // Load MCP tools (inherited from parent)
    let (mcp_tools_list, unavailable_servers) = if let Some(runtime) = super::MCP_RUNTIME.get() {
        runtime.get_all_tools_with_status().await
    } else {
        (vec![], vec![])
    };
    let skill_overrides = std::collections::HashMap::new();
    let mcp_extra: Vec<super::ToolDefinition> = super::mcp_tools_as_definitions(&mcp_tools_list, &skill_overrides);

    let agent_names: Vec<String> = specs.iter().map(|s| s.name.clone()).collect();
    let agent_tasks: Vec<String> = specs.iter().map(|s| s.task.clone()).collect();

    // Launch all agents in a background tokio task — returns immediately
    let depth = current_depth + 1;
    // Inherit the cancellation signal so spawn agents can be stopped
    let cancelled = super::TASK_CANCELLED.try_with(|c| c.clone()).ok();
    spawn_agents_background(
        specs, depth, llm_config, working_dir, app_handle,
        all_skill_index, all_always_active, mcp_tools_list, unavailable_servers, mcp_extra, session_id, cancelled,
    );

    // Return immediately — agents run in background
    format!(
        "Team started with {} agents: {}.\n\nTheir tasks:\n{}\n\nThe agents are working in the background. Results will be delivered when all agents complete.",
        agent_names.len(),
        agent_names.join(", "),
        agent_names.iter().zip(agent_tasks.iter())
            .map(|(n, t)| format!("- **{}**: {}", n, t))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// Background task that runs spawned agents in parallel.
fn spawn_agents_background(
    specs: Vec<AgentSpec>,
    depth: u32,
    llm_config: super::llm_client::LLMConfig,
    working_dir: std::path::PathBuf,
    app_handle: Option<tauri::AppHandle>,
    all_skill_index: Vec<crate::commands::agent::SkillIndexEntry>,
    all_always_active: Vec<String>,
    mcp_tools_list: Vec<crate::engine::infra::mcp_runtime::MCPTool>,
    unavailable_servers: Vec<String>,
    mcp_extra: Vec<super::ToolDefinition>,
    session_id: String,
    cancelled: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) {
    let sid = session_id.clone();
    // Resolve current branch ONCE before spawning agents
    let current_branch = crate::engine::coding::git_context::current_branch(&working_dir)
        .unwrap_or_else(|| "default".to_string());
    let handle = tokio::spawn(super::with_session_id(sid.clone(), async move {
        let futures: Vec<_> = specs.into_iter().map(|spec| {
            let config = llm_config.clone();
            let wd = working_dir.clone();
            let mcp_extra = mcp_extra.clone();
            let skill_idx = all_skill_index.clone();
            let always_active = all_always_active.clone();
            let mcp_tools_for_prompt = mcp_tools_list.clone();
            let unavail_for_prompt = unavailable_servers.clone();
            let handle_for_agent = app_handle.clone();
            let cancelled_for_agent = cancelled.clone();
            let sid_for_agent = session_id.clone();
            let branch_name = current_branch.clone();

            async move {
                let agent_name = spec.name.clone();
                let started_at = std::time::Instant::now();

                // Register worker in WorkerRegistry
                let worker_id = if let Some(handle) = super::APP_HANDLE.get() {
                    let registry = handle.state::<crate::engine::worker::WorkerRegistry>();
                    let wid = registry.spawn(&agent_name);
                    let _ = registry.transition(&wid, crate::engine::worker::WorkerState::Running);
                    Some(wid)
                } else {
                    None
                };

                // Acquire branch lock to prevent file conflicts with other agents
                let lock_module = spec.name.clone(); // Use agent name as module scope
                {
                    let mut locks = super::branch_lock_registry().lock().unwrap_or_else(|e| e.into_inner());
                    let lock_agent_id = worker_id.as_deref().unwrap_or(&agent_name);
                    if let Err(collision) = locks.acquire(&branch_name, &lock_module, lock_agent_id) {
                        log::warn!("Branch lock collision for agent '{}': {}", agent_name, collision);
                        // Don't block — just warn. The agent proceeds but may hit conflicts.
                    }
                }

                // Register in global TaskRegistry
                if let Some(reg) = crate::engine::task_registry::global_registry() {
                    let task_reg_id = worker_id.as_deref().unwrap_or(&agent_name).to_string();
                    let entry = crate::engine::task_registry::TaskEntry::new(
                        &task_reg_id,
                        crate::engine::task_registry::TaskKind::SpawnAgent {
                            agent_name: agent_name.clone(),
                            parent_session_id: sid_for_agent.clone(),
                        },
                        &spec.task,
                    );
                    reg.register(entry);
                    reg.start(&task_reg_id);
                }

                // Resolve agent definition from registry if agent_type is specified
                let agent_def: Option<crate::engine::agents::AgentDefinition> = if let Some(ref at) = spec.agent_type {
                    // Try to load from global AppState via APP_HANDLE
                    if let Some(handle) = super::APP_HANDLE.get() {
                        let state: tauri::State<'_, crate::state::AppState> = handle.state::<crate::state::AppState>();
                        let registry = state.agent_registry.read().await;
                        let found: Option<crate::engine::agents::AgentDefinition> = registry.get(at).cloned();
                        found
                    } else {
                        None
                    }
                } else {
                    None
                };

                let tool_filter = if let Some(ref def) = agent_def {
                    def.tool_filter()
                } else if spec.read_only {
                    super::react_agent::ToolFilter::read_only()
                } else {
                    super::react_agent::ToolFilter::All
                };

                // Skills: agent definition skills take priority, then spec.skills
                let effective_skills: Vec<String> = if let Some(ref def) = agent_def {
                    if !def.skills.is_empty() { def.skills.clone() } else { spec.skills.clone() }
                } else {
                    spec.skills.clone()
                };

                // Apply tool filter to MCP extra tools
                let mcp_extra = tool_filter.apply(&mcp_extra);

                // Filter skill index
                let filtered_index: Vec<crate::commands::agent::SkillIndexEntry> = if effective_skills.is_empty() {
                    skill_idx
                } else {
                    skill_idx.into_iter()
                        .filter(|e| effective_skills.iter().any(|s| s == &e.name))
                        .collect()
                };

                let mcp_ref = if mcp_tools_for_prompt.is_empty() { None } else { Some(mcp_tools_for_prompt.as_slice()) };
                let unavail_ref = if unavail_for_prompt.is_empty() { None } else { Some(unavail_for_prompt.as_slice()) };

                let base_prompt = super::react_agent::build_system_prompt(
                    &wd, None, &filtered_index, &always_active, None, mcp_ref, unavail_ref,
                ).await;

                // Build system prompt: agent definition instructions take priority
                let agent_identity = if let Some(ref def) = agent_def {
                    format!(
                        "{} {}\n\nYour assigned task: {}\n\n{}\n\n{}",
                        def.emoji(), def.name, spec.task, def.instructions, base_prompt
                    )
                } else {
                    format!(
                        "You are **{}**, a specialist agent.\n\
                        Your task: {}\n\n\
                        Complete the task thoroughly and return a clear, concise result.\n\n\
                        {}",
                        spec.name, spec.task, base_prompt
                    )
                };
                let system_prompt = agent_identity;

                let timeout_secs = spec.timeout_secs;
                let run_future = async {
                if let Some(ref handle) = handle_for_agent {
                    let h = handle.clone();
                    let name_for_cb = agent_name.clone();
                    let sid_for_cb = sid_for_agent.clone();
                    let on_event = move |evt: super::react_agent::AgentStreamEvent| {
                        match &evt {
                            super::react_agent::AgentStreamEvent::Token(text) => {
                                h.emit("chat://spawn_agent_chunk", serde_json::json!({
                                    "agent_name": name_for_cb, "content": text,
                                    "session_id": sid_for_cb,
                                })).ok();
                                // Update streaming snapshot
                                if let Some(ss_arc) = super::STREAMING_STATE.get() {
                                    if let Ok(mut ss) = ss_arc.lock() {
                                        if let Some(snap) = ss.get_mut(&sid_for_cb) {
                                            if let Some(agent) = snap.spawn_agents.iter_mut().find(|a| a.name == name_for_cb) {
                                                agent.content.push_str(text);
                                            }
                                        }
                                    }
                                }
                            }
                            super::react_agent::AgentStreamEvent::ToolStart { name, args_preview } => {
                                h.emit("chat://spawn_agent_tool", serde_json::json!({
                                    "agent_name": name_for_cb, "type": "start",
                                    "tool_name": name, "preview": args_preview,
                                    "session_id": sid_for_cb,
                                })).ok();
                                if let Some(ss_arc) = super::STREAMING_STATE.get() {
                                    if let Ok(mut ss) = ss_arc.lock() {
                                        if let Some(snap) = ss.get_mut(&sid_for_cb) {
                                            if let Some(agent) = snap.spawn_agents.iter_mut().find(|a| a.name == name_for_cb) {
                                                agent.tools.push(crate::state::app_state::ToolSnapshot {
                                                    name: name.clone(),
                                                    status: "running".into(),
                                                    preview: Some(args_preview.clone()),
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                            super::react_agent::AgentStreamEvent::ToolEnd { name, result_preview } => {
                                h.emit("chat://spawn_agent_tool", serde_json::json!({
                                    "agent_name": name_for_cb, "type": "end",
                                    "tool_name": name, "preview": result_preview,
                                    "session_id": sid_for_cb,
                                })).ok();
                                if let Some(ss_arc) = super::STREAMING_STATE.get() {
                                    if let Ok(mut ss) = ss_arc.lock() {
                                        if let Some(snap) = ss.get_mut(&sid_for_cb) {
                                            if let Some(agent) = snap.spawn_agents.iter_mut().find(|a| a.name == name_for_cb) {
                                                for t in agent.tools.iter_mut().rev() {
                                                    if t.name == *name && t.status == "running" {
                                                        t.status = "done".into();
                                                        if !result_preview.is_empty() {
                                                            t.preview = Some(result_preview.clone());
                                                        }
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            super::react_agent::AgentStreamEvent::Complete
                            | super::react_agent::AgentStreamEvent::Error
                            | super::react_agent::AgentStreamEvent::Thinking(_)
                            | super::react_agent::AgentStreamEvent::ContextOverflowRetry
                            | super::react_agent::AgentStreamEvent::Usage { .. } => {}
                        }
                    };
                    DELEGATION_DEPTH.scope(depth, Box::pin(
                        super::with_tool_filter(tool_filter.clone(),
                            super::react_agent::run_react_with_options_stream(
                                &config, &system_prompt, &spec.task, &mcp_extra,
                                &[], None, Some(&wd), on_event,
                                cancelled_for_agent.as_ref().map(|c| c.as_ref()), None, None,
                            )
                        )
                    )).await
                } else {
                    DELEGATION_DEPTH.scope(depth, Box::pin(
                        super::with_tool_filter(tool_filter.clone(),
                            super::react_agent::run_react_with_options(
                                &config, &system_prompt, &spec.task, &mcp_extra,
                                &[], None, Some(&wd),
                            )
                        )
                    )).await
                }
                };

                // Apply optional wall-clock timeout. When the future elapses,
                // flatten Elapsed into a synthetic Err so the downstream error
                // handling path (worker/task registry, snapshot, event emit)
                // treats it uniformly.
                let (result, timed_out) = match timeout_secs {
                    Some(secs) => match tokio::time::timeout(
                        std::time::Duration::from_secs(secs),
                        run_future,
                    ).await {
                        Ok(r) => (r, false),
                        Err(_) => (
                            Err(format!("Agent '{}' timed out after {}s", agent_name, secs)),
                            true,
                        ),
                    },
                    None => (run_future.await, false),
                };

                // `full_text` is the complete, uncapped output/error. It is
                // what we persist and what downstream consumers (worker
                // registry, task registry, events, DB) may render. We also
                // compute a short preview — but NEVER drop the full text.
                let (full_text, is_error) = match result {
                    Ok(reply) => (reply, false),
                    Err(e) => (e, true),
                };

                // For the parent LLM's tool-result context we still cap to
                // avoid polluting the context window. Display/DB paths use
                // `full_text` directly.
                let preview_text: String = full_text.chars().take(200).collect();

                let duration_ms = started_at.elapsed().as_millis() as u64;

                // On timeout, emit a dedicated error event so the frontend can
                // surface it distinctly from ordinary agent errors. Include
                // both a short preview and the FULL text so the UI has the
                // information it needs without having to query the DB.
                if timed_out {
                    if let Some(ref handle) = handle_for_agent {
                        handle.emit("chat://spawn_agent_error", serde_json::json!({
                            "agent_name": agent_name,
                            "reason": "timeout",
                            "preview": preview_text,
                            "full": full_text,
                            "message": full_text, // legacy alias — keep for existing listeners
                            "session_id": sid_for_agent,
                        })).ok();
                    }
                } else if is_error {
                    // Non-timeout runtime errors also get a dedicated event
                    // so the UI doesn't have to reach into spawn_agent_complete
                    // to distinguish success from failure.
                    if let Some(ref handle) = handle_for_agent {
                        handle.emit("chat://spawn_agent_error", serde_json::json!({
                            "agent_name": agent_name,
                            "reason": "runtime_error",
                            "preview": preview_text,
                            "full": full_text,
                            "message": full_text,
                            "session_id": sid_for_agent,
                        })).ok();
                    }
                }

                // Transition worker state. We preserve the full error text in
                // `FailureReason::RuntimeError` (UI can cap for display) so
                // debugging and audit have what they need.
                if let (Some(ref wid), Some(handle)) = (&worker_id, super::APP_HANDLE.get()) {
                    use crate::engine::worker::{WorkerState, FailureReason};
                    let registry = handle.state::<crate::engine::worker::WorkerRegistry>();
                    if is_error {
                        let reason = if timed_out {
                            FailureReason::Timeout
                        } else {
                            FailureReason::RuntimeError(full_text.clone())
                        };
                        let _ = registry.transition(wid, WorkerState::Failed { reason });
                    } else {
                        // Finished-state `result` is a short summary; full
                        // output lives in the DB metadata + snapshot.
                        let _ = registry.transition(wid, WorkerState::Finished {
                            result: full_text.chars().take(500).collect(),
                        });
                    }
                }

                // Update TaskRegistry — pass the full error, not a 200-char slice.
                if let Some(reg) = crate::engine::task_registry::global_registry() {
                    let tid = worker_id.as_deref().unwrap_or(&agent_name);
                    if is_error {
                        reg.fail(tid, &full_text);
                    } else {
                        reg.complete(tid);
                    }
                }

                // Release branch lock
                {
                    let mut locks = super::branch_lock_registry().lock().unwrap_or_else(|e| e.into_inner());
                    let lock_agent_id = worker_id.as_deref().unwrap_or(&agent_name);
                    locks.release(&branch_name, lock_agent_id);
                }

                if let Some(ref handle) = handle_for_agent {
                    // Emit the structured result so the frontend can render
                    // success/failure/timeout without guessing from text.
                    handle.emit("chat://spawn_agent_complete", serde_json::json!({
                        "agent_name": agent_name,
                        "result": full_text,        // legacy: full output
                        "success": !is_error,
                        "status": if timed_out { "timeout" }
                                  else if is_error { "failed" }
                                  else { "complete" },
                        "duration_ms": duration_ms,
                        "session_id": sid_for_agent,
                    })).ok();
                }

                // Update streaming snapshot: mark spawn agent as complete/failed/timeout
                if let Some(ss_arc) = super::STREAMING_STATE.get() {
                    if let Ok(mut ss) = ss_arc.lock() {
                        if let Some(snap) = ss.get_mut(&sid_for_agent) {
                            if let Some(agent) = snap.spawn_agents.iter_mut().find(|a| a.name == agent_name) {
                                agent.status = if timed_out {
                                    "timeout".into()
                                } else if is_error {
                                    "failed".into()
                                } else {
                                    "complete".into()
                                };
                                agent.content = full_text.clone();
                                agent.full_error = if is_error { Some(full_text.clone()) } else { None };
                                agent.duration_ms = Some(duration_ms);
                            }
                        }
                    }
                }

                (agent_name, full_text, is_error, timed_out, duration_ms)
            }
        }).collect();

        let results = futures::future::join_all(futures).await;

        // Build structured agent results — the canonical SpawnAgentResult type.
        let structured_results: Vec<crate::state::app_state::SpawnAgentResult> = results.iter()
            .map(|(name, full_text, is_err, timed_out, duration_ms)| {
                crate::state::app_state::SpawnAgentResult::build(
                    name, full_text, *is_err, *timed_out, *duration_ms,
                )
            })
            .collect();

        // DB metadata: legacy fields (`result`, `is_error`) for backward-compat
        // with existing rows, plus new structured fields. `full_output` holds
        // the uncapped text; `result` remains a preview for quick reads.
        let agent_results_json: Vec<serde_json::Value> = structured_results.iter().map(|r| {
            serde_json::json!({
                "name": r.name,
                "result": r.full_output.chars().take(3000).collect::<String>(),
                "is_error": !r.success,
                "full_output": r.full_output,
                "error": r.error,
                "status": r.status,
                "duration_ms": r.duration_ms,
                "success": r.success,
                "summary": r.summary,
            })
        }).collect();

        // Save to DB with structured metadata so frontend can render nicely
        if !session_id.is_empty() {
            if let Some(db) = super::DATABASE.get() {
                let metadata = serde_json::json!({
                    "spawn_agents": agent_results_json,
                }).to_string();
                // Content is a brief, human-readable + machine-parseable list
                // so the parent LLM can both read and structurally extract results.
                let summary: Vec<String> = structured_results.iter().map(|r| {
                    let marker = match r.status.as_str() {
                        "complete" => "✓ complete",
                        "timeout" => "⏱ timeout",
                        "cancelled" => "⊘ cancelled",
                        _ => "✗ failed",
                    };
                    format!("- [{}] {}: {}", marker, r.name, r.summary)
                }).collect();
                let header = format!(
                    "Spawned {} agent(s):\n{}",
                    structured_results.len(),
                    summary.join("\n"),
                );
                db.push_message_with_metadata(
                    &session_id, "assistant",
                    &header,
                    Some(&metadata),
                ).ok();
            }
        }

        if let Some(ref handle) = app_handle {
            handle.emit("chat://spawn_complete", serde_json::json!({
                "results": structured_results,
                "session_id": session_id,
            })).ok();
        }
    }));

    // Register the JoinHandle for potential cancellation when session is closed
    if let Some(state_arc) = super::STREAMING_STATE.get() {
        if let Ok(_ss) = state_arc.lock() {
            // Store handle abort capability — when session is deleted,
            // the streaming state cleanup can abort orphaned agent tasks.
            // For now, just log that the task is tracked.
            log::debug!("Spawn agents task registered for session {}", sid);
        }
    }
    // Drop handle — task runs independently. Cancellation is via the AtomicBool signal.
    drop(handle);
}

// ── Cached skill loading ────────────────────────────────────────────────

type SkillCacheEntry = (
    Vec<crate::commands::agent::SkillIndexEntry>,
    Vec<String>,
    std::time::Instant,
);
static SKILL_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<SkillCacheEntry>>> = std::sync::OnceLock::new();

fn skill_cache() -> &'static std::sync::Mutex<Option<SkillCacheEntry>> {
    SKILL_CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

async fn load_cached_skills(
    working_dir: &std::path::Path,
) -> (Vec<crate::commands::agent::SkillIndexEntry>, Vec<String>) {
    // Check if cache is still fresh (30s TTL)
    if let Ok(guard) = skill_cache().lock() {
        if let Some((idx, active, ts)) = guard.as_ref() {
            if ts.elapsed() < std::time::Duration::from_secs(30) {
                return (idx.clone(), active.clone());
            }
        }
    }

    let skills_dir = working_dir.join("active_skills");
    let mut skill_index = Vec::new();
    let mut always_active = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(&skills_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let skill_md = path.join("SKILL.md");
            if let Ok(content) = tokio::fs::read_to_string(&skill_md).await {
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let (description, is_always_active) = crate::commands::agent::parse_skill_frontmatter(&content);
                if is_always_active {
                    always_active.push(content);
                } else {
                    skill_index.push(crate::commands::agent::SkillIndexEntry {
                        name,
                        description: description.unwrap_or_default(),
                    });
                }
            }
        }
    }

    // Store in cache
    if let Ok(mut guard) = skill_cache().lock() {
        *guard = Some((skill_index.clone(), always_active.clone(), std::time::Instant::now()));
    }
    (skill_index, always_active)
}
