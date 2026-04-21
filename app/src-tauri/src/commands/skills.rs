use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{Emitter, State};

use crate::engine::llm_client::{self, LLMMessage, MessageContent};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub source: String,
    pub enabled: bool,
    pub content: String,
    pub path: String,
    #[serde(default)]
    pub references: Option<serde_json::Value>,
    #[serde(default)]
    pub scripts: Option<serde_json::Value>,
    /// System-internal skills cannot be edited, disabled, or deleted by users.
    #[serde(default)]
    pub system: bool,
}

fn skills_dir(working_dir: &Path, source: &str) -> PathBuf {
    match source {
        "customized" => working_dir.join("customized_skills"),
        "active" => working_dir.join("active_skills"),
        _ => working_dir.join("active_skills"),
    }
}

/// Embedded skills directory (complete with scripts, references, etc.)
static EMBEDDED_SKILLS: Dir = include_dir!("$CARGO_MANIFEST_DIR/skills");

/// System-internal skills — always active, cannot be edited/disabled/deleted.
/// Loaded from embedded resources regardless of active_skills/ directory.
pub const SYSTEM_SKILL_NAMES: &[&str] = &[];

/// Returns true if the skill is a system-internal skill.
pub fn is_system_skill(name: &str) -> bool {
    SYSTEM_SKILL_NAMES.contains(&name)
}

/// Get embedded SKILL.md content for a builtin skill by name.
pub fn get_embedded_skill_content(name: &str) -> Option<String> {
    let dir = EMBEDDED_SKILLS.get_dir(name)?;
    let file = dir.get_file(format!("{}/SKILL.md", name))
        .or_else(|| dir.get_file("SKILL.md"))?;
    Some(String::from_utf8_lossy(file.contents()).to_string())
}

/// Names of all builtin skills
const BUILTIN_SKILL_NAMES: &[&str] = &[
    "algorithmic_art",
    "bot_setup",
    "canvas_design",
    "docx",
    "feishu",
    "frontend_design",
    "himalaya",
    "mcp_builder",
    "pdf",
    "pptx",
    "skill_creator",
    "theme_factory",
    "webapp_testing",
    "wechat_writer",
    "xlsx",
];

/// Seed builtin skills into active_skills/ if not already present.
/// Extracts complete directory trees (SKILL.md + scripts/ + references/).
pub fn seed_builtin_skills(working_dir: &Path) {
    let active_dir = skills_dir(working_dir, "active");
    std::fs::create_dir_all(&active_dir).ok();

    for name in BUILTIN_SKILL_NAMES {
        let skill_dir = active_dir.join(name);
        let skill_md = skill_dir.join("SKILL.md");
        if !skill_md.exists() {
            if let Some(dir) = EMBEDDED_SKILLS.get_dir(name) {
                // Ensure the target directory exists before extracting
                std::fs::create_dir_all(&skill_dir).ok();
                if let Err(e) = dir.extract(&active_dir) {
                    log::error!("Failed to seed skill '{}': {}", name, e);
                }
            }
        }
    }

    // Migration: remove deprecated skills that have been deleted or merged into core
    for deprecated_name in &["claude_code", "coding_assistant", "file_reader", "auto_continue",
                              "task_proposer", "browser_visible", "cron", "seo", "doc_coauthoring", "news", "app_guide"] {
        let deprecated = active_dir.join(deprecated_name);
        if deprecated.exists() {
            std::fs::remove_dir_all(&deprecated).ok();
            log::info!("Removed deprecated '{}' skill", deprecated_name);
        }
    }
}

fn discover_skills(dir: &Path, source: &str) -> Vec<Skill> {
    let mut skills = Vec::new();
    if !dir.exists() {
        return skills;
    }

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }

            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let content = std::fs::read_to_string(&skill_md).unwrap_or_default();

            let refs = build_dir_tree(&path.join("references"));
            let scripts = build_dir_tree(&path.join("scripts"));

            skills.push(Skill {
                name: name.clone(),
                source: source.to_string(),
                enabled: true,
                content,
                path: path.to_string_lossy().to_string(),
                references: refs,
                scripts,
                system: is_system_skill(&name),
            });
        }
    }

    skills
}

