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
    /// 当前会话绑定的具名群(Approach B)。None = 未绑(Phase A 回落:family_mode=1
    /// 时全 active 隐式群,family_mode=0 时普通单聊)。前端据此在 session 列表
    /// 渲染群 emoji + 名前缀。
    #[serde(default)]
    pub group_id: Option<i64>,
    /// 绑定到单个 companion 的私聊会话(好友列表点进去的专属对话)。None = 普通
    /// 单聊(YiYi)或群聊。与 group_id 互斥:绑了 companion = 和该 agent 1:1 私聊。
    #[serde(default)]
    pub companion_id: Option<i64>,
    /// 会话列表预览:最后一条 user/assistant 消息(子查询带出,仅列表/搜索用)。
    #[serde(default)]
    pub last_message: Option<String>,
}

fn default_source() -> String {
    "chat".to_string()
}

impl super::Database {
    // --- Session CRUD ---

    pub fn list_sessions(&self) -> Result<Vec<ChatSession>, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare("SELECT id, name, created_at, updated_at, source, source_meta, group_id, companion_id, (SELECT m.content FROM messages m WHERE m.session_id = sessions.id AND m.role IN ('user','assistant') ORDER BY m.timestamp DESC, m.id DESC LIMIT 1) AS last_message FROM sessions ORDER BY updated_at DESC")
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
                    group_id: row.get(6)?,
                    companion_id: row.get(7)?,
                    last_message: row.get(8)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.map_err(|e| log::warn!("Row parse error: {}", e)).ok())
            .collect();

        Ok(sessions)
    }

    /// List sessions filtered by source type
    pub fn list_sessions_by_source(&self, source: &str) -> Result<Vec<ChatSession>, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare("SELECT id, name, created_at, updated_at, source, source_meta, group_id, companion_id, (SELECT m.content FROM messages m WHERE m.session_id = sessions.id AND m.role IN ('user','assistant') ORDER BY m.timestamp DESC, m.id DESC LIMIT 1) AS last_message FROM sessions WHERE source = ?1 ORDER BY updated_at DESC")
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
                    group_id: row.get(6)?,
                    companion_id: row.get(7)?,
                    last_message: row.get(8)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.map_err(|e| log::warn!("Row parse error: {}", e)).ok())
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
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT id, name, created_at, updated_at, source, source_meta, group_id, companion_id, (SELECT m.content FROM messages m WHERE m.session_id = sessions.id AND m.role IN ('user','assistant') ORDER BY m.timestamp DESC, m.id DESC LIMIT 1) AS last_message \
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
                    group_id: row.get(6)?,
                    companion_id: row.get(7)?,
                    last_message: row.get(8)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.map_err(|e| log::warn!("Row parse error: {}", e)).ok())
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
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let pattern = format!("%{}%", query);
        let mut stmt = conn
            .prepare(
                "SELECT id, name, created_at, updated_at, source, source_meta, group_id, companion_id, (SELECT m.content FROM messages m WHERE m.session_id = sessions.id AND m.role IN ('user','assistant') ORDER BY m.timestamp DESC, m.id DESC LIMIT 1) AS last_message \
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
                    group_id: row.get(6)?,
                    companion_id: row.get(7)?,
                    last_message: row.get(8)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.map_err(|e| log::warn!("Row parse error: {}", e)).ok())
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
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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
            group_id: None,
            companion_id: None,
            last_message: None,
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
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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
            group_id: None,
            companion_id: None,
            last_message: None,
        })
    }

    /// Single-session lookup by id. Returns `Ok(None)` if not found —
    /// callers that don't care to distinguish "missing" from "DB error"
    /// can `.ok().flatten()`.
    pub fn get_session(&self, id: &str) -> Result<Option<ChatSession>, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT id, name, created_at, updated_at, source, source_meta, group_id, companion_id, (SELECT m.content FROM messages m WHERE m.session_id = sessions.id AND m.role IN ('user','assistant') ORDER BY m.timestamp DESC, m.id DESC LIMIT 1) AS last_message \
                 FROM sessions WHERE id = ?1 LIMIT 1",
            )
            .map_err(|e| format!("Query error: {}", e))?;
        let mut rows = stmt
            .query(params![id])
            .map_err(|e| format!("Query error: {}", e))?;
        if let Some(row) = rows.next().map_err(|e| format!("Row error: {}", e))? {
            Ok(Some(ChatSession {
                id: row.get(0).map_err(|e| e.to_string())?,
                name: row.get(1).map_err(|e| e.to_string())?,
                created_at: row.get(2).map_err(|e| e.to_string())?,
                updated_at: row.get(3).map_err(|e| e.to_string())?,
                source: row.get::<_, String>(4).unwrap_or_else(|_| "chat".into()),
                source_meta: row.get(5).map_err(|e| e.to_string())?,
                group_id: row.get(6).map_err(|e| e.to_string())?,
                companion_id: row.get(7).map_err(|e| e.to_string())?,
                last_message: row.get(8).map_err(|e| e.to_string())?,
            }))
        } else {
            Ok(None)
        }
    }

    // --- 好友私聊:session ↔ companion 绑定 ---

    /// 把 session 绑定到单个 companion(好友私聊)。None = 解绑。
    pub fn set_session_companion(&self, id: &str, companion_id: Option<i64>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE sessions SET companion_id = ?1 WHERE id = ?2",
            params![companion_id, id],
        )
        .map_err(|e| format!("Failed to set session companion: {}", e))?;
        Ok(())
    }

    /// 读 session 绑定的 companion id(None = 不是私聊会话)。
    pub fn get_session_companion(&self, id: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT companion_id, (SELECT m.content FROM messages m WHERE m.session_id = sessions.id AND m.role IN ('user','assistant') ORDER BY m.timestamp DESC, m.id DESC LIMIT 1) AS last_message FROM sessions WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
    }

    /// 设本会话的思考覆盖。`None` = 跟随全局默认;`Some("off"/"high"/"max")` = 覆盖。
    pub fn set_session_thinking(&self, id: &str, mode: Option<String>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE sessions SET thinking_mode = ?1 WHERE id = ?2",
            params![mode, id],
        )
        .map_err(|e| format!("Failed to set session thinking: {}", e))?;
        Ok(())
    }

    /// 读本会话的思考覆盖(`None` = 跟随全局默认)。
    pub fn get_session_thinking(&self, id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT thinking_mode FROM sessions WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    /// 找绑定到某 companion 的最近私聊会话;没有就新建一个(名用 companion 名)。
    /// 好友列表点进去用 —— 每个好友一个固定专属会话(像微信)。
    /// 点好友头像 = 每次都新开一段对话。新建一个会话并绑定到该 companion,
    /// 返回 session id(不复用旧会话——产品需求:每次都是新的一段)。
    pub fn create_companion_session(
        &self,
        companion_id: i64,
        companion_name: &str,
    ) -> Result<String, String> {
        let session = self.create_session(companion_name)?;
        self.set_session_companion(&session.id, Some(companion_id))?;
        Ok(session.id)
    }

    pub fn rename_session(&self, id: &str, name: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE sessions SET name = ?1 WHERE id = ?2",
            params![name, id],
        )
        .map_err(|e| format!("Failed to rename session: {}", e))?;
        Ok(())
    }

    pub fn delete_session(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute("DELETE FROM messages WHERE session_id = ?1", params![id])
            .map_err(|e| format!("Failed to delete messages: {}", e))?;
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete session: {}", e))?;
        Ok(())
    }

    // --- 群会话 (family mode) ---
    // 已退役:IM 心智下 group_id 是唯一真相(见 sessions.group_id / get_session_group)。
    // 旧的 get/set_session_family_mode 读写函数已删 —— set 是唯一往 family_mode 列
    // 写的路径,删后该列永不再变脏。DB 列本身保留(SQLite 删列需重表,WAL 下风险高,
    // 且列纯历史残留、零读零写、零风险)。
}
