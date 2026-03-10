pub mod manager;
pub mod discord;
pub mod qq;
pub mod telegram;
pub mod webhook_server;

use serde::{Deserialize, Serialize};

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
