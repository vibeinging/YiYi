use std::process::Stdio;

/// Cached Claude Code CLI availability (supports refresh after installation).
pub(super) static CLAUDE_CLI_AVAILABLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub(super) static CLAUDE_CLI_CHECKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Check if Claude Code CLI is installed (cached after first check).
pub(super) async fn is_claude_cli_available() -> bool {
    if !CLAUDE_CLI_CHECKED.load(std::sync::atomic::Ordering::Acquire) {
        let available = resolve_claude_bin().await.is_some();
        CLAUDE_CLI_AVAILABLE.store(available, std::sync::atomic::Ordering::Release);
        CLAUDE_CLI_CHECKED.store(true, std::sync::atomic::Ordering::Release);
    }
    CLAUDE_CLI_AVAILABLE.load(std::sync::atomic::Ordering::Acquire)
}

/// Refresh Claude Code CLI availability cache (call after installation).
pub(super) fn refresh_claude_cli_cache() {
    CLAUDE_CLI_CHECKED.store(false, std::sync::atomic::Ordering::Release);
}

/// Per-session Claude Code session ID cache (capped at 100 entries).
const CC_SESSIONS_MAX: usize = 100;
static CC_SESSIONS: std::sync::LazyLock<tokio::sync::Mutex<std::collections::HashMap<String, String>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));

/// Claude Code tool definitions.
pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "claude_code",
            "Delegate a coding task to Claude Code CLI. Claude Code provides powerful code understanding, editing, searching, and terminal capabilities. \
            Use this for complex coding tasks like multi-file refactoring, feature implementation, debugging, and code analysis. \
            Session continuity is automatic — multiple calls within the same chat session share context. \
            IMPORTANT: After this tool completes, you MUST present the results to the user. \
            If the output is a website/HTML page, use browser_use(headed=true) to open it so the user can see it immediately. \
            If it's a script, run it and show the output. Never just say 'done' without showing tangible results.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "The coding task description. Be specific about what to do, which files/directories to work with."
                    },
                    "working_dir": {
                        "type": "string",
                        "description": "Working directory for Claude Code. Defaults to user workspace if not specified."
                    },
                    "continue_session": {
                        "type": "boolean",
                        "description": "If true, continue the previous Claude Code session for this chat (maintains full context). Default true."
                    },
                    "context": {
                        "type": "string",
                        "description": "Additional context to prepend to the prompt. Use this to pass relevant skill instructions, project conventions, user preferences, or conversation summary to Claude Code."
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds. Default 300 (5 minutes)."
                    }
                },
                "required": ["prompt"]
            }),
        ),
    ]
}

