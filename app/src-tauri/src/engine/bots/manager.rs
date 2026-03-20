use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

use super::IncomingMessage;
use crate::engine::db::BotRow;
use crate::engine::llm_client::{LLMMessage, MessageContent};
use crate::engine::react_agent;
use crate::engine::tools::mcp_tools_as_definitions;
use crate::state::AppState;
use crate::state::config::AccessPolicy;

/// Buffered messages for a single sender, with the instant of the last received message.
struct DebounceEntry {
    messages: Vec<IncomingMessage>,
    last_received: tokio::time::Instant,
}

/// Tracks a running bot instance so it can be stopped individually.
pub struct RunningBot {
    pub bot_id: String,
    /// Shared running flag from the platform bot — set to `false` to stop it.
    pub running_flag: Arc<RwLock<bool>>,
}

/// Central bot manager — receives messages from all bots,
/// processes them through the agent with conversation history, and dispatches responses.
pub struct BotManager {
    /// Incoming message receiver
    rx: Arc<RwLock<mpsc::Receiver<IncomingMessage>>>,
    /// Sender cloned to each bot
    tx: mpsc::Sender<IncomingMessage>,
    /// Callback to send responses back, keyed by bot_id
    response_handlers: Arc<RwLock<HashMap<String, Box<dyn Fn(String, String) -> futures_util::future::BoxFuture<'static, Result<(), String>> + Send + Sync>>>>,
    /// Running flag
    running: Arc<RwLock<bool>>,
    /// Debounce buffer: key = "{bot_id}:{sender_id}", value = buffered messages
    debounce_buffer: Arc<RwLock<HashMap<String, DebounceEntry>>>,
    /// Message ID deduplication set (last 1000 IDs)
    seen_message_ids: Arc<RwLock<VecDeque<String>>>,
    /// Currently running bot instances, keyed by bot_id
    running_bots: Arc<RwLock<HashMap<String, RunningBot>>>,
    /// Webhook server instance for lifecycle management
    webhook_server: Arc<RwLock<Option<super::webhook_server::WebhookServer>>>,
}

/// Max number of message IDs to keep for deduplication
const DEDUP_MAX_IDS: usize = 1000;
/// Debounce window in milliseconds
const DEBOUNCE_WINDOW_MS: u64 = 500;
/// Max conversation history messages to load for bot context
const BOT_HISTORY_LIMIT: usize = 30;

