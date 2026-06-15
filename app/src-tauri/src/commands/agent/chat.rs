use tauri::{Emitter, State};

use crate::engine::react_agent;
use crate::state::app_state::StreamingSnapshot;
use crate::state::AppState;

use super::helpers::{
    extract_title_from_message, handle_command,
    is_image_mime, make_persist_fn, prepare_chat_context, read_attachment_as_base64,
    resolve_session_id, AttachmentRef,
};
use super::{
    Attachment, ChatMessage, MessageSource, SpawnAgentResult, ToolCallInfo,
};

// --- MemMe pipeline helper (shared by streaming & non-streaming paths) ---

/// Track when we last manually compacted each session, to avoid thrashing.
/// Key: session_id, Value: unix timestamp seconds.
static LAST_MANUAL_COMPACT: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, i64>>> = std::sync::OnceLock::new();

fn last_manual_compact_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, i64>> {
    LAST_MANUAL_COMPACT.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// If the last LLM call used > 40% of typical 128k context, trigger a manual compact.
/// This "freezes" earlier messages into episodes so they become retrievable via semantic search
/// before they fall out of the 50-message window.
///
/// Has a 2-minute cooldown per session to avoid compact-thrashing when the conversation
/// stays near the threshold.
pub fn maybe_trigger_pressure_compact(session_id: &str, input_tokens: u64) {
    const CONTEXT_BASELINE: u64 = 128_000;
    const PRESSURE_RATIO: f64 = 0.4;
    const COOLDOWN_SECS: i64 = 120;

    let ratio = input_tokens as f64 / CONTEXT_BASELINE as f64;
    if ratio < PRESSURE_RATIO {
        return;
    }

    let now = chrono::Utc::now().timestamp();
    {
        let mut map = last_manual_compact_map().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(&last) = map.get(session_id) {
            if now - last < COOLDOWN_SECS {
                return; // Still in cooldown
            }
        }
        map.insert(session_id.to_string(), now);
    }

    let store = match crate::engine::tools::get_memme_store() {
        Some(s) => s,
        None => return,
    };
    let sid = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        match store.compact(&sid) {
            Ok(cr) => {
                log::info!(
                    "MemMe: pressure compact ({}k input tokens, ratio {:.0}%) -> episode {}",
                    input_tokens / 1000, ratio * 100.0, cr.episode_id
                );
                if let Some(handle) = crate::engine::tools::get_app_handle() {
                    use tauri::Emitter;
                    let _ = handle.emit("buddy://compact-completed", &cr.episode_id);
                }
            }
            Err(e) => log::warn!("MemMe pressure compact failed: {}", e),
        }
    });
}

/// Feed a user↔assistant turn into MemMe's Session pipeline in a background thread.
pub(crate) fn feed_to_memme(session_id: String, user_msg: String, assistant_msg: String) {
    let store = match crate::engine::tools::get_memme_store() {
        Some(s) => s,
        None => return,
    };
    tokio::task::spawn_blocking(move || {
        let messages = vec![
            memme_core::types::ChatMessage {
                role: "user".into(),
                content: user_msg,
                image_url: None,
                image_type: None,
                timestamp: None,
            },
            memme_core::types::ChatMessage {
                role: "assistant".into(),
                content: assistant_msg,
                image_url: None,
                image_type: None,
                timestamp: None,
            },
        ];
        match store.append_events(&session_id, &messages, crate::engine::tools::MEMME_USER_ID, None) {
            Ok(result) => {
                log::debug!(
                    "MemMe: appended {} events to session {} ({} unprocessed)",
                    result.events_appended, result.session_id, result.total_unprocessed,
                );
                if result.compact_needed {
                    match store.compact(&result.session_id) {
                        Ok(cr) => {
                            log::debug!("MemMe: compacted session {} -> episode {}", cr.session_id, cr.episode_id);
                            if let Some(handle) = crate::engine::tools::get_app_handle() {
                                use tauri::Emitter;
                                let _ = handle.emit("buddy://compact-completed", &cr.episode_id);
                            }
                        }
                        Err(e) => log::warn!("MemMe compact failed: {}", e),
                    }
                }
            }
            Err(e) => log::warn!("MemMe append_events failed: {}", e),
        }
    });
}

