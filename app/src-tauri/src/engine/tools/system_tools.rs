use std::process::Stdio;
use crate::engine::infra::python_bridge;
use super::shell_security::{self, CommandClass, SecurityVerdict};
use super::permission_gate;

/// System tool definitions.
pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "execute_shell",
            "Execute a shell command and return its output. Has a timeout to prevent hanging.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "The shell command to execute" },
                    "cwd": { "type": "string", "description": "Working directory (optional)" },
                    "timeout_secs": { "type": "integer", "description": "Timeout in seconds. Default 120 (2 minutes)." }
                },
                "required": ["command"]
            }),
        ),
        super::tool_def(
            "get_current_time",
            "Get the current date and time.",
            serde_json::json!({
                "type": "object",
                "properties": {}
            }),
        ),
        super::tool_def(
            "desktop_screenshot",
            "Take a screenshot of the desktop. Returns base64-encoded PNG.",
            serde_json::json!({
                "type": "object",
                "properties": {}
            }),
        ),
        // --- Python tools (embedded interpreter, no system Python needed) ---
        super::tool_def(
            "run_python",
            "Execute Python code using the embedded interpreter. Output is captured and returned. Use for complex data processing, library calls, etc.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "code": { "type": "string", "description": "Python code to execute" }
                },
                "required": ["code"]
            }),
        ),
        super::tool_def(
            "run_python_script",
            "Execute a Python script file using the embedded interpreter. Script output is captured.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "script_path": { "type": "string", "description": "Absolute path to the .py file" },
                    "args": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Command-line arguments for the script (optional)"
                    }
                },
                "required": ["script_path"]
            }),
        ),
        super::tool_def(
            "pip_install",
            "Install Python packages using pip. Packages are installed to the user's local directory (~/.yiyi/python_packages/).",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "packages": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Package names to install, e.g. [\"requests\", \"beautifulsoup4\"]"
                    }
                },
                "required": ["packages"]
            }),
        ),
        // --- Document tools (native, no Python/Node.js needed) ---
        super::tool_def(
            "read_pdf",
            "Extract text content from a PDF file. No external dependencies needed.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the PDF file" }
                },
                "required": ["path"]
            }),
        ),
        super::tool_def(
            "read_spreadsheet",
            "Read data from Excel (.xlsx/.xls) or CSV/TSV files. Returns tabular text.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the spreadsheet file" },
                    "sheet": { "type": "string", "description": "Sheet name (optional, defaults to first sheet)" },
                    "max_rows": { "type": "integer", "description": "Maximum rows to return (default: 200)" }
                },
                "required": ["path"]
            }),
        ),
        super::tool_def(
            "create_spreadsheet",
            "Create an Excel (.xlsx) file from tabular data. Data is a JSON array of arrays (first row = headers).",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Output file path (should end with .xlsx)" },
                    "data": { "type": "array", "description": "Array of arrays, e.g. [[\"Name\",\"Age\"],[\"Alice\",30]]" },
                    "sheet_name": { "type": "string", "description": "Sheet name (optional)" }
                },
                "required": ["path", "data"]
            }),
        ),
        super::tool_def(
            "read_docx",
            "Extract text content from a Word (.docx) file. No external dependencies needed.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the DOCX file" }
                },
                "required": ["path"]
            }),
        ),
        super::tool_def(
            "create_docx",
            "Create a Word (.docx) file from text content. Supports Markdown-style headings (# ## ###) and bullet lists (- *).",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Output file path (should end with .docx)" },
                    "content": { "type": "string", "description": "Text content with optional Markdown formatting" }
                },
                "required": ["path", "content"]
            }),
        ),
        super::tool_def(
            "send_notification",
            "Send a macOS system notification to the user immediately.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Notification title" },
                    "body": { "type": "string", "description": "Notification body text" }
                },
                "required": ["title", "body"]
            }),
        ),
        super::tool_def(
            "add_calendar_event",
            "Add an event or reminder to the system calendar. Cross-platform: opens in Calendar (macOS), Outlook (Windows), or default calendar app (Linux). \
            Best for long-term reminders (hours/days/weeks away). For short delays (< 30 min), prefer manage_cronjob with delay type.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Event title" },
                    "description": { "type": "string", "description": "Event description/notes (optional)" },
                    "start_time": { "type": "string", "description": "Start time in ISO 8601 format (e.g. '2026-03-10T09:00:00+08:00')" },
                    "end_time": { "type": "string", "description": "End time in ISO 8601 (optional, defaults to start_time + 15min for reminders)" },
                    "reminder_minutes": { "type": "integer", "description": "Reminder alert N minutes before event (default: 5)" },
                    "all_day": { "type": "boolean", "description": "Whether this is an all-day event (default: false)" }
                },
                "required": ["title", "start_time"]
            }),
        ),
        super::tool_def(
            "send_file_to_user",
            "Send a file to the user. In the desktop app, this triggers a save dialog so the user can download/save the file. Use this after creating a file that the user needs.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file to send" },
                    "filename": { "type": "string", "description": "Suggested filename for the user (optional, defaults to original filename)" },
                    "description": { "type": "string", "description": "Brief description of the file (optional)" }
                },
                "required": ["path"]
            }),
        ),
        super::tool_def(
            "pty_spawn_interactive",
            "Spawn an interactive PTY session for a CLI tool (e.g. bash, python, claude-code). Returns session_id.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command to run (e.g. 'bash', 'python3', 'claude')" },
                    "args": { "type": "array", "items": { "type": "string" }, "description": "Command arguments" },
                    "cwd": { "type": "string", "description": "Working directory" }
                },
                "required": ["command"]
            }),
        ),
        super::tool_def(
            "pty_send_input",
            "Send input to an interactive PTY session and wait for output.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "PTY session ID" },
                    "input": { "type": "string", "description": "Text to send (newline appended automatically)" },
                    "wait_ms": { "type": "integer", "description": "Milliseconds to wait for output (default: 3000)" }
                },
                "required": ["session_id", "input"]
            }),
        ),
        super::tool_def(
            "pty_read_output",
            "Read recent output from a PTY session without sending input.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "PTY session ID" },
                    "wait_ms": { "type": "integer", "description": "Milliseconds to wait for new output (default: 1000)" }
                },
                "required": ["session_id"]
            }),
        ),
        super::tool_def(
            "pty_close_session",
            "Close an interactive PTY session and kill the process.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "PTY session ID to close" }
                },
                "required": ["session_id"]
            }),
        ),
    ]
}

