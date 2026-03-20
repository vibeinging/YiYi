use serde::{Deserialize, Serialize};
use std::path::Path;
use std::path::PathBuf;
use tauri::{Emitter, State};

use std::sync::Arc;

use crate::engine::db;
use crate::engine::llm_client::{LLMConfig, LLMMessage, MessageContent};
use crate::engine::react_agent;
use crate::engine::react_agent::{PersistToolFn, SignalType, ToolPersistEvent};
use crate::engine::tools::{mcp_tools_as_definitions, ToolDefinition};
use crate::state::app_state::{StreamingSnapshot, ToolSnapshot};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub mime_type: String,
    pub data: String, // base64
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallInfo {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnAgentResult {
    pub name: String,
    pub result: String,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: Option<i64>,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub timestamp: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<MessageSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_agents: Option<Vec<SpawnAgentResult>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

/// Resolve LLM config from app state
pub async fn resolve_llm_config(state: &AppState) -> Result<LLMConfig, String> {
    let providers = state.providers.read().await;
    crate::engine::llm_client::resolve_config_from_providers(&providers)
}

/// Skill index entry — name + one-line description for the system prompt.
#[derive(Clone)]
pub struct SkillIndexEntry {
    pub name: String,
    pub description: String,
}

/// Load skill index (name + description) and always-active skill contents.
///
/// Returns:
/// - `index`: compact list for the system prompt (model uses `activate_skills` tool to load full content)
/// - `always_active`: full content of skills marked `always_active: true` (injected directly)
///
/// System skills (auto_continue, task_proposer) are always loaded from embedded resources,
/// regardless of whether they exist in active_skills/. They are fundamental app capabilities.
async fn load_skill_index(state: &AppState) -> (Vec<SkillIndexEntry>, Vec<String>) {
    let skills_dir = state.working_dir.join("active_skills");
    let mut index = Vec::new();
    let mut always_active = Vec::new();
    let mut loaded_names = std::collections::HashSet::new();

    // 1. Always load system skills from embedded resources (guaranteed to work)
    for name in super::skills::SYSTEM_SKILL_NAMES {
        if let Some(content) = super::skills::get_embedded_skill_content(name) {
            let (_, is_always_active) = parse_skill_frontmatter(&content);
            if is_always_active {
                always_active.push(format!("[System skill: {}]\n\n{}", name, content));
            }
            loaded_names.insert(name.to_string());
        }
    }

    // 2. Load user-enabled skills from active_skills/
    let mut entries = match tokio::fs::read_dir(&skills_dir).await {
        Ok(entries) => entries,
        Err(_) => return (index, always_active),
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let name = path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        // Skip system skills (already loaded from embedded)
        if loaded_names.contains(&name) {
            continue;
        }

        let skill_md = path.join("SKILL.md");
        if let Ok(content) = tokio::fs::read_to_string(&skill_md).await {
            let (description, is_always_active) = parse_skill_frontmatter(&content);

            if is_always_active {
                let skill_dir = path.to_string_lossy();
                always_active.push(format!(
                    "[Skill directory: {}]\n\n{}",
                    skill_dir, content
                ));
            } else {
                index.push(SkillIndexEntry {
                    name,
                    description: description.unwrap_or_default(),
                });
            }
        }
    }

    (index, always_active)
}

/// Parse SKILL.md YAML frontmatter to extract description and always_active flag.
pub fn parse_skill_frontmatter(content: &str) -> (Option<String>, bool) {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return (None, false);
    }
    let rest = &trimmed[3..];
    let end = match rest.find("---") {
        Some(e) => e,
        None => return (None, false),
    };
    let frontmatter = &rest[..end];
    let mut description = None;
    let mut always_active = false;

    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(desc) = line.strip_prefix("description:") {
            description = Some(desc.trim().trim_matches('"').trim_matches('\'').to_string());
        }
        if line.contains("always_active") && line.contains("true") {
            always_active = true;
        }
    }

    (description, always_active)
}

/// Create a persist callback that saves tool calls to the database.
fn make_persist_fn(db: Arc<db::Database>, session_id: String) -> PersistToolFn {
    Arc::new(move |evt: ToolPersistEvent| {
        match evt {
            ToolPersistEvent::AssistantWithToolCalls { content, tool_calls_json } => {
                let metadata = serde_json::json!({
                    "tool_calls": serde_json::from_str::<serde_json::Value>(&tool_calls_json).unwrap_or_default()
                }).to_string();
                db.push_message_with_metadata(&session_id, "assistant", &content, Some(&metadata)).ok();
            }
            ToolPersistEvent::ToolResult { tool_call_id, tool_name, result_content } => {
                let metadata = serde_json::json!({
                    "tool_call_id": tool_call_id,
                    "tool_name": tool_name,
                }).to_string();
                db.push_message_with_metadata(&session_id, "tool", &result_content, Some(&metadata)).ok();
            }
        }
    })
}