pub(super) async fn claude_code_tool(args: &serde_json::Value) -> String {
    let prompt = match args["prompt"].as_str() {
        Some(p) if !p.is_empty() => p,
        _ => return "Error: prompt is required".into(),
    };

    let context = args["context"].as_str().unwrap_or("");
    let continue_session = args["continue_session"].as_bool().unwrap_or(true);
    let timeout_secs = args["timeout_secs"].as_u64().unwrap_or(300);

    // Resolve working directory: args > USER_WORKSPACE > WORKING_DIR > "."
    let working_dir = args["working_dir"]
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| super::USER_WORKSPACE.get().map(|p| p.to_string_lossy().to_string()))
        .or_else(|| super::WORKING_DIR.get().map(|p| p.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".into());

    // Resolve claude CLI path — auto-install if not found
    let claude_bin = match resolve_claude_bin().await {
        Some(bin) => bin,
        None => {
            // Try auto-install silently
            log::info!("Claude Code not found, attempting auto-install...");
            match auto_install_claude_code().await {
                Ok(bin) => {
                    log::info!("Claude Code auto-installed successfully");
                    refresh_claude_cli_cache();
                    bin
                }
                Err(e) => {
                    log::warn!("Claude Code auto-install failed: {}", e);
                    return format!(
                        "Claude Code is not available and auto-install failed: {}. \
                         Falling back to built-in coding tools. \
                         You can install manually with: npm i -g @anthropic-ai/claude-code",
                        e
                    );
                }
            }
        }
    };

    // Build command — combine context + prompt into final prompt
    let final_prompt = if context.is_empty() {
        prompt.to_string()
    } else {
        format!(
            "<context>\n{}\n</context>\n\n{}",
            context, prompt
        )
    };

    let mut cmd = tokio::process::Command::new(&claude_bin);
    cmd.arg("-p").arg(&final_prompt);
    cmd.arg("--output-format").arg("stream-json");
    cmd.arg("--max-turns").arg("30");
    cmd.current_dir(&working_dir);

    // Non-interactive mode: skip permission prompts.
    cmd.arg("--dangerously-skip-permissions");

    // Prevent "nested session" error when called from within a Claude Code context.
    cmd.env_remove("CLAUDECODE");

    // Inject provider API key if ANTHROPIC_API_KEY isn't already in env.
    if std::env::var("ANTHROPIC_API_KEY").map(|v| v.is_empty()).unwrap_or(true) {
        if let Some((api_key, base_url)) = resolve_claude_code_provider().await {
            cmd.env("ANTHROPIC_API_KEY", &api_key);
            cmd.env("ANTHROPIC_BASE_URL", &base_url);
        }
    }

    // Session continuity: look up or create session ID for this chat
    let yiyi_session = super::get_current_session_id();
    if continue_session && !yiyi_session.is_empty() {
        let sessions = CC_SESSIONS.lock().await;
        if let Some(cc_sid) = sessions.get(&yiyi_session) {
            cmd.arg("--resume").arg(cc_sid);
        }
        drop(sessions);
    }

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Execute with timeout — use spawn + streaming read
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return format!("Error: failed to start claude: {}", e),
    };

    let child_id = child.id();
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => return "Error: failed to capture claude stdout".into(),
    };

    // Drain stderr in background to prevent pipe buffer from filling up and blocking the child
    let stderr_handle = child.stderr.take().map(|stderr| {
        tokio::spawn(async move {
            let mut buf = String::new();
            let mut reader = tokio::io::BufReader::new(stderr);
            use tokio::io::AsyncReadExt;
            reader.read_to_string(&mut buf).await.ok();
            buf
        })
    });

    // Emit initial progress event
    let handle = super::APP_HANDLE.get().cloned();
    let session_id = yiyi_session.clone();
    if let Some(h) = &handle {
        use tauri::Emitter;
        h.emit("chat://claude_code_stream", serde_json::json!({
            "type": "start",
            "session_id": session_id,
            "working_dir": working_dir,
        })).ok();
    }

    // Stream stdout line by line (NDJSON from --output-format stream-json)
    let reader = tokio::io::BufReader::new(stdout);
    use tokio::io::AsyncBufReadExt;
    let mut lines = reader.lines();

    let mut final_result = String::new();
    let mut cc_session_id = String::new();
    let mut had_error = false;

    let stream_future = async {
        while let Ok(Some(line)) = lines.next_line().await {
            // Check cancellation on each line
            if super::is_task_cancelled() {
                return; // Will be handled as cancellation below
            }
            if line.trim().is_empty() {
                continue;
            }
            let json: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let msg_type = json["type"].as_str().unwrap_or("");

            match msg_type {
                "stream_event" => {
                    // Extract streaming text deltas and tool use events
                    let event = &json["event"];
                    let event_type = event["type"].as_str().unwrap_or("");

                    match event_type {
                        "content_block_delta" => {
                            let delta = &event["delta"];
                            let delta_type = delta["type"].as_str().unwrap_or("");
                            if delta_type == "text_delta" {
                                if let Some(text) = delta["text"].as_str() {
                                    if let Some(h) = &handle {
                                        use tauri::Emitter;
                                        h.emit("chat://claude_code_stream", serde_json::json!({
                                            "type": "text_delta",
                                            "content": text,
                                            "session_id": session_id,
                                        })).ok();
                                    }
                                }
                            }
                        }
                        "content_block_start" => {
                            let block = &event["content_block"];
                            let block_type = block["type"].as_str().unwrap_or("");
                            if block_type == "tool_use" {
                                let tool_name = block["name"].as_str().unwrap_or("unknown");
                                if let Some(h) = &handle {
                                    use tauri::Emitter;
                                    h.emit("chat://claude_code_stream", serde_json::json!({
                                        "type": "tool_start",
                                        "tool_name": tool_name,
                                        "session_id": session_id,
                                    })).ok();
                                }
                            }
                        }
                        _ => {}
                    }
                }
                // tool_result messages indicate a tool has finished executing
                "tool_result" | "tool_use_summary" => {
                    let tool_name = json["tool_name"].as_str()
                        .or_else(|| json["name"].as_str())
                        .unwrap_or("unknown");
                    if let Some(h) = &handle {
                        use tauri::Emitter;
                        h.emit("chat://claude_code_stream", serde_json::json!({
                            "type": "tool_end",
                            "tool_name": tool_name,
                            "session_id": session_id,
                        })).ok();
                    }
                }
                "assistant" => {
                    // Extract session_id from assistant messages
                    if let Some(sid) = json["session_id"].as_str() {
                        cc_session_id = sid.to_string();
                    }
                }
                "result" => {
                    // Final result — extract text
                    if let Some(result_text) = json["result"].as_str() {
                        final_result = result_text.to_string();
                    } else if let Some(blocks) = json["result"].as_array() {
                        let texts: Vec<&str> = blocks
                            .iter()
                            .filter_map(|b| b["text"].as_str())
                            .collect();
                        if !texts.is_empty() {
                            final_result = texts.join("\n");
                        }
                    }
                    if let Some(sid) = json["session_id"].as_str() {
                        cc_session_id = sid.to_string();
                    }
                }
                _ => {}
            }
        }
    };

    // Wrap with timeout
    let timed_out = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        stream_future,
    ).await.is_err();

    let was_cancelled = super::is_task_cancelled();

    // Helper to kill the child process and its descendants
    let kill_child = |pid: u32| {
        #[cfg(windows)]
        {
            // /T kills the process tree
            std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output().ok();
        }
        #[cfg(unix)]
        {
            // Kill the process group (negative PID) to clean up child processes,
            // then fall back to killing the PID directly if it wasn't a group leader.
            unsafe { libc::kill(-(pid as i32), libc::SIGTERM); }
            std::thread::sleep(std::time::Duration::from_millis(100));
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
            // Also kill the process directly in case it didn't have its own group
            unsafe { libc::kill(pid as i32, libc::SIGKILL); }
        }
    };

    if timed_out || was_cancelled {
        // Kill the child process on timeout or cancellation
        if let Some(pid) = child_id {
            kill_child(pid);
        }
        had_error = true;
        final_result = if was_cancelled {
            "Claude Code was cancelled by user.".into()
        } else {
            "Error: Claude Code timed out. Try breaking the task into smaller steps.".into()
        };
    } else {
        // Wait for process exit
        match child.wait().await {
            Ok(status) if !status.success() => {
                had_error = true;
                if final_result.is_empty() {
                    // Try to include stderr for better diagnostics
                    let stderr_text = if let Some(h) = stderr_handle {
                        h.await.ok().unwrap_or_default()
                    } else {
                        String::new()
                    };
                    final_result = if stderr_text.is_empty() {
                        format!("Claude Code exited with code {}", status.code().unwrap_or(-1))
                    } else {
                        format!("Claude Code exited with code {}.\n{}", status.code().unwrap_or(-1), super::truncate_output(&stderr_text, 4000))
                    };
                }
            }
            Err(e) => {
                had_error = true;
                final_result = format!("Error: failed to wait for claude: {}", e);
            }
            _ => {}
        }
    }

    // Cache Claude Code session ID for continuity
    if !cc_session_id.is_empty() && !yiyi_session.is_empty() {
        let mut sessions = CC_SESSIONS.lock().await;
        if sessions.len() >= CC_SESSIONS_MAX {
            if let Some(oldest) = sessions.keys().next().cloned() {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(yiyi_session, cc_session_id);
    }

    // Emit completion event to frontend
    if let Some(h) = &handle {
        use tauri::Emitter;
        h.emit("chat://claude_code_stream", serde_json::json!({
            "type": "done",
            "session_id": session_id,
            "error": had_error,
        })).ok();
    }

    if final_result.is_empty() {
        "(Claude Code completed with no output)".into()
    } else {
        super::truncate_output(&final_result, 12000)
    }
}

/// Resolve the full path to the `claude` CLI binary.
pub(super) async fn resolve_claude_bin() -> Option<String> {
    // Try PATH first
    let check_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = tokio::process::Command::new(check_cmd)
        .arg("claude")
        .output()
        .await
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }

    // Fallback: check common install locations (GUI apps may not inherit shell PATH)
    #[cfg(not(windows))]
    {
        let home = dirs::home_dir().unwrap_or_default();
        let candidates = [
            home.join(".npm-global/bin/claude"),
            home.join(".local/bin/claude"),
            std::path::PathBuf::from("/usr/local/bin/claude"),
            home.join(".nvm/current/bin/claude"),
        ];
        for path in &candidates {
            if path.exists() {
                return Some(path.to_string_lossy().to_string());
            }
        }
    }

    None
}