// --- Chat commands ---

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
            &ctx.llm_history,
            ctx.max_iter,
            Some(&ctx.working_dir),
            persist_fn,
        ),
    )
    .await?;

    // Save assistant reply (final text-only response), strip internal markers
    let clean_reply = crate::engine::tools::strip_stage_markers(&reply);
    if !clean_reply.is_empty() && clean_reply != "(no response)" {
        state.db.push_message(&sid, "assistant", &clean_reply)?;
    }

    // Feed conversation into MemMe Session pipeline
    feed_to_memme(sid.clone(), ctx.augmented_message.clone(), reply.clone());

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
    // 群里 @ 点名的成员 id —— 非空走"点名必答"(强制这些成员上场)。
    mentioned_companion_ids: Option<Vec<i64>>,
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

    // Detect buddy delegation triggers in user message
    {
        let msg_lower = message.to_lowercase();
        let buddy_name = state.config.read().await.buddy.name.to_lowercase();

        // Disable triggers (check first — higher priority)
        let is_disable = msg_lower.contains("我来决定")
            || msg_lower.contains("取消托管")
            || msg_lower.contains("不用你管")
            || msg_lower.contains("我自己来");

        if is_disable {
            crate::engine::buddy_delegate::disable_session_hosted(&sid);
            log::info!("Buddy hosted mode deactivated by user message");
        } else {
            let is_enable = msg_lower.contains(&format!("@{}", buddy_name))
                || msg_lower.contains("@小精灵")
                || msg_lower.contains("@buddy")
                || msg_lower.contains("你来帮我做决定")
                || msg_lower.contains("你来决定")
                || msg_lower.contains("交给你了")
                || msg_lower.contains("托管模式");
            if is_enable {
                crate::engine::buddy_delegate::enable_session_hosted(&sid);
                log::info!("Buddy hosted mode activated by user message");
            }
        }
    }

    let ctx = prepare_chat_context(&state, &sid, &message, &attachments).await?;

    // work 会话(source='work'):后续消息**不进放养群聊**(放养是无上限事件循环,全员会
    // 几十轮空转烧 token —— 见用户反馈 2026-06-09)。chat×work 决策 B:work 永远结构化 ——
    // 交给牵头者单 agent 有界接手(intake:澄清,需要时 propose_work_plan 再派工)。
    // R3:停止意图 → 中止 job;上一轮 intake 没回完 → 互斥拒绝 —— 都以可见提示收束本轮。
    if state.db.get_session(&sid).ok().flatten().map(|s| s.source).as_deref() == Some("work") {
        use crate::commands::work::WorkFollowup;
        let forced = mentioned_companion_ids.clone().unwrap_or_default();
        match crate::commands::work::dispatch_work_followup(&state, &sid, &message, &forced).await {
            Ok(WorkFollowup::Intake(collab_id)) => {
                app.emit("chat://complete", serde_json::json!({
                    "text": "",
                    "session_id": sid,
                    "collaboration_id": collab_id,
                })).ok();
                return Ok(());
            }
            Ok(WorkFollowup::Notice(text)) => {
                app.emit("chat://complete", serde_json::json!({
                    "text": text,
                    "session_id": sid,
                })).ok();
                return Ok(());
            }
            Err(e) => {
                // 不回落放养(避免又烧 token)——给一条可见提示并结束本轮。
                log::warn!("work followup dispatch 失败:{e}");
                let hint = format!("这个工作群暂时没法接手:{e}");
                let _ = state.db.push_message(&sid, "assistant", &hint);
                app.emit("chat://complete", serde_json::json!({
                    "text": hint,
                    "session_id": sid,
                })).ok();
                return Ok(());
            }
        }
    }

    // 单聊好友(私聊):session 绑定了单个 companion → 这一轮直接派遣给它(必答、流式,
    // private scope)。失败回落主精灵自答。
    // 2026-06-15:chat **多分身群聊/家族已退役**(与 work 多 agent 重叠、易造成产品混乱)——
    // chat 侧只剩 YiYi 单聊 + 1:1 分身私聊。work 团队(source='work')走更上面的
    // dispatch_work_followup,不经此路,不受影响。
    if let Some(cid) = state.db.get_session_companion(&sid) {
        // 好友私聊:session 绑定了单个 companion → 这一轮直接派遣给它(它必答、流式,
        // private scope)。失败则回落主精灵自答。
        use crate::commands::agent::group_dispatch::dispatch_to_companion;
        match dispatch_to_companion(state.db.clone(), ctx.config.clone(), &sid, &message, cid).await {
            Ok(collab_id) => {
                log::info!("private chat → companion {cid} collab {collab_id}");
                app.emit("chat://complete", serde_json::json!({
                    "text": "",
                    "session_id": sid,
                    "collaboration_id": collab_id,
                })).ok();
                return Ok(());
            }
            Err(e) => {
                log::warn!("private companion dispatch 失败,回落主精灵自答:{e}");
            }
        }
    }

    // Task routing — log the route decision for observability
    let route = crate::engine::buddy_delegate::route_task(&message);
    if route != crate::engine::buddy_delegate::TaskRoute::Direct {
        let route_label = match route {
            crate::engine::buddy_delegate::TaskRoute::BackgroundTask => "background_task",
            crate::engine::buddy_delegate::TaskRoute::DelegateCoding => "delegate_coding",
            _ => "direct",
        };
        log::info!("Task route: {} for message: {}", route_label, message.chars().take(80).collect::<String>());
        app.emit("buddy://route_suggestion", serde_json::json!({
            "route": route_label,
            "session_id": sid,
        })).ok();
    }

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
    // Build the run config + event sink, then hand off to the unified runner.
    // The auto-continue loop + verify/growth/feed_memme/progress all live in
    // `agent_runner::run::run_with_shell` now; this command just assembles inputs.
    let sink: std::sync::Arc<dyn crate::engine::agent_runner::AgentEventSink> =
        std::sync::Arc::new(crate::engine::agent_runner::chat_sink::ChatEventSink::new(
            app_handle,
            streaming_state.clone(),
            sid_clone.clone(),
            ctx.config.model.clone(),
        ));

    let run_config = crate::engine::agent_runner::config::AgentRunConfig {
        llm: ctx.config,
        system_prompt: ctx.system_prompt,
        agent_message: ctx.agent_message,
        augmented_message: ctx.augmented_message,
        llm_history: ctx.llm_history,
        max_iter: ctx.max_iter,
        is_first_message: ctx.is_first_message,
        session_id: sid_clone,
        working_dir: Some(working_dir.clone()),
        shell: crate::engine::agent_runner::config::ShellOptions::primary(max_r, budget),
    };
    let persist = Some(crate::engine::agent_runner::config::ChatPersistence {
        db,
        internal_dir: working_dir,
        user_workspace,
    });

    tokio::spawn(async move {
        let _ = crate::engine::agent_runner::run::run_agent(run_config, persist, sink, cancelled)
            .await;
    });

    Ok(())
}

