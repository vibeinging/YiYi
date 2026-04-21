use std::sync::Arc;
use tauri::{Emitter, State};

use crate::engine::react_agent;
use crate::engine::react_agent::SignalType;
use crate::state::app_state::{StreamingSnapshot, ToolSnapshot};
use crate::state::AppState;

use super::helpers::{
    db_messages_to_llm, estimate_tokens_simple, extract_title_from_message, handle_command,
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
fn feed_to_memme(session_id: String, user_msg: String, assistant_msg: String) {
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
            &ctx.extra_tools,
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
            crate::engine::buddy_delegate::disable_session_hosted();
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
                crate::engine::buddy_delegate::enable_session_hosted();
                log::info!("Buddy hosted mode activated by user message");
            }
        }
    }

    let ctx = prepare_chat_context(&state, &sid, &message, &attachments).await?;

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
        let model_for_event = ctx.config.model.clone();
        let thinking_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let thinking_buf_for_event = thinking_buf.clone();
        let tool_call_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let tool_error_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let tool_count_for_event = tool_call_count.clone();
        let tool_error_for_event = tool_error_count.clone();
        let on_event = move |evt: react_agent::AgentStreamEvent| {
            match &evt {
                react_agent::AgentStreamEvent::Token(text) => {
                    // Strip internal markers before sending to frontend
                    let clean = crate::engine::tools::strip_stage_markers(text);
                    if !clean.is_empty() {
                        handle.emit("chat://chunk", serde_json::json!({
                            "text": clean,
                            "session_id": sid_for_event,
                        })).ok();
                    }
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
                react_agent::AgentStreamEvent::ContextOverflowRetry => {
                    // Reset accumulated text so the retry doesn't produce duplicate content
                    handle.emit("chat://stream_reset", serde_json::json!({
                        "session_id": sid_for_event,
                        "reason": "context_overflow",
                    })).ok();
                    if let Ok(mut ss) = ss_for_event.lock() {
                        if let Some(snap) = ss.get_mut(&sid_for_event) {
                            snap.accumulated_text.clear();
                        }
                    }
                }
                react_agent::AgentStreamEvent::Usage { input_tokens, output_tokens, cache_read_tokens, estimated_cost_usd } => {
                    handle.emit("chat://usage", serde_json::json!({
                        "session_id": sid_for_event,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "cache_read_tokens": cache_read_tokens,
                        "estimated_cost_usd": estimated_cost_usd,
                    })).ok();
                    // Persist to DB for historical queries
                    if let Some(db) = crate::engine::tools::get_database() {
                        db.record_usage(
                            &sid_for_event, &model_for_event,
                            *input_tokens, *output_tokens, *cache_read_tokens, 0,
                            estimated_cost_usd.unwrap_or(0.0),
                        );
                    }
                    // Window-pressure compact: if input tokens are nearing context limit,
                    // compact the session so earlier messages become searchable episodes.
                    maybe_trigger_pressure_compact(&sid_for_event, *input_tokens as u64);
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
                    None,
                )
                .await
                {
                    Ok(reply) => {
                        if !reply.is_empty() && reply != "(no response)" {
                            let thinking_text = thinking_buf.lock().ok()
                                .map(|mut b| std::mem::take(&mut *b))
                                .unwrap_or_default();
                            let clean_reply = crate::engine::tools::strip_stage_markers(&reply);
                            if thinking_text.is_empty() {
                                db.push_message(&sid_clone, "assistant", &clean_reply).ok();
                            } else {
                                let meta = serde_json::json!({ "thinking": thinking_text }).to_string();
                                db.push_message_with_metadata(&sid_clone, "assistant", &clean_reply, Some(&meta)).ok();
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

                            // Verification Agent: auto-verify multi-round tasks (round >= 3)
                            // Runs in background so it doesn't block the main completion flow.
                            if round >= 3 {
                                let verify_config = ctx.config.clone();
                                let verify_task_desc = ctx.augmented_message.clone();
                                let verify_output = last_reply.clone();
                                let verify_handle = app_handle.clone();
                                let verify_sid = sid_clone.clone();
                                let verify_wd = ctx.working_dir.clone();
                                tokio::spawn(async move {
                                    log::info!("Verification Agent starting for session {}", verify_sid);
                                    let on_event = {
                                        let h = verify_handle.clone();
                                        let sid = verify_sid.clone();
                                        move |evt: react_agent::AgentStreamEvent| {
                                            if let react_agent::AgentStreamEvent::Token(text) = &evt {
                                                h.emit("chat://verification_chunk", serde_json::json!({
                                                    "text": text, "session_id": sid,
                                                })).ok();
                                            }
                                        }
                                    };
                                    match react_agent::verification::verify_task(
                                        &verify_config, &verify_task_desc, &verify_output,
                                        &[], Some(verify_wd.as_path()), on_event, None,
                                    ).await {
                                        Ok(report) => {
                                            log::info!("Verification complete: {}", &report.chars().take(200).collect::<String>());
                                            verify_handle.emit("chat://verification_complete", serde_json::json!({
                                                "report": report, "session_id": verify_sid,
                                            })).ok();
                                        }
                                        Err(e) => {
                                            log::warn!("Verification Agent failed: {}", e);
                                        }
                                    }
                                });
                            }

                            // Feed conversation into MemMe Session pipeline
                            feed_to_memme(sid_clone.clone(), ctx.augmented_message.clone(), last_reply.clone());

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

                            // Memory extraction is delegated to MemMe's meditation pipeline (runs nightly).
                            // Short-term memory lives in the last 50 messages in the prompt.
                            // Long-term facts get extracted during `store.meditate()`.

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
pub async fn get_history(
    state: State<'_, AppState>,
    session_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ChatMessage>, String> {
    get_history_impl(&*state, session_id, limit).await
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