fn build_dir_tree(dir: &Path) -> Option<serde_json::Value> {
    if !dir.exists() {
        return None;
    }
    let mut map = serde_json::Map::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if path.is_dir() {
                if let Some(subtree) = build_dir_tree(&path) {
                    map.insert(name, subtree);
                }
            } else {
                map.insert(name, serde_json::Value::Null);
            }
        }
    }
    if map.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(map))
    }
}

pub async fn list_skills_impl(
    state: &AppState,
    source: Option<String>,
    _enabled_only: Option<bool>,
) -> Result<Vec<Skill>, String> {
    let mut all_skills = Vec::new();
    let active_dir = skills_dir(&state.working_dir, "active");

    match source.as_deref() {
        Some("customized") => {
            let dir = skills_dir(&state.working_dir, "customized");
            all_skills.extend(discover_skills(&dir, "customized"));
        }
        Some("builtin") => {
            all_skills.extend(builtin_skills_with_status(&active_dir));
        }
        _ => {
            // Builtin skills (always visible, with enabled/disabled status)
            all_skills.extend(builtin_skills_with_status(&active_dir));
            // Non-builtin active skills
            let active = discover_skills(&active_dir, "builtin");
            for skill in active {
                if !BUILTIN_SKILL_NAMES.contains(&skill.name.as_str()) {
                    all_skills.push(skill);
                }
            }
            // Customized skills
            let custom_dir = skills_dir(&state.working_dir, "customized");
            all_skills.extend(discover_skills(&custom_dir, "customized"));
        }
    }

    Ok(all_skills)
}

#[tauri::command]
pub async fn list_skills(
    state: State<'_, AppState>,
    source: Option<String>,
    _enabled_only: Option<bool>,
) -> Result<Vec<Skill>, String> {
    list_skills_impl(&state, source, _enabled_only).await
}

/// List all builtin skills, marking each as enabled/disabled based on active_skills presence
fn builtin_skills_with_status(active_dir: &Path) -> Vec<Skill> {
    BUILTIN_SKILL_NAMES
        .iter()
        .filter_map(|name| {
            let embedded_dir = EMBEDDED_SKILLS.get_dir(name)?;
            let embedded_content = embedded_dir
                .get_file(format!("{}/SKILL.md", name))
                .or_else(|| embedded_dir.get_file("SKILL.md"))
                .map(|f| String::from_utf8_lossy(f.contents()).to_string())
                .unwrap_or_default();

            let skill_dir = active_dir.join(name);
            let enabled = skill_dir.join("SKILL.md").exists();
            let actual_content = if enabled {
                std::fs::read_to_string(skill_dir.join("SKILL.md"))
                    .unwrap_or_else(|_| embedded_content.clone())
            } else {
                embedded_content
            };
            let refs = if enabled {
                build_dir_tree(&skill_dir.join("references"))
            } else {
                None
            };
            let scripts = if enabled {
                build_dir_tree(&skill_dir.join("scripts"))
            } else {
                None
            };
            Some(Skill {
                name: name.to_string(),
                source: "builtin".to_string(),
                enabled,
                content: actual_content,
                path: skill_dir.to_string_lossy().to_string(),
                references: refs,
                scripts,
                system: is_system_skill(name),
            })
        })
        .collect()
}

pub async fn get_skill_impl(state: &AppState, name: String) -> Result<Skill, String> {
    let skills = list_skills_impl(state, None, None).await?;
    skills
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("Skill '{}' not found", name))
}

#[tauri::command]
pub async fn get_skill(state: State<'_, AppState>, name: String) -> Result<Skill, String> {
    get_skill_impl(&state, name).await
}

pub async fn get_skill_content_impl(
    state: &AppState,
    name: String,
    file_path: Option<String>,
) -> Result<String, String> {
    let active_dir = skills_dir(&state.working_dir, "active");
    let custom_dir = skills_dir(&state.working_dir, "customized");

    let skill_dir = if active_dir.join(&name).exists() {
        active_dir.join(&name)
    } else if custom_dir.join(&name).exists() {
        custom_dir.join(&name)
    } else {
        return Err(format!("Skill '{}' not found", name));
    };

    let target = match file_path {
        Some(fp) => {
            let fp_path = std::path::Path::new(&fp);
            // `Path::starts_with` does NOT resolve `..` segments, so reject any
            // parent-dir component (or absolute path) up front to prevent escape.
            if fp_path.is_absolute()
                || fp_path
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err("Path traversal not allowed".to_string());
            }
            skill_dir.join(fp_path)
        }
        None => skill_dir.join("SKILL.md"),
    };

    if !target.starts_with(&skill_dir) {
        return Err("Path traversal not allowed".to_string());
    }

    std::fs::read_to_string(&target).map_err(|e| format!("Failed to read: {}", e))
}