pub(super) async fn execute_shell_tool(args: &serde_json::Value) -> String {
    let command = args["command"].as_str().unwrap_or("");
    let cwd = args["cwd"].as_str();
    let timeout_secs = args["timeout_secs"].as_u64().unwrap_or(120);

    if command.is_empty() {
        return "Error: command is required".into();
    }

    // --- Phase 0: Permission-mode-aware bash validation ---
    {
        use crate::engine::coding::bash_validation::{validate_bash_command, BashValidation};
        use crate::engine::permission_mode::PermissionMode;
        // TODO: read actual mode from agent context; default Standard
        let mode = PermissionMode::Standard;
        let workspace = super::USER_WORKSPACE.get().map(|p| p.as_path());
        match validate_bash_command(command, mode, workspace) {
            BashValidation::Deny(reason) => {
                return format!("Error: {reason}");
            }
            BashValidation::Warn(reason) => {
                log::info!("Bash validation warning: {reason}");
                // Warnings pass through to existing shell_security for further analysis
            }
            BashValidation::Allow => {}
        }
    }

    // --- Phase 1: Analyze command (classification + security + path extraction) ---
    let analysis = shell_security::analyze_command(command);

    // Truncate command for display in permission dialog (prevent giant popups)
    let display_cmd: String = if command.len() > 200 {
        format!("{}…", &command[..200])
    } else {
        command.to_string()
    };

    // Block dangerous commands — ask user via permission gate
    if let SecurityVerdict::Block { reason } = &analysis.security_verdict {
        let req = permission_gate::PermissionRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            permission_type: "shell_block".into(),
            path: display_cmd.clone(),
            parent_folder: String::new(),
            reason: reason.clone(),
            risk_level: "high".into(),
        };
        if !permission_gate::request_permission(req).await {
            return format!("Error: Blocked — {}", reason);
        }
    }

    // Warn-level suspicious commands — ask user via permission gate
    if let SecurityVerdict::Warn { message } = &analysis.security_verdict {
        let req = permission_gate::PermissionRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            permission_type: "shell_warn".into(),
            path: display_cmd.clone(),
            parent_folder: String::new(),
            reason: message.clone(),
            risk_level: "medium".into(),
        };
        if !permission_gate::request_permission(req).await {
            return format!("Error: Denied — {}", message);
        }
    }

    // For non-read-only commands, validate extracted paths against authorized folders
    if !matches!(analysis.classification, CommandClass::ReadOnly) {
        if let Err(e) = shell_security::check_command_paths(&analysis).await {
            return format!("Error: {}", e);
        }
    }

    // Validate cwd if provided
    if let Some(dir) = cwd {
        if let Err(e) = super::access_check(dir, false).await {
            return format!("Error: working directory access denied — {}", e);
        }
    }

    // --- Phase 2: Execute ---
    let effective_cwd = match cwd {
        Some(dir) => Some(dir.to_string()),
        None => Some(super::get_effective_workspace().to_string_lossy().to_string()),
    };

    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    if let Some(dir) = &effective_cwd {
        cmd.current_dir(dir);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return format!("Failed to execute: {}", e),
    };

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_handle = tokio::spawn(async move {
        if let Some(mut pipe) = stdout_pipe {
            use tokio::io::AsyncReadExt;
            let mut bytes = Vec::new();
            pipe.read_to_end(&mut bytes).await.ok();
            String::from_utf8_lossy(&bytes).to_string()
        } else {
            String::new()
        }
    });
    let stderr_handle = tokio::spawn(async move {
        if let Some(mut pipe) = stderr_pipe {
            use tokio::io::AsyncReadExt;
            let mut bytes = Vec::new();
            pipe.read_to_end(&mut bytes).await.ok();
            String::from_utf8_lossy(&bytes).to_string()
        } else {
            String::new()
        }
    });

    let wait_result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait(),
    )
    .await;

    // --- Phase 3: Enhanced output ---
    match wait_result {
        Ok(Ok(status)) => {
            let stdout = stdout_handle.await.unwrap_or_default();
            let stderr = stderr_handle.await.unwrap_or_default();
            let code = status.code().unwrap_or(-1);
            shell_security::enhance_output(&analysis, &stdout, &stderr, code)
        }
        Ok(Err(e)) => format!("Failed to execute: {}", e),
        Err(_) => {
            child.kill().await.ok();
            format!("Error: command timed out after {} seconds. Try breaking it into smaller steps.", timeout_secs)
        }
    }
}

