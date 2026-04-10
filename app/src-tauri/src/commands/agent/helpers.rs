use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::engine::db;
use crate::engine::llm_client::{LLMConfig, LLMMessage, MessageContent};
use crate::engine::react_agent;
use crate::engine::react_agent::PersistToolFn;
use crate::engine::react_agent::ToolPersistEvent;
use crate::engine::tools::mcp_tools_as_definitions;
use crate::engine::tools::ToolDefinition;
use crate::state::AppState;

use super::{Attachment, SkillIndexEntry};

/// Resolve LLM config from app state
pub async fn resolve_llm_config(state: &AppState) -> Result<LLMConfig, String> {
    let providers = state.providers.read().await;
    crate::engine::llm_client::resolve_config_from_providers(&providers)
}

/// Load skill index (name + description) and always-active skill contents.
///
/// Returns:
/// - `index`: compact list for the system prompt (model uses `activate_skills` tool to load full content)
/// - `always_active`: full content of skills marked `always_active: true` (injected directly)
///
/// System skills (if any) are always loaded from embedded resources,
/// regardless of whether they exist in active_skills/.
pub(super) async fn load_skill_index(state: &AppState) -> (Vec<SkillIndexEntry>, Vec<String>) {
    let skills_dir = state.working_dir.join("active_skills");
    let mut index = Vec::new();
    let mut always_active = Vec::new();
    let mut loaded_names = std::collections::HashSet::new();

    // 1. Always load system skills from embedded resources (guaranteed to work)
    for name in crate::commands::skills::SYSTEM_SKILL_NAMES {
        if let Some(content) = crate::commands::skills::get_embedded_skill_content(name) {
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
pub(super) fn make_persist_fn(db: Arc<db::Database>, session_id: String) -> PersistToolFn {
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
pub(super) fn db_messages_to_llm(internal_dir: &Path, workspace_dir: &Path, messages: &[db::ChatMessage]) -> Vec<LLMMessage> {
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

pub(super) const DEFAULT_SESSION: &str = "default";

/// Extract a short session title from the user's first message.
/// Takes the first line (or first 30 chars) as title, no LLM call needed.
pub(super) fn extract_title_from_message(message: &str) -> String {
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

pub(super) fn resolve_session_id(session_id: &Option<String>) -> String {
    session_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SESSION)
        .to_string()
}

/// Recall relevant memories via MemMe vector search and inject them as context.
pub(super) fn recall_memories(_db: &db::Database, user_message: &str) -> Option<String> {
    if user_message.trim().len() < 4 {
        return None;
    }

    let store = crate::engine::tools::get_memme_store()?;
    let options = memme_core::SearchOptions::new(crate::engine::tools::MEMME_USER_ID)
        .limit(5)
        .keyword_search(true);
    let results = store.search(user_message, options).ok()?;
    if results.is_empty() {
        return None;
    }
    let mut context = String::from("[Recalled memories]\n");
    for mem in &results {
        let cats = mem.categories.as_ref()
            .map(|c| c.join(", "))
            .unwrap_or_else(|| "note".into());
        context.push_str(&format!("- [{}] {}\n", cats, mem.content));
    }
    context.push_str("[/Recalled memories]\n");
    Some(context)
}

/// Simple token count estimation.
/// English text averages ~4 chars/token, Chinese ~2 chars/token.
/// Uses a rough 3/4 multiplier as a middle ground.
pub(super) fn estimate_tokens_simple(text: &str) -> u64 {
    let chars = text.chars().count() as u64;
    (chars * 3) / 4
}

/// All pre-processed data needed before invoking the ReAct agent.
pub(super) struct ChatContext {
    pub config: LLMConfig,
    pub system_prompt: String,
    pub agent_message: String,
    pub augmented_message: String,
    pub extra_tools: Vec<ToolDefinition>,
    pub llm_history: Vec<LLMMessage>,
    pub max_iter: Option<usize>,
    pub working_dir: PathBuf,
    pub is_first_message: bool,
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
pub(super) async fn prepare_chat_context(
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
pub(super) async fn handle_command(
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

// --- Attachment helpers ---

/// Saved attachment reference stored in metadata (file path instead of base64).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct AttachmentRef {
    pub mime_type: String,
    pub path: String, // relative path under working_dir
    #[serde(default)]
    pub name: Option<String>,
}

pub(super) fn is_image_mime(mime: &str) -> bool {
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
pub(super) struct SaveResult {
    pub metadata_json: Option<String>,
    pub file_hints: Vec<String>, // e.g. "[用户上传了文件: report.pdf，路径: /abs/path]"
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
pub(super) fn read_attachment_as_base64(internal_dir: &Path, workspace_dir: &Path, rel_path: &str) -> Option<String> {
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