#[tauri::command]
pub async fn get_skill_content(
    state: State<'_, AppState>,
    name: String,
    file_path: Option<String>,
) -> Result<String, String> {
    get_skill_content_impl(&state, name, file_path).await
}

pub async fn enable_skill_impl(
    state: &AppState,
    name: String,
) -> Result<serde_json::Value, String> {
    let custom_dir = skills_dir(&state.working_dir, "customized");
    let active_dir = skills_dir(&state.working_dir, "active");
    let dst = active_dir.join(&name);

    if !dst.exists() {
        std::fs::create_dir_all(&active_dir).ok();
        // Check customized first
        let src = custom_dir.join(&name);
        if src.exists() {
            copy_dir_all(&src, &dst)?;
        } else if let Some(dir) = EMBEDDED_SKILLS.get_dir(&name) {
            // Ensure the target directory exists before extracting
            std::fs::create_dir_all(&dst).ok();
            if let Err(e) = dir.extract(&active_dir) {
                return Err(format!("Failed to extract skill '{}': {}", name, e));
            }
        }
    }

    Ok(serde_json::json!({ "status": "ok", "message": format!("Skill '{}' enabled", name) }))
}

#[tauri::command]
pub async fn enable_skill(
    state: State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    enable_skill_impl(&state, name).await
}

pub async fn disable_skill_impl(
    state: &AppState,
    name: String,
) -> Result<serde_json::Value, String> {
    if is_system_skill(&name) {
        return Err(format!("System skill '{}' cannot be disabled", name));
    }
    let active_dir = skills_dir(&state.working_dir, "active");
    let path = active_dir.join(&name);

    if path.exists() {
        std::fs::remove_dir_all(&path)
            .map_err(|e| format!("Failed to disable skill: {}", e))?;
    }

    Ok(serde_json::json!({ "status": "ok", "message": format!("Skill '{}' disabled", name) }))
}

#[tauri::command]
pub async fn disable_skill(
    state: State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    disable_skill_impl(&state, name).await
}

pub async fn update_skill_impl(
    state: &AppState,
    name: String,
    content: String,
) -> Result<serde_json::Value, String> {
    if is_system_skill(&name) {
        return Err(format!("System skill '{}' cannot be edited", name));
    }
    let active_dir = skills_dir(&state.working_dir, "active");
    let custom_dir = skills_dir(&state.working_dir, "customized");

    // For builtin skills: update in active_skills (extract first if not present)
    let is_builtin = BUILTIN_SKILL_NAMES.contains(&name.as_str());

    if is_builtin {
        let skill_dir = active_dir.join(&name);
        if !skill_dir.exists() {
            // Extract from embedded first
            std::fs::create_dir_all(&skill_dir).ok();
            if let Some(dir) = EMBEDDED_SKILLS.get_dir(&name) {
                dir.extract(&active_dir)
                    .map_err(|e| format!("Failed to extract skill '{}': {}", name, e))?;
            }
        }
        std::fs::write(skill_dir.join("SKILL.md"), &content)
            .map_err(|e| format!("Failed to write SKILL.md: {}", e))?;
    } else {
        // For custom skills: update in both customized and active
        let custom_skill = custom_dir.join(&name);
        if custom_skill.exists() {
            std::fs::write(custom_skill.join("SKILL.md"), &content)
                .map_err(|e| format!("Failed to write customized SKILL.md: {}", e))?;
        }
        let active_skill = active_dir.join(&name);
        if active_skill.exists() {
            std::fs::write(active_skill.join("SKILL.md"), &content)
                .map_err(|e| format!("Failed to write active SKILL.md: {}", e))?;
        }
    }

    Ok(serde_json::json!({ "status": "ok", "message": format!("Skill '{}' updated", name) }))
}