pub(super) async fn get_current_time_tool() -> String {
    let now = chrono::Local::now();
    format!(
        "Current time: {}\nTimezone: {}",
        now.format("%Y-%m-%d %H:%M:%S"),
        now.format("%Z")
    )
}

pub(super) async fn desktop_screenshot_tool() -> (String, Vec<String>) {
    // Use macOS screencapture command
    let tmp = format!("/tmp/yiyi_screenshot_{}.png", uuid::Uuid::new_v4());

    let mut cmd = tokio::process::Command::new("screencapture");
    cmd.args(["-x", &tmp]);

    match cmd.output().await {
        Ok(output) => {
            if output.status.success() {
                match tokio::fs::read(&tmp).await {
                    Ok(data) => {
                        tokio::fs::remove_file(&tmp).await.ok();
                        use base64::Engine;
                        let b64 =
                            base64::engine::general_purpose::STANDARD.encode(&data);
                        let data_uri = format!("data:image/png;base64,{}", b64);
                        (
                            format!("[Screenshot captured successfully, {} bytes]", data.len()),
                            vec![data_uri],
                        )
                    }
                    Err(e) => (format!("Failed to read screenshot: {}", e), vec![]),
                }
            } else {
                ("Screenshot command failed".into(), vec![])
            }
        }
        Err(e) => (format!("Failed to take screenshot: {}", e), vec![]),
    }
}

