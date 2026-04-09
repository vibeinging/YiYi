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
                "SELECT id, session_id, role, content, timestamp, metadata FROM messages
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
                "SELECT id, session_id, role, content, timestamp, metadata FROM messages
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