#[tauri::command]
pub async fn update_skill(
    state: State<'_, AppState>,
    name: String,
    content: String,
) -> Result<serde_json::Value, String> {
    update_skill_impl(&state, name, content).await
}

pub async fn create_skill_impl(
    state: &AppState,
    name: String,
    content: String,
    _references: Option<HashMap<String, serde_json::Value>>,
    _scripts: Option<HashMap<String, serde_json::Value>>,
) -> Result<serde_json::Value, String> {
    let custom_dir = skills_dir(&state.working_dir, "customized");
    let skill_dir = custom_dir.join(&name);

    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to create skill dir: {}", e))?;

    std::fs::write(skill_dir.join("SKILL.md"), &content)
        .map_err(|e| format!("Failed to write SKILL.md: {}", e))?;

    // Also copy to active
    let active_dir = skills_dir(&state.working_dir, "active");
    let active_skill = active_dir.join(&name);
    std::fs::create_dir_all(&active_skill).ok();
    std::fs::write(active_skill.join("SKILL.md"), &content).ok();

    Ok(serde_json::json!({ "status": "ok", "message": format!("Skill '{}' created", name) }))
}

#[tauri::command]
pub async fn create_skill(
    state: State<'_, AppState>,
    name: String,
    content: String,
    _references: Option<HashMap<String, serde_json::Value>>,
    _scripts: Option<HashMap<String, serde_json::Value>>,
) -> Result<serde_json::Value, String> {
    create_skill_impl(&state, name, content, _references, _scripts).await
}

pub async fn delete_skill_impl(
    state: &AppState,
    name: String,
) -> Result<serde_json::Value, String> {
    if is_system_skill(&name) {
        return Err(format!("System skill '{}' cannot be deleted", name));
    }
    let custom_dir = skills_dir(&state.working_dir, "customized");
    let active_dir = skills_dir(&state.working_dir, "active");

    let custom_path = custom_dir.join(&name);
    let active_path = active_dir.join(&name);

    if custom_path.exists() {
        std::fs::remove_dir_all(&custom_path)
            .map_err(|e| format!("Failed to delete customized skill: {}", e))?;
    }
    if active_path.exists() {
        std::fs::remove_dir_all(&active_path)
            .map_err(|e| format!("Failed to delete active skill: {}", e))?;
    }

    Ok(serde_json::json!({ "status": "ok", "message": format!("Skill '{}' deleted", name) }))
}

#[tauri::command]
pub async fn delete_skill(
    state: State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    delete_skill_impl(&state, name).await
}

pub async fn import_skill_impl(
    state: &AppState,
    url: String,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();

    let raw_url = if url.contains("github.com") && !url.contains("raw.githubusercontent") {
        url.replace("github.com", "raw.githubusercontent.com")
            .replace("/blob/", "/")
    } else {
        url.clone()
    };

    let skill_url = if raw_url.ends_with("SKILL.md") {
        raw_url.clone()
    } else {
        format!("{}/SKILL.md", raw_url.trim_end_matches('/'))
    };

    let resp = client
        .get(&skill_url)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Failed to download skill: HTTP {}", resp.status()));
    }

    let content = resp.text().await.map_err(|e| e.to_string())?;

    let name = raw_url
        .trim_end_matches('/')
        .trim_end_matches("SKILL.md")
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("imported_skill")
        .to_string();

    let custom_dir = skills_dir(&state.working_dir, "customized");
    let active_dir = skills_dir(&state.working_dir, "active");

    let skill_custom = custom_dir.join(&name);
    let skill_active = active_dir.join(&name);

    std::fs::create_dir_all(&skill_custom).ok();
    std::fs::create_dir_all(&skill_active).ok();

    std::fs::write(skill_custom.join("SKILL.md"), &content)
        .map_err(|e| format!("Failed to save skill: {}", e))?;
    std::fs::write(skill_active.join("SKILL.md"), &content).ok();

    let skill = Skill {
        name: name.clone(),
        source: "customized".into(),
        enabled: true,
        content,
        path: skill_custom.to_string_lossy().to_string(),
        references: None,
        scripts: None,
        system: false,
    };

    Ok(serde_json::json!({
        "status": "ok",
        "message": format!("Skill '{}' imported", name),
        "skill": skill
    }))
}

