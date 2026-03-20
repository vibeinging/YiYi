use tauri::{Emitter, State};

use crate::engine::db::TaskInfo;
use crate::state::AppState;

/// Generate a TASK.md file in ~/.yiyi/tasks/{task_id}/
fn generate_task_md(
    working_dir: &std::path::Path,
    task_id: &str,
    task_name: &str,
    description: &str,
    workspace_path: Option<&str>,
) {
    let task_dir = working_dir.join("tasks").join(task_id);
    if let Err(e) = std::fs::create_dir_all(&task_dir) {
        log::warn!("Failed to create task dir {}: {}", task_dir.display(), e);
        return;
    }

    let workspace_section = workspace_path.unwrap_or("(none)");
    let content = format!(
        "# {}\n\n## 原始需求\n{}\n\n## 执行计划\n（待 Agent 执行时填充）\n\n## 产出文件\n（待 Agent 执行时更新）\n\n## 产出目录\n{}\n",
        task_name, description, workspace_section
    );

    let md_path = task_dir.join("TASK.md");
    if let Err(e) = std::fs::write(&md_path, &content) {
        log::warn!("Failed to write TASK.md: {}", e);
    }
}

/// Shared logic for creating a task with its own session.
/// Returns (task_id, session_id, TaskInfo).
fn create_task_with_session(
    state: &AppState,
    app: &tauri::AppHandle,
    task_name: &str,
    description: &str,
    parent_session_id: &str,
    workspace_path: Option<&str>,
    source: &str,
) -> Result<TaskInfo, String> {
    let task_id = uuid::Uuid::new_v4().to_string();
    let session_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();

    // Create a dedicated session for this task
    state.db.ensure_session(
        &session_id,
        task_name,
        "task",
        Some(&task_id),
    )?;

    // Insert task record
    state.db.create_task(
        &task_id,
        task_name,
        Some(description),
        "pending",
        &session_id,
        Some(parent_session_id),
        None,
        0,
        now,
    )?;

    // Set workspace_path if provided
    if let Some(wp) = workspace_path {
        state.db.update_task_workspace_path(&task_id, wp)?;
    }

    // Initialize cancellation signal
    state.get_or_create_task_cancel(&task_id);

    // Generate TASK.md
    generate_task_md(&state.working_dir, &task_id, task_name, description, workspace_path);

    let task = state
        .db
        .get_task(&task_id)?
        .ok_or_else(|| "Failed to retrieve created task".to_string())?;

    // Emit creation event
    let _ = app.emit(
        "task://created",
        serde_json::json!({
            "taskId": task_id,
            "title": task_name,
            "parentSessionId": parent_session_id,
            "source": source,
        }),
    );

    Ok(task)
}