pub(super) async fn run_python_tool(args: &serde_json::Value) -> String {
    let code = args["code"].as_str().unwrap_or("");
    if code.is_empty() {
        return "Error: code is required".into();
    }
    if !python_bridge::is_available() {
        return "Error: Python interpreter not available".into();
    }
    match python_bridge::call_python("run_code", vec![code.to_string()]).await {
        Ok(result) => super::truncate_output(&result, 8000),
        Err(e) => format!("Python error: {}", e),
    }
}

pub(super) async fn run_python_script_tool(args: &serde_json::Value) -> String {
    let script_path = args["script_path"].as_str().unwrap_or("");
    if script_path.is_empty() {
        return "Error: script_path is required".into();
    }
    if !python_bridge::is_available() {
        return "Error: Python interpreter not available".into();
    }

    let script_args: Vec<String> = args["args"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let args_json = serde_json::to_string(&script_args).unwrap_or_else(|_| "[]".into());

    let result = python_bridge::call_python(
        "run_script",
        vec![script_path.to_string(), args_json],
    )
    .await;

    // Auto-track execution in code registry (match by path, then by name)
    if let Some(db) = super::DATABASE.get() {
        db.record_code_execution_by_path(script_path, result.is_ok(),
            result.as_ref().err().map(|e| e.as_str()));
    }

    match result {
        Ok(output) => super::truncate_output(&output, 8000),
        Err(e) => format!("Python script error: {}", e),
    }
}

pub(super) async fn pip_install_tool(args: &serde_json::Value) -> String {
    let packages: Vec<String> = args["packages"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if packages.is_empty() {
        return "Error: packages array is required".into();
    }
    if !python_bridge::is_available() {
        return "Error: Python interpreter not available".into();
    }

    let packages_json = serde_json::to_string(&packages).unwrap_or_else(|_| "[]".into());

    match python_bridge::call_python("pip_install", vec![packages_json]).await {
        Ok(result) => result,
        Err(e) => format!("pip install error: {}", e),
    }
}

pub(super) fn send_notification_tool(args: &serde_json::Value) -> String {
    let title = args["title"].as_str().unwrap_or("YiYi");
    let body = args["body"].as_str().unwrap_or("");

    if body.is_empty() {
        return "Error: body is required".into();
    }

    super::scheduler::send_system_notification(title, body);
    format!("Notification sent: {} - {}", title, body)
}

pub(super) async fn add_calendar_event_tool(args: &serde_json::Value) -> String {
    let title = args["title"].as_str().unwrap_or("");
    let description = args["description"].as_str().unwrap_or("");
    let start_str = args["start_time"].as_str().unwrap_or("");
    let end_str = args["end_time"].as_str().unwrap_or("");
    let reminder_min = args["reminder_minutes"].as_i64().unwrap_or(5);
    let all_day = args["all_day"].as_bool().unwrap_or(false);

    if title.is_empty() || start_str.is_empty() {
        return "Error: title and start_time are required".into();
    }

    // Parse start time
    let start = match chrono::DateTime::parse_from_rfc3339(start_str) {
        Ok(t) => t.to_utc(),
        Err(e) => return format!("Error: invalid start_time '{}': {}", start_str, e),
    };

    // Parse or default end time
    let end = if !end_str.is_empty() {
        match chrono::DateTime::parse_from_rfc3339(end_str) {
            Ok(t) => t.to_utc(),
            Err(e) => return format!("Error: invalid end_time '{}': {}", end_str, e),
        }
    } else {
        start + chrono::Duration::minutes(15)
    };

    // Format times for ICS (UTC)
    let fmt = "%Y%m%dT%H%M%SZ";
    let (dtstart, dtend) = if all_day {
        let day_fmt = "%Y%m%d";
        (
            format!("VALUE=DATE:{}", start.format(day_fmt)),
            format!("VALUE=DATE:{}", (start + chrono::Duration::days(1)).format(day_fmt)),
        )
    } else {
        (start.format(fmt).to_string(), end.format(fmt).to_string())
    };

    let now_stamp = chrono::Utc::now().format(fmt);
    let uid = uuid::Uuid::new_v4();

    // Escape special characters in ICS text fields
    let ics_escape = |s: &str| -> String {
        s.replace('\\', "\\\\")
            .replace(';', "\\;")
            .replace(',', "\\,")
            .replace('\n', "\\n")
    };

    let mut ics = format!(
        "BEGIN:VCALENDAR\r\n\
        VERSION:2.0\r\n\
        PRODID:-//YiYi//Calendar//EN\r\n\
        CALSCALE:GREGORIAN\r\n\
        METHOD:PUBLISH\r\n\
        BEGIN:VEVENT\r\n\
        UID:{uid}\r\n\
        DTSTAMP:{now}\r\n\
        DTSTART{colon}{dtstart}\r\n\
        DTEND{colon}{dtend}\r\n\
        SUMMARY:{title}\r\n",
        uid = uid,
        now = now_stamp,
        colon = if all_day { ";" } else { ":" },
        dtstart = dtstart,
        dtend = dtend,
        title = ics_escape(title),
    );

    if !description.is_empty() {
        ics.push_str(&format!("DESCRIPTION:{}\r\n", ics_escape(description)));
    }

    if reminder_min > 0 {
        ics.push_str(&format!(
            "BEGIN:VALARM\r\n\
            TRIGGER:-PT{}M\r\n\
            ACTION:DISPLAY\r\n\
            DESCRIPTION:Reminder\r\n\
            END:VALARM\r\n",
            reminder_min
        ));
    }

    ics.push_str("END:VEVENT\r\nEND:VCALENDAR\r\n");

    // Write .ics file to temp directory
    let temp_dir = std::env::temp_dir().join("yiyi_calendar");
    if let Err(e) = tokio::fs::create_dir_all(&temp_dir).await {
        return format!("Error creating temp dir: {}", e);
    }

    let safe_title: String = title
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == ' ')
        .take(50)
        .collect();
    let filename = format!("{}_{}.ics", safe_title.trim(), uid.to_string().split('-').next().unwrap_or("evt"));
    let file_path = temp_dir.join(&filename);

    if let Err(e) = tokio::fs::write(&file_path, &ics).await {
        return format!("Error writing .ics file: {}", e);
    }

    // Open with system default calendar app
    let open_cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "start"
    } else {
        "xdg-open"
    };

    let path_str = file_path.to_string_lossy().to_string();
    let open_result = if cfg!(target_os = "windows") {
        tokio::process::Command::new("cmd")
            .args(["/C", "start", "", &path_str])
            .spawn()
    } else {
        tokio::process::Command::new(open_cmd)
            .arg(&path_str)
            .spawn()
    };

    match open_result {
        Ok(_) => {
            let local_start = start.with_timezone(&chrono::Local);
            format!(
                "Calendar event created and opened in system calendar:\n\
                - Title: {}\n\
                - Time: {}\n\
                - Reminder: {} minutes before\n\
                - File: {}",
                title,
                local_start.format("%Y-%m-%d %H:%M"),
                reminder_min,
                file_path.display()
            )
        }
        Err(e) => {
            format!(
                "Calendar event file created at {} but failed to open: {}. \
                The user can manually open this .ics file to add it to their calendar.",
                file_path.display(), e
            )
        }
    }
}

