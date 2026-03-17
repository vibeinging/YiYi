use rusqlite::{params, Connection, OptionalExtension};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizedFolderRow {
    pub id: String,
    pub path: String,
    pub label: Option<String>,
    pub permission: String, // "read_only" | "read_write"
    pub is_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SensitivePathRow {
    pub id: String,
    pub pattern: String,
    pub is_builtin: bool,
    pub enabled: bool,
    pub created_at: i64,
}

pub struct Database {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub plan: Option<String>, // JSON string
    pub current_stage: i32,
    pub total_stages: i32,
    pub progress: f64,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
    #[serde(default = "default_task_type")]
    pub task_type: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub last_activity_at: i64,
    pub workspace_path: Option<String>,
}

fn default_task_type() -> String {
    "oneoff".to_string()
}

impl Database {
    /// Get a locked connection handle (for ad-hoc queries in growth system etc.)
    pub fn get_conn(&self) -> Option<std::sync::MutexGuard<'_, Connection>> {
        self.conn.lock().ok()
    }

    pub fn open(working_dir: &Path) -> Result<Self, String> {
        let db_path = working_dir.join("yiyiclaw.db");
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
        db.migrate_sandbox_to_authorized_folders();
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
            );

            -- Authorized folders (workspace authorization)
            CREATE TABLE IF NOT EXISTS authorized_folders (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                label TEXT,
                permission TEXT NOT NULL DEFAULT 'read_write',
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            -- Sensitive path patterns
            CREATE TABLE IF NOT EXISTS sensitive_paths (
                id TEXT PRIMARY KEY,
                pattern TEXT NOT NULL UNIQUE,
                is_builtin INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            );

            -- Memory entries (structured knowledge store)
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                content TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'fact',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
            CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
            CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);

            -- Unified users: cross-platform identity linkage
            CREATE TABLE IF NOT EXISTS unified_users (
                id TEXT PRIMARY KEY,
                display_name TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS user_identities (
                platform TEXT NOT NULL,
                platform_user_id TEXT NOT NULL,
                unified_user_id TEXT NOT NULL,
                bot_id TEXT NOT NULL,
                display_name TEXT,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (platform, platform_user_id, bot_id),
                FOREIGN KEY (unified_user_id) REFERENCES unified_users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_user_identities_unified ON user_identities(unified_user_id);
            CREATE INDEX IF NOT EXISTS idx_user_identities_lookup ON user_identities(platform, platform_user_id, bot_id);",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;

        // Create FTS5 virtual table for full-text search on memories.
        // Uses unicode61 tokenizer which handles CJK (Chinese/Japanese/Korean) and Latin text.
        // We use a content-sync (external content) approach: the FTS index mirrors
        // the `memories` table so we can do BM25 ranking while keeping a single
        // source-of-truth in the regular table.
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                content,
                category,
                content='memories',
                content_rowid='rowid',
                tokenize='unicode61'
            );"
        )
        .map_err(|e| format!("Failed to create FTS5 table: {}", e))?;

        // Triggers to keep FTS index in sync with the memories table.
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
                INSERT INTO memories_fts(rowid, content, category)
                VALUES (new.rowid, new.content, new.category);
            END;
            CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content, category)
                VALUES ('delete', old.rowid, old.content, old.category);
            END;
            CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content, category)
                VALUES ('delete', old.rowid, old.content, old.category);
                INSERT INTO memories_fts(rowid, content, category)
                VALUES (new.rowid, new.content, new.category);
            END;"
        )
        .map_err(|e| format!("Failed to create FTS triggers: {}", e))?;

        // Persistent agents tables
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS persistent_agents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                task_description TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'planning',
                workspace_dir TEXT NOT NULL,
                config TEXT NOT NULL DEFAULT '{}',
                task_plan TEXT,
                total_steps INTEGER DEFAULT 0,
                completed_steps INTEGER DEFAULT 0,
                total_tokens_used INTEGER DEFAULT 0,
                total_cost_usd REAL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                session_id TEXT,
                heartbeat_job_id TEXT
            );

            CREATE TABLE IF NOT EXISTS agent_progress (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT NOT NULL,
                step_index INTEGER NOT NULL,
                step_title TEXT NOT NULL,
                status TEXT NOT NULL,
                result_summary TEXT,
                tokens_used INTEGER DEFAULT 0,
                duration_secs INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_agent_progress_agent ON agent_progress(agent_id);

            CREATE TABLE IF NOT EXISTS agent_feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT NOT NULL,
                message TEXT NOT NULL,
                processed INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_agent_feedback_agent ON agent_feedback(agent_id);",
        )
        .map_err(|e| format!("Failed to create persistent agent tables: {}", e))?;

        // Tasks table
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                session_id TEXT NOT NULL,
                parent_session_id TEXT,
                plan TEXT,
                current_stage INTEGER DEFAULT 0,
                total_stages INTEGER DEFAULT 0,
                progress REAL DEFAULT 0.0,
                error_message TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_parent_session ON tasks(parent_session_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);",
        )
        .map_err(|e| format!("Failed to create tasks table: {}", e))?;

        // Reflections table — post-task self-assessment
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS reflections (
                id TEXT PRIMARY KEY,
                task_id TEXT,
                session_id TEXT,
                outcome TEXT NOT NULL DEFAULT 'success',
                summary TEXT NOT NULL,
                lesson TEXT,
                skill_opportunity TEXT,
                user_feedback TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_reflections_outcome ON reflections(outcome);
            CREATE INDEX IF NOT EXISTS idx_reflections_created ON reflections(created_at);",
        )
        .map_err(|e| format!("Failed to create reflections table: {}", e))?;

        // Corrections table — behavioral rules learned from feedback
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS corrections (
                id TEXT PRIMARY KEY,
                trigger_pattern TEXT NOT NULL,
                wrong_behavior TEXT,
                correct_behavior TEXT NOT NULL,
                source TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                hit_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_corrections_active ON corrections(active);",
        )
        .map_err(|e| format!("Failed to create corrections table: {}", e))?;

        // Code registry — tracks scripts/tools YiYi has created
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS code_registry (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                description TEXT NOT NULL,
                language TEXT NOT NULL DEFAULT 'python',
                invoke_hint TEXT,
                skill_name TEXT,
                run_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_code_registry_name ON code_registry(name);
            CREATE INDEX IF NOT EXISTS idx_code_registry_skill ON code_registry(skill_name);",
        )
        .map_err(|e| format!("Failed to create code_registry table: {}", e))?;

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

        // Add execution_mode to cronjobs table
        let has_execution_mode: bool = conn
            .prepare("SELECT execution_mode FROM cronjobs LIMIT 0")
            .is_ok();
        if !has_execution_mode {
            conn.execute_batch(
                "ALTER TABLE cronjobs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'shared';"
            ).map_err(|e| format!("Migration error (cronjobs execution_mode): {}", e))?;
            log::info!("Migrated cronjobs table: added execution_mode column");
        }

        // Add task_type, pinned, last_activity_at to tasks table
        let has_task_type: bool = conn
            .prepare("SELECT task_type FROM tasks LIMIT 0")
            .is_ok();
        if !has_task_type {
            conn.execute_batch(
                "ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT 'oneoff';
                 ALTER TABLE tasks ADD COLUMN pinned INTEGER DEFAULT 0;
                 ALTER TABLE tasks ADD COLUMN last_activity_at INTEGER DEFAULT 0;"
            ).map_err(|e| format!("Migration error (tasks new fields): {}", e))?;
            // Backfill last_activity_at from updated_at
            conn.execute_batch(
                "UPDATE tasks SET last_activity_at = updated_at WHERE last_activity_at = 0;"
            ).map_err(|e| format!("Migration backfill error: {}", e))?;
            log::info!("Migrated tasks table: added task_type, pinned, last_activity_at columns");
        }

        // Add workspace_path to tasks table
        let has_workspace_path: bool = conn
            .prepare("SELECT workspace_path FROM tasks LIMIT 0")
            .is_ok();
        if !has_workspace_path {
            conn.execute_batch(
                "ALTER TABLE tasks ADD COLUMN workspace_path TEXT;"
            ).map_err(|e| format!("Migration error (tasks workspace_path): {}", e))?;
            log::info!("Migrated tasks table: added workspace_path column");
        }

        // Growth System: add access_count and last_accessed_at to memories table
        let has_access_count: bool = conn
            .prepare("SELECT access_count FROM memories LIMIT 0")
            .is_ok();
        if !has_access_count {
            conn.execute_batch(
                "ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER DEFAULT NULL;"
            ).map_err(|e| format!("Migration error (memories growth): {}", e))?;
            log::info!("Migrated memories table: added access_count, last_accessed_at columns");
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

    /// Get recent N messages for LLM context.
    /// Stops at the most recent `context_reset` boundary so earlier messages
    /// are excluded from the conversation context sent to the LLM.
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
            .filter_map(|r| r.ok())
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
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
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
            .prepare("SELECT id, name, enabled, schedule_json, task_type, text, request_json, dispatch_json, runtime_json, execution_mode FROM cronjobs")
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
                    execution_mode: ExecutionMode::from_str_lossy(&row.get::<_, String>(9)?),
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
            "SELECT id, name, enabled, schedule_json, task_type, text, request_json, dispatch_json, runtime_json, execution_mode FROM cronjobs WHERE id = ?1",
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
                    execution_mode: ExecutionMode::from_str_lossy(&row.get::<_, String>(9)?),
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
            "INSERT OR REPLACE INTO cronjobs (id, name, enabled, schedule_json, task_type, text, request_json, dispatch_json, runtime_json, execution_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![row.id, row.name, row.enabled, row.schedule_json, row.task_type, row.text, row.request_json, row.dispatch_json, row.runtime_json, row.execution_mode.to_string()],
        )
        .map_err(|e| format!("Failed to save cronjob: {}", e))?;
        Ok(())
    }

    pub fn delete_cronjob(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()
            .map_err(|e| format!("Failed to begin transaction: {}", e))?;
        let session_id = format!("cron:{}", id);
        tx.execute("DELETE FROM messages WHERE session_id = ?1", params![session_id])
            .map_err(|e| format!("Failed to delete cron messages: {}", e))?;
        tx.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
            .map_err(|e| format!("Failed to delete cron session: {}", e))?;
        tx.execute("DELETE FROM cronjob_executions WHERE job_id = ?1", params![id])
            .map_err(|e| format!("Failed to delete executions: {}", e))?;
        tx.execute("DELETE FROM cronjobs WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete cronjob: {}", e))?;
        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;
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

        // Prune old executions: keep only the latest 100 for the affected job
        // First, look up the job_id from the execution record
        let job_id: Option<String> = conn.query_row(
            "SELECT job_id FROM cronjob_executions WHERE id = ?1",
            params![exec_id],
            |row| row.get(0),
        ).ok();

        if let Some(job_id) = job_id {
            conn.execute(
                "DELETE FROM cronjob_executions WHERE job_id = ?1 AND id NOT IN (
                    SELECT id FROM cronjob_executions WHERE job_id = ?1 ORDER BY started_at DESC LIMIT 100
                )",
                params![job_id],
            )
            .map_err(|e| format!("Failed to prune old executions: {}", e))?;
        }

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
                    execution_mode: ExecutionMode::from_str_lossy(job["execution_mode"].as_str().unwrap_or("shared")),
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

    // === Migration: file-based memory → FTS5 SQLite ===

    /// Migrate existing file-based memory entries (MEMORY.md, memory/topics/*.md)
    /// into the memories table with FTS5 indexing. One-time operation.
    pub fn migrate_memory_from_files(&self, working_dir: &Path) -> Result<(), String> {
        // Check if we already have memory data
        {
            let conn = self.conn.lock().unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
                .unwrap_or(0);
            if count > 0 {
                return Ok(()); // Already migrated or has data
            }
        }

        let mut migrated = 0;

        // Migrate MEMORY.md (top-level memory file)
        let memory_md = working_dir.join("MEMORY.md");
        if memory_md.exists() {
            if let Ok(content) = std::fs::read_to_string(&memory_md) {
                // Split by headings or paragraphs to create separate memory entries
                for section in split_into_memory_entries(&content) {
                    if !section.trim().is_empty() {
                        self.memory_add(section.trim(), "note", None).ok();
                        migrated += 1;
                    }
                }
            }
        }

        // Migrate memory/topics/*.md files
        let topics_dir = working_dir.join("memory").join("topics");
        if topics_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&topics_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map_or(false, |e| e == "md") {
                        if let Ok(content) = std::fs::read_to_string(&path) {
                            let topic = path
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string();
                            // Infer category from topic name
                            let category = infer_category_from_topic(&topic);
                            for section in split_into_memory_entries(&content) {
                                if !section.trim().is_empty() {
                                    self.memory_add(section.trim(), category, None).ok();
                                    migrated += 1;
                                }
                            }
                        }
                    }
                }
            }
        }

        if migrated > 0 {
            log::info!(
                "Migrated {} memory entries from files to SQLite FTS5",
                migrated
            );
        }

        Ok(())
    }

    // --- Sandbox paths ---

    // --- Authorized folders CRUD ---

    pub fn list_authorized_folders(&self) -> Vec<AuthorizedFolderRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, path, label, permission, is_default, created_at, updated_at
                 FROM authorized_folders ORDER BY created_at",
            )
            .unwrap();
        stmt.query_map([], |row| {
            Ok(AuthorizedFolderRow {
                id: row.get(0)?,
                path: row.get(1)?,
                label: row.get(2)?,
                permission: row.get(3)?,
                is_default: row.get::<_, i32>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .unwrap()
        .flatten()
        .collect()
    }

    pub fn get_authorized_folder(&self, id: &str) -> Result<Option<AuthorizedFolderRow>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT id, path, label, permission, is_default, created_at, updated_at
             FROM authorized_folders WHERE id = ?1",
            params![id],
            |row| {
                Ok(AuthorizedFolderRow {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    label: row.get(2)?,
                    permission: row.get(3)?,
                    is_default: row.get::<_, i32>(4)? != 0,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }

    pub fn upsert_authorized_folder(&self, folder: &AuthorizedFolderRow) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO authorized_folders (id, path, label, permission, is_default, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET path=excluded.path, label=excluded.label,
             permission=excluded.permission, is_default=excluded.is_default, updated_at=excluded.updated_at",
            params![
                folder.id,
                folder.path,
                folder.label,
                folder.permission,
                folder.is_default as i32,
                folder.created_at,
                folder.updated_at,
            ],
        )
        .map_err(|e| format!("Failed to upsert authorized folder: {}", e))?;
        Ok(())
    }

    pub fn remove_authorized_folder(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM authorized_folders WHERE id = ?1",
            params![id],
        )
        .map_err(|e| format!("Failed to remove authorized folder: {}", e))?;
        Ok(())
    }

    // --- Sensitive paths CRUD ---

    pub fn list_sensitive_paths(&self) -> Vec<SensitivePathRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, pattern, is_builtin, enabled, created_at
                 FROM sensitive_paths ORDER BY created_at",
            )
            .unwrap();
        stmt.query_map([], |row| {
            Ok(SensitivePathRow {
                id: row.get(0)?,
                pattern: row.get(1)?,
                is_builtin: row.get::<_, i32>(2)? != 0,
                enabled: row.get::<_, i32>(3)? != 0,
                created_at: row.get(4)?,
            })
        })
        .unwrap()
        .flatten()
        .collect()
    }

    pub fn upsert_sensitive_path(&self, row: &SensitivePathRow) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sensitive_paths (id, pattern, is_builtin, enabled, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET pattern=excluded.pattern, is_builtin=excluded.is_builtin,
             enabled=excluded.enabled",
            params![
                row.id,
                row.pattern,
                row.is_builtin as i32,
                row.enabled as i32,
                row.created_at,
            ],
        )
        .map_err(|e| format!("Failed to upsert sensitive path: {}", e))?;
        Ok(())
    }

    pub fn remove_sensitive_path(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM sensitive_paths WHERE id = ?1",
            params![id],
        )
        .map_err(|e| format!("Failed to remove sensitive path: {}", e))?;
        Ok(())
    }

    pub fn toggle_sensitive_path(&self, id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sensitive_paths SET enabled = ?1 WHERE id = ?2",
            params![enabled as i32, id],
        )
        .map_err(|e| format!("Failed to toggle sensitive path: {}", e))?;
        Ok(())
    }

    /// Seed built-in sensitive path patterns (idempotent).
    pub fn seed_builtin_sensitive_patterns(&self) {
        let builtin_patterns = [
            "**/.env",
            "**/.env.*",
            "**/*.pem",
            "**/*.key",
            "**/credentials.json",
            "**/service_account*.json",
            "~/.ssh/**",
            "~/.gnupg/**",
            "~/.aws/credentials",
            "~/.npmrc",
            "~/.pypirc",
        ];
        let conn = self.conn.lock().unwrap();
        for pattern in &builtin_patterns {
            let exists: bool = conn
                .prepare("SELECT 1 FROM sensitive_paths WHERE pattern = ?1")
                .and_then(|mut stmt| stmt.exists(params![pattern]))
                .unwrap_or(false);
            if !exists {
                conn.execute(
                    "INSERT INTO sensitive_paths (id, pattern, is_builtin, enabled, created_at)
                     VALUES (?1, ?2, 1, 1, ?3)",
                    params![uuid::Uuid::new_v4().to_string(), pattern, now_ts()],
                )
                .ok();
            }
        }
    }

    /// Migrate old sandbox_paths entries to authorized_folders (one-time).
    fn migrate_sandbox_to_authorized_folders(&self) {
        let conn = self.conn.lock().unwrap();
        let sandbox_paths: Vec<String> = conn
            .prepare("SELECT path FROM sandbox_paths")
            .and_then(|mut stmt| {
                stmt.query_map([], |row| row.get::<_, String>(0))
                    .map(|rows| rows.flatten().collect())
            })
            .unwrap_or_default();

        if sandbox_paths.is_empty() {
            return;
        }

        let now = now_ts();
        for path in &sandbox_paths {
            let exists: bool = conn
                .prepare("SELECT 1 FROM authorized_folders WHERE path = ?1")
                .and_then(|mut stmt| stmt.exists(params![path]))
                .unwrap_or(false);
            if !exists {
                conn.execute(
                    "INSERT INTO authorized_folders (id, path, label, permission, is_default, created_at, updated_at)
                     VALUES (?1, ?2, NULL, 'read_write', 0, ?3, ?4)",
                    params![uuid::Uuid::new_v4().to_string(), path, now, now],
                )
                .ok();
            }
        }

        log::info!(
            "Migrated {} sandbox_paths entries to authorized_folders",
            sandbox_paths.len()
        );
    }

    // === Memory CRUD (FTS5-backed) ===

    /// Add a memory entry. Returns the generated id.
    pub fn memory_add(
        &self,
        content: &str,
        category: &str,
        session_id: Option<&str>,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO memories (id, session_id, content, category, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, session_id, content, category, now, now],
        )
        .map_err(|e| format!("Failed to add memory: {}", e))?;
        Ok(id)
    }

    /// Search memories using FTS5 MATCH with BM25 ranking.
    /// Returns up to `limit` results ordered by relevance score.
    pub fn memory_search(
        &self,
        query: &str,
        category: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MemoryRow>, String> {
        let conn = self.conn.lock().unwrap();

        // Build the FTS5 query. We search the content column.
        // For multi-word queries, we OR the terms so partial matches are included,
        // and BM25 will rank entries with more matching terms higher.
        let fts_query = build_fts_query(query);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }

        let sql = if category.is_some() {
            "SELECT m.id, m.session_id, m.content, m.category, m.created_at, m.updated_at
             FROM memories m
             JOIN memories_fts f ON m.rowid = f.rowid
             WHERE memories_fts MATCH ?1 AND m.category = ?2
             ORDER BY bm25(memories_fts) ASC
             LIMIT ?3"
        } else {
            "SELECT m.id, m.session_id, m.content, m.category, m.created_at, m.updated_at
             FROM memories m
             JOIN memories_fts f ON m.rowid = f.rowid
             WHERE memories_fts MATCH ?1
             ORDER BY bm25(memories_fts) ASC
             LIMIT ?2"
        };

        let mut stmt = conn.prepare(sql).map_err(|e| format!("Query error: {}", e))?;

        let mapper = |row: &rusqlite::Row| {
            Ok(MemoryRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                content: row.get(2)?,
                category: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        };

        let results: Vec<MemoryRow> = if let Some(cat) = category {
            stmt.query_map(params![fts_query, cat, limit as i64], mapper)
                .map_err(|e| format!("Query error: {}", e))?
                .filter_map(|r| r.ok())
                .collect()
        } else {
            stmt.query_map(params![fts_query, limit as i64], mapper)
                .map_err(|e| format!("Query error: {}", e))?
                .filter_map(|r| r.ok())
                .collect()
        };

        // Growth System: bump access_count for returned memories
        if !results.is_empty() {
            let now = now_ts();
            for mem in &results {
                conn.execute(
                    "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ?1 WHERE id = ?2",
                    params![now, mem.id],
                ).ok();
            }
        }

        Ok(results)
    }

    /// Delete a memory by id.
    pub fn memory_delete(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let changed = conn
            .execute("DELETE FROM memories WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete memory: {}", e))?;
        Ok(changed > 0)
    }

    /// List memories, optionally filtered by category.
    pub fn memory_list(
        &self,
        category: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<MemoryRow>, String> {
        let conn = self.conn.lock().unwrap();
        let (sql, rows) = if let Some(cat) = category {
            let mut stmt = conn
                .prepare(
                    "SELECT id, session_id, content, category, created_at, updated_at
                     FROM memories WHERE category = ?1
                     ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3",
                )
                .map_err(|e| format!("Query error: {}", e))?;
            let r = stmt
                .query_map(params![cat, limit as i64, offset as i64], |row| {
                    Ok(MemoryRow {
                        id: row.get(0)?,
                        session_id: row.get(1)?,
                        content: row.get(2)?,
                        category: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                })
                .map_err(|e| format!("Query error: {}", e))?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>();
            ("filtered", r)
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, session_id, content, category, created_at, updated_at
                     FROM memories
                     ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2",
                )
                .map_err(|e| format!("Query error: {}", e))?;
            let r = stmt
                .query_map(params![limit as i64, offset as i64], |row| {
                    Ok(MemoryRow {
                        id: row.get(0)?,
                        session_id: row.get(1)?,
                        content: row.get(2)?,
                        category: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                })
                .map_err(|e| format!("Query error: {}", e))?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>();
            ("all", r)
        };

        let _ = sql; // suppress unused warning
        Ok(rows)
    }

    /// Update a memory entry's content (and bump updated_at).
    /// Count total memories, optionally by category.
    pub fn memory_count(&self, category: Option<&str>) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        let count = if let Some(cat) = category {
            conn.query_row(
                "SELECT COUNT(*) FROM memories WHERE category = ?1",
                params![cat],
                |row| row.get(0),
            )
        } else {
            conn.query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
        }
        .unwrap_or(0);
        Ok(count)
    }

    // Agent CRUD methods removed — switched to dynamic agent spawning.

    // === Unified Users (cross-platform identity) ===

    pub fn create_unified_user(&self, display_name: Option<&str>) -> Result<UnifiedUserRow, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO unified_users (id, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, display_name, now, now],
        )
        .map_err(|e| format!("Failed to create unified user: {}", e))?;
        Ok(UnifiedUserRow {
            id,
            display_name: display_name.map(|s| s.to_string()),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn get_unified_user(&self, id: &str) -> Result<Option<UnifiedUserRow>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT id, display_name, created_at, updated_at FROM unified_users WHERE id = ?1",
            params![id],
            |row| {
                Ok(UnifiedUserRow {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            },
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }

    pub fn list_unified_users(&self) -> Result<Vec<UnifiedUserRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, display_name, created_at, updated_at FROM unified_users ORDER BY updated_at DESC")
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(UnifiedUserRow {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Link a platform identity to a unified user.
    /// If the identity already exists for this (platform, platform_user_id, bot_id),
    /// it is re-linked to the new unified_user_id.
    pub fn link_identity(
        &self,
        platform: &str,
        platform_user_id: &str,
        bot_id: &str,
        unified_user_id: &str,
        display_name: Option<&str>,
    ) -> Result<(), String> {
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()
            .map_err(|e| format!("Failed to begin transaction: {}", e))?;
        tx.execute(
            "INSERT OR REPLACE INTO user_identities (platform, platform_user_id, unified_user_id, bot_id, display_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![platform, platform_user_id, unified_user_id, bot_id, display_name, now],
        )
        .map_err(|e| format!("Failed to link identity: {}", e))?;

        // Touch the unified user's updated_at
        tx.execute(
            "UPDATE unified_users SET updated_at = ?1 WHERE id = ?2",
            params![now, unified_user_id],
        )
        .map_err(|e| format!("Failed to update unified user: {}", e))?;
        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        Ok(())
    }

    pub fn unlink_identity(
        &self,
        platform: &str,
        platform_user_id: &str,
        bot_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM user_identities WHERE platform = ?1 AND platform_user_id = ?2 AND bot_id = ?3",
            params![platform, platform_user_id, bot_id],
        )
        .map_err(|e| format!("Failed to unlink identity: {}", e))?;
        Ok(())
    }

    /// Look up the unified_user_id for a given platform identity.
    pub fn get_unified_user_by_identity(
        &self,
        platform: &str,
        platform_user_id: &str,
        bot_id: &str,
    ) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT unified_user_id FROM user_identities WHERE platform = ?1 AND platform_user_id = ?2 AND bot_id = ?3",
            params![platform, platform_user_id, bot_id],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }

    /// List all identities linked to a unified user.
    pub fn list_user_identities(&self, unified_user_id: &str) -> Result<Vec<UserIdentityRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT platform, platform_user_id, unified_user_id, bot_id, display_name, created_at
                 FROM user_identities WHERE unified_user_id = ?1 ORDER BY created_at"
            )
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map(params![unified_user_id], |row| {
                Ok(UserIdentityRow {
                    platform: row.get(0)?,
                    platform_user_id: row.get(1)?,
                    unified_user_id: row.get(2)?,
                    bot_id: row.get(3)?,
                    display_name: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // --- Tasks CRUD ---

    pub fn create_task(
        &self,
        id: &str,
        title: &str,
        description: Option<&str>,
        status: &str,
        session_id: &str,
        parent_session_id: Option<&str>,
        plan: Option<&str>,
        total_stages: i32,
        created_at: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tasks (id, title, description, status, session_id, parent_session_id, plan, total_stages, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![id, title, description, status, session_id, parent_session_id, plan, total_stages, created_at],
        )
        .map_err(|e| format!("Failed to create task: {}", e))?;
        Ok(())
    }

    pub fn update_task_workspace_path(&self, task_id: &str, path: &str) -> Result<(), String> {
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tasks SET workspace_path = ?1, updated_at = ?2 WHERE id = ?3",
            params![path, now, task_id],
        )
        .map_err(|e| format!("Failed to update workspace path: {}", e))?;
        Ok(())
    }

    pub fn search_tasks_by_name(&self, query: &str) -> Result<Option<TaskInfo>, String> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("%{}%", query);
        conn.query_row(
            "SELECT id, title, description, status, session_id, parent_session_id, plan,
                    current_stage, total_stages, progress, error_message,
                    created_at, updated_at, completed_at, task_type, pinned, last_activity_at, workspace_path
             FROM tasks WHERE title LIKE ?1 ORDER BY last_activity_at DESC LIMIT 1",
            params![pattern],
            |row| {
                let pinned_int: i32 = row.get(15)?;
                Ok(TaskInfo {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    status: row.get(3)?,
                    session_id: row.get(4)?,
                    parent_session_id: row.get(5)?,
                    plan: row.get(6)?,
                    current_stage: row.get(7)?,
                    total_stages: row.get(8)?,
                    progress: row.get(9)?,
                    error_message: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                    completed_at: row.get(13)?,
                    task_type: row.get::<_, Option<String>>(14)?.unwrap_or_else(|| "oneoff".to_string()),
                    pinned: pinned_int != 0,
                    last_activity_at: row.get::<_, Option<i64>>(16)?.unwrap_or(0),
                    workspace_path: row.get(17)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to search tasks: {}", e))
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskInfo>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, title, description, status, session_id, parent_session_id, plan,
                    current_stage, total_stages, progress, error_message,
                    created_at, updated_at, completed_at, task_type, pinned, last_activity_at, workspace_path
             FROM tasks WHERE id = ?1",
            params![task_id],
            |row| {
                let pinned_int: i32 = row.get(15)?;
                Ok(TaskInfo {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    status: row.get(3)?,
                    session_id: row.get(4)?,
                    parent_session_id: row.get(5)?,
                    plan: row.get(6)?,
                    current_stage: row.get(7)?,
                    total_stages: row.get(8)?,
                    progress: row.get(9)?,
                    error_message: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                    completed_at: row.get(13)?,
                    task_type: row.get::<_, Option<String>>(14)?.unwrap_or_else(|| "oneoff".to_string()),
                    pinned: pinned_int != 0,
                    last_activity_at: row.get::<_, Option<i64>>(16)?.unwrap_or(0),
                    workspace_path: row.get(17)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to get task: {}", e))
    }

    pub fn list_tasks(
        &self,
        parent_session_id: Option<&str>,
        status: Option<&str>,
    ) -> Result<Vec<TaskInfo>, String> {
        let conn = self.conn.lock().unwrap();

        let mut sql = String::from(
            "SELECT id, title, description, status, session_id, parent_session_id, plan,
                    current_stage, total_stages, progress, error_message,
                    created_at, updated_at, completed_at, task_type, pinned, last_activity_at, workspace_path
             FROM tasks WHERE 1=1"
        );
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(pid) = parent_session_id {
            sql.push_str(&format!(" AND parent_session_id = ?{}", param_values.len() + 1));
            param_values.push(Box::new(pid.to_string()));
        }
        if let Some(st) = status {
            sql.push_str(&format!(" AND status = ?{}", param_values.len() + 1));
            param_values.push(Box::new(st.to_string()));
        }
        sql.push_str(" ORDER BY created_at DESC");

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql).map_err(|e| format!("Query error: {}", e))?;
        let tasks = stmt
            .query_map(param_refs.as_slice(), |row| {
                let pinned_int: i32 = row.get(15)?;
                Ok(TaskInfo {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    status: row.get(3)?,
                    session_id: row.get(4)?,
                    parent_session_id: row.get(5)?,
                    plan: row.get(6)?,
                    current_stage: row.get(7)?,
                    total_stages: row.get(8)?,
                    progress: row.get(9)?,
                    error_message: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                    completed_at: row.get(13)?,
                    task_type: row.get::<_, Option<String>>(14)?.unwrap_or_else(|| "oneoff".to_string()),
                    pinned: pinned_int != 0,
                    last_activity_at: row.get::<_, Option<i64>>(16)?.unwrap_or(0),
                    workspace_path: row.get(17)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(tasks)
    }

    pub fn update_task_status(&self, task_id: &str, status: &str) -> Result<(), String> {
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        let completed_at: Option<i64> = if status == "completed" || status == "cancelled" {
            Some(now)
        } else {
            None
        };
        conn.execute(
            "UPDATE tasks SET status = ?1, updated_at = ?2, last_activity_at = ?2, completed_at = COALESCE(?3, completed_at) WHERE id = ?4",
            params![status, now, completed_at, task_id],
        )
        .map_err(|e| format!("Failed to update task status: {}", e))?;
        Ok(())
    }

    pub fn update_task_progress(
        &self,
        task_id: &str,
        current_stage: i32,
        total_stages: i32,
        progress: f64,
    ) -> Result<(), String> {
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tasks SET current_stage = ?1, total_stages = ?2, progress = ?3, updated_at = ?4, last_activity_at = ?4 WHERE id = ?5",
            params![current_stage, total_stages, progress, now, task_id],
        )
        .map_err(|e| format!("Failed to update task progress: {}", e))?;
        Ok(())
    }

    pub fn update_task_error(
        &self,
        task_id: &str,
        status: &str,
        error_message: &str,
    ) -> Result<(), String> {
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tasks SET status = ?1, error_message = ?2, updated_at = ?3 WHERE id = ?4",
            params![status, error_message, now, task_id],
        )
        .map_err(|e| format!("Failed to update task error: {}", e))?;
        Ok(())
    }

    pub fn pin_task(&self, task_id: &str, pinned: bool) -> Result<(), String> {
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tasks SET pinned = ?1, last_activity_at = ?2, updated_at = ?2 WHERE id = ?3",
            params![pinned as i32, now, task_id],
        )
        .map_err(|e| format!("Failed to pin task: {}", e))?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Reflections & Corrections (Growth System)
    // -----------------------------------------------------------------------

    /// Save a post-task reflection.
    pub fn add_reflection(
        &self,
        task_id: Option<&str>,
        session_id: Option<&str>,
        outcome: &str,
        summary: &str,
        lesson: Option<&str>,
        skill_opportunity: Option<&str>,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO reflections (id, task_id, session_id, outcome, summary, lesson, skill_opportunity, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, task_id, session_id, outcome, summary, lesson, skill_opportunity, now],
        )
        .map_err(|e| format!("Failed to add reflection: {}", e))?;
        Ok(id)
    }

    /// Save a behavioral correction learned from user feedback.
    pub fn add_correction(
        &self,
        trigger_pattern: &str,
        wrong_behavior: Option<&str>,
        correct_behavior: &str,
        source: Option<&str>,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO corrections (id, trigger_pattern, wrong_behavior, correct_behavior, source, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, trigger_pattern, wrong_behavior, correct_behavior, source, now],
        )
        .map_err(|e| format!("Failed to add correction: {}", e))?;
        Ok(id)
    }

    /// Get active corrections for system prompt injection (most recent first, limited).
    pub fn get_active_corrections(&self, limit: usize) -> Vec<(String, String, String)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT trigger_pattern, correct_behavior, source
             FROM corrections WHERE active = 1
             ORDER BY hit_count DESC, created_at DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2).unwrap_or_default(),
            ))
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Get recent reflections for growth analysis.
    pub fn get_recent_reflections(&self, limit: usize) -> Vec<(String, String, Option<String>)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT outcome, summary, lesson FROM reflections
             ORDER BY created_at DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // Code Registry (Growth System — self-created tools)
    // -----------------------------------------------------------------------

    /// Register a script/tool that YiYi has created.
    pub fn register_code(
        &self,
        name: &str,
        path: &str,
        description: &str,
        language: &str,
        invoke_hint: Option<&str>,
        skill_name: Option<&str>,
    ) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();
        // Upsert: if same name exists, update it
        let existing: Option<String> = conn
            .query_row("SELECT id FROM code_registry WHERE name = ?1", params![name], |r| r.get(0))
            .optional()
            .map_err(|e| format!("Query error: {}", e))?;

        let now = now_ts();
        if let Some(id) = existing {
            conn.execute(
                "UPDATE code_registry SET path = ?1, description = ?2, language = ?3, invoke_hint = ?4, skill_name = ?5, updated_at = ?6 WHERE id = ?7",
                params![path, description, language, invoke_hint, skill_name, now, id],
            ).map_err(|e| format!("Update error: {}", e))?;
            Ok(id)
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO code_registry (id, name, path, description, language, invoke_hint, skill_name, run_count, success_count, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, ?8, ?9)",
                params![id, name, path, description, language, invoke_hint, skill_name, now, now],
            ).map_err(|e| format!("Insert error: {}", e))?;
            Ok(id)
        }
    }

    /// Record a script execution result (success or failure with error).
    pub fn record_code_execution(&self, name: &str, success: bool, error: Option<&str>) {
        let conn = self.conn.lock().unwrap();
        let now = now_ts();
        if success {
            conn.execute(
                "UPDATE code_registry SET run_count = run_count + 1, success_count = success_count + 1, last_error = NULL, updated_at = ?1 WHERE name = ?2",
                params![now, name],
            ).ok();
        } else {
            conn.execute(
                "UPDATE code_registry SET run_count = run_count + 1, last_error = ?1, updated_at = ?2 WHERE name = ?3",
                params![error.unwrap_or("unknown error"), now, name],
            ).ok();
        }
    }

    /// Search code registry by name or description keywords.
    pub fn search_code_registry(&self, query: &str, limit: usize) -> Vec<CodeRegistryEntry> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("%{}%", query);
        let mut stmt = match conn.prepare(
            "SELECT name, path, description, language, invoke_hint, skill_name, run_count, success_count, last_error
             FROM code_registry
             WHERE name LIKE ?1 OR description LIKE ?1
             ORDER BY run_count DESC, updated_at DESC
             LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![pattern, limit as i64], |row| {
            Ok(CodeRegistryEntry {
                name: row.get(0)?,
                path: row.get(1)?,
                description: row.get(2)?,
                language: row.get(3)?,
                invoke_hint: row.get(4)?,
                skill_name: row.get(5)?,
                run_count: row.get(6)?,
                success_count: row.get(7)?,
                last_error: row.get(8)?,
            })
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// List all registered code entries.
    pub fn list_code_registry(&self) -> Vec<CodeRegistryEntry> {
        self.search_code_registry("", 100)
    }

    pub fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        // Get the session_id for this task so we can cascade-delete the session
        let session_id: Option<String> = conn
            .query_row(
                "SELECT session_id FROM tasks WHERE id = ?1",
                params![task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to find task: {}", e))?;

        conn.execute("DELETE FROM tasks WHERE id = ?1", params![task_id])
            .map_err(|e| format!("Failed to delete task: {}", e))?;

        // Delete associated session (messages will cascade)
        if let Some(sid) = session_id {
            conn.execute("DELETE FROM messages WHERE session_id = ?1", params![sid])
                .map_err(|e| format!("Failed to delete task messages: {}", e))?;
            conn.execute("DELETE FROM sessions WHERE id = ?1", params![sid])
                .map_err(|e| format!("Failed to delete task session: {}", e))?;
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedUserRow {
    pub id: String,
    pub display_name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserIdentityRow {
    pub platform: String,
    pub platform_user_id: String,
    pub unified_user_id: String,
    pub bot_id: String,
    pub display_name: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodeRegistryEntry {
    pub name: String,
    pub path: String,
    pub description: String,
    pub language: String,
    pub invoke_hint: Option<String>,
    pub skill_name: Option<String>,
    pub run_count: i64,
    pub success_count: i64,
    pub last_error: Option<String>,
}

pub struct MemoryRow {
    pub id: String,
    pub session_id: Option<String>,
    pub content: String,
    pub category: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Build an FTS5 query string from a natural-language query.
/// Splits on whitespace, wraps each token in quotes (to handle CJK characters
/// that the tokenizer may split differently), and ORs them together.
fn build_fts_query(query: &str) -> String {
    let tokens: Vec<String> = query
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| {
            // Escape double quotes inside the token
            let escaped = t.replace('"', "\"\"");
            format!("\"{}\"", escaped)
        })
        .collect();
    if tokens.is_empty() {
        return String::new();
    }
    // Use OR so partial matches are found; BM25 naturally ranks more-matching
    // entries higher.
    tokens.join(" OR ")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Shared,
    Isolated,
}

impl Default for ExecutionMode {
    fn default() -> Self {
        Self::Shared
    }
}

impl std::fmt::Display for ExecutionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Shared => write!(f, "shared"),
            Self::Isolated => write!(f, "isolated"),
        }
    }
}

impl ExecutionMode {
    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "isolated" => Self::Isolated,
            _ => Self::Shared,
        }
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
    /// Execution mode: Shared (default) runs in global context,
    /// Isolated runs in a dedicated cron session with its own history.
    pub execution_mode: ExecutionMode,
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

/// Split text content into separate memory entries.
/// Splits on markdown headings (## ...) or double newlines.
fn split_into_memory_entries(content: &str) -> Vec<&str> {
    let mut entries = Vec::new();
    let mut last = 0;

    for (i, line) in content.lines().enumerate() {
        let _ = i; // not needed, iterating for position
        if line.starts_with("## ") || line.starts_with("### ") {
            let pos = line.as_ptr() as usize - content.as_ptr() as usize;
            if pos > last && content[last..pos].trim().len() > 10 {
                entries.push(content[last..pos].trim());
            }
            last = pos;
        }
    }
    // Remainder
    if last < content.len() && content[last..].trim().len() > 10 {
        entries.push(content[last..].trim());
    }

    // If no headings found, split on double newlines
    if entries.is_empty() && content.trim().len() > 10 {
        entries = content.split("\n\n").filter(|s| s.trim().len() > 10).collect();
    }

    // If still just one big block, return it whole
    if entries.is_empty() && content.trim().len() > 10 {
        entries.push(content.trim());
    }

    entries
}

/// Infer memory category from topic file name.
fn infer_category_from_topic(topic: &str) -> &str {
    let lower = topic.to_lowercase();
    if lower.contains("prefer") || lower.contains("偏好") || lower.contains("喜好") {
        "preference"
    } else if lower.contains("decision") || lower.contains("决定") || lower.contains("决策") {
        "decision"
    } else if lower.contains("experience") || lower.contains("经验") || lower.contains("教训") {
        "experience"
    } else if lower.contains("fact") || lower.contains("事实") || lower.contains("信息") {
        "fact"
    } else {
        "note"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn setup_db() -> (Database, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "yiyiclaw_test_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("Failed to create temp dir");
        let db = Database::open(&dir).expect("Failed to open test db");
        (db, dir)
    }

    #[test]
    fn test_execution_mode_serde() {
        let shared = ExecutionMode::Shared;
        let isolated = ExecutionMode::Isolated;

        assert_eq!(serde_json::to_string(&shared).unwrap(), "\"shared\"");
        assert_eq!(serde_json::to_string(&isolated).unwrap(), "\"isolated\"");

        let parsed: ExecutionMode = serde_json::from_str("\"shared\"").unwrap();
        assert_eq!(parsed, ExecutionMode::Shared);

        let parsed: ExecutionMode = serde_json::from_str("\"isolated\"").unwrap();
        assert_eq!(parsed, ExecutionMode::Isolated);

        // Unknown value fallback to Shared
        assert_eq!(ExecutionMode::from_str_lossy("unknown"), ExecutionMode::Shared);
        assert_eq!(ExecutionMode::default(), ExecutionMode::Shared);
    }

    #[test]
    fn test_unified_user_lifecycle() {
        let (db, dir) = setup_db();

        // Create
        let user = db.create_unified_user(Some("Test User"))
            .expect("create should succeed");
        let user_id = user.id;
        assert!(!user_id.is_empty());

        // Get
        let fetched = db.get_unified_user(&user_id)
            .expect("get should succeed")
            .expect("user should exist");
        assert_eq!(fetched.display_name.as_deref(), Some("Test User"));

        // Link identity
        db.link_identity("telegram", "tg_user_123", "bot_abc", &user_id, Some("Alice"))
            .expect("link should succeed");

        // Lookup by identity
        let found = db.get_unified_user_by_identity("telegram", "tg_user_123", "bot_abc")
            .expect("lookup should succeed");
        assert_eq!(found.as_deref(), Some(user_id.as_str()));

        // Idempotent re-link (same identity again)
        db.link_identity("telegram", "tg_user_123", "bot_abc", &user_id, Some("Alice Updated"))
            .expect("re-link should succeed");

        // Unlink
        db.unlink_identity("telegram", "tg_user_123", "bot_abc")
            .expect("unlink should succeed");
        let not_found = db.get_unified_user_by_identity("telegram", "tg_user_123", "bot_abc")
            .expect("lookup after unlink should succeed");
        assert!(not_found.is_none());

        // Delete
        db.delete_unified_user(&user_id)
            .expect("delete should succeed");
        let deleted = db.get_unified_user(&user_id)
            .expect("get after delete should succeed");
        assert!(deleted.is_none());

        // Cleanup temp dir
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn test_link_identity_cross_platform() {
        let (db, dir) = setup_db();

        let user = db.create_unified_user(Some("Cross Platform User"))
            .expect("create should succeed");
        let user_id = user.id;

        // Link multiple platforms
        db.link_identity("telegram", "tg123", "bot1", &user_id, None)
            .expect("telegram link should succeed");
        db.link_identity("discord", "dc456", "bot2", &user_id, None)
            .expect("discord link should succeed");

        // Both should resolve to the same user
        let tg_uid = db.get_unified_user_by_identity("telegram", "tg123", "bot1")
            .unwrap()
            .unwrap();
        let dc_uid = db.get_unified_user_by_identity("discord", "dc456", "bot2")
            .unwrap()
            .unwrap();
        assert_eq!(tg_uid, dc_uid);
        assert_eq!(tg_uid, user_id);

        // List identities
        let identities = db.list_user_identities(&user_id)
            .expect("list should succeed");
        assert_eq!(identities.len(), 2);

        // Cleanup temp dir
        let _ = std::fs::remove_dir_all(dir);
    }
}