/// Auto-install Claude Code CLI via npm. Returns the binary path on success.
async fn auto_install_claude_code() -> Result<String, String> {
    // Check npm
    let check_cmd = if cfg!(windows) { "where" } else { "which" };
    let npm_ok = tokio::process::Command::new(check_cmd)
        .arg("npm")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !npm_ok {
        return Err("npm not available (Node.js not installed)".into());
    }

    // Run npm install -g
    let output = tokio::process::Command::new("npm")
        .args(["install", "-g", "@anthropic-ai/claude-code"])
        .output()
        .await
        .map_err(|e| format!("Failed to run npm: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("npm install failed: {}", stderr.chars().take(200).collect::<String>()));
    }

    // Verify installation — resolve the binary path
    match resolve_claude_bin().await {
        Some(bin) => Ok(bin),
        None => Err("npm install succeeded but claude binary not found in PATH".into()),
    }
}

/// Resolve a usable provider's API key + base URL for Claude Code.
async fn resolve_claude_code_provider() -> Option<(String, String)> {
    // Check DB flag first — user may have chosen a provider in the setup dialog
    let chosen_provider = super::DATABASE
        .get()
        .and_then(|db| db.get_config("claude_code_provider"));

    let providers_lock = super::PROVIDERS.get()?;
    let providers = providers_lock.read().await;
    let all = providers.get_all_providers();

    // If user explicitly chose a provider, use that
    let candidates: Vec<&str> = if let Some(ref chosen) = chosen_provider {
        vec![chosen.as_str()]
    } else {
        vec!["anthropic"]
    };

    for pid in candidates {
        let p = match all.iter().find(|p| p.id == pid) {
            Some(p) => p,
            None => continue,
        };

        let api_key = if let Some(custom) = providers.custom_providers.get(pid) {
            custom.settings.api_key.clone()
        } else {
            providers
                .providers
                .get(pid)
                .and_then(|s| s.api_key.clone())
        };
        let api_key = api_key
            .or_else(|| std::env::var(&p.api_key_prefix).ok())
            .filter(|k| !k.is_empty());

        if let Some(key) = api_key {
            let base_url = p
                .base_url
                .as_deref()
                .unwrap_or(&p.default_base_url)
                .to_string();
            return Some((key, base_url));
        }
    }
    None
}
