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

#[cfg(test)]
mod tests {
    use super::*;

    /// Metadata round-trip: the chat.rs `get_history` path builds
    /// `SpawnAgentResult` from a JSON blob stored in `chat_messages.metadata`.
    /// This test locks the serde shape so future renames in either direction
    /// (write-time or read-time) break loudly.
    #[test]
    fn spawn_agent_result_metadata_round_trip_preserves_structured_fields() {
        let original = SpawnAgentResult {
            name: "explore".into(),
            result: "summary preview".into(),
            is_error: false,
            full_output: Some("full uncapped body\nwith newlines".into()),
            error: None,
            status: Some("complete".into()),
            duration_ms: Some(1_234),
        };
        // Write path: serialize into a JSON blob (the same flow persists it
        // into the DB `metadata` column).
        let j = serde_json::to_value(&original).unwrap();
        assert_eq!(j["name"], "explore");
        assert_eq!(j["status"], "complete");
        assert_eq!(j["full_output"], "full uncapped body\nwith newlines");
        assert_eq!(j["duration_ms"], 1_234);
        // `error` is None → must NOT appear (skip_serializing_if).
        assert!(j.get("error").is_none() || j["error"].is_null());

        // Read path: deserialize back into the struct.
        let back: SpawnAgentResult = serde_json::from_value(j).unwrap();
        assert_eq!(back.name, original.name);
        assert_eq!(back.result, original.result);
        assert_eq!(back.is_error, original.is_error);
        assert_eq!(back.full_output, original.full_output);
        assert_eq!(back.error, original.error);
        assert_eq!(back.status, original.status);
        assert_eq!(back.duration_ms, original.duration_ms);
    }

    /// Failure path: full uncapped error must survive round-trip. Guards
    /// Gap 5 (stop the 200-char truncation upstream) — a regression that
    /// re-truncates would surface here as a length mismatch.
    #[test]
    fn spawn_agent_result_preserves_uncapped_error_on_failure() {
        let long = "boom ".repeat(250); // 1250 chars — well past the old 200-char cap.
        let original = SpawnAgentResult {
            name: "planner".into(),
            result: "short preview".into(),
            is_error: true,
            full_output: Some(long.clone()),
            error: Some(long.clone()),
            status: Some("failed".into()),
            duration_ms: Some(42),
        };
        let j = serde_json::to_value(&original).unwrap();
        let back: SpawnAgentResult = serde_json::from_value(j).unwrap();
        assert_eq!(back.error.as_deref(), Some(long.as_str()));
        assert_eq!(back.full_output.as_deref(), Some(long.as_str()));
        assert_eq!(back.status.as_deref(), Some("failed"));
        assert!(back.is_error);
    }

    /// Legacy-row compatibility: old metadata rows only have
    /// `name`/`result`/`is_error` and must still deserialize (the new fields
    /// are all `#[serde(default)]`).
    #[test]
    fn spawn_agent_result_accepts_legacy_metadata_without_new_fields() {
        let legacy = serde_json::json!({
            "name": "old",
            "result": "legacy summary",
            "is_error": false,
        });
        let back: SpawnAgentResult = serde_json::from_value(legacy).unwrap();
        assert_eq!(back.name, "old");
        assert!(back.full_output.is_none());
        assert!(back.status.is_none());
        assert!(back.duration_ms.is_none());
    }
}
