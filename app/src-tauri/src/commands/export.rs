use tauri::State;
use std::io::Write;

use crate::state::AppState;

/// Get the export directory (~/Documents/YiYi/exports/), creating it if needed.
fn export_dir(state: &AppState) -> Result<std::path::PathBuf, String> {
    let dir = state.user_workspace().join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create export dir: {e}"))?;
    Ok(dir)
}

/// Generate a timestamped filename.
fn timestamped_name(prefix: &str, ext: &str) -> String {
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    format!("{prefix}_{ts}.{ext}")
}

/// Export conversations to a file.
///
/// Returns the file path where data was saved.
#[tauri::command]
pub async fn export_conversations(
    state: State<'_, AppState>,
    format: String,
    session_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let sessions = state.db.list_sessions()?;

    // Filter to requested session ids (if any)
    let sessions: Vec<_> = match &session_ids {
        Some(ids) if !ids.is_empty() => {
            sessions.into_iter().filter(|s| ids.contains(&s.id)).collect()
        }
        _ => sessions,
    };

    let dir = export_dir(&state)?;
    let ext = if format == "markdown" { "md" } else { "json" };
    let path = dir.join(timestamped_name("conversations", ext));
    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("Failed to create file: {e}"))?;

    // Stream: write one session at a time, then drop its messages to free memory.
    match format.as_str() {
        "markdown" => {
            writeln!(file, "# YiYi Conversations Export\n").ok();
            for session in &sessions {
                writeln!(file, "## Session: {}\n", session.name).ok();
                let messages = state.db.get_messages(&session.id, None)?;
                for msg in &messages {
                    let role = match msg.role.as_str() {
                        "user" => "User",
                        "assistant" => "Assistant",
                        "system" => "System",
                        "context_reset" => continue,
                        other => other,
                    };
                    writeln!(file, "### {}\n{}\n", role, msg.content).ok();
                }
                writeln!(file, "---\n").ok();
            }
        }
        "json" => {
            writeln!(file, "[").ok();
            for (i, session) in sessions.iter().enumerate() {
                let messages = state.db.get_messages(&session.id, None)?;
                let entry = serde_json::json!({ "session": session, "messages": messages });
                let chunk = serde_json::to_string_pretty(&entry)
                    .map_err(|e| format!("Serialize error: {e}"))?;
                if i > 0 { write!(file, ",\n").ok(); }
                write!(file, "{}", chunk).ok();
            }
            writeln!(file, "\n]").ok();
        }
        _ => return Err(format!("Unknown format '{}'. Use 'markdown' or 'json'.", format)),
    }

    let path_str = path.to_string_lossy().to_string();
    log::info!("Exported {} sessions to {}", sessions.len(), path_str);
    Ok(path_str)
}

/// Export memories to a JSON file. Returns the file path.
#[tauri::command]
pub async fn export_memories(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let store = crate::engine::tools::get_memme_store()
        .ok_or("MemMe store not initialized")?;

    let options = memme_core::ListOptions::new(crate::engine::tools::MEMME_USER_ID)
        .limit(5000);

    let traces = store
        .list_traces(options)
        .map_err(|e| format!("Failed to list memories: {e}"))?;

    let dir = export_dir(&state)?;
    let path = dir.join(timestamped_name("memories", "json"));
    let json = serde_json::to_string_pretty(&traces)
        .map_err(|e| format!("Serialize error: {e}"))?;
    std::fs::write(&path, &json).map_err(|e| format!("Write error: {e}"))?;

    let path_str = path.to_string_lossy().to_string();
    log::info!("Exported {} memories to {}", traces.len(), path_str);
    Ok(path_str)
}

/// Export app settings (WITHOUT api keys for security).
///
/// Includes: active model, provider list (no keys), workspace path,
/// enabled skills, meditation config, memme config.
#[tauri::command]
pub async fn export_settings(
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Active model
    let active_llm = {
        let providers = state.providers.read().await;
        let active_llm = providers.active_llm.clone();

        // Provider info (strip API keys)
        let all_providers = providers.get_all_providers();
        let safe_providers: Vec<serde_json::Value> = all_providers
            .iter()
            .map(|p| {
                serde_json::json!({
                    "id": p.id,
                    "name": p.name,
                    "default_base_url": p.default_base_url,
                    "is_custom": p.is_custom,
                    "is_local": p.is_local,
                    "configured": p.configured,
                    "base_url": p.base_url,
                    "models": p.models.iter().map(|m| &m.id).collect::<Vec<_>>(),
                })
            })
            .collect();

        (active_llm, safe_providers)
    };
    let (active_llm, safe_providers) = active_llm;

    // Workspace path
    let workspace = state.user_workspace().to_string_lossy().to_string();

    // Config: agents, meditation, memme (strip embedding API key)
    let (agents_config, meditation_config, memme_config_safe) = {
        let config = state.config.read().await;
        let agents_config = serde_json::to_value(&config.agents).unwrap_or_default();
        let meditation_config = serde_json::to_value(&config.meditation).unwrap_or_default();
        let memme_config_safe = serde_json::json!({
            "embedding_provider": config.memme.embedding_provider,
            "embedding_model": config.memme.embedding_model,
            "embedding_base_url": config.memme.embedding_base_url,
            "embedding_dims": config.memme.embedding_dims,
            "enable_graph": config.memme.enable_graph,
            "enable_forgetting_curve": config.memme.enable_forgetting_curve,
            "extraction_depth": config.memme.extraction_depth,
            // Note: embedding_api_key intentionally omitted for security
        });
        (agents_config, meditation_config, memme_config_safe)
    };

    // Enabled skills list
    let skills_dir = state.working_dir.join("active_skills");
    let enabled_skills: Vec<String> = if skills_dir.exists() {
        std::fs::read_dir(&skills_dir)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let export = serde_json::json!({
        "active_llm": active_llm,
        "providers": safe_providers,
        "workspace_path": workspace,
        "agents": agents_config,
        "meditation": meditation_config,
        "memme": memme_config_safe,
        "enabled_skills": enabled_skills,
    });

    let dir = export_dir(&state)?;
    let path = dir.join(timestamped_name("settings", "json"));
    let json = serde_json::to_string_pretty(&export)
        .map_err(|e| format!("Serialize error: {e}"))?;
    std::fs::write(&path, &json).map_err(|e| format!("Write error: {e}"))?;

    log::info!("Exported settings to {}", path.display());
    Ok(path.to_string_lossy().to_string())
}