#[tauri::command]
pub async fn create_task(
    title: String,
    description: Option<String>,
    parent_session_id: String,
    plan: Option<Vec<String>>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<TaskInfo, String> {
    let task_id = uuid::Uuid::new_v4().to_string();
    let session_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();

    let total_stages = plan.as_ref().map(|p| p.len() as i32).unwrap_or(0);
    let plan_json = plan
        .as_ref()
        .map(|p| serde_json::to_string(p).unwrap_or_else(|_| "[]".to_string()));

    let session_name = format!("Task: {}", &title);
    state.db.ensure_session(&session_id, &session_name, "task", Some(&task_id))?;

    state.db.create_task(
        &task_id, &title, description.as_deref(), "pending",
        &session_id, Some(&parent_session_id), plan_json.as_deref(), total_stages, now,
    )?;

    state.get_or_create_task_cancel(&task_id);

    let task = state.db.get_task(&task_id)?
        .ok_or_else(|| "Failed to retrieve created task".to_string())?;

    let _ = app.emit("task://created", serde_json::json!({
        "taskId": task_id, "title": title, "parentSessionId": parent_session_id,
    }));

    Ok(task)
}

#[tauri::command]
pub async fn list_tasks(
    parent_session_id: Option<String>,
    status: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<TaskInfo>, String> {
    state.db.list_tasks(parent_session_id.as_deref(), status.as_deref())
}

#[tauri::command]
pub async fn get_task_status(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<TaskInfo, String> {
    state.db.get_task(&task_id)?
        .ok_or_else(|| format!("Task not found: {}", task_id))
}

#[tauri::command]
pub async fn cancel_task(
    task_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let signalled = state.cancel_task_signal(&task_id);
    if !signalled {
        log::warn!("No active cancellation signal for task {}", task_id);
    }
    state.db.update_task_status(&task_id, "cancelled")?;
    state.cleanup_task_signal(&task_id);
    let _ = app.emit("task://cancelled", serde_json::json!({ "taskId": task_id }));
    Ok(())
}

#[tauri::command]
pub async fn pause_task(
    task_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let task = state.db.get_task(&task_id)?
        .ok_or_else(|| format!("Task not found: {}", task_id))?;

    if task.status != "running" && task.status != "pending" {
        return Err(format!("Cannot pause task in '{}' status", task.status));
    }

    state.cancel_task_signal(&task_id);
    state.db.update_task_status(&task_id, "paused")?;
    let _ = app.emit("task://paused", serde_json::json!({ "taskId": task_id }));
    Ok(())
}

#[tauri::command]
pub async fn send_task_message(
    task_id: String,
    message: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let task = state.db.get_task(&task_id)?
        .ok_or_else(|| format!("Task not found: {}", task_id))?;

    if task.status != "running" && task.status != "paused" {
        return Err(format!("Cannot send message to task in '{}' status", task.status));
    }

    state.db.push_message(&task.session_id, "user", &message)?;
    let _ = app.emit("task://message", serde_json::json!({
        "taskId": task_id, "sessionId": task.session_id, "message": message,
    }));
    Ok(())
}

#[tauri::command]
pub async fn delete_task(
    task_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.db.delete_task(&task_id)?;
    state.cleanup_task_signal(&task_id);
    let _ = app.emit("task://deleted", serde_json::json!({ "taskId": task_id }));
    Ok(())
}

#[tauri::command]
pub async fn pin_task(
    task_id: String,
    pinned: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.db.pin_task(&task_id, pinned)?;
    let _ = app.emit("task://updated", serde_json::json!({ "taskId": task_id, "pinned": pinned }));
    Ok(())
}

#[tauri::command]
pub async fn confirm_background_task(
    parent_session_id: String,
    task_name: String,
    original_message: String,
    context_summary: String,
    workspace_path: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<TaskInfo, String> {
    let task = create_task_with_session(
        &state, &app, &task_name, &original_message,
        &parent_session_id, workspace_path.as_deref(), "background",
    )?;

    // Inject context summary as system message into task session
    if !context_summary.is_empty() {
        let ctx_msg = format!("[Context from main chat]\n{}", context_summary);
        state.db.push_message(&task.session_id, "system", &ctx_msg)?;
    }

    // Push the original user message into task session
    state.db.push_message(&task.session_id, "user", &original_message)?;

    // Extract plan from task record for spawning
    let plan: Vec<String> = task.plan.as_ref()
        .and_then(|p| serde_json::from_str(p).ok())
        .unwrap_or_default();

    // Spawn the background task execution (ReAct agent loop)
    crate::engine::tools::spawn_task_execution(
        task.id.clone(),
        task.session_id.clone(),
        task.title.clone(),
        task.description.clone().unwrap_or_default(),
        plan,
        task.total_stages,
    );

    Ok(task)
}

#[tauri::command]
pub async fn convert_to_long_task(
    parent_session_id: String,
    task_name: String,
    context_summary: String,
    workspace_path: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<TaskInfo, String> {
    let task = create_task_with_session(
        &state, &app, &task_name, &context_summary,
        &parent_session_id, workspace_path.as_deref(), "converted",
    )?;

    // Inject context summary FIRST so Agent sees it before history
    state.db.push_message(
        &task.session_id, "system",
        &format!("[Task Context]\n{}", context_summary),
    )?;

    // Then copy recent messages from parent session
    let recent_messages = state.db.get_recent_messages(&parent_session_id, 50)?;
    for msg in &recent_messages {
        state.db.push_message_with_metadata(
            &task.session_id, &msg.role, &msg.content, msg.metadata.as_deref(),
        )?;
    }

    // Extract plan from task record for spawning
    let plan: Vec<String> = task.plan.as_ref()
        .and_then(|p| serde_json::from_str(p).ok())
        .unwrap_or_default();

    // Spawn the task execution (ReAct agent loop)
    crate::engine::tools::spawn_task_execution(
        task.id.clone(),
        task.session_id.clone(),
        task.title.clone(),
        task.description.clone().unwrap_or_default(),
        plan,
        task.total_stages,
    );

    Ok(task)
}

#[tauri::command]
pub async fn get_task_by_name(
    name: String,
    state: State<'_, AppState>,
) -> Result<Option<TaskInfo>, String> {
    state.db.search_tasks_by_name(&name)
}

#[tauri::command]
pub async fn list_all_tasks_brief(
    state: State<'_, AppState>,
) -> Result<Vec<TaskInfo>, String> {
    state.db.list_tasks(None, None)
}

#[tauri::command]
pub async fn open_task_folder(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Validate task_id is a valid UUID to prevent path traversal
    uuid::Uuid::parse_str(&task_id)
        .map_err(|_| "Invalid task ID format".to_string())?;

    let task = state.db.get_task(&task_id).map_err(|e| e.to_string())?;
    let path = match &task {
        Some(t) if t.workspace_path.is_some() => t.workspace_path.clone().unwrap(),
        _ => {
            // Fallback: use user workspace + task title (sanitized), or tasks/{id}
            let user_ws = state.user_workspace();
            if let Some(t) = &task {
                let safe_title: String = t.title
                    .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
                    .trim()
                    .to_string();
                let name = if safe_title.is_empty() { task_id.clone() } else { safe_title };
                user_ws.join(&name).to_string_lossy().to_string()
            } else {
                state.working_dir.join("tasks").join(&task_id).to_string_lossy().to_string()
            }
        }
    };

    let dir = std::path::Path::new(&path);
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    }

    // Verify the resolved path is under working_dir or user_workspace
    let canonical = std::fs::canonicalize(dir)
        .map_err(|e| format!("Failed to resolve path: {}", e))?;
    let working_dir_canon = std::fs::canonicalize(&state.working_dir)
        .unwrap_or_else(|_| state.working_dir.clone());
    let user_ws_canon = std::fs::canonicalize(&state.user_workspace())
        .unwrap_or_else(|_| state.user_workspace());
    if !canonical.starts_with(&working_dir_canon) && !canonical.starts_with(&user_ws_canon) {
        return Err("Path is outside allowed directories".to_string());
    }

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;

    Ok(())
}
