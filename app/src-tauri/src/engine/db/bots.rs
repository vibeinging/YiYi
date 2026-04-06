use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotRow {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub enabled: bool,
    pub config_json: String,
    pub persona: Option<String>,
    pub access_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl super::Database {
    // === Bots ===

    pub fn list_bots(&self) -> Result<Vec<BotRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, platform, enabled, config_json, persona, access_json, created_at, updated_at FROM bots ORDER BY created_at DESC")
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(BotRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    platform: row.get(2)?,
                    enabled: row.get(3)?,
                    config_json: row.get(4)?,
                    persona: row.get(5)?,
                    access_json: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn get_bot(&self, id: &str) -> Result<Option<BotRow>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT id, name, platform, enabled, config_json, persona, access_json, created_at, updated_at FROM bots WHERE id = ?1",
            params![id],
            |row| {
                Ok(BotRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    platform: row.get(2)?,
                    enabled: row.get(3)?,
                    config_json: row.get(4)?,
                    persona: row.get(5)?,
                    access_json: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }

    pub fn upsert_bot(&self, row: &BotRow) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO bots (id, name, platform, enabled, config_json, persona, access_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![row.id, row.name, row.platform, row.enabled, row.config_json, row.persona, row.access_json, row.created_at, row.updated_at],
        )
        .map_err(|e| format!("Failed to save bot: {}", e))?;
        Ok(())
    }

    pub fn delete_bot(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM bots WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete bot: {}", e))?;
        Ok(())
    }

    // === Bot Conversations ===
    // Each (bot_id, external_id) pair = one conversation with its own session.

    /// Find or create a conversation for a (bot_id, external_id) pair.
    /// Auto-creates a session for the conversation if it doesn't exist.
    pub fn upsert_conversation(
        &self,
        bot_id: &str,
        external_id: &str,
        platform: &str,
        display_name: Option<&str>,
    ) -> Result<BotConversationRow, String> {
        let conn = self.conn.lock().unwrap();
        let now = super::now_ts();

        // Try to find existing
        let existing: Option<BotConversationRow> = conn
            .query_row(
                "SELECT id, bot_id, external_id, platform, display_name, session_id, \
                 linked_session_id, trigger_mode, last_message_at, message_count, created_at \
                 FROM bot_conversations WHERE bot_id = ?1 AND external_id = ?2",
                params![bot_id, external_id],
                |row| Ok(Self::row_to_conversation(row)),
            )
            .ok();

        if let Some(mut conv) = existing {
            // Update display_name if provided and different
            if let Some(name) = display_name {
                if conv.display_name.as_deref() != Some(name) {
                    conn.execute(
                        "UPDATE bot_conversations SET display_name = ?1 WHERE id = ?2",
                        params![name, conv.id],
                    ).ok();
                    conv.display_name = Some(name.to_string());
                }
            }
            return Ok(conv);
        }

        // Create new conversation with auto-generated session
        let conv_id = uuid::Uuid::new_v4().to_string();
        let session_id = format!("bot:{}:{}", bot_id, external_id);

        conn.execute(
            "INSERT INTO bot_conversations \
             (id, bot_id, external_id, platform, display_name, session_id, trigger_mode, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'mention', ?7)",
            params![conv_id, bot_id, external_id, platform, display_name, session_id, now],
        ).map_err(|e| format!("Failed to create conversation: {}", e))?;

        Ok(BotConversationRow {
            id: conv_id,
            bot_id: bot_id.to_string(),
            external_id: external_id.to_string(),
            platform: platform.to_string(),
            display_name: display_name.map(String::from),
            session_id,
            linked_session_id: None,
            trigger_mode: "mention".to_string(),
            last_message_at: None,
            message_count: 0,
            created_at: now,
        })
    }

    /// List conversations, optionally filtered by bot_id.
    pub fn list_conversations(&self, bot_id: Option<&str>) -> Result<Vec<BotConversationRow>, String> {
        let conn = self.conn.lock().unwrap();
        let sql = if bot_id.is_some() {
            "SELECT id, bot_id, external_id, platform, display_name, session_id, \
             linked_session_id, trigger_mode, last_message_at, message_count, created_at \
             FROM bot_conversations WHERE bot_id = ?1 ORDER BY last_message_at DESC NULLS LAST"
        } else {
            "SELECT id, bot_id, external_id, platform, display_name, session_id, \
             linked_session_id, trigger_mode, last_message_at, message_count, created_at \
             FROM bot_conversations ORDER BY last_message_at DESC NULLS LAST"
        };
        let mut stmt = conn.prepare(sql).map_err(|e| format!("Query error: {}", e))?;
        let rows: Vec<BotConversationRow> = if let Some(bid) = bot_id {
            stmt.query_map(params![bid], |row| Ok(Self::row_to_conversation(row)))
                .map_err(|e| format!("Query error: {}", e))?
                .filter_map(|r| r.ok())
                .collect()
        } else {
            stmt.query_map([], |row| Ok(Self::row_to_conversation(row)))
                .map_err(|e| format!("Query error: {}", e))?
                .filter_map(|r| r.ok())
                .collect()
        };
        Ok(rows)
    }

    /// Get a conversation by its (bot_id, external_id) pair.
    pub fn get_conversation_by_external(&self, bot_id: &str, external_id: &str) -> Result<Option<BotConversationRow>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT id, bot_id, external_id, platform, display_name, session_id, \
             linked_session_id, trigger_mode, last_message_at, message_count, created_at \
             FROM bot_conversations WHERE bot_id = ?1 AND external_id = ?2",
            params![bot_id, external_id],
            |row| Ok(Self::row_to_conversation(row)),
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }

    /// Get a conversation by its primary ID.
    pub fn get_conversation(&self, id: &str) -> Result<Option<BotConversationRow>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT id, bot_id, external_id, platform, display_name, session_id, \
             linked_session_id, trigger_mode, last_message_at, message_count, created_at \
             FROM bot_conversations WHERE id = ?1",
            params![id],
            |row| Ok(Self::row_to_conversation(row)),
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }

    /// Update the trigger mode for a conversation.
    pub fn update_conversation_trigger(&self, id: &str, trigger_mode: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE bot_conversations SET trigger_mode = ?1 WHERE id = ?2",
            params![trigger_mode, id],
        ).map_err(|e| format!("Failed to update trigger mode: {}", e))?;
        Ok(())
    }

    /// Link (or unlink) a conversation to a main chat session.
    pub fn link_conversation(&self, id: &str, linked_session_id: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE bot_conversations SET linked_session_id = ?1 WHERE id = ?2",
            params![linked_session_id, id],
        ).map_err(|e| format!("Failed to link conversation: {}", e))?;
        Ok(())
    }

    /// Delete a conversation record.
    pub fn delete_conversation(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM bot_conversations WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete conversation: {}", e))?;
        Ok(())
    }

    /// Update activity timestamp and increment message count.
    pub fn update_conversation_activity(&self, bot_id: &str, external_id: &str) -> Result<(), String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE bot_conversations SET last_message_at = ?1, message_count = message_count + 1 \
             WHERE bot_id = ?2 AND external_id = ?3",
            params![now, bot_id, external_id],
        ).map_err(|e| format!("Failed to update conversation activity: {}", e))?;
        Ok(())
    }

    fn row_to_conversation(row: &rusqlite::Row) -> BotConversationRow {
        BotConversationRow {
            id: row.get(0).unwrap_or_default(),
            bot_id: row.get(1).unwrap_or_default(),
            external_id: row.get(2).unwrap_or_default(),
            platform: row.get(3).unwrap_or_default(),
            display_name: row.get(4).ok(),
            session_id: row.get(5).unwrap_or_default(),
            linked_session_id: row.get(6).ok(),
            trigger_mode: row.get(7).unwrap_or_else(|_| "mention".to_string()),
            last_message_at: row.get(8).ok(),
            message_count: row.get(9).unwrap_or(0),
            created_at: row.get(10).unwrap_or(0),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotConversationRow {
    pub id: String,
    pub bot_id: String,
    pub external_id: String,
    pub platform: String,
    pub display_name: Option<String>,
    pub session_id: String,
    pub linked_session_id: Option<String>,
    pub trigger_mode: String,
    pub last_message_at: Option<i64>,
    pub message_count: i64,
    pub created_at: i64,
}
