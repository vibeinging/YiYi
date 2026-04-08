use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub source_meta: Option<String>,
}

fn default_source() -> String {
    "chat".to_string()
}

impl super::Database {
    // --- Session CRUD ---

    pub fn list_sessions(&self) -> Result<Vec<ChatSession>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, created_at, updated_at, source, source_meta FROM sessions ORDER BY updated_at DESC")
            .map_err(|e| format!("Query error: {}", e))?;

        let sessions = stmt
            .query_map([], |row| {
                Ok(ChatSession {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    source: row.get::<_, String>(4).unwrap_or_else(|_| "chat".into()),
                    source_meta: row.get(5)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(sessions)
    }

    /// List sessions filtered by source type
    pub fn list_sessions_by_source(&self, source: &str) -> Result<Vec<ChatSession>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, created_at, updated_at, source, source_meta FROM sessions WHERE source = ?1 ORDER BY updated_at DESC")
            .map_err(|e| format!("Query error: {}", e))?;

        let sessions = stmt
            .query_map(params![source], |row| {
                Ok(ChatSession {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    source: row.get::<_, String>(4).unwrap_or_else(|_| "chat".into()),
                    source_meta: row.get(5)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(sessions)
    }

    /// List sessions by source with pagination (offset + limit)
    pub fn list_sessions_by_source_paged(
        &self,
        source: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<ChatSession>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, created_at, updated_at, source, source_meta \
                 FROM sessions WHERE source = ?1 \
                 ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3",
            )
            .map_err(|e| format!("Query error: {}", e))?;

        let sessions = stmt
            .query_map(params![source, limit, offset], |row| {
                Ok(ChatSession {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    source: row.get::<_, String>(4).unwrap_or_else(|_| "chat".into()),
                    source_meta: row.get(5)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(sessions)
    }

    /// Search sessions by name (LIKE match) filtered by source
    pub fn search_sessions(
        &self,
        source: &str,
        query: &str,
        limit: i64,
    ) -> Result<Vec<ChatSession>, String> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("%{}%", query);
        let mut stmt = conn
            .prepare(
                "SELECT id, name, created_at, updated_at, source, source_meta \
                 FROM sessions WHERE source = ?1 AND name LIKE ?2 \
                 ORDER BY updated_at DESC LIMIT ?3",
            )
            .map_err(|e| format!("Query error: {}", e))?;

        let sessions = stmt
            .query_map(params![source, pattern, limit], |row| {
                Ok(ChatSession {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    source: row.get::<_, String>(4).unwrap_or_else(|_| "chat".into()),
                    source_meta: row.get(5)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(sessions)
    }

    pub fn create_session(&self, name: &str) -> Result<ChatSession, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = super::now_ts();
        self.create_session_with_id(&id, name, now)
    }

    pub(super) fn create_session_with_id(
        &self,
        id: &str,
        name: &str,
        now: i64,
    ) -> Result<ChatSession, String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, name, created_at, updated_at, source) VALUES (?1, ?2, ?3, ?4, 'chat')",
            params![id, name, now, now],
        )
        .map_err(|e| format!("Failed to create session: {}", e))?;

        Ok(ChatSession {
            id: id.to_string(),
            name: name.to_string(),
            created_at: now,
            updated_at: now,
            source: "chat".into(),
            source_meta: None,
        })
    }

    /// Create or ensure a session exists with a specific source (bot, cronjob, etc.)
    pub fn ensure_session(
        &self,
        id: &str,
        name: &str,
        source: &str,
        source_meta: Option<&str>,
    ) -> Result<ChatSession, String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, name, created_at, updated_at, source, source_meta) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name, now, now, source, source_meta],
        )
        .map_err(|e| format!("Failed to ensure session: {}", e))?;

        Ok(ChatSession {
            id: id.to_string(),
            name: name.to_string(),
            created_at: now,
            updated_at: now,
            source: source.to_string(),
            source_meta: source_meta.map(|s| s.to_string()),
        })
    }

    pub fn rename_session(&self, id: &str, name: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET name = ?1 WHERE id = ?2",
            params![name, id],
        )
        .map_err(|e| format!("Failed to rename session: {}", e))?;
        Ok(())
    }

    pub fn delete_session(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM messages WHERE session_id = ?1", params![id])
            .map_err(|e| format!("Failed to delete messages: {}", e))?;
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete session: {}", e))?;
        Ok(())
    }
}