pub(super) async fn send_file_to_user_tool(args: &serde_json::Value) -> String {
    use tauri::Emitter;

    let path = args["path"].as_str().unwrap_or("");
    if path.is_empty() {
        return "Error: path is required".into();
    }

    let file_path = std::path::Path::new(path);
    if !file_path.exists() {
        return format!("Error: file not found: {}", path);
    }

    let filename = args["filename"]
        .as_str()
        .unwrap_or_else(|| {
            file_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
        })
        .to_string();

    let description = args["description"].as_str().unwrap_or("").to_string();

    let metadata = file_path.metadata().ok();
    let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

    let payload = serde_json::json!({
        "path": path,
        "filename": filename,
        "description": description,
        "size": size,
    });

    match super::APP_HANDLE.get() {
        Some(handle) => {
            handle.emit("agent://send_file", &payload).ok();

            // System notification for generated file
            crate::engine::scheduler::send_notification_with_context(
                "YiYi",
                &format!("{} ({:.1} KB)", filename, size as f64 / 1024.0),
                serde_json::json!({
                    "page": "chat",
                    "file_path": path,
                }),
            );

            format!(
                "File sent to user: {} ({} bytes)",
                filename, size
            )
        }
        None => {
            format!(
                "File ready: {} ({} bytes) at {}",
                filename, size, path
            )
        }
    }
}