/// Convert db messages to LLMMessages for conversation context.
/// Reconstructs multimodal content for image attachments only (files are referenced via path hints in text).
/// Also reconstructs tool_calls and tool_call_id from metadata.
fn db_messages_to_llm(internal_dir: &Path, workspace_dir: &Path, messages: &[db::ChatMessage]) -> Vec<LLMMessage> {
    messages
        .iter()
        .map(|m| {
            let meta: Option<serde_json::Value> = m.metadata.as_ref()
                .and_then(|s| serde_json::from_str(s).ok());

            let content = if let Some(ref meta_val) = meta {
                if let Some(att_arr) = meta_val["attachments"].as_array() {
                    let refs: Vec<AttachmentRef> = att_arr
                        .iter()
                        .filter_map(|a| serde_json::from_value(a.clone()).ok())
                        .collect();
                    let image_uris: Vec<String> = refs
                        .iter()
                        .filter(|r| is_image_mime(&r.mime_type))
                        .filter_map(|r| attachment_ref_to_data_uri(internal_dir, workspace_dir, r))
                        .collect();
                    if !image_uris.is_empty() {
                        Some(MessageContent::with_images(&m.content, &image_uris))
                    } else {
                        Some(MessageContent::text(&m.content))
                    }
                } else {
                    Some(MessageContent::text(&m.content))
                }
            } else {
                Some(MessageContent::text(&m.content))
            };

            // Reconstruct tool_calls for assistant messages
            let tool_calls = if m.role == "assistant" {
                meta.as_ref().and_then(|mv| {
                    let arr = mv["tool_calls"].as_array()?;
                    let calls: Vec<crate::engine::tools::ToolCall> = arr.iter().filter_map(|tc| {
                        Some(crate::engine::tools::ToolCall {
                            id: tc["id"].as_str()?.to_string(),
                            r#type: "function".into(),
                            function: crate::engine::tools::FunctionCall {
                                name: tc["name"].as_str()?.to_string(),
                                arguments: {
                                    let raw = tc["arguments"].as_str().unwrap_or("{}");
                                    // Validate JSON — some providers reject invalid arguments
                                    if serde_json::from_str::<serde_json::Value>(raw).is_ok() {
                                        raw.to_string()
                                    } else if let Some(repaired) = crate::engine::tools::repair_json(raw) {
                                        serde_json::to_string(&repaired).unwrap_or_else(|_| "{}".to_string())
                                    } else {
                                        "{}".to_string()
                                    }
                                },
                            },
                        })
                    }).collect();
                    if calls.is_empty() { None } else { Some(calls) }
                })
            } else {
                None
            };

            // Reconstruct tool_call_id for tool messages
            let tool_call_id = if m.role == "tool" {
                meta.as_ref().and_then(|mv| mv["tool_call_id"].as_str().map(|s| s.to_string()))
            } else {
                None
            };

            LLMMessage {
                role: m.role.clone(),
                content,
                tool_calls,
                tool_call_id,
            }
        })
        .collect()
}

const DEFAULT_SESSION: &str = "default";

/// Extract a short session title from the user's first message.
/// Takes the first line (or first 30 chars) as title, no LLM call needed.
fn extract_title_from_message(message: &str) -> String {
    let trimmed = message.trim();
    // Take first line
    let first_line = trimmed.lines().next().unwrap_or(trimmed);
    // Limit to 30 chars, break at word/char boundary
    let chars: Vec<char> = first_line.chars().collect();
    if chars.len() <= 30 {
        first_line.to_string()
    } else {
        let truncated: String = chars[..30].iter().collect();
        format!("{}…", truncated.trim_end())
    }
}

fn resolve_session_id(session_id: &Option<String>) -> String {
    session_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SESSION)
        .to_string()
}

/// Recall relevant memories based on user message and inject them as context.
/// Returns an augmented message with memory context prepended if any relevant memories found.
fn recall_memories(db: &db::Database, user_message: &str) -> Option<String> {
    // Skip very short messages (greetings, single words)
    if user_message.trim().len() < 4 {
        return None;
    }
    let results = db.memory_search(user_message, None, 5).ok()?;
    if results.is_empty() {
        return None;
    }
    let mut context = String::from("[Recalled memories]\n");
    for mem in &results {
        context.push_str(&format!("- [{}] {}\n", mem.category, mem.content));
    }
    context.push_str("[/Recalled memories]\n");
    Some(context)
}

/// Simple token count estimation.
/// English text averages ~4 chars/token, Chinese ~2 chars/token.
/// Uses a rough 3/4 multiplier as a middle ground.
fn estimate_tokens_simple(text: &str) -> u64 {
    let chars = text.chars().count() as u64;
    (chars * 3) / 4
}

/// All pre-processed data needed before invoking the ReAct agent.
struct ChatContext {
    config: LLMConfig,
    system_prompt: String,
    agent_message: String,
    augmented_message: String,
    extra_tools: Vec<ToolDefinition>,
    llm_history: Vec<LLMMessage>,
    max_iter: Option<usize>,
    working_dir: PathBuf,
    is_first_message: bool,
}

/// Build additional context for special session types (cron jobs, tasks, bots).
/// Returns None for regular chat sessions.
async fn build_session_context(state: &AppState, session_id: &str) -> Option<String> {
    // Cron job session: cron:{job_id}
    if let Some(job_id) = session_id.strip_prefix("cron:") {
        if let Ok(Some(job)) = state.db.get_cronjob(job_id) {
            let schedule_info: serde_json::Value = serde_json::from_str(&job.schedule_json).unwrap_or_default();
            let schedule_type = schedule_info.get("type").and_then(|v| v.as_str()).unwrap_or("unknown");
            let cron_expr = schedule_info.get("cron").and_then(|v| v.as_str()).unwrap_or("");
            let task_content = job.text.as_deref().unwrap_or("(no task content)");

            let mut ctx = format!(
                "## Current Session Context\n\
                 You are in a cron job session. The user is managing this specific scheduled task:\n\
                 - **Job ID**: {}\n\
                 - **Job Name**: {}\n\
                 - **Status**: {}\n\
                 - **Task Type**: {}\n\
                 - **Schedule Type**: {}\n",
                job_id,
                job.name,
                if job.enabled { "enabled (running)" } else { "paused" },
                job.task_type,
                schedule_type,
            );
            if !cron_expr.is_empty() {
                ctx.push_str(&format!("- **Cron Expression**: {}\n", cron_expr));
            }
            if let Some(delay) = schedule_info.get("delay_minutes").and_then(|v| v.as_u64()) {
                ctx.push_str(&format!("- **Delay**: {} minutes\n", delay));
            }
            if let Some(at) = schedule_info.get("schedule_at").and_then(|v| v.as_str()) {
                ctx.push_str(&format!("- **Scheduled At**: {}\n", at));
            }
            ctx.push_str(&format!("- **Task Content**: {}\n", task_content));
            ctx.push_str("\nWhen the user asks about \"this task\" or \"this job\", they are referring to the above cron job. \
                          You can directly use the cron job management tools to modify it without needing to search for it.\n\
                          To view execution history, use manage_cronjob with action='history' (id is auto-inferred in this session).\n\
                          To get the full result of a specific execution, use action='get_execution' with execution_index (e.g. 5 for the 5th run, -1 for latest).");
            return Some(ctx);
        }
    }
    None
}