impl BotManager {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel(1000);
        Self {
            rx: Arc::new(RwLock::new(rx)),
            tx,
            response_handlers: Arc::new(RwLock::new(HashMap::new())),
            running: Arc::new(RwLock::new(false)),
            debounce_buffer: Arc::new(RwLock::new(HashMap::new())),
            seen_message_ids: Arc::new(RwLock::new(VecDeque::new())),
            running_bots: Arc::new(RwLock::new(HashMap::new())),
            webhook_server: Arc::new(RwLock::new(None)),
        }
    }

    /// Store the webhook server instance so it can be stopped on shutdown.
    pub async fn set_webhook_server(&self, server: super::webhook_server::WebhookServer) {
        let mut ws = self.webhook_server.write().await;
        *ws = Some(server);
    }

    /// Generate a dedup key for a message
    fn message_dedup_id(msg: &IncomingMessage) -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        msg.content.hash(&mut hasher);
        let hash = hasher.finish();
        format!(
            "{}:{}:{}:{:x}",
            msg.bot_id, msg.conversation_id, msg.timestamp, hash
        )
    }

    /// Merge multiple messages from the same sender into one.
    fn merge_messages(messages: Vec<IncomingMessage>) -> IncomingMessage {
        if messages.len() == 1 {
            return messages.into_iter().next().unwrap();
        }

        let first = &messages[0];
        let mut merged_content = Vec::new();
        let mut merged_parts = Vec::new();

        for msg in &messages {
            if !msg.content.is_empty() {
                merged_content.push(msg.content.clone());
            }
            merged_parts.extend(msg.content_parts.clone());
        }

        IncomingMessage {
            bot_id: first.bot_id.clone(),
            platform: first.platform.clone(),
            conversation_id: first.conversation_id.clone(),
            sender_id: first.sender_id.clone(),
            sender_name: first.sender_name.clone(),
            content: merged_content.join("\n"),
            content_parts: merged_parts,
            timestamp: first.timestamp,
            meta: first.meta.clone(),
        }
    }

    pub fn get_sender(&self) -> mpsc::Sender<IncomingMessage> {
        self.tx.clone()
    }

    /// Register a response handler for a specific bot_id
    pub async fn register_handler<F, Fut>(&self, bot_id: &str, handler: F)
    where
        F: Fn(String, String) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<(), String>> + Send + 'static,
    {
        let mut handlers = self.response_handlers.write().await;
        handlers.insert(
            bot_id.to_string(),
            Box::new(move |target, content| Box::pin(handler(target.clone(), content.clone()))),
        );
    }

    /// Unregister the response handler for a specific bot_id.
    pub async fn unregister_handler(&self, bot_id: &str) {
        let mut handlers = self.response_handlers.write().await;
        handlers.remove(bot_id);
    }

    /// Register a running bot instance for tracking.
    pub async fn register_running_bot(&self, bot: RunningBot) {
        let mut bots = self.running_bots.write().await;
        bots.insert(bot.bot_id.clone(), bot);
    }

    /// Unregister and stop a running bot instance. Returns true if the bot was found.
    pub async fn unregister_running_bot(&self, bot_id: &str) -> bool {
        let mut bots = self.running_bots.write().await;
        if let Some(bot) = bots.remove(bot_id) {
            let mut flag = bot.running_flag.write().await;
            *flag = false;
            true
        } else {
            false
        }
    }

    /// Check if a specific bot is currently running.
    pub async fn is_bot_running(&self, bot_id: &str) -> bool {
        let bots = self.running_bots.read().await;
        bots.contains_key(bot_id)
    }

    /// List all currently running bot IDs.
    pub async fn list_running_bot_ids(&self) -> Vec<String> {
        let bots = self.running_bots.read().await;
        bots.keys().cloned().collect()
    }

    /// Start the consumer loop with deduplication and debouncing.
    pub async fn start(&self, app_state: Arc<AppState>, app_handle: tauri::AppHandle) {
        let mut running = self.running.write().await;
        if *running {
            return;
        }
        *running = true;
        drop(running);

        // Internal processed channel: debounce task writes here, workers read from here.
        let (proc_tx, proc_rx) = mpsc::channel::<IncomingMessage>(1000);
        let proc_rx = Arc::new(RwLock::new(proc_rx));

        // --- Spawn debounce ingestion task ---
        {
            let rx = self.rx.clone();
            let running = self.running.clone();
            let debounce_buffer = self.debounce_buffer.clone();
            let seen_ids = self.seen_message_ids.clone();

            tokio::spawn(async move {
                loop {
                    let msg = {
                        let mut receiver = rx.write().await;
                        tokio::select! {
                            result = receiver.recv() => {
                                match result {
                                    Some(msg) => Some(msg),
                                    None => break, // channel closed
                                }
                            }
                            _ = async {
                                loop {
                                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                                    let is_running = running.read().await;
                                    if !*is_running {
                                        return;
                                    }
                                }
                            } => {
                                break; // running flag set to false
                            }
                        }
                    };

                    if let Some(msg) = msg {
                        let dedup_id = BotManager::message_dedup_id(&msg);
                        let is_dup = {
                            let mut seen = seen_ids.write().await;
                            if seen.contains(&dedup_id) {
                                true
                            } else {
                                seen.push_back(dedup_id.clone());
                                if seen.len() > DEDUP_MAX_IDS {
                                    seen.pop_front();
                                }
                                false
                            }
                        };

                        if is_dup {
                            log::debug!("Dropping duplicate message: {}", dedup_id);
                            continue;
                        }

                        // Buffer by bot_id:sender_id
                        let sender_key = format!("{}:{}", msg.bot_id, msg.sender_id);
                        let mut buffer = debounce_buffer.write().await;
                        let entry = buffer.entry(sender_key).or_insert_with(|| DebounceEntry {
                            messages: Vec::new(),
                            last_received: tokio::time::Instant::now(),
                        });
                        entry.messages.push(msg);
                        entry.last_received = tokio::time::Instant::now();
                    }
                }
            });
        }

        // --- Spawn debounce flusher task ---
        {
            let debounce_buffer = self.debounce_buffer.clone();
            let running = self.running.clone();
            let proc_tx = proc_tx.clone();
            let debounce_window = std::time::Duration::from_millis(DEBOUNCE_WINDOW_MS);

            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

                    let is_running = *running.read().await;
                    if !is_running {
                        let mut buffer = debounce_buffer.write().await;
                        for (_key, entry) in buffer.drain() {
                            if !entry.messages.is_empty() {
                                let merged = BotManager::merge_messages(entry.messages);
                                proc_tx.send(merged).await.ok();
                            }
                        }
                        break;
                    }

                    let now = tokio::time::Instant::now();

                    // Single write lock to avoid race between read-scan and write-flush
                    let mut buffer = debounce_buffer.write().await;
                    let keys: Vec<String> = buffer.iter()
                        .filter(|(_, entry)| now.duration_since(entry.last_received) >= debounce_window)
                        .map(|(key, _)| key.clone())
                        .collect();

                    for key in keys {
                        if let Some(entry) = buffer.remove(&key) {
                            if !entry.messages.is_empty() {
                                let count = entry.messages.len();
                                let merged = BotManager::merge_messages(entry.messages);
                                if count > 1 {
                                    log::info!(
                                        "Debounce: merged {} messages from {}",
                                        count, key
                                    );
                                }
                                proc_tx.send(merged).await.ok();
                            }
                        }
                    }
                }
            });
        }

        // --- Spawn 4 consumer workers ---
        let handlers = self.response_handlers.clone();
        let running = self.running.clone();

        for worker_id in 0..4 {
            let proc_rx = proc_rx.clone();
            let handlers = handlers.clone();
            let running = running.clone();
            let state = app_state.clone();
            let app = app_handle.clone();

            tokio::spawn(async move {
                loop {
                    let msg = {
                        let mut receiver = proc_rx.write().await;
                        match receiver.try_recv() {
                            Ok(msg) => msg,
                            Err(mpsc::error::TryRecvError::Empty) => {
                                drop(receiver);
                                tokio::time::sleep(std::time::Duration::from_millis(100)).await;

                                let is_running = running.read().await;
                                if !*is_running {
                                    break;
                                }
                                continue;
                            }
                            Err(mpsc::error::TryRecvError::Disconnected) => break,
                        }
                    };

                    let content_preview: String = msg.content.chars().take(50).collect();
                    log::info!(
                        "[Worker {}] Processing message from bot:{} {}:{} - {}",
                        worker_id,
                        msg.bot_id,
                        msg.platform,
                        msg.sender_id,
                        content_preview
                    );

                    // Load bot config from DB for access control
                    let bot_row = match state.db.get_bot(&msg.bot_id) {
                        Ok(row) => row,
                        Err(e) => {
                            log::error!(
                                "[Worker {}] Failed to load bot config for '{}': {}. Denying access.",
                                worker_id, msg.bot_id, e
                            );
                            continue;
                        }
                    };

                    // Check access control using bot's access_json
                    if let Some(ref bot) = bot_row {
                        if let Some(ref access_json) = bot.access_json {
                            match serde_json::from_str::<AccessPolicy>(access_json) {
                                Ok(policy) => {
                                    if let Err(deny_msg) = check_access(&policy, &msg) {
                                        log::info!(
                                            "[Worker {}] Access denied for {}:{} - {}",
                                            worker_id, msg.platform, msg.sender_id, deny_msg
                                        );
                                        let hs = handlers.read().await;
                                        if let Some(handler) = hs.get(&msg.bot_id) {
                                            super::rate_limit::acquire(&msg.platform, &msg.bot_id).await;
                                            handler(msg.conversation_id.clone(), deny_msg).await.ok();
                                        }
                                        continue;
                                    }
                                }
                                Err(e) => {
                                    log::warn!(
                                        "[Worker {}] Failed to parse access_json for bot '{}': {}. Denying access.",
                                        worker_id, msg.bot_id, e
                                    );
                                    continue;
                                }
                            }
                        }
                    }

                    // Emit incoming message event to frontend
                    use tauri::Emitter;
                    app.emit("bot://message", &msg).ok();



                    // Build early-reply callback: when agent's first iteration
                    // produces text + tool_calls, send the text immediately as a
                    // passive reply (with msg_id) so the user sees a natural ack
                    // generated by the agent itself (e.g. "好的，我来帮你查一下").
                    let early_handler: Option<Box<dyn Fn(String) -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>> = {
                        let msg_id = msg.meta["msg_id"].as_str().map(|s| s.to_string());
                        if let Some(mid) = msg_id {
                            let hs = handlers.clone();
                            let bot_id = msg.bot_id.clone();
                            let conv = msg.conversation_id.clone();
                            Some(Box::new(move |text: String| {
                                let hs = hs.clone();
                                let bot_id = bot_id.clone();
                                let target = format!("{}#msg_id={}", conv, mid);
                                Box::pin(async move {
                                    let handlers = hs.read().await;
                                    if let Some(handler) = handlers.get(&bot_id) {
                                        handler(target, text).await.ok();
                                    }
                                })
                            }))
                        } else {
                            None
                        }
                    };

                    // Process with agent — early_reply sends first-iteration text if tools are called
                    let (reply, actual_session_id) = match process_message(&state, &msg, bot_row.as_ref(), early_handler, Some(app.clone())).await {
                        Ok(r) => r,
                        Err(e) => {
                            log::error!("Agent error: {}", e);
                            (format!("Error: {}", e), msg.session_id())
                        }
                    };

                    // Send the final reply with rate limiting + retry
                    let hs = handlers.read().await;
                    if let Some(handler) = hs.get(&msg.bot_id) {
                        let target = msg.conversation_id.clone();

                        // Rate limit: wait for token before sending
                        super::rate_limit::acquire(&msg.platform, &msg.bot_id).await;

                        // Retry with exponential backoff (max 3 retries)
                        let send_result = super::retry::with_retry(&msg.bot_id, || {
                            handler(target.clone(), reply.clone())
                        }).await;

                        if !send_result.success {
                            log::error!(
                                "Failed to send response after {} attempts: {:?}",
                                send_result.attempts, send_result.last_error
                            );
                            // Notify frontend of send failure
                            super::retry::emit_send_failure(
                                &app,
                                &msg.bot_id,
                                &target,
                                send_result.last_error.as_deref().unwrap_or("unknown"),
                                send_result.attempts,
                            );
                        }
                    }

                    // Emit response event to frontend with the actual session ID
                    // (may be the bound user session, not the bot's default session)
                    app.emit(
                        "bot://response",
                        serde_json::json!({
                            "bot_id": msg.bot_id,
                            "platform": msg.platform,
                            "conversation_id": msg.conversation_id,
                            "session_id": actual_session_id,
                            "content": reply,
                        }),
                    )
                    .ok();
                }
            });
        }
    }

    /// Get the number of connected (registered) bots.
    pub async fn connected_count(&self) -> usize {
        self.response_handlers.read().await.len()
    }

    /// Check if the bot manager consumer loop is running.
    pub async fn is_running(&self) -> bool {
        *self.running.read().await
    }

    pub async fn stop(&self) {
        let mut running = self.running.write().await;
        *running = false;
        drop(running);

        // Stop webhook server if running
        let ws = self.webhook_server.read().await;
        if let Some(ref server) = *ws {
            server.stop().await;
            log::info!("Webhook server stopped");
        }
    }
}