pub(super) async fn pty_spawn_interactive_tool(args: &serde_json::Value) -> String {
    let command = args["command"].as_str().unwrap_or("bash");
    let cmd_args: Vec<String> = args.get("args")
        .and_then(|a| serde_json::from_value(a.clone()).ok())
        .unwrap_or_default();
    let cwd = args["cwd"].as_str()
        .map(String::from)
        .unwrap_or_else(|| super::get_effective_workspace().to_string_lossy().to_string());
    let cols = args["cols"].as_u64().unwrap_or(80) as u16;
    let rows = args["rows"].as_u64().unwrap_or(24) as u16;

    match (super::get_pty_manager(), super::APP_HANDLE.get()) {
        (Ok(mgr), Some(handle)) => {
            match mgr.spawn(handle, command, &cmd_args, &cwd, cols, rows).await {
                Ok(sid) => serde_json::json!({
                    "__type": "pty_session",
                    "session_id": sid,
                    "command": command,
                    "message": format!("PTY session created: {}", sid)
                }).to_string(),
                Err(e) => format!("Error spawning PTY: {}", e),
            }
        }
        (Err(e), _) => e,
        (_, None) => "Error: App handle not available".into(),
    }
}

pub(super) async fn pty_send_input_tool(args: &serde_json::Value) -> String {
    let session_id = args["session_id"].as_str().unwrap_or("");
    let input = args["input"].as_str().unwrap_or("");
    let wait_ms = args["wait_ms"].as_u64().unwrap_or(3000);

    let mgr = match super::get_pty_manager() {
        Ok(m) => m,
        Err(e) => return e,
    };

    let input_with_nl = format!("{}\n", input);
    if let Err(e) = mgr.write_stdin(session_id, input_with_nl.as_bytes()).await {
        return format!("Error writing to PTY: {}", e);
    }

    match mgr.read_output(session_id, wait_ms).await {
        Ok(output) if output.is_empty() => "(no output within timeout)".into(),
        Ok(output) => super::truncate_output(&output, 8000),
        Err(e) => format!("Error reading PTY output: {}", e),
    }
}

pub(super) async fn pty_read_output_tool(args: &serde_json::Value) -> String {
    let session_id = args["session_id"].as_str().unwrap_or("");
    let wait_ms = args["wait_ms"].as_u64().unwrap_or(1000);

    let mgr = match super::get_pty_manager() {
        Ok(m) => m,
        Err(e) => return e,
    };

    match mgr.read_output(session_id, wait_ms).await {
        Ok(output) if output.is_empty() => "(no new output)".into(),
        Ok(output) => super::truncate_output(&output, 8000),
        Err(e) => format!("Error reading PTY output: {}", e),
    }
}

pub(super) async fn pty_close_session_tool(args: &serde_json::Value) -> String {
    let session_id = args["session_id"].as_str().unwrap_or("");

    let mgr = match super::get_pty_manager() {
        Ok(m) => m,
        Err(e) => return e,
    };

    match mgr.close(session_id).await {
        Ok(()) => format!("PTY session {} closed", session_id),
        Err(e) => format!("Error closing PTY: {}", e),
    }
}
