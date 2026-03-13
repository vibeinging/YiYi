pub mod manager;
pub mod discord;
pub mod dingtalk;
pub mod feishu;
pub mod formatter;
pub mod media;
pub mod qq;
pub mod rate_limit;
pub mod retry;
pub mod telegram;
pub mod wecom;
pub mod webhook_server;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

// ---------------------------------------------------------------------------
// Shared HTTP client — reuses connection pool & TLS across all bot modules
// ---------------------------------------------------------------------------

lazy_static::lazy_static! {
    static ref HTTP_CLIENT: reqwest::Client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .pool_max_idle_per_host(5)
        .build()
        .expect("Failed to build HTTP client");
}

/// Return a clone of the shared HTTP client (cheap `Arc` ref-count bump).
pub fn http_client() -> reqwest::Client {
    HTTP_CLIENT.clone()
}

// ---------------------------------------------------------------------------
// Bot connection status monitoring
// ---------------------------------------------------------------------------

/// Connection state of a bot instance
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BotConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

/// Runtime status snapshot for a single bot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotStatus {
    pub bot_id: String,
    pub state: BotConnectionState,
    pub message: Option<String>,
    pub connected_at: Option<u64>,
    pub last_error: Option<String>,
}

lazy_static::lazy_static! {
    /// Global registry of bot connection statuses.
    /// Updated by each bot implementation and read by the frontend command.
    static ref BOT_STATUS: RwLock<HashMap<String, BotStatus>> = RwLock::new(HashMap::new());
}

/// Update the connection status of a bot in the global registry.
pub fn update_bot_status(bot_id: &str, state: BotConnectionState, message: Option<String>) {
    let mut map = BOT_STATUS.write().unwrap();
    let entry = map.entry(bot_id.to_string()).or_insert_with(|| BotStatus {
        bot_id: bot_id.to_string(),
        state: BotConnectionState::Disconnected,
        message: None,
        connected_at: None,
        last_error: None,
    });

    // Track connected_at and last_error
    match &state {
        BotConnectionState::Connected => {
            entry.connected_at = Some(now_ts());
            entry.last_error = None;
        }
        BotConnectionState::Error => {
            entry.last_error = message.clone();
        }
        BotConnectionState::Disconnected => {
            entry.connected_at = None;
        }
        _ => {}
    }

    entry.state = state;
    entry.message = message;
}

/// Read all bot statuses from the global registry.
pub fn get_all_bot_statuses() -> Vec<BotStatus> {
    let map = BOT_STATUS.read().unwrap();
    map.values().cloned().collect()
}

/// Content types for multi-media messages
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
    Image { url: String, alt: Option<String> },
    File { url: String, filename: String, mime_type: Option<String> },
    Audio { url: String },
    Video { url: String },
}

/// Unified incoming message from any bot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingMessage {
    /// Which bot instance received this message
    pub bot_id: String,
    /// Platform type (discord, telegram, qq, etc.)
    pub platform: String,
    /// Conversation identifier within the platform (channel_id, chat_id, etc.)
    pub conversation_id: String,
    pub sender_id: String,
    pub sender_name: Option<String>,
    pub content: String,
    /// Multi-media content parts (optional, for rich messages)
    #[serde(default)]
    pub content_parts: Vec<ContentPart>,
    pub timestamp: u64,
    pub meta: serde_json::Value,
}

impl IncomingMessage {
    /// Generate the session ID for persisting this conversation
    pub fn session_id(&self) -> String {
        format!("bot:{}:{}", self.bot_id, self.conversation_id)
    }
}

/// Supported platform types
pub fn platform_types() -> Vec<(&'static str, &'static str)> {
    vec![
        ("discord", "Discord"),
        ("telegram", "Telegram"),
        ("qq", "QQ"),
        ("dingtalk", "DingTalk"),
        ("feishu", "Feishu"),
        ("wecom", "WeCom"),
        ("webhook", "Webhook"),
    ]
}

fn now_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