/// Check if a sender is allowed based on access policy.
fn check_access(policy: &AccessPolicy, msg: &IncomingMessage) -> Result<(), String> {
    let is_group = msg.conversation_id != msg.sender_id;

    let active_policy = if is_group {
        &policy.group_policy
    } else {
        &policy.dm_policy
    };

    if active_policy == "open" {
        return Ok(());
    }

    if policy.allow_from.contains(&msg.sender_id) {
        return Ok(());
    }

    if is_group && policy.allow_from.contains(&msg.conversation_id) {
        return Ok(());
    }

    let deny_msg = policy.deny_message.clone()
        .unwrap_or_else(|| "Access denied. You are not authorized to use this bot.".to_string());
    Err(deny_msg)
}

/// Convert DB ChatMessages to LLM history messages
fn db_messages_to_llm(messages: &[crate::engine::db::ChatMessage]) -> Vec<LLMMessage> {
    messages
        .iter()
        .map(|m| LLMMessage {
            role: m.role.clone(),
            content: Some(MessageContent::text(&m.content)),
            tool_calls: None,
            tool_call_id: None,
        })
        .collect()
}

/// Process an incoming message through the ReAct agent with session persistence.
/// `early_reply` is called once when the agent's first iteration produces text AND
/// tool calls — the text (agent's natural ack) is sent immediately to the user.
async fn process_message(
    state: &AppState,
    msg: &IncomingMessage,
    bot: Option<&BotRow>,
    early_reply: Option<Box<dyn Fn(String) -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>>,
    app_handle: Option<tauri::AppHandle>,
) -> Result<(String, String), String> {
    // Use global LLM config for all bot messages
    let config = crate::commands::agent::resolve_llm_config(state).await?;

    // Check if this bot is bound to an existing session
    let bound_session = state.db.get_session_for_bot(&msg.bot_id).unwrap_or(None);

    // Check if sender has a unified user identity for cross-platform session continuity
    let unified_user_id = state.db.get_unified_user_by_identity(
        &msg.platform, &msg.sender_id, &msg.bot_id
    ).unwrap_or(None);

    let session_id = if let Some(ref uid) = unified_user_id {
        // Cross-platform shared session: use unified user session
        let sid = format!("unified:{}", uid);
        let user = state.db.get_unified_user(uid).ok().flatten();
        let session_name = format!(
            "Unified - {}",
            user.as_ref().and_then(|u| u.display_name.as_deref()).unwrap_or(uid.as_str())
        );
        let source_meta = serde_json::json!({
            "unified_user_id": uid,
            "bot_id": msg.bot_id,
            "platform": msg.platform,
            "conversation_id": msg.conversation_id,
            "sender_id": msg.sender_id,
        }).to_string();
        state.db.ensure_session(&sid, &session_name, "unified", Some(&source_meta))?;
        log::info!(
            "Unified user {} (via {}:{}), using shared session {}",
            uid, msg.platform, msg.sender_id, sid
        );
        sid
    } else if let Some(ref sid) = bound_session {
        // Route to the bound session instead of creating a separate bot session
        log::info!("Bot {} is bound to session {}, routing message there", msg.bot_id, sid);
        sid.clone()
    } else {
        // Default: create/use a bot-specific session
        let sid = msg.session_id();
        let session_name = format!(
            "{} - {}",
            bot.map(|b| b.name.as_str()).unwrap_or(&msg.platform),
            msg.sender_name.as_deref().unwrap_or(&msg.sender_id)
        );
        let source_meta = serde_json::json!({
            "bot_id": msg.bot_id,
            "platform": msg.platform,
            "conversation_id": msg.conversation_id,
            "sender_id": msg.sender_id,
        }).to_string();

        state.db.ensure_session(&sid, &session_name, "bot", Some(&source_meta))?;
        sid
    };

    // Save user message to session with bot source metadata
    let source_metadata = serde_json::json!({
        "via": "bot",
        "platform": msg.platform,
        "bot_id": msg.bot_id,
        "sender_id": msg.sender_id,
        "sender_name": msg.sender_name,
    }).to_string();
    state.db.push_message_with_metadata(&session_id, "user", &msg.content, Some(&source_metadata))?;

    // Update the last conversation target so agent knows where to send replies
    state.db.update_bot_last_conversation(&msg.bot_id, &msg.conversation_id).ok();

    // Load conversation history
    let history_messages = state.db.get_recent_messages(&session_id, BOT_HISTORY_LIMIT).unwrap_or_default();
    let llm_history: Vec<LLMMessage> = if history_messages.len() > 1 {
        // Exclude the current message (last one we just pushed)
        db_messages_to_llm(&history_messages[..history_messages.len() - 1])
    } else {
        vec![]
    };

    // Load skill index + always-active skills
    let skills_dir = state.working_dir.join("active_skills");
    let mut skill_index = Vec::new();
    let mut always_active_skills = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&skills_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let skill_md = path.join("SKILL.md");
            if let Ok(content) = tokio::fs::read_to_string(&skill_md).await {
                let name = path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let (description, is_always_active) = crate::commands::agent::parse_skill_frontmatter(&content);
                if is_always_active {
                    always_active_skills.push(content);
                } else {
                    skill_index.push(crate::commands::agent::SkillIndexEntry {
                        name,
                        description: description.unwrap_or_default(),
                    });
                }
            }
        }
    }

    let (lang, max_iter) = {
        let cfg = state.config.read().await;
        (cfg.agents.language.clone(), cfg.agents.max_iterations)
    };

    // Build system prompt using global config
    let user_ws = state.user_workspace();
    let mut system_prompt = react_agent::build_system_prompt(
        &state.working_dir, Some(&user_ws), &skill_index, &always_active_skills, lang.as_deref(), None, None,
    ).await;

    // Remove the bot-tools guidance that confuses the agent in this context
    if let Some(idx) = system_prompt.find("## Bots & External Messaging") {
        if let Some(end) = system_prompt[idx..].find("\n\n##").or_else(|| system_prompt[idx..].find("\n\n\"")) {
            system_prompt.replace_range(idx..idx + end, "");
        } else {
            system_prompt.truncate(idx);
        }
    }

    // Add bot-specific context
    let sender_display = msg.sender_name.as_deref().unwrap_or(&msg.sender_id);
    system_prompt.push_str(&format!(
        "\n\n## Current Context\n\
        You are responding as a {} bot to user \"{}\". \
        Just reply naturally to their message. Your response will be sent back to them automatically. \
        Do NOT use send_bot_message, list_bound_bots, or any bot-related tools. \
        Do NOT explain how the bot system works. Just have a normal conversation.",
        msg.platform, sender_display
    ));

    if let Some(bot) = bot {
        if let Some(ref persona) = bot.persona {
            if !persona.is_empty() {
                system_prompt.push_str(&format!("\n\n## Bot Persona\n{}", persona));
            }
        }
    }

    // Collect MCP tools
    let mcp_tools = state.mcp_runtime.get_all_tools().await;
    let empty_overrides = std::collections::HashMap::new();
    let extra_tools = mcp_tools_as_definitions(&mcp_tools, &empty_overrides);

    // Download any media attachments and enrich the message content.
    // For platform-specific URLs (telegram://file/xxx, feishu://image/xxx, etc.),
    // this downloads the actual file and appends local path info to the message.
    let enriched_message = if msg.content_parts.iter().any(|p| !matches!(p, super::ContentPart::Text { .. })) {
        // Parse bot config to extract platform credentials for media download
        let bot_config: serde_json::Value = bot
            .map(|b| serde_json::from_str(&b.config_json).unwrap_or(serde_json::json!({})))
            .unwrap_or(serde_json::json!({}));

        let (media_notes, _downloaded_paths) = super::media::enrich_media_content(
            &msg.content_parts,
            &msg.platform,
            &bot_config,
            &state.user_workspace(),
        ).await;

        if media_notes.is_empty() {
            msg.content.clone()
        } else {
            format!("{}\n{}", msg.content, media_notes)
        }
    } else {
        msg.content.clone()
    };

    // Use streaming agent: when first iteration has text + tool_calls,
    // send the text immediately as a natural ack via early_reply callback.
    // We use a tokio::sync::watch channel to safely pass text from the sync
    // on_event callback to the async send_task, avoiding mixed mutex issues.
    let early_sent = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let token_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let (early_watch_tx, early_watch_rx) = tokio::sync::watch::channel(String::new());
    let early_watch_tx = std::sync::Arc::new(early_watch_tx);

    let on_event = {
        let early_sent = early_sent.clone();
        let token_buf = token_buf.clone();
        let early_watch_tx = early_watch_tx.clone();
        move |event: react_agent::AgentStreamEvent| {
            match event {
                react_agent::AgentStreamEvent::ToolStart { .. } => {
                    if !early_sent.load(std::sync::atomic::Ordering::Relaxed) {
                        let text = token_buf.lock().unwrap().clone();
                        if !text.trim().is_empty() {
                            early_sent.store(true, std::sync::atomic::Ordering::Relaxed);
                            early_watch_tx.send(text).ok();
                        }
                    }
                }
                react_agent::AgentStreamEvent::Token(token) => {
                    if !early_sent.load(std::sync::atomic::Ordering::Relaxed) {
                        token_buf.lock().unwrap().push_str(&token);
                    }
                }
                _ => {}
            }
        }
    };

    let early_reply = std::sync::Arc::new(tokio::sync::Mutex::new(early_reply));
    let early_saved_text = std::sync::Arc::new(tokio::sync::Mutex::new(Option::<String>::None));
    let bot_id_for_context = msg.bot_id.clone();
    let conversation_id_for_context = msg.conversation_id.clone();
    let reply = crate::engine::tools::with_session_id(
        session_id.clone(),
        crate::engine::tools::with_bot_context(
            bot_id_for_context,
            conversation_id_for_context,
        async {
            let early_reply_ref = early_reply.clone();
            let mut early_watch_rx = early_watch_rx.clone();
            let early_saved = early_saved_text.clone();
            let db_ref = std::sync::Arc::clone(&state.db);
            let sid = session_id.clone();
            let app_h = app_handle.clone();
            let bot_id_for_early = msg.bot_id.clone();
            let reply_meta = serde_json::json!({
                "via": "bot",
                "platform": msg.platform,
                "bot_id": msg.bot_id,
            }).to_string();
            let send_task = tokio::spawn(async move {
                // Wait for the watch channel to receive early text or be closed
                if early_watch_rx.changed().await.is_ok() {
                    let text = early_watch_rx.borrow().clone();
                    if !text.trim().is_empty() {
                        // Mark as saved FIRST to prevent race
                        *early_saved.lock().await = Some(text.clone());
                        // Send via bot channel (passive reply with msg_id)
                        let cb = early_reply_ref.lock().await;
                        if let Some(ref f) = *cb {
                            f(text.clone()).await;
                        }
                        // Save early reply to DB so it shows in YiYi
                        db_ref.push_message_with_metadata(&sid, "assistant", &text, Some(&reply_meta)).ok();
                        // Notify frontend to refresh messages
                        if let Some(ref ah) = app_h {
                            use tauri::Emitter;
                            ah.emit("bot://early-reply", serde_json::json!({
                                "bot_id": bot_id_for_early,
                                "session_id": sid,
                                "content": text,
                            })).ok();
                        }
                    }
                }
            });

            let result = react_agent::run_react_with_options_stream(
                &config, &system_prompt, &enriched_message, &extra_tools,
                &llm_history, max_iter, Some(&state.working_dir),
                on_event, None, None,
            ).await;

            // Graceful shutdown: drop the watch sender so send_task sees channel closed,
            // then wait up to 2 seconds for it to finish instead of aborting.
            drop(early_watch_tx);
            match tokio::time::timeout(
                std::time::Duration::from_secs(2),
                send_task,
            ).await {
                Err(_) => log::warn!("[bot] early reply send_task did not finish within 2s"),
                Ok(Err(e)) => log::error!("[bot] early reply send_task panicked: {:?}", e),
                Ok(Ok(_)) => {}
            }
            result
        }),
    ).await?;

    // Save assistant reply to session with bot metadata
    let bot_reply_meta = serde_json::json!({
        "via": "bot",
        "platform": msg.platform,
        "bot_id": msg.bot_id,
    }).to_string();
    let early = early_saved_text.lock().await.clone();
    let should_save = !reply.is_empty() && reply != "(no response)";
    if should_save {
        if early.is_some() && early.as_deref() != Some(reply.trim()) {
            state.db.push_message_with_metadata(&session_id, "assistant", &reply, Some(&bot_reply_meta))?;
        } else if early.is_none() {
            state.db.push_message_with_metadata(&session_id, "assistant", &reply, Some(&bot_reply_meta))?;
        }
    }
    // If early text == final reply, skip duplicate save

    Ok((reply, session_id))
}
