use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub timestamp: i64,
    pub metadata: Option<String>,
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open(working_dir: &Path) -> Result<Self, String> {
        let db_path = working_dir.join("yiclaw.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open database: {}", e))?;

        // Enable WAL mode for better concurrent read performance
        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .map_err(|e| format!("Failed to set WAL mode: {}", e))?;

        // Enable foreign key constraints (required for ON DELETE CASCADE to work)
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("Failed to enable foreign keys: {}", e))?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_tables()?;
        db.migrate_tables()?;
        db.migrate_from_json(working_dir)?;
        Ok(db)
    }

    fn init_tables(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);

            -- Provider settings (built-in providers)
            CREATE TABLE IF NOT EXISTS provider_settings (
                provider_id TEXT PRIMARY KEY,
                api_key TEXT,
                base_url TEXT,
                extra_models TEXT NOT NULL DEFAULT '[]'
            );

            -- Custom providers (user-defined)
            CREATE TABLE IF NOT EXISTS custom_providers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                default_base_url TEXT NOT NULL DEFAULT '',
                api_key_prefix TEXT NOT NULL DEFAULT '',
                models TEXT NOT NULL DEFAULT '[]',
                is_local INTEGER NOT NULL DEFAULT 0,
                api_key TEXT,
                base_url TEXT
            );

            -- App-level key-value config (active_llm, etc.)
            CREATE TABLE IF NOT EXISTS app_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Cron jobs
            CREATE TABLE IF NOT EXISTS cronjobs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                schedule_json TEXT NOT NULL DEFAULT '{}',
                task_type TEXT NOT NULL DEFAULT 'notify',
                text TEXT,
                request_json TEXT,
                dispatch_json TEXT,
                runtime_json TEXT
            );

            -- Cron job execution history
            CREATE TABLE IF NOT EXISTS cronjob_executions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                status TEXT NOT NULL DEFAULT 'running',
                result TEXT,
                trigger_type TEXT NOT NULL DEFAULT 'scheduled'
            );
            CREATE INDEX IF NOT EXISTS idx_exec_job_id ON cronjob_executions(job_id);
            CREATE INDEX IF NOT EXISTS idx_exec_started ON cronjob_executions(started_at);

            -- Bots (replaces channels in config.json)
            CREATE TABLE IF NOT EXISTS bots (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                platform TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                config_json TEXT NOT NULL DEFAULT '{}',
                persona TEXT DEFAULT NULL,
                access_json TEXT DEFAULT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_bots_platform ON bots(platform);

            -- Heartbeat history
            CREATE TABLE IF NOT EXISTS heartbeat_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                success INTEGER NOT NULL,
                message TEXT,
                target TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_heartbeat_ts ON heartbeat_history(timestamp);

            -- Session-bot bindings (bidirectional channel)
            CREATE TABLE IF NOT EXISTS session_bots (
                session_id TEXT NOT NULL,
                bot_id TEXT NOT NULL,
                bound_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, bot_id),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_session_bots_bot ON session_bots(bot_id);

            -- Sandbox allowed paths
            CREATE TABLE IF NOT EXISTS sandbox_paths (
                path TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL
            );",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;
        Ok(())
    }

    fn migrate_tables(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        // Check if metadata column exists
        let has_metadata: bool = conn
            .prepare("SELECT metadata FROM messages LIMIT 0")
            .is_ok();
        if !has_metadata {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT NULL;
                 ALTER TABLE messages ADD COLUMN exported INTEGER NOT NULL DEFAULT 0;"
            ).map_err(|e| format!("Migration error: {}", e))?;
            log::info!("Migrated messages table: added metadata, exported columns");
        }

        // Add source/source_meta to sessions table
        let has_source: bool = conn
            .prepare("SELECT source FROM sessions LIMIT 0")
            .is_ok();
        if !has_source {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'chat';
                 ALTER TABLE sessions ADD COLUMN source_meta TEXT DEFAULT NULL;"
            ).map_err(|e| format!("Migration error (sessions source): {}", e))?;
            log::info!("Migrated sessions table: added source, source_meta columns");
        }

        // Add last_conversation_id to session_bots table
        let has_last_conv: bool = conn
            .prepare("SELECT last_conversation_id FROM session_bots LIMIT 0")
            .is_ok();
        if !has_last_conv {
            conn.execute_batch(
                "ALTER TABLE session_bots ADD COLUMN last_conversation_id TEXT DEFAULT NULL;"
            ).map_err(|e| format!("Migration error (session_bots): {}", e))?;
            log::info!("Migrated session_bots table: added last_conversation_id column");
        }

        Ok(())
    }

    /// Migrate existing chats.json into the database (one-time)
    fn migrate_from_json(&self, working_dir: &Path) -> Result<(), String> {
        let json_path = working_dir.join("chats.json");
        if !json_path.exists() {
            return Ok(());
        }

        // Check if we already have data
        let count = self.message_count("default")?;
        if count > 0 {
            // Already migrated, remove old file
            std::fs::remove_file(&json_path).ok();
            return Ok(());
        }

        let content = std::fs::read_to_string(&json_path)
            .map_err(|e| format!("Failed to read chats.json: {}", e))?;

        #[derive(Deserialize)]
        struct OldMessage {
            role: String,
            content: String,
            timestamp: Option<u64>,
        }

        let old_messages: Vec<OldMessage> =
            serde_json::from_str(&content).unwrap_or_default();

        if old_messages.is_empty() {
            std::fs::remove_file(&json_path).ok();
            return Ok(());
        }

        let now = now_ts();
        // Create a default session for migrated messages
        self.create_session_with_id("default", "Default", now)?;

        let conn = self.conn.lock().unwrap();
        for msg in &old_messages {
            let ts = msg.timestamp.unwrap_or(now as u64) as i64;
            conn.execute(
                "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?1, ?2, ?3, ?4)",
                params!["default", msg.role, msg.content, ts],
            )
            .map_err(|e| format!("Failed to migrate message: {}", e))?;
        }

        log::info!(
            "Migrated {} messages from chats.json to SQLite",
            old_messages.len()
        );

        // Rename old file as backup
        let backup = working_dir.join("chats.json.bak");
        std::fs::rename(&json_path, &backup).ok();

        Ok(())
    }

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

    pub fn create_session(&self, name: &str) -> Result<ChatSession, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ts();
        self.create_session_with_id(&id, name, now)
    }

    fn create_session_with_id(
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
        let now = now_ts();
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
        // Clean up bot bindings for this session (also handled by ON DELETE CASCADE
        // when foreign_keys is enabled, but we do it explicitly for safety)
        conn.execute("DELETE FROM session_bots WHERE session_id = ?1", params![id])
            .map_err(|e| format!("Failed to delete session bot bindings: {}", e))?;
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete session: {}", e))?;
        Ok(())
    }

    // --- Message CRUD ---

    pub fn get_messages(
        &self,
        session_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<ChatMessage>, String> {
        let conn = self.conn.lock().unwrap();
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
            .filter_map(|r| r.ok())
            .collect();

        Ok(messages)
    }

    /// Get recent N messages for LLM context
    pub fn get_recent_messages(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<ChatMessage>, String> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, role, content, timestamp, metadata FROM messages
                 WHERE session_id = ?1 ORDER BY timestamp DESC LIMIT ?2",
            )
            .map_err(|e| format!("Query error: {}", e))?;

        let mut messages: Vec<ChatMessage> = stmt
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
            .filter_map(|r| r.ok())
            .collect();

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
        let now = now_ts();
        let conn = self.conn.lock().unwrap();

        // Auto-create session if not exists
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, session_id, now, now],
        )
        .map_err(|e| format!("Failed to ensure session: {}", e))?;

        conn.execute(
            "INSERT INTO messages (session_id, role, content, timestamp, metadata) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, role, content, now, metadata],
        )
        .map_err(|e| format!("Failed to insert message: {}", e))?;

        let msg_id = conn.last_insert_rowid();

        // Update session timestamp
        conn.execute(
            "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
            params![now, session_id],
        )
        .map_err(|e| format!("Failed to update session: {}", e))?;

        Ok(msg_id)
    }

    pub fn clear_messages(&self, session_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM messages WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| format!("Failed to clear messages: {}", e))?;
        Ok(())
    }

    pub fn delete_message(&self, message_id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM messages WHERE id = ?1", params![message_id])
            .map_err(|e| format!("Failed to delete message: {}", e))?;
        Ok(())
    }

    fn message_count(&self, session_id: &str) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(count)
    }

    // === Provider Settings ===

    pub fn get_provider_setting(&self, provider_id: &str) -> Option<ProviderSettingRow> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT provider_id, api_key, base_url, extra_models FROM provider_settings WHERE provider_id = ?1",
            params![provider_id],
            |row| {
                Ok(ProviderSettingRow {
                    provider_id: row.get(0)?,
                    api_key: row.get(1)?,
                    base_url: row.get(2)?,
                    extra_models_json: row.get(3)?,
                })
            },
        )
        .ok()
    }

    pub fn get_all_provider_settings(&self) -> Vec<ProviderSettingRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT provider_id, api_key, base_url, extra_models FROM provider_settings")
            .unwrap();
        stmt.query_map([], |row| {
            Ok(ProviderSettingRow {
                provider_id: row.get(0)?,
                api_key: row.get(1)?,
                base_url: row.get(2)?,
                extra_models_json: row.get(3)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn upsert_provider_setting(
        &self,
        provider_id: &str,
        api_key: Option<&str>,
        base_url: Option<&str>,
        extra_models_json: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        // Get existing row
        let existing = conn
            .query_row(
                "SELECT api_key, base_url, extra_models FROM provider_settings WHERE provider_id = ?1",
                params![provider_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?)),
            )
            .ok();

        let (final_key, final_url, final_models) = match existing {
            Some((old_key, old_url, old_models)) => (
                api_key.map(|s| s.to_string()).or(old_key),
                base_url.map(|s| s.to_string()).or(old_url),
                extra_models_json.unwrap_or(&old_models).to_string(),
            ),
            None => (
                api_key.map(|s| s.to_string()),
                base_url.map(|s| s.to_string()),
                extra_models_json.unwrap_or("[]").to_string(),
            ),
        };

        conn.execute(
            "INSERT OR REPLACE INTO provider_settings (provider_id, api_key, base_url, extra_models) VALUES (?1, ?2, ?3, ?4)",
            params![provider_id, final_key, final_url, final_models],
        )
        .map_err(|e| format!("Failed to save provider setting: {}", e))?;
        Ok(())
    }

    // === Custom Providers ===

    pub fn get_all_custom_providers(&self) -> Vec<CustomProviderRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, default_base_url, api_key_prefix, models, is_local, api_key, base_url FROM custom_providers")
            .unwrap();
        stmt.query_map([], |row| {
            Ok(CustomProviderRow {
                id: row.get(0)?,
                name: row.get(1)?,
                default_base_url: row.get(2)?,
                api_key_prefix: row.get(3)?,
                models_json: row.get(4)?,
                is_local: row.get(5)?,
                api_key: row.get(6)?,
                base_url: row.get(7)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn upsert_custom_provider(&self, row: &CustomProviderRow) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO custom_providers (id, name, default_base_url, api_key_prefix, models, is_local, api_key, base_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![row.id, row.name, row.default_base_url, row.api_key_prefix, row.models_json, row.is_local, row.api_key, row.base_url],
        )
        .map_err(|e| format!("Failed to save custom provider: {}", e))?;
        Ok(())
    }

    pub fn delete_custom_provider(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM custom_providers WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete custom provider: {}", e))?;
        Ok(())
    }

    // === App Config (key-value) ===

    pub fn get_config(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM app_config WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok()
    }

    pub fn set_config(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO app_config (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|e| format!("Failed to set config: {}", e))?;
        Ok(())
    }

    /// Migrate providers.json into the database (one-time)
    pub fn migrate_providers_from_json(&self, secret_dir: &Path) -> Result<(), String> {
        let json_path = secret_dir.join("providers.json");
        if !json_path.exists() {
            return Ok(());
        }

        // Check if we already have provider data
        {
            let conn = self.conn.lock().unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM provider_settings", [], |row| row.get(0))
                .unwrap_or(0);
            let custom_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM custom_providers", [], |row| row.get(0))
                .unwrap_or(0);
            let config_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM app_config WHERE key = 'active_llm'", [], |row| row.get(0))
                .unwrap_or(0);
            if count > 0 || custom_count > 0 || config_count > 0 {
                // Already migrated
                let backup = secret_dir.join("providers.json.bak");
                std::fs::rename(&json_path, &backup).ok();
                return Ok(());
            }
        }

        let content = std::fs::read_to_string(&json_path)
            .map_err(|e| format!("Failed to read providers.json: {}", e))?;

        // Reuse the old ProvidersData structure for deserialization
        #[derive(serde::Deserialize, Default)]
        struct OldModelInfo { id: String, name: String }
        #[derive(serde::Deserialize, Default)]
        struct OldProviderSettings {
            #[serde(default)] base_url: Option<String>,
            #[serde(default)] api_key: Option<String>,
            #[serde(default)] extra_models: Vec<OldModelInfo>,
        }
        #[derive(serde::Deserialize, Default)]
        struct OldProviderDef {
            id: String, name: String,
            #[serde(default)] default_base_url: String,
            #[serde(default)] api_key_prefix: String,
            #[serde(default)] models: Vec<OldModelInfo>,
            #[serde(default)] is_local: bool,
        }
        #[derive(serde::Deserialize, Default)]
        struct OldCustom {
            definition: OldProviderDef,
            #[serde(default)] settings: OldProviderSettings,
        }
        #[derive(serde::Deserialize, serde::Serialize, Default)]
        struct OldModelSlot { provider_id: String, model: String }
        #[derive(serde::Deserialize, Default)]
        struct OldData {
            #[serde(default)] providers: std::collections::HashMap<String, OldProviderSettings>,
            #[serde(default)] custom_providers: std::collections::HashMap<String, OldCustom>,
            #[serde(default)] active_llm: Option<OldModelSlot>,
        }

        let old: OldData = serde_json::from_str(&content).unwrap_or_default();

        // Migrate provider settings
        for (pid, settings) in &old.providers {
            let extra_json = serde_json::to_string(&settings.extra_models.iter().map(|m| serde_json::json!({"id": m.id, "name": m.name})).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into());
            self.upsert_provider_setting(pid, settings.api_key.as_deref(), settings.base_url.as_deref(), Some(&extra_json))?;
        }

        // Migrate custom providers
        for (_, custom) in &old.custom_providers {
            let def = &custom.definition;
            let models_json = serde_json::to_string(&def.models.iter().map(|m| serde_json::json!({"id": m.id, "name": m.name})).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into());
            self.upsert_custom_provider(&CustomProviderRow {
                id: def.id.clone(),
                name: def.name.clone(),
                default_base_url: def.default_base_url.clone(),
                api_key_prefix: def.api_key_prefix.clone(),
                models_json,
                is_local: def.is_local,
                api_key: custom.settings.api_key.clone(),
                base_url: custom.settings.base_url.clone(),
            })?;
        }

        // Migrate active_llm
        if let Some(active) = &old.active_llm {
            let val = serde_json::to_string(active).unwrap_or_default();
            self.set_config("active_llm", &val)?;
        }

        log::info!("Migrated providers.json to SQLite ({} providers, {} custom)", old.providers.len(), old.custom_providers.len());
        let backup = secret_dir.join("providers.json.bak");
        std::fs::rename(&json_path, &backup).ok();
        Ok(())
    }

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

    pub fn set_bot_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE bots SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
            params![enabled, now, id],
        )
        .map_err(|e| format!("Failed to update bot: {}", e))?;
        Ok(())
    }

    // === Session-Bot Bindings ===

    /// Bind a bot to a session. A bot can only be bound to one session at a time —
    /// any existing binding for this bot is removed first.
    /// Returns the previous session_id if the bot was re-bound, None if fresh bind.
    pub fn bind_bot_to_session(&self, session_id: &str, bot_id: &str) -> Result<Option<String>, String> {
        let now = now_ts();
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

    // === Cron Jobs ===

    pub fn list_cronjobs(&self) -> Result<Vec<CronJobRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, enabled, schedule_json, task_type, text, request_json, dispatch_json, runtime_json FROM cronjobs")
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(CronJobRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    enabled: row.get(2)?,
                    schedule_json: row.get(3)?,
                    task_type: row.get(4)?,
                    text: row.get(5)?,
                    request_json: row.get(6)?,
                    dispatch_json: row.get(7)?,
                    runtime_json: row.get(8)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn get_cronjob(&self, id: &str) -> Result<Option<CronJobRow>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT id, name, enabled, schedule_json, task_type, text, request_json, dispatch_json, runtime_json FROM cronjobs WHERE id = ?1",
            params![id],
            |row| {
                Ok(CronJobRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    enabled: row.get(2)?,
                    schedule_json: row.get(3)?,
                    task_type: row.get(4)?,
                    text: row.get(5)?,
                    request_json: row.get(6)?,
                    dispatch_json: row.get(7)?,
                    runtime_json: row.get(8)?,
                })
            },
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }

    pub fn upsert_cronjob(&self, row: &CronJobRow) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO cronjobs (id, name, enabled, schedule_json, task_type, text, request_json, dispatch_json, runtime_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![row.id, row.name, row.enabled, row.schedule_json, row.task_type, row.text, row.request_json, row.dispatch_json, row.runtime_json],
        )
        .map_err(|e| format!("Failed to save cronjob: {}", e))?;
        Ok(())
    }

    pub fn delete_cronjob(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM cronjob_executions WHERE job_id = ?1", params![id])
            .map_err(|e| format!("Failed to delete executions: {}", e))?;
        conn.execute("DELETE FROM cronjobs WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete cronjob: {}", e))?;
        Ok(())
    }

    // === Cron Job Executions ===

    pub fn insert_execution(&self, job_id: &str, trigger_type: &str) -> Result<i64, String> {
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO cronjob_executions (job_id, started_at, status, trigger_type) VALUES (?1, ?2, 'running', ?3)",
            params![job_id, now, trigger_type],
        )
        .map_err(|e| format!("Failed to insert execution: {}", e))?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_execution(&self, exec_id: i64, status: &str, result: Option<&str>) -> Result<(), String> {
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE cronjob_executions SET finished_at = ?1, status = ?2, result = ?3 WHERE id = ?4",
            params![now, status, result, exec_id],
        )
        .map_err(|e| format!("Failed to update execution: {}", e))?;
        Ok(())
    }

    pub fn list_executions(&self, job_id: &str, limit: usize) -> Result<Vec<CronJobExecutionRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, job_id, started_at, finished_at, status, result, trigger_type
                 FROM cronjob_executions WHERE job_id = ?1 ORDER BY started_at DESC LIMIT ?2",
            )
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map(params![job_id, limit as i64], |row| {
                Ok(CronJobExecutionRow {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    status: row.get(4)?,
                    result: row.get(5)?,
                    trigger_type: row.get(6)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn delete_executions_by_job(&self, job_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM cronjob_executions WHERE job_id = ?1",
            params![job_id],
        )
        .map_err(|e| format!("Failed to delete executions: {}", e))?;
        Ok(())
    }

    pub fn get_last_execution(&self, job_id: &str) -> Result<Option<CronJobExecutionRow>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT id, job_id, started_at, finished_at, status, result, trigger_type
             FROM cronjob_executions WHERE job_id = ?1 ORDER BY started_at DESC LIMIT 1",
            params![job_id],
            |row| {
                Ok(CronJobExecutionRow {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    status: row.get(4)?,
                    result: row.get(5)?,
                    trigger_type: row.get(6)?,
                })
            },
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }

    pub fn set_cronjob_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE cronjobs SET enabled = ?1 WHERE id = ?2",
            params![enabled, id],
        )
        .map_err(|e| format!("Failed to update cronjob: {}", e))?;
        Ok(())
    }

    // === Heartbeat History ===

    pub fn push_heartbeat(&self, item: &HeartbeatRow) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO heartbeat_history (timestamp, success, message, target) VALUES (?1, ?2, ?3, ?4)",
            params![item.timestamp, item.success, item.message, item.target],
        )
        .map_err(|e| format!("Failed to insert heartbeat: {}", e))?;

        // Keep last 100 entries
        conn.execute(
            "DELETE FROM heartbeat_history WHERE id NOT IN (SELECT id FROM heartbeat_history ORDER BY timestamp DESC LIMIT 100)",
            [],
        )
        .map_err(|e| format!("Failed to trim heartbeat history: {}", e))?;

        Ok(())
    }

    pub fn get_heartbeat_history(&self, limit: usize) -> Result<Vec<HeartbeatRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT timestamp, success, message, target FROM heartbeat_history ORDER BY timestamp DESC LIMIT ?1",
            )
            .map_err(|e| format!("Query error: {}", e))?;

        let rows = stmt
            .query_map(params![limit as i64], |row| {
                Ok(HeartbeatRow {
                    timestamp: row.get(0)?,
                    success: row.get(1)?,
                    message: row.get(2)?,
                    target: row.get(3)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    // === Migration: jobs.json ===

    pub fn migrate_jobs_from_json(&self, working_dir: &Path) -> Result<(), String> {
        let json_path = working_dir.join("jobs.json");
        if !json_path.exists() {
            return Ok(());
        }

        // Check if we already have data
        {
            let conn = self.conn.lock().unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM cronjobs", [], |row| row.get(0))
                .unwrap_or(0);
            if count > 0 {
                let backup = working_dir.join("jobs.json.bak");
                std::fs::rename(&json_path, &backup).ok();
                return Ok(());
            }
        }

        let content = std::fs::read_to_string(&json_path)
            .map_err(|e| format!("Failed to read jobs.json: {}", e))?;

        let jobs_file: serde_json::Value =
            serde_json::from_str(&content).unwrap_or(serde_json::json!({"jobs": []}));

        if let Some(jobs) = jobs_file["jobs"].as_array() {
            for job in jobs {
                let id = job["id"].as_str().unwrap_or("").to_string();
                if id.is_empty() {
                    continue;
                }
                let row = CronJobRow {
                    id,
                    name: job["name"].as_str().unwrap_or("").to_string(),
                    enabled: job["enabled"].as_bool().unwrap_or(false),
                    schedule_json: serde_json::to_string(&job["schedule"]).unwrap_or_else(|_| "{}".into()),
                    task_type: job["task_type"].as_str().unwrap_or("notify").to_string(),
                    text: job["text"].as_str().map(|s| s.to_string()),
                    request_json: job.get("request").map(|v| v.to_string()),
                    dispatch_json: job.get("dispatch").map(|v| v.to_string()),
                    runtime_json: job.get("runtime").map(|v| v.to_string()),
                };
                self.upsert_cronjob(&row)?;
            }
            log::info!("Migrated {} cron jobs from jobs.json to SQLite", jobs.len());
        }

        let backup = working_dir.join("jobs.json.bak");
        std::fs::rename(&json_path, &backup).ok();
        Ok(())
    }

    // === Migration: heartbeat_history.json ===

    pub fn migrate_heartbeat_from_json(&self, working_dir: &Path) -> Result<(), String> {
        let json_path = working_dir.join("heartbeat_history.json");
        if !json_path.exists() {
            return Ok(());
        }

        // Check if we already have data
        {
            let conn = self.conn.lock().unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM heartbeat_history", [], |row| row.get(0))
                .unwrap_or(0);
            if count > 0 {
                let backup = working_dir.join("heartbeat_history.json.bak");
                std::fs::rename(&json_path, &backup).ok();
                return Ok(());
            }
        }

        let content = std::fs::read_to_string(&json_path)
            .map_err(|e| format!("Failed to read heartbeat_history.json: {}", e))?;

        #[derive(Deserialize)]
        struct OldItem {
            timestamp: u64,
            success: bool,
            message: Option<String>,
            #[serde(default)]
            target: String,
        }

        let items: Vec<OldItem> = serde_json::from_str(&content).unwrap_or_default();

        if !items.is_empty() {
            let conn = self.conn.lock().unwrap();
            for item in &items {
                conn.execute(
                    "INSERT INTO heartbeat_history (timestamp, success, message, target) VALUES (?1, ?2, ?3, ?4)",
                    params![item.timestamp as i64, item.success, item.message, item.target],
                )
                .map_err(|e| format!("Failed to migrate heartbeat: {}", e))?;
            }
            log::info!("Migrated {} heartbeat history entries to SQLite", items.len());
        }

        let backup = working_dir.join("heartbeat_history.json.bak");
        std::fs::rename(&json_path, &backup).ok();
        Ok(())
    }

    // --- Sandbox paths ---

    pub fn save_sandbox_path(&self, path: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO sandbox_paths (path, created_at) VALUES (?1, ?2)",
            params![path, now_ts()],
        )
        .map_err(|e| format!("Failed to save sandbox path: {}", e))?;
        Ok(())
    }

    pub fn remove_sandbox_path(&self, path: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM sandbox_paths WHERE path = ?1",
            params![path],
        )
        .map_err(|e| format!("Failed to remove sandbox path: {}", e))?;
        Ok(())
    }

    pub fn list_sandbox_paths(&self) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT path FROM sandbox_paths ORDER BY created_at")
            .unwrap();
        stmt.query_map([], |row| row.get(0))
            .unwrap()
            .flatten()
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct CronJobRow {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub schedule_json: String,
    pub task_type: String,
    pub text: Option<String>,
    pub request_json: Option<String>,
    pub dispatch_json: Option<String>,
    pub runtime_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronJobExecutionRow {
    pub id: i64,
    pub job_id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub result: Option<String>,
    pub trigger_type: String,
}

#[derive(Debug, Clone)]
pub struct HeartbeatRow {
    pub timestamp: i64,
    pub success: bool,
    pub message: Option<String>,
    pub target: String,
}

#[derive(Debug, Clone)]
pub struct ProviderSettingRow {
    pub provider_id: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub extra_models_json: String,
}

#[derive(Debug, Clone)]
pub struct CustomProviderRow {
    pub id: String,
    pub name: String,
    pub default_base_url: String,
    pub api_key_prefix: String,
    pub models_json: String,
    pub is_local: bool,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