/// Shared pre-processing for `chat` and `chat_stream_start`.
///
/// Resolves LLM config, saves attachments, pushes user message to DB,
/// loads skills & MCP tools, builds conversation history, recalls memories,
/// and constructs the system prompt.
async fn prepare_chat_context(
    state: &AppState,
    sid: &str,
    message: &str,
    attachments: &Option<Vec<Attachment>>,
) -> Result<ChatContext, String> {
    let config = resolve_llm_config(state).await?;
    let working_dir = state.working_dir.clone();
    let user_workspace = state.user_workspace();

    // Save attachments to filesystem, store paths in metadata
    let save = save_attachments_to_disk(&working_dir, &user_workspace, sid, attachments);
    let augmented_message = if save.file_hints.is_empty() {
        message.to_string()
    } else {
        format!("{}\n\n{}", message, save.file_hints.join("\n"))
    };
    state.db.push_message_with_metadata(sid, "user", &augmented_message, save.metadata_json.as_deref())?;

    let (skill_index, always_active_skills) = load_skill_index(state).await;
    let (lang, max_iter) = {
        let cfg = state.config.read().await;
        let lang = cfg.agents.language.clone();
        let max_iter = cfg.agents.max_iterations;
        (lang, max_iter)
    };
    let (mcp_tools, unavailable_servers) = state.mcp_runtime.get_all_tools_with_status().await;
    let skill_overrides = {
        let cfg = state.config.read().await;
        crate::engine::tools::build_mcp_skill_overrides(&cfg.mcp, &working_dir)
    };
    let extra_tools = mcp_tools_as_definitions(&mcp_tools, &skill_overrides);

    // Build system prompt with skill index (on-demand) + always-active skills (injected)
    let unavail = if unavailable_servers.is_empty() { None } else { Some(unavailable_servers.as_slice()) };
    let mut system_prompt = react_agent::build_system_prompt(
        &working_dir, Some(&user_workspace), &skill_index, &always_active_skills,
        lang.as_deref(), Some(&mcp_tools), unavail,
    ).await;

    // Inject session context for special session types (e.g. cron jobs)
    if let Some(context) = build_session_context(state, sid).await {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&context);
    }

    // Build conversation history (exclude the message we just pushed)
    let history_messages = state.db.get_recent_messages(sid, 50).unwrap_or_default();
    let llm_history: Vec<LLMMessage> = if history_messages.len() > 1 {
        db_messages_to_llm(&working_dir, &user_workspace, &history_messages[..history_messages.len() - 1])
    } else {
        vec![]
    };
    let is_first_message = llm_history.is_empty();

    // Recall relevant memories and inject into context
    let agent_message = if let Some(mem_context) = recall_memories(&state.db, message) {
        format!("{mem_context}\n{augmented_message}")
    } else {
        augmented_message.clone()
    };

    Ok(ChatContext {
        config,
        system_prompt,
        agent_message,
        augmented_message,
        extra_tools,
        llm_history,
        max_iter,
        working_dir,
        is_first_message,
    })
}

/// Handle system commands that start with /
async fn handle_command(
    state: &AppState,
    session_id: &str,
    message: &str,
) -> Option<String> {
    let cmd = message.trim();
    match cmd {
        "/clear" => {
            state.db.clear_messages(session_id).ok();
            Some("Chat history cleared.".into())
        }
        "/new" => {
            state.db.clear_messages(session_id).ok();
            Some("New conversation started.".into())
        }
        "/history" => {
            let messages = state.db.get_messages(session_id, Some(10)).unwrap_or_default();
            let count = messages.len();
            let preview: Vec<String> = messages
                .iter()
                .rev()
                .take(10)
                .map(|m| {
                    let preview: String = m.content.chars().take(80).collect();
                    format!("[{}] {}", m.role, preview)
                })
                .collect();
            Some(format!(
                "Chat history: {} messages\nRecent:\n{}",
                count,
                preview.join("\n")
            ))
        }
        _ => None,
    }
}

// --- Session management commands ---

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<db::ChatSession>, String> {
    state.db.list_sessions()
}

#[tauri::command]
pub async fn create_session(
    state: State<'_, AppState>,
    name: String,
) -> Result<db::ChatSession, String> {
    state.db.create_session(&name)
}

#[tauri::command]
pub async fn ensure_session(
    state: State<'_, AppState>,
    id: String,
    name: String,
    source: String,
    source_meta: Option<String>,
) -> Result<db::ChatSession, String> {
    state.db.ensure_session(&id, &name, &source, source_meta.as_deref())
}

#[tauri::command]
pub async fn rename_session(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    state.db.rename_session(&session_id, &name)
}

#[tauri::command]
pub async fn delete_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.db.delete_session(&session_id)
}

// --- Chat commands ---

/// Saved attachment reference stored in metadata (file path instead of base64).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AttachmentRef {
    mime_type: String,
    path: String, // relative path under working_dir
    #[serde(default)]
    name: Option<String>,
}

fn is_image_mime(mime: &str) -> bool {
    mime.starts_with("image/")
}

/// Guess file extension from MIME type.
fn mime_to_ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "image/jpeg" => "jpg",
        "application/pdf" => "pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "text/plain" => "txt",
        "text/csv" => "csv",
        "text/markdown" => "md",
        "application/json" => "json",
        _ => "bin",
    }
}

/// Extract extension from filename, or fall back to MIME-based extension.
fn resolve_ext(mime: &str, name: Option<&str>) -> String {
    if let Some(n) = name {
        if let Some(ext) = n.rsplit('.').next() {
            if (1..=10).contains(&ext.len()) && ext != n {
                return ext.to_lowercase();
            }
        }
    }
    mime_to_ext(mime).to_string()
}

