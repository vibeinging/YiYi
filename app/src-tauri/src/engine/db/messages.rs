use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub timestamp: i64,
    pub metadata: Option<String>,
    pub collaboration_id: Option<i64>,
    pub step_id: Option<i64>,
    pub companion_id: Option<i64>,
}

impl super::Database {
    // --- Message CRUD ---

    pub fn get_messages(
        &self,
        session_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<ChatMessage>, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let limit = limit.unwrap_or(200);

        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, role, content, timestamp, metadata,
                        collaboration_id, step_id, companion_id FROM messages
                 WHERE session_id = ?1 ORDER BY timestamp ASC LIMIT ?2",
            )
            .map_err(|e| format!("Query error: {}", e))?;

        let messages = stmt
            .query_map(params![session_id, limit as i64], |row| {
                Ok(ChatMessage {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    timestamp: row.get(4)?,
                    metadata: row.get(5)?,
                    collaboration_id: row.get(6)?,
                    step_id: row.get(7)?,
                    companion_id: row.get(8)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.map_err(|e| log::warn!("Row parse error: {}", e)).ok())
            .collect();

        Ok(messages)
    }

    /// Get recent N messages for LLM context.
    /// Stops at the most recent `context_reset` boundary so earlier messages
    /// are excluded from the conversation context sent to the LLM.
    pub fn get_recent_messages(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<ChatMessage>, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());

        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, role, content, timestamp, metadata,
                        collaboration_id, step_id, companion_id FROM messages
                 WHERE session_id = ?1 ORDER BY timestamp DESC LIMIT ?2",
            )
            .map_err(|e| format!("Query error: {}", e))?;

        let mut messages: Vec<ChatMessage> = Vec::new();
        let rows: Vec<ChatMessage> = stmt
            .query_map(params![session_id, limit as i64], |row| {
                Ok(ChatMessage {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    timestamp: row.get(4)?,
                    metadata: row.get(5)?,
                    collaboration_id: row.get(6)?,
                    step_id: row.get(7)?,
                    companion_id: row.get(8)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.map_err(|e| log::warn!("Row parse error: {}", e)).ok())
            .collect();

        // rows are DESC order — stop when hitting a context_reset marker
        for msg in rows {
            if msg.role == "context_reset" {
                break;
            }
            messages.push(msg);
        }

        messages.reverse(); // chronological order
        Ok(messages)
    }

    pub fn push_message(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
    ) -> Result<i64, String> {
        self.push_message_with_metadata(session_id, role, content, None)
    }

    pub fn push_message_with_metadata(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
        metadata: Option<&str>,
    ) -> Result<i64, String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn.unchecked_transaction()
            .map_err(|e| format!("Failed to begin transaction: {}", e))?;

        // Auto-create session if not exists
        tx.execute(
            "INSERT OR IGNORE INTO sessions (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, session_id, now, now],
        )
        .map_err(|e| format!("Failed to ensure session: {}", e))?;

        tx.execute(
            "INSERT INTO messages (session_id, role, content, timestamp, metadata) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, role, content, now, metadata],
        )
        .map_err(|e| format!("Failed to insert message: {}", e))?;

        let msg_id = conn.last_insert_rowid();

        // Update session timestamp
        tx.execute(
            "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
            params![now, session_id],
        )
        .map_err(|e| format!("Failed to update session: {}", e))?;

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        Ok(msg_id)
    }

    /// Upsert the collaboration's tracking row in the host session's
    /// message stream. Used twice in a collaboration's lifetime:
    ///
    ///   1. When the orchestrator first accepts the collaboration (via
    ///      `delegate_to_companion` tool or similar) — content is the
    ///      intro / @mention line, so the user sees a bubble immediately.
    ///   2. When `finalize()` writes the verdict — UPDATEs the same row.
    ///
    /// This way the frontend always renders a single
    /// `CollaborationMessageCard` per collaboration; the inline card
    /// streams live tokens via the store, and on session re-load the
    /// verdict content backs the card from disk.
    ///
    /// Stored with `role = "assistant"` so the LLM reads it as history.
    /// Returns the message id (existing or newly-inserted).
    pub fn upsert_collaboration_message(
        &self,
        session_id: &str,
        collaboration_id: i64,
        content: &str,
    ) -> Result<i64, String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());

        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to begin transaction: {}", e))?;

        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM messages WHERE collaboration_id = ?1 LIMIT 1",
                params![collaboration_id],
                |row| row.get(0),
            )
            .ok();

        let msg_id = if let Some(id) = existing {
            tx.execute(
                "UPDATE messages SET content = ?1, timestamp = ?2 WHERE id = ?3",
                params![content, now, id],
            )
            .map_err(|e| format!("Failed to update collaboration message: {}", e))?;
            id
        } else {
            tx.execute(
                "INSERT OR IGNORE INTO sessions (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![session_id, session_id, now, now],
            )
            .map_err(|e| format!("Failed to ensure session: {}", e))?;
            tx.execute(
                "INSERT INTO messages (session_id, role, content, timestamp, collaboration_id)
                 VALUES (?1, 'assistant', ?2, ?3, ?4)",
                params![session_id, content, now, collaboration_id],
            )
            .map_err(|e| format!("Failed to insert collaboration message: {}", e))?;
            tx.last_insert_rowid()
        };

        tx.execute(
            "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
            params![now, session_id],
        )
        .map_err(|e| format!("Failed to update session: {}", e))?;

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        Ok(msg_id)
    }

    /// Patch a companion-draft message's `draft_state` (and optional
    /// `adopted_companion_id`) inside its `metadata` JSON. Used by the
    /// inline CompanionDraftCard so adopt / dismiss persists past a
    /// refresh. No-op if the message has no `metadata.companion_draft`.
    pub fn update_companion_draft_state(
        &self,
        message_id: i64,
        new_state: &str,
        adopted_companion_id: Option<i64>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let raw: Option<String> = conn
            .query_row(
                "SELECT metadata FROM messages WHERE id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("read message metadata: {}", e))?;

        let mut meta: serde_json::Value = raw
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if meta.get("companion_draft").is_none() {
            return Err("message is not a companion draft".into());
        }
        meta["draft_state"] = serde_json::Value::String(new_state.into());
        if let Some(id) = adopted_companion_id {
            meta["adopted_companion_id"] = serde_json::Value::Number(id.into());
        }

        let serialized = meta.to_string();
        conn.execute(
            "UPDATE messages SET metadata = ?1 WHERE id = ?2",
            params![serialized, message_id],
        )
        .map_err(|e| format!("update message metadata: {}", e))?;
        Ok(())
    }

    pub fn clear_messages(&self, session_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "DELETE FROM messages WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| format!("Failed to clear messages: {}", e))?;
        Ok(())
    }

    pub fn delete_message(&self, message_id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute("DELETE FROM messages WHERE id = ?1", params![message_id])
            .map_err(|e| format!("Failed to delete message: {}", e))?;
        Ok(())
    }

    pub(super) fn message_count(&self, session_id: &str) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(count)
    }
}