pub async fn get_history_impl(
    state: &AppState,
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
                        bot_name: mv["bot_name"].as_str().map(|s| s.into()),
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
                        full_output: a["full_output"].as_str().map(|s| s.to_string()),
                        error: a["error"].as_str().map(|s| s.to_string()),
                        status: a["status"].as_str().map(|s| s.to_string()),
                        duration_ms: a["duration_ms"].as_u64(),
                    })
                }).collect();
                if agents.is_empty() { None } else { Some(agents) }
            });

            // Extract thinking/reasoning content
            let thinking = meta.as_ref().and_then(|mv| {
                mv["thinking"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string())
            });

            // Extract tool-produced visual artifacts (screenshots, generated
            // images). Only meaningful on `tool` role messages.
            let tool_artifacts = if m.role == "tool" {
                meta.as_ref().and_then(|mv| {
                    let arts: Vec<crate::engine::react_agent::ToolArtifact> =
                        serde_json::from_value(mv["tool_artifacts"].clone()).ok()?;
                    if arts.is_empty() { None } else { Some(arts) }
                })
            } else {
                None
            };

            // Verdict rows are stored as role='assistant' so the LLM
            // reads them naturally on the next turn; the frontend gets
            // role='collaboration' so it renders the inline
            // CollaborationMessageCard instead of a plain bubble.
            // Same trick for companion drafts: stored as 'assistant'
            // (LLM sees the intro line, tool result already informed it),
            // returned as 'companion_draft' so the frontend renders the
            // adopt-or-edit card.
            // Frontend expects the full envelope shape:
            //   { companion_draft: <payload>, draft_state, adopted_companion_id }
            // — so reconstruct it from the raw metadata fields instead of
            // returning just the inner payload (which would crash the card
            // when it dereferences envelope.companion_draft.x).
            let companion_draft = meta.as_ref().and_then(|mv| {
                let payload = &mv["companion_draft"];
                if payload.is_null() {
                    return None;
                }
                Some(serde_json::json!({
                    "companion_draft": payload.clone(),
                    "draft_state": mv.get("draft_state").and_then(|v| v.as_str()).unwrap_or("pending"),
                    "adopted_companion_id": mv.get("adopted_companion_id").and_then(|v| v.as_i64()),
                }))
            });

            let (role_for_frontend, collaboration_id, companion_draft_out) = if m.role == "assistant"
                && companion_draft.is_some()
            {
                ("companion_draft".to_string(), None, companion_draft)
            } else if m.role == "assistant" && m.collaboration_id.is_some() {
                ("collaboration".to_string(), m.collaboration_id, None)
            } else {
                (m.role, None, None)
            };

            // R4:work_plan 锚点(propose_work_plan 落库的开工方案)→ 提取方案载荷,
            // 前端渲染**持久化**的开工方案卡(不再依赖易失的一次性事件单槽)。
            let work_plan = if m.context_type.as_deref() == Some("work_plan") {
                meta.as_ref().map(|mv| {
                    serde_json::json!({
                        "request_id": mv.get("request_id").cloned().unwrap_or_default(),
                        "summary": mv.get("summary").cloned().unwrap_or_default(),
                        "plan": mv.get("plan").cloned().unwrap_or_default(),
                        // 已开工标记(commit_work_plan 写入):前端据此渲染 ✅ 已开工态。
                        "committed": mv.get("committed").cloned().unwrap_or(serde_json::Value::Bool(false)),
                    })
                })
            } else {
                None
            };

            ChatMessage {
                id: Some(m.id),
                role: role_for_frontend,
                content: m.content,
                context_type: m.context_type,
                work_plan,
                timestamp: Some(m.timestamp as u64),
                attachments,
                source,
                tool_calls: tool_calls_info,
                tool_call_id,
                tool_name,
                spawn_agents,
                thinking,
                tool_artifacts,
                collaboration_id,
                companion_draft: companion_draft_out,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn get_history(
    state: State<'_, AppState>,
    session_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ChatMessage>, String> {
    get_history_impl(&*state, session_id, limit).await
}

/// Read a tool-produced visual artifact off disk and return it as a `data:`
/// URI. Path is the relative reference stored in tool message metadata; only
/// paths under the internal data dir's `artifacts/` are accepted (no escapes).
#[tauri::command]
pub async fn read_artifact_data_uri(
    state: State<'_, AppState>,
    path: String,
    mime_type: String,
) -> Result<String, String> {
    if !path.starts_with("artifacts/") || path.contains("..") {
        return Err("Error: artifact_path_outside_scope".into());
    }
    let full = state.working_dir.join(&path);
    let bytes = tokio::fs::read(&full).await.map_err(|e| format!("read failed: {}", e))?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime_type, b64))
}

