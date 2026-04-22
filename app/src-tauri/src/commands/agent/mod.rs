pub mod chat;
pub mod helpers;
pub mod session;

use serde::{Deserialize, Serialize};

// Re-export public helpers used by other modules
pub use helpers::{parse_skill_frontmatter, resolve_llm_config};

// --- Shared types ---

/// Skill index entry — name + one-line description for the system prompt.
#[derive(Clone)]
#[allow(dead_code)]
pub struct SkillIndexEntry {
    pub name: String,
    pub description: String,
}

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
    pub bot_name: Option<String>,
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

/// Chat-history view of a spawned agent's result.
///
/// This is the shape persisted in `chat_messages.metadata.spawn_agents` and
/// returned to the frontend via `get_history`. It mirrors
/// `state::app_state::SpawnAgentResult` but keeps legacy field names
/// (`result`, `is_error`) for backward compatibility with existing rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnAgentResult {
    pub name: String,
    /// Legacy: preview / summary text. New rows store the first ~3000 chars of
    /// `full_output`; old rows have the full truncated string here.
    pub result: String,
    #[serde(default)]
    pub is_error: bool,
    /// Full uncapped output (new rows only; `None` for legacy rows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_output: Option<String>,
    /// Full uncapped error text when `is_error` is true (new rows only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// "complete" | "failed" | "timeout" | "cancelled" — new rows only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Wall-clock milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
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

// Agent CRUD commands removed — switched to dynamic agent spawning.