/// Generate a unique filename in a directory, appending _1, _2, etc. on conflict.
fn unique_filename(dir: &Path, desired: &str) -> String {
    if !dir.join(desired).exists() {
        return desired.to_string();
    }
    let stem = desired.rsplit_once('.').map(|(s, _)| s).unwrap_or(desired);
    let ext = desired.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    for i in 1..1000 {
        let candidate = if ext.is_empty() {
            format!("{}_{}", stem, i)
        } else {
            format!("{}_{}.{}", stem, i, ext)
        };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{}_{}", uuid::Uuid::new_v4(), desired)
}

/// Result of saving attachments to disk.
struct SaveResult {
    metadata_json: Option<String>,
    file_hints: Vec<String>, // e.g. "[用户上传了文件: report.pdf，路径: /abs/path]"
}

/// Save attachments to filesystem and return metadata + file path hints for non-image files.
/// `internal_dir` = app data dir (~/.yiyi) for image attachments
/// `workspace_dir` = user workspace (~/Documents/YiYi) for file uploads
fn save_attachments_to_disk(
    internal_dir: &Path,
    workspace_dir: &Path,
    session_id: &str,
    attachments: &Option<Vec<Attachment>>,
) -> SaveResult {
    let empty = SaveResult { metadata_json: None, file_hints: vec![] };
    let atts = match attachments.as_ref() {
        Some(a) if !a.is_empty() => a,
        _ => return empty,
    };

    let mut refs: Vec<AttachmentRef> = Vec::new();
    let mut file_hints: Vec<String> = Vec::new();

    for att in atts {
        let bytes = match base64_decode(&att.data) {
            Some(b) => b,
            None => continue,
        };

        if is_image_mime(&att.mime_type) {
            // Images → internal_dir/attachments/{session_id}/{uuid}.{ext}
            let dir = internal_dir.join("attachments").join(session_id);
            if std::fs::create_dir_all(&dir).is_err() { continue; }
            let ext = resolve_ext(&att.mime_type, att.name.as_deref());
            let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
            let rel_path = format!("attachments/{}/{}", session_id, filename);
            let full_path = internal_dir.join(&rel_path);
            if std::fs::write(&full_path, &bytes).is_err() { continue; }
            refs.push(AttachmentRef {
                mime_type: att.mime_type.clone(),
                path: rel_path,
                name: att.name.clone(),
            });
        } else {
            // Files → workspace_dir/uploads/{original_name}
            let dir = workspace_dir.join("uploads");
            if std::fs::create_dir_all(&dir).is_err() { continue; }
            let ext = resolve_ext(&att.mime_type, att.name.as_deref());
            let desired = att.name.as_deref()
                .unwrap_or(&format!("file.{}", ext))
                .to_string();
            let filename = unique_filename(&dir, &desired);
            let full_path = dir.join(&filename);
            if std::fs::write(&full_path, &bytes).is_err() { continue; }

            file_hints.push(format!(
                "[用户上传了文件: {}，路径: {}]",
                filename,
                full_path.to_string_lossy()
            ));

            // Store as workspace-relative path (prefix with "ws:" to distinguish)
            refs.push(AttachmentRef {
                mime_type: att.mime_type.clone(),
                path: format!("ws:uploads/{}", filename),
                name: Some(filename),
            });
        }
    }

    let metadata_json = if refs.is_empty() {
        None
    } else {
        Some(serde_json::json!({ "attachments": refs }).to_string())
    };

    SaveResult { metadata_json, file_hints }
}

/// Decode base64 (handles both standard and data-URI prefixed).
fn base64_decode(data: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let raw = if let Some((_prefix, b64)) = data.split_once(',') {
        b64
    } else {
        data
    };
    base64::engine::general_purpose::STANDARD.decode(raw).ok()
}

/// Resolve an attachment path. Paths prefixed with "ws:" are relative to user_workspace,
/// otherwise relative to internal working_dir.
fn resolve_attachment_path(internal_dir: &Path, workspace_dir: &Path, rel_path: &str) -> std::path::PathBuf {
    if let Some(ws_path) = rel_path.strip_prefix("ws:") {
        workspace_dir.join(ws_path)
    } else {
        internal_dir.join(rel_path)
    }
}

/// Read an attachment file from disk and return base64 data.
fn read_attachment_as_base64(internal_dir: &Path, workspace_dir: &Path, rel_path: &str) -> Option<String> {
    use base64::Engine;
    let full_path = resolve_attachment_path(internal_dir, workspace_dir, rel_path);
    let bytes = std::fs::read(&full_path).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Build a data URI from an attachment ref by reading the file from disk.
fn attachment_ref_to_data_uri(internal_dir: &Path, workspace_dir: &Path, att: &AttachmentRef) -> Option<String> {
    let b64 = read_attachment_as_base64(internal_dir, workspace_dir, &att.path)?;
    Some(format!("data:{};base64,{}", att.mime_type, b64))
}

#[tauri::command]
pub async fn chat(
    state: State<'_, AppState>,
    message: String,
    session_id: Option<String>,
    attachments: Option<Vec<Attachment>>,
) -> Result<String, String> {
    let sid = resolve_session_id(&session_id);

    // Handle system commands
    if message.trim().starts_with('/') {
        if let Some(response) = handle_command(&state, &sid, &message).await {
            return Ok(response);
        }
    }

    let ctx = prepare_chat_context(&state, &sid, &message, &attachments).await?;

    // Run agent with session-scoped context (task_local) so tools see the correct session
    let persist_fn = Some(make_persist_fn(state.db.clone(), sid.clone()));
    let reply = crate::engine::tools::with_session_id(
        sid.clone(),
        react_agent::run_react_with_options_persist(
            &ctx.config,
            &ctx.system_prompt,
            &ctx.agent_message,
            &ctx.extra_tools,
            &ctx.llm_history,
            ctx.max_iter,
            Some(&ctx.working_dir),
            persist_fn,
        ),
    )
    .await?;

    // Save assistant reply (final text-only response)
    if !reply.is_empty() && reply != "(no response)" {
        state.db.push_message(&sid, "assistant", &reply)?;
    }

    // Auto-extract memories in background
    {
        let config_clone = ctx.config.clone();
        let msg_clone = ctx.augmented_message.clone();
        let reply_clone = reply.clone();
        let sid_clone = sid.clone();
        tokio::spawn(async move {
            react_agent::extract_memories_from_conversation(
                &config_clone,
                &msg_clone,
                &reply_clone,
                Some(&sid_clone),
            )
            .await;
        });
    }

    // Set session title from user's first message
    if ctx.is_first_message {
        let title = extract_title_from_message(&message);
        state.db.rename_session(&sid, &title).ok();
    }

    Ok(reply)
}

#[tauri::command]
pub async fn chat_stream_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    message: String,
    session_id: Option<String>,
    attachments: Option<Vec<Attachment>>,
    _auto_continue: Option<bool>,
    max_rounds: Option<usize>,
    token_budget: Option<u64>,
) -> Result<(), String> {
    let sid = resolve_session_id(&session_id);

    // Handle system commands
    if message.trim().starts_with('/') {
        if let Some(response) = handle_command(&state, &sid, &message).await {
            app.emit("chat://complete", serde_json::json!({
                "text": response,
                "session_id": sid,
            })).ok();
            return Ok(());
        }
    }

    let ctx = prepare_chat_context(&state, &sid, &message, &attachments).await?;

    // Auto-continue limits — the model decides via [CONTINUE] marker (see auto_continue skill)
    let max_r = max_rounds.unwrap_or(200);
    let budget = token_budget.unwrap_or(10_000_000);

    let db = state.db.clone();
    let cancelled = state.chat_cancelled.clone();

    // Reset cancellation flag for new stream
    cancelled.store(false, std::sync::atomic::Ordering::Relaxed);

    let streaming_state = state.streaming_state.clone();

    // Initialize the snapshot for this session
    {
        let mut ss = streaming_state.lock().unwrap();
        ss.insert(sid.clone(), StreamingSnapshot {
            is_active: true,
            accumulated_text: String::new(),
            tools: vec![],
            spawn_agents: vec![],
        });
    }

    let working_dir = state.working_dir.clone();
    let user_workspace = state.user_workspace();
    let app_handle = app.clone();
    let sid_clone = sid.clone();
    let continuation_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    tokio::spawn(async move {
        // Wrap entire agent run in with_session_id + with_cancelled + with_continuation_flag
        // so all tool calls see the session, cancellation, and continuation signals
        let sid_for_scope = sid_clone.clone();
        let cancelled_for_scope = cancelled.clone();
        let cont_flag = continuation_flag.clone();
        crate::engine::tools::with_continuation_flag(cont_flag, crate::engine::tools::with_cancelled(cancelled_for_scope, crate::engine::tools::with_session_id(sid_for_scope, async {

        let handle = app_handle.clone();
        let ss_for_event = streaming_state.clone();
        let sid_for_event = sid_clone.clone();
        let thinking_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let thinking_buf_for_event = thinking_buf.clone();
        let tool_call_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let tool_error_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let tool_count_for_event = tool_call_count.clone();
        let tool_error_for_event = tool_error_count.clone();
        let on_event = move |evt: react_agent::AgentStreamEvent| {
            match &evt {
                react_agent::AgentStreamEvent::Token(text) => {
                    handle.emit("chat://chunk", serde_json::json!({
                        "text": text,
                        "session_id": sid_for_event,
                    })).ok();
                    if let Ok(mut ss) = ss_for_event.lock() {
                        if let Some(snap) = ss.get_mut(&sid_for_event) {
                            snap.accumulated_text.push_str(text);
                        }
                    }
                }
                react_agent::AgentStreamEvent::Thinking(text) => {
                    handle.emit("chat://thinking", serde_json::json!({
                        "text": text,
                        "session_id": sid_for_event,
                    })).ok();
                    if let Ok(mut buf) = thinking_buf_for_event.lock() {
                        buf.push_str(text);
                    }
                }
                react_agent::AgentStreamEvent::ToolStart { name, args_preview } => {
                    handle
                        .emit(
                            "chat://tool_status",
                            serde_json::json!({
                                "type": "start",
                                "name": name,
                                "preview": args_preview,
                                "session_id": sid_for_event,
                            }),
                        )
                        .ok();
                    if let Ok(mut ss) = ss_for_event.lock() {
                        if let Some(snap) = ss.get_mut(&sid_for_event) {
                            snap.tools.push(ToolSnapshot {
                                name: name.clone(),
                                status: "running".into(),
                                preview: Some(args_preview.clone()),
                            });
                        }
                    }
                }
                react_agent::AgentStreamEvent::ToolEnd { name, result_preview } => {
                    tool_count_for_event.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if result_preview.starts_with("Error:")
                        || result_preview.starts_with("error:")
                        || result_preview.starts_with("Failed")
                        || result_preview.starts_with("failed") {
                        tool_error_for_event.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    handle
                        .emit(
                            "chat://tool_status",
                            serde_json::json!({
                                "type": "end",
                                "name": name,
                                "preview": result_preview,
                                "session_id": sid_for_event,
                            }),
                        )
                        .ok();
                    if let Ok(mut ss) = ss_for_event.lock() {
                        if let Some(snap) = ss.get_mut(&sid_for_event) {
                            for t in snap.tools.iter_mut().rev() {
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
                react_agent::AgentStreamEvent::Complete
                | react_agent::AgentStreamEvent::Error => {}
            }
        };

        {
            // ── Auto-continue loop (always active, model decides via [CONTINUE]) ──
            let mut round: usize = 0;
            let mut total_tokens: u64 = 0;
            let mut last_reply: String;
            let task_started_at = chrono::Utc::now().timestamp();

            // Check if this session belongs to a task (for progress persistence)
            let task_for_progress: Option<(String, std::path::PathBuf)> = {
                let tasks = db.list_tasks(None, Some("running")).unwrap_or_default();
                tasks.into_iter()
                    .find(|t| t.session_id == sid_clone)
                    .map(|t| {
                        let progress_dir = working_dir.join("tasks").join(&t.id);
                        std::fs::create_dir_all(&progress_dir).ok();
                        (t.id.clone(), progress_dir)
                    })
            };

            loop {
                round += 1;

                // Reset continuation flag for this round
                crate::engine::tools::reset_continuation_flag();

                // Only emit round_start from round 2 onward — round 1 is silent
                // so simple Q&A doesn't flash the long task progress panel
                if round >= 2 {
                    app_handle.emit("chat://auto_continue", serde_json::json!({
                        "type": "round_start",
                        "round": round,
                        "max_rounds": max_r,
                        "total_tokens": total_tokens,
                        "token_budget": budget,
                        "session_id": sid_clone,
                    })).ok();
                }

                // Build message and history for this round
                let (round_message, history) = if round == 1 {
                    (ctx.agent_message.clone(), ctx.llm_history.clone())
                } else {
                    // Push a "continue" user message into DB
                    let continue_msg = "请继续执行任务。".to_string();
                    db.push_message(&sid_clone, "user", &continue_msg).ok();

                    // Reload full conversation history from DB
                    let raw_msgs = db.get_recent_messages(&sid_clone, 50).unwrap_or_default();
                    // Exclude the last message (the continue_msg we just pushed) since
                    // run_react_with_options_stream will include user_message as current turn
                    let hist = if raw_msgs.len() > 1 {
                        db_messages_to_llm(&working_dir, &user_workspace, &raw_msgs[..raw_msgs.len() - 1])
                    } else {
                        vec![]
                    };
                    (continue_msg, hist)
                };

                let persist_fn = Some(make_persist_fn(db.clone(), sid_clone.clone()));

                match react_agent::run_react_with_options_stream(
                    &ctx.config,
                    &ctx.system_prompt,
                    &round_message,
                    &ctx.extra_tools,
                    &history,
                    ctx.max_iter,
                    Some(&ctx.working_dir),
                    on_event.clone(),
                    Some(&cancelled),
                    persist_fn,
                )
                .await
                {
                    Ok(reply) => {
                        if !reply.is_empty() && reply != "(no response)" {
                            let thinking_text = thinking_buf.lock().ok()
                                .map(|mut b| std::mem::take(&mut *b))
                                .unwrap_or_default();
                            if thinking_text.is_empty() {
                                db.push_message(&sid_clone, "assistant", &reply).ok();
                            } else {
                                let meta = serde_json::json!({ "thinking": thinking_text }).to_string();
                                db.push_message_with_metadata(&sid_clone, "assistant", &reply, Some(&meta)).ok();
                            }
                        } else {
                            // Clear thinking buffer even if no reply
                            if let Ok(mut b) = thinking_buf.lock() { b.clear(); }
                        }

                        if round == 1 && ctx.is_first_message {
                            let title = extract_title_from_message(&ctx.augmented_message);
                            db.rename_session(&sid_clone, &title).ok();
                        }

                        total_tokens += estimate_tokens_simple(&reply);
                        last_reply = reply;

                        // Check if the model called request_continuation tool during this round
                        let should_continue = crate::engine::tools::is_continuation_requested();

                        let should_stop = !should_continue
                            || round >= max_r
                            || total_tokens >= budget
                            || cancelled.load(std::sync::atomic::Ordering::Relaxed);

                        if should_stop {
                            let stop_reason = if !should_continue { "task_complete" }
                                else if round >= max_r { "max_rounds" }
                                else if total_tokens >= budget { "token_budget" }
                                else { "cancelled" };

                            // Write final progress.json for task completion
                            if let Some((ref tid, ref progress_dir)) = task_for_progress {
                                let progress = serde_json::json!({
                                    "task_id": tid,
                                    "session_id": sid_clone,
                                    "status": stop_reason,
                                    "current_round": round,
                                    "total_tokens": total_tokens,
                                    "last_output_preview": last_reply.chars().take(200).collect::<String>(),
                                    "updated_at": chrono::Utc::now().timestamp(),
                                });
                                crate::engine::tools::write_progress_json(progress_dir, &progress);
                            }

                            // Only emit finished if we ever emitted round_start (round >= 2)
                            if round >= 2 {
                                app_handle.emit("chat://auto_continue", serde_json::json!({
                                    "type": "finished",
                                    "round": round,
                                    "total_tokens": total_tokens,
                                    "stop_reason": stop_reason,
                                    "session_id": sid_clone,
                                })).ok();
                            }

                            app_handle.emit("chat://complete", serde_json::json!({
                                "text": last_reply,
                                "session_id": sid_clone,
                            })).ok();

                            let preview: String = last_reply.chars().take(100).collect();
                            crate::engine::scheduler::send_notification_with_context(
                                "YiYi",
                                &preview,
                                serde_json::json!({
                                    "page": "chat",
                                    "session_id": sid_clone,
                                }),
                            );

                            // Auto-extract memories in background
                            {
                                let config_bg = ctx.config.clone();
                                let msg_bg = ctx.augmented_message.clone();
                                let reply_bg = last_reply.clone();
                                let sid_bg = sid_clone.clone();
                                tokio::spawn(async move {
                                    react_agent::extract_memories_from_conversation(
                                        &config_bg,
                                        &msg_bg,
                                        &reply_bg,
                                        Some(&sid_bg),
                                    )
                                    .await;
                                });
                            }

                            // Growth System: detect implicit negative feedback in user message
                            // Safety: only trigger on short messages that START with correction keywords
                            // to avoid false positives like "不要忘记加测试" or "what's wrong with this code?"
                            {
                                let msg = ctx.augmented_message.trim();
                                let msg_lower = msg.to_lowercase();
                                let is_short = msg.chars().count() < 50;

                                // Must start with a correction keyword (not just contain it)
                                let starts_with_correction = [
                                    "不对", "不是这样", "重来", "错了",
                                    "wrong", "no,", "no ", "redo",
                                    "别这样", "我说的不是", "你理解错了",
                                ].iter().any(|p| msg_lower.starts_with(p));

                                // Or short message containing correction words
                                let short_contains_correction = is_short && [
                                    "重新做", "重做", "换一个", "不要这样",
                                ].iter().any(|p| msg_lower.contains(p));

                                let is_correction = starts_with_correction || short_contains_correction;

                                if is_correction && !last_reply.is_empty() {
                                    let config_fb = ctx.config.clone();
                                    let feedback = ctx.augmented_message.clone();
                                    let prev_request: String = ctx.llm_history.iter()
                                        .rev()
                                        .find(|m| m.role == "user")
                                        .and_then(|m| m.content.as_ref())
                                        .map(|c| c.clone().into_text())
                                        .unwrap_or_default();
                                    // Use the PREVIOUS assistant reply from history (the bad reply
                                    // the user is correcting), not last_reply which is the response
                                    // to the current correction message.
                                    let prev_reply: String = ctx.llm_history.iter()
                                        .rev()
                                        .filter(|m| m.role == "assistant")
                                        .next()
                                        .and_then(|m| m.content.as_ref())
                                        .map(|c| c.clone().into_text())
                                        .unwrap_or_default();
                                    let prev_request_for_reflect = prev_request.clone();
                                    let prev_reply_for_reflect = prev_reply.clone();
                                    let config_fb_reflect = config_fb.clone();
                                    let sid_fb_reflect = sid_clone.clone();
                                    tokio::spawn(async move {
                                        react_agent::learn_from_feedback(
                                            &config_fb,
                                            &feedback,
                                            &prev_request,
                                            &prev_reply,
                                        ).await;
                                    });

                                    // Also reflect on the previous exchange as a failure
                                    if !prev_request_for_reflect.is_empty() {
                                        log::info!("User correction detected, reflecting on previous exchange as failure");
                                        tokio::spawn(async move {
                                            react_agent::reflect_on_task(
                                                &config_fb_reflect,
                                                None,
                                                Some(&sid_fb_reflect),
                                                &prev_request_for_reflect,
                                                &prev_reply_for_reflect,
                                                false,
                                                SignalType::ExplicitCorrection,
                                            ).await;
                                        });
                                    }
                                }

                                // --- Positive feedback detection ---
                                // Detect explicit praise to reinforce correct behaviors
                                // "好的" means "OK" (acknowledgment), not praise — excluded
                                let praise_keywords_zh = ["很好", "太好了", "完美", "就是这样", "对的", "正是我要的", "没错"];
                                let praise_keywords_en = ["perfect", "great", "exactly", "well done", "good job", "nice work"];

                                let is_short_msg = msg.chars().count() < 15;

                                let starts_with_praise = praise_keywords_zh.iter().any(|p| msg.starts_with(p))
                                    || praise_keywords_en.iter().any(|p| msg_lower.starts_with(p));

                                // Exclude false positives where a praise word is part of a longer non-praise phrase
                                let false_positive_prefixes = ["很好奇", "很好的", "好的", "对的话", "就是这样的"];
                                let is_false_positive = false_positive_prefixes.iter().any(|fp| msg.starts_with(fp));

                                // Filter out messages with continuation ("好的，接下来...")
                                let has_continuation = msg_lower.contains("但是") || msg_lower.contains("不过")
                                    || msg_lower.contains("but ") || msg_lower.contains("however")
                                    || msg_lower.contains("接下来") || msg_lower.contains("然后")
                                    || msg_lower.contains("帮我") || msg_lower.contains("再");

                                let is_praise = is_short_msg && starts_with_praise && !has_continuation && !is_false_positive;

                                if is_praise && !is_correction {
                                    // Reflect on the PREVIOUS exchange as a confirmed success
                                    let prev_request: String = ctx.llm_history.iter()
                                        .rev()
                                        .find(|m| m.role == "user")
                                        .and_then(|m| m.content.as_ref())
                                        .map(|c| c.clone().into_text())
                                        .unwrap_or_default();

                                    if !prev_request.is_empty() {
                                        let config_praise = ctx.config.clone();
                                        let prev_req = prev_request.clone();
                                        let prev_resp = last_reply.clone();
                                        let sid_praise = sid_clone.clone();
                                        tokio::spawn(async move {
                                            react_agent::reflect_on_task(
                                                &config_praise,
                                                None,
                                                Some(&sid_praise),
                                                &prev_req,
                                                &prev_resp,
                                                true,
                                                SignalType::ExplicitPraise,
                                            ).await;
                                        });
                                        log::debug!("Praise detected, reinforcing previous exchange");
                                    }
                                }
                            }

                            // Growth System: reflect on chat if tools were used (real work done)
                            if tool_call_count.load(std::sync::atomic::Ordering::Relaxed) > 0 {
                                let config_ref = ctx.config.clone();
                                let user_msg = ctx.augmented_message.clone();
                                let reply_ref = last_reply.clone();
                                let sid_ref = sid_clone.clone();

                                // Determine success: no tool errors and didn't hit max iterations/rounds
                                let had_tool_errors = tool_error_count.load(std::sync::atomic::Ordering::Relaxed) > 0;
                                let hit_max_iterations = stop_reason == "max_rounds";
                                let was_successful = !had_tool_errors && !hit_max_iterations;

                                let signal_type = if had_tool_errors {
                                    SignalType::ToolError
                                } else if hit_max_iterations {
                                    SignalType::MaxIterations
                                } else {
                                    SignalType::SilentCompletion
                                };

                                log::debug!(
                                    "Reflection: was_successful={}, tool_errors={}, stop_reason={}, signal={:?}",
                                    was_successful,
                                    tool_error_count.load(std::sync::atomic::Ordering::Relaxed),
                                    stop_reason,
                                    signal_type,
                                );

                                tokio::spawn(async move {
                                    react_agent::reflect_on_task(
                                        &config_ref,
                                        None,
                                        Some(&sid_ref),
                                        &user_msg,
                                        &reply_ref,
                                        was_successful,
                                        signal_type,
                                    ).await;
                                });
                            }

                            break;
                        }

                        // Emit round_complete, prepare for next round
                        app_handle.emit("chat://auto_continue", serde_json::json!({
                            "type": "round_complete",
                            "round": round,
                            "total_tokens": total_tokens,
                            "session_id": sid_clone,
                        })).ok();

                        // Write progress.json for crash recovery
                        if let Some((ref tid, ref progress_dir)) = task_for_progress {
                            let progress = serde_json::json!({
                                "task_id": tid,
                                "session_id": sid_clone,
                                "status": "running",
                                "current_round": round,
                                "total_tokens": total_tokens,
                                "last_output_preview": last_reply.chars().take(200).collect::<String>(),
                                "started_at": task_started_at,
                                "updated_at": chrono::Utc::now().timestamp(),
                            });
                            crate::engine::tools::write_progress_json(progress_dir, &progress);
                        }
                    }
                    Err(e) => {
                        if e == "cancelled" {
                            if round >= 2 {
                                app_handle.emit("chat://auto_continue", serde_json::json!({
                                    "type": "finished",
                                    "round": round,
                                    "total_tokens": total_tokens,
                                    "stop_reason": "cancelled",
                                    "session_id": sid_clone,
                                })).ok();
                            }
                            app_handle.emit("chat://complete", serde_json::json!({
                                "text": "",
                                "session_id": sid_clone,
                            })).ok();
                        } else {
                            app_handle.emit("chat://error", serde_json::json!({
                                "text": e,
                                "session_id": sid_clone,
                            })).ok();
                            let err_preview: String = e.chars().take(100).collect();
                            crate::engine::scheduler::send_notification_with_context(
                                "YiYi",
                                &format!("Agent error: {}", err_preview),
                                serde_json::json!({
                                    "page": "chat",
                                    "session_id": sid_clone,
                                }),
                            );

                            // Reflect on agent error as a failure (e.g. max iterations hit)
                            if tool_call_count.load(std::sync::atomic::Ordering::Relaxed) > 0 {
                                let config_err = ctx.config.clone();
                                let user_msg_err = ctx.augmented_message.clone();
                                let err_msg = e.clone();
                                let sid_err = sid_clone.clone();
                                log::debug!("Agent error, reflecting as failure: {}", &err_msg);
                                tokio::spawn(async move {
                                    react_agent::reflect_on_task(
                                        &config_err,
                                        None,
                                        Some(&sid_err),
                                        &user_msg_err,
                                        &err_msg,
                                        false,
                                        SignalType::AgentError,
                                    ).await;
                                });
                            }
                        }
                        break;
                    }
                }
            } // end auto-continue loop
        }

        // Mark snapshot as inactive, then schedule cleanup after 30s for recovery window
        if let Ok(mut ss) = streaming_state.lock() {
            if let Some(snap) = ss.get_mut(&sid_clone) {
                snap.is_active = false;
            }
        }
        {
            let ss_cleanup = streaming_state.clone();
            let sid_cleanup = sid_clone.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                if let Ok(mut ss) = ss_cleanup.lock() {
                    if let Some(snap) = ss.get(&sid_cleanup) {
                        if !snap.is_active {
                            ss.remove(&sid_cleanup);
                        }
                    }
                }
            });
        }
        }))).await; // end with_session_id + with_cancelled + with_continuation_flag
    });

    Ok(())
}

#[tauri::command]
pub async fn get_history(
    state: State<'_, AppState>,
    session_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ChatMessage>, String> {
    let sid = resolve_session_id(&session_id);
    let messages = state.db.get_messages(&sid, limit)?;
    let internal_dir = &state.working_dir;
    let workspace_dir = &state.user_workspace();
    Ok(messages
        .into_iter()
        .map(|m| {
            let meta: Option<serde_json::Value> = m.metadata.as_ref()
                .and_then(|s| serde_json::from_str(s).ok());

            let attachments = meta.as_ref().and_then(|mv| {
                let refs: Vec<AttachmentRef> =
                    serde_json::from_value(mv["attachments"].clone()).ok()?;
                let atts: Vec<Attachment> = refs
                    .iter()
                    .filter_map(|r| {
                        if is_image_mime(&r.mime_type) {
                            let b64 = read_attachment_as_base64(internal_dir, workspace_dir, &r.path)?;
                            Some(Attachment {
                                mime_type: r.mime_type.clone(),
                                data: b64,
                                name: r.name.clone(),
                            })
                        } else {
                            Some(Attachment {
                                mime_type: r.mime_type.clone(),
                                data: String::new(),
                                name: r.name.clone(),
                            })
                        }
                    })
                    .collect();
                if atts.is_empty() { None } else { Some(atts) }
            });

            let source = meta.as_ref().and_then(|mv| {
                if mv["via"].as_str() == Some("bot") {
                    Some(MessageSource {
                        via: Some("bot".into()),
                        platform: mv["platform"].as_str().map(|s| s.into()),
                        bot_id: mv["bot_id"].as_str().map(|s| s.into()),
                        sender_id: mv["sender_id"].as_str().map(|s| s.into()),
                        sender_name: mv["sender_name"].as_str().map(|s| s.into()),
                    })
                } else {
                    None
                }
            });

            // Extract tool_calls for assistant messages with tool invocations
            let tool_calls_info = if m.role == "assistant" {
                meta.as_ref().and_then(|mv| {
                    let arr = mv["tool_calls"].as_array()?;
                    let infos: Vec<ToolCallInfo> = arr.iter().filter_map(|tc| {
                        Some(ToolCallInfo {
                            id: tc["id"].as_str()?.to_string(),
                            name: tc["name"].as_str()?.to_string(),
                            arguments: tc["arguments"].as_str().unwrap_or("{}").to_string(),
                        })
                    }).collect();
                    if infos.is_empty() { None } else { Some(infos) }
                })
            } else {
                None
            };

            // Extract tool info for tool result messages
            let (tool_call_id, tool_name) = if m.role == "tool" {
                let tcid = meta.as_ref().and_then(|mv| mv["tool_call_id"].as_str().map(|s| s.to_string()));
                let tname = meta.as_ref().and_then(|mv| mv["tool_name"].as_str().map(|s| s.to_string()));
                (tcid, tname)
            } else {
                (None, None)
            };

            // Extract spawn_agents for team task results
            let spawn_agents = meta.as_ref().and_then(|mv| {
                let arr = mv["spawn_agents"].as_array()?;
                let agents: Vec<SpawnAgentResult> = arr.iter().filter_map(|a| {
                    Some(SpawnAgentResult {
                        name: a["name"].as_str()?.to_string(),
                        result: a["result"].as_str().unwrap_or("").to_string(),
                        is_error: a["is_error"].as_bool().unwrap_or(false),
                    })
                }).collect();
                if agents.is_empty() { None } else { Some(agents) }
            });

            // Extract thinking/reasoning content
            let thinking = meta.as_ref().and_then(|mv| {
                mv["thinking"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string())
            });

            ChatMessage {
                id: Some(m.id),
                role: m.role,
                content: m.content,
                timestamp: Some(m.timestamp as u64),
                attachments,
                source,
                tool_calls: tool_calls_info,
                tool_call_id,
                tool_name,
                spawn_agents,
                thinking,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn chat_stream_stop(
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.chat_cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn chat_stream_state(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<StreamingSnapshot>, String> {
    let ss = state.streaming_state.lock().map_err(|e| e.to_string())?;
    Ok(ss.get(&session_id).cloned())
}

#[tauri::command]
pub async fn clear_history(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<(), String> {
    let sid = resolve_session_id(&session_id);
    // Insert a context_reset marker instead of deleting messages.
    // get_recent_messages will stop at this boundary, effectively
    // resetting the LLM context while preserving chat history.
    state.db.push_message(&sid, "context_reset", "")?;
    Ok(())
}

#[tauri::command]
pub async fn delete_message(
    state: State<'_, AppState>,
    message_id: i64,
) -> Result<(), String> {
    state.db.delete_message(message_id)
}

// Agent CRUD commands removed — switched to dynamic agent spawning.