/// Tagged preview of a local file, sized for inline rendering in chat.
///
/// `Image` / `Video` / `Audio` carry a self-contained data URI so the webview
/// renders without an asset-protocol bridge. `Text` carries a UTF-8 head,
/// optionally truncated. `Unsupported` falls back to icon + label.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilePreview {
    Image { data_uri: String },
    Video { data_uri: String },
    Audio { data_uri: String },
    Text { content: String, truncated: bool },
    Unsupported,
}

/// Per-kind size caps. Larger files fall through to `Unsupported` so the
/// webview doesn't choke on a 200MB data URI round-trip.
const IMAGE_MAX_BYTES: u64 = 8 * 1024 * 1024;
const VIDEO_MAX_BYTES: u64 = 50 * 1024 * 1024;
const AUDIO_MAX_BYTES: u64 = 20 * 1024 * 1024;
const TEXT_MAX_BYTES: u64 = 64 * 1024;

#[tauri::command]
pub async fn read_file_preview(path: String) -> Result<FilePreview, String> {
    let p = std::path::Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let meta = tokio::fs::metadata(p).await.map_err(|e| format!("stat failed: {}", e))?;
    let len = meta.len();

    let (mime, cap) = match ext.as_str() {
        "png" => ("image/png", IMAGE_MAX_BYTES),
        "jpg" | "jpeg" => ("image/jpeg", IMAGE_MAX_BYTES),
        "gif" => ("image/gif", IMAGE_MAX_BYTES),
        "webp" => ("image/webp", IMAGE_MAX_BYTES),
        "svg" => ("image/svg+xml", IMAGE_MAX_BYTES),
        "bmp" => ("image/bmp", IMAGE_MAX_BYTES),
        "mp4" | "m4v" => ("video/mp4", VIDEO_MAX_BYTES),
        "webm" => ("video/webm", VIDEO_MAX_BYTES),
        "mov" => ("video/quicktime", VIDEO_MAX_BYTES),
        "mp3" => ("audio/mpeg", AUDIO_MAX_BYTES),
        "wav" => ("audio/wav", AUDIO_MAX_BYTES),
        "m4a" => ("audio/mp4", AUDIO_MAX_BYTES),
        "ogg" => ("audio/ogg", AUDIO_MAX_BYTES),
        "txt" | "md" | "markdown" | "json" | "log" | "csv" | "yaml" | "yml" | "toml"
        | "ini" | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "java" | "kt"
        | "swift" | "sh" | "bash" | "zsh" | "fish" | "html" | "css" | "scss" | "xml"
        | "sql" => {
            // Bounded read: log files / data dumps can be hundreds of MB. We
            // only ever show the first 64 KB, so don't slurp the whole file.
            use tokio::io::AsyncReadExt;
            let mut f = tokio::fs::File::open(p).await.map_err(|e| format!("open failed: {}", e))?;
            let mut buf = Vec::with_capacity(TEXT_MAX_BYTES as usize);
            (&mut f).take(TEXT_MAX_BYTES).read_to_end(&mut buf).await
                .map_err(|e| format!("read failed: {}", e))?;
            let truncated = len > TEXT_MAX_BYTES;
            let content = String::from_utf8_lossy(&buf).to_string();
            return Ok(FilePreview::Text { content, truncated });
        }
        _ => return Ok(FilePreview::Unsupported),
    };
    if len > cap {
        return Ok(FilePreview::Unsupported);
    }
    let bytes = tokio::fs::read(p).await.map_err(|e| format!("read failed: {}", e))?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let data_uri = format!("data:{};base64,{}", mime, b64);
    Ok(match ext.as_str() {
        "mp4" | "m4v" | "webm" | "mov" => FilePreview::Video { data_uri },
        "mp3" | "wav" | "m4a" | "ogg" => FilePreview::Audio { data_uri },
        _ => FilePreview::Image { data_uri },
    })
}