#[tauri::command]
pub async fn import_skill(
    state: State<'_, AppState>,
    url: String,
) -> Result<serde_json::Value, String> {
    import_skill_impl(&state, url).await
}

pub async fn reload_skills_impl(
    state: &AppState,
) -> Result<serde_json::Value, String> {
    let active_dir = skills_dir(&state.working_dir, "active");
    let custom_dir = skills_dir(&state.working_dir, "customized");

    // Sync customized skills to active
    if custom_dir.exists() {
        std::fs::create_dir_all(&active_dir).ok();
        if let Ok(entries) = std::fs::read_dir(&custom_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() && entry.path().join("SKILL.md").exists() {
                    let name = entry.file_name();
                    let dst = active_dir.join(&name);
                    if !dst.exists() {
                        copy_dir_all(&entry.path(), &dst).ok();
                    }
                }
            }
        }
    }

    let count = discover_skills(&active_dir, "active").len();
    Ok(serde_json::json!({ "status": "ok", "count": count }))
}

#[tauri::command]
pub async fn reload_skills(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    reload_skills_impl(&state).await
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let dest = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_all(&path, &dest)?;
        } else {
            std::fs::copy(&path, &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ============================================================================
// AI Skill Generation
// ============================================================================

const SKILL_GENERATION_PROMPT: &str = r#"You are a skill author for YiYi, an AI assistant platform. Generate a complete SKILL.md file based on the user's description.

A SKILL.md has this structure:
1. YAML frontmatter (between --- markers) with: name, description, metadata (emoji, requires)
2. Markdown body with detailed instructions for the AI agent

Rules:
- name: lowercase, alphanumeric with hyphens/underscores only
- description: concise one-line summary in the same language as user input
- emoji: a single relevant emoji
- Instructions should be detailed and actionable — tell the AI exactly how to accomplish the task
- Include examples, step-by-step guides, and edge cases
- If the skill needs scripts (Python etc.), include the script code in fenced code blocks and reference them
- Write in the same language as the user's description
- Output ONLY the SKILL.md content, no extra explanation

Example SKILL.md:
---
name: weather
description: "Query weather information for any city worldwide"
metadata:
  {
    "yiyi":
      {
        "emoji": "🌤️",
        "requires": {}
      }
  }
---

# Weather Query

When the user asks about weather...
(detailed instructions follow)
"#;

/// Stream-generate a skill using AI from a user description
#[tauri::command]
pub async fn generate_skill_ai(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    description: String,
) -> Result<(), String> {
    let config = super::agent::resolve_llm_config(&state).await?;

    let messages = vec![
        LLMMessage {
            role: "system".into(),
            content: Some(MessageContent::text(SKILL_GENERATION_PROMPT)),
            tool_calls: None,
            tool_call_id: None,
        },
        LLMMessage {
            role: "user".into(),
            content: Some(MessageContent::text(&description)),
            tool_calls: None,
            tool_call_id: None,
        },
    ];

    let handle = app.clone();
    tokio::spawn(async move {
        match llm_client::chat_completion_stream(
            &config,
            &messages,
            &[],
            move |evt| match evt {
                llm_client::StreamEvent::ContentDelta(text) => {
                    handle.emit("skill-gen://chunk", &text).ok();
                }
                llm_client::StreamEvent::Done => {
                    handle.emit("skill-gen://done", "").ok();
                }
                _ => {}
            },
            None,
        )
        .await
        {
            Ok(resp) => {
                let content = resp
                    .message
                    .content
                    .map(|c| c.into_text())
                    .unwrap_or_default();
                app.emit("skill-gen://complete", &content).ok();
            }
            Err(e) => {
                app.emit("skill-gen://error", &e).ok();
            }
        }
    });

    Ok(())
}

// ============================================================================
// Skills Hub commands
// ============================================================================

use crate::engine::skills_hub::{self, HubConfig, HubSkill, InstallResult};

/// Search skills from hub
pub async fn hub_search_skills_impl(
    query: String,
    limit: Option<usize>,
    hub_url: Option<String>,
) -> Result<Vec<HubSkill>, String> {
    let config = HubConfig {
        base_url: hub_url.unwrap_or_else(|| skills_hub::get_default_hub_config().base_url),
        ..skills_hub::get_default_hub_config()
    };

    skills_hub::search_hub_skills(&query, limit.unwrap_or(20), &config).await
}

#[tauri::command]
pub async fn hub_search_skills(
    query: String,
    limit: Option<usize>,
    hub_url: Option<String>,
) -> Result<Vec<HubSkill>, String> {
    hub_search_skills_impl(query, limit, hub_url).await
}

/// Install skill from URL (supports ClawHub, skills.sh, GitHub, direct bundle)
pub async fn hub_install_skill_impl(
    state: &AppState,
    url: String,
    version: Option<String>,
    enable: Option<bool>,
    overwrite: Option<bool>,
    hub_url: Option<String>,
) -> Result<InstallResult, String> {
    let config = HubConfig {
        base_url: hub_url.unwrap_or_else(|| skills_hub::get_default_hub_config().base_url),
        ..skills_hub::get_default_hub_config()
    };

    skills_hub::install_skill_from_url(
        &url,
        version.as_deref(),
        enable.unwrap_or(true),
        overwrite.unwrap_or(false),
        &state.working_dir,
        &config,
    )
    .await
}

#[tauri::command]
pub async fn hub_install_skill(
    state: State<'_, AppState>,
    url: String,
    version: Option<String>,
    enable: Option<bool>,
    overwrite: Option<bool>,
    hub_url: Option<String>,
) -> Result<InstallResult, String> {
    hub_install_skill_impl(&state, url, version, enable, overwrite, hub_url).await
}

/// Batch enable skills
pub async fn batch_enable_skills_impl(
    state: &AppState,
    names: Vec<String>,
) -> Result<serde_json::Value, String> {
    let mut enabled = Vec::new();
    let mut failed = Vec::new();

    for name in names {
        match enable_skill_impl(state, name.clone()).await {
            Ok(_) => enabled.push(name),
            Err(e) => failed.push(format!("{}: {}", name, e)),
        }
    }

    Ok(serde_json::json!({
        "enabled": enabled,
        "failed": failed,
        "total": enabled.len() + failed.len(),
    }))
}

#[tauri::command]
pub async fn batch_enable_skills(
    state: State<'_, AppState>,
    names: Vec<String>,
) -> Result<serde_json::Value, String> {
    batch_enable_skills_impl(&state, names).await
}

/// Batch disable skills
pub async fn batch_disable_skills_impl(
    state: &AppState,
    names: Vec<String>,
) -> Result<serde_json::Value, String> {
    let mut disabled = Vec::new();
    let mut failed = Vec::new();

    for name in names {
        match disable_skill_impl(state, name.clone()).await {
            Ok(_) => disabled.push(name),
            Err(e) => failed.push(format!("{}: {}", name, e)),
        }
    }

    Ok(serde_json::json!({
        "disabled": disabled,
        "failed": failed,
        "total": disabled.len() + failed.len(),
    }))
}

#[tauri::command]
pub async fn batch_disable_skills(
    state: State<'_, AppState>,
    names: Vec<String>,
) -> Result<serde_json::Value, String> {
    batch_disable_skills_impl(&state, names).await
}

/// List skills from hub with sorting/pagination (ClawHub browse)
pub async fn hub_list_skills_impl(
    limit: Option<usize>,
    cursor: Option<String>,
    sort: Option<String>,
    hub_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let config = HubConfig {
        base_url: hub_url.unwrap_or_else(|| skills_hub::get_default_hub_config().base_url),
        ..skills_hub::get_default_hub_config()
    };

    let (skills, next_cursor) = skills_hub::list_hub_skills(
        limit.unwrap_or(20),
        cursor.as_deref(),
        sort.as_deref(),
        &config,
    )
    .await?;

    Ok(serde_json::json!({
        "items": skills,
        "nextCursor": next_cursor,
    }))
}

#[tauri::command]
pub async fn hub_list_skills(
    limit: Option<usize>,
    cursor: Option<String>,
    sort: Option<String>,
    hub_url: Option<String>,
) -> Result<serde_json::Value, String> {
    hub_list_skills_impl(limit, cursor, sort, hub_url).await
}

/// Get hub configuration
pub fn get_hub_config_impl() -> Result<HubConfig, String> {
    Ok(skills_hub::get_default_hub_config())
}

#[tauri::command]
pub fn get_hub_config() -> Result<HubConfig, String> {
    get_hub_config_impl()
}
