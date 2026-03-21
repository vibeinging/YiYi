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

    // === Session-Bot Bindings ===

    /// Bind a bot to a session. A bot can only be bound to one session at a time —
    /// any existing binding for this bot is removed first.
    /// Returns the previous session_id if the bot was re-bound, None if fresh bind.
    pub fn bind_bot_to_session(&self, session_id: &str, bot_id: &str) -> Result<Option<String>, String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap();

        // Check for existing binding
        let prev_session: Option<String> = conn
            .query_row(
                "SELECT session_id FROM session_bots WHERE bot_id = ?1",
                params![bot_id],
                |row| row.get(0),
            )
            .ok();

        // Remove any existing binding for this bot (enforce one-bot-one-session)
        conn.execute(
            "DELETE FROM session_bots WHERE bot_id = ?1",
            params![bot_id],
        )
        .map_err(|e| format!("Failed to unbind bot: {}", e))?;

        conn.execute(
            "INSERT INTO session_bots (session_id, bot_id, bound_at) VALUES (?1, ?2, ?3)",
            params![session_id, bot_id, now],
        )
        .map_err(|e| format!("Failed to bind bot to session: {}", e))?;

        // Return previous session only if it was different
        Ok(prev_session.filter(|s| s != session_id))
    }

    /// Update the last conversation target for a bound bot (e.g. "c2c:xxx", "group:xxx").
    pub fn update_bot_last_conversation(&self, bot_id: &str, conversation_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE session_bots SET last_conversation_id = ?1 WHERE bot_id = ?2",
            params![conversation_id, bot_id],
        )
        .map_err(|e| format!("Failed to update last_conversation_id: {}", e))?;
        Ok(())
    }

    pub fn unbind_bot_from_session(&self, session_id: &str, bot_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM session_bots WHERE session_id = ?1 AND bot_id = ?2",
            params![session_id, bot_id],
        )
        .map_err(|e| format!("Failed to unbind bot from session: {}", e))?;
        Ok(())
    }

    pub fn list_session_bots(&self, session_id: &str) -> Result<Vec<BotRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT b.id, b.name, b.platform, b.enabled, b.config_json, b.persona, b.access_json, b.created_at, b.updated_at
                 FROM bots b INNER JOIN session_bots sb ON b.id = sb.bot_id
                 WHERE sb.session_id = ?1
                 ORDER BY sb.bound_at"
            )
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map(params![session_id], |row| {
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

    /// Get the last conversation_id for a bot binding.
    pub fn get_bot_last_conversation(&self, bot_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT last_conversation_id FROM session_bots WHERE bot_id = ?1 AND last_conversation_id IS NOT NULL",
            params![bot_id],
            |row| row.get::<_, String>(0),
        ).ok()
    }

    /// Find the session a bot is bound to (if any). Returns the first binding found.
    pub fn get_session_for_bot(&self, bot_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT session_id FROM session_bots WHERE bot_id = ?1 ORDER BY bound_at LIMIT 1",
            params![bot_id],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }
}