pub async fn chat_stream_stop_impl(state: &AppState) -> Result<(), String> {
    state.chat_cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn chat_stream_stop(
    state: State<'_, AppState>,
) -> Result<(), String> {
    chat_stream_stop_impl(&*state).await
}

pub async fn chat_stream_state_impl(
    state: &AppState,
    session_id: String,
) -> Result<Option<StreamingSnapshot>, String> {
    let ss = state.streaming_state.lock().map_err(|e| e.to_string())?;
    Ok(ss.get(&session_id).cloned())
}

#[tauri::command]
pub async fn chat_stream_state(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<StreamingSnapshot>, String> {
    chat_stream_state_impl(&*state, session_id).await
}

pub async fn clear_history_impl(
    state: &AppState,
    session_id: Option<String>,
) -> Result<(), String> {
    let sid = resolve_session_id(&session_id);
    // Insert a context_reset marker instead of deleting messages.
    // get_recent_messages will stop at this boundary, effectively
    // resetting the LLM context while preserving chat history.
    state.db.push_message(&sid, "context_reset", "")?;
    // Reset of LLM context also retires the frozen persona snapshot, so the
    // next turn picks up the user's latest AGENTS.md / SOUL.md edits.
    react_agent::invalidate_persona_snapshot(&sid);
    Ok(())
}

#[tauri::command]
pub async fn clear_history(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<(), String> {
    clear_history_impl(&*state, session_id).await
}

pub async fn delete_message_impl(state: &AppState, message_id: i64) -> Result<(), String> {
    state.db.delete_message(message_id)
}

#[tauri::command]
pub async fn delete_message(
    state: State<'_, AppState>,
    message_id: i64,
) -> Result<(), String> {
    delete_message_impl(&*state, message_id).await
}
