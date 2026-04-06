use rusqlite::{params, Connection};
use serde::Deserialize;
use std::path::Path;
use std::sync::Mutex;

mod sessions;
mod messages;
mod providers;
mod bots;
mod cronjobs;
mod memory;
mod workspace;
mod users;
mod tasks;
mod growth;
mod quick_actions;

// Re-export all public types
pub use sessions::ChatSession;
pub use messages::ChatMessage;
pub use providers::{ProviderSettingRow, CustomProviderRow};
pub use bots::{BotRow, BotConversationRow};
pub use cronjobs::{ExecutionMode, CronJobRow, CronJobExecutionRow, HeartbeatRow};
// Memories now live in MemMe (DuckDB). SQLite memories table kept for schema compat only.
pub use workspace::{AuthorizedFolderRow, SensitivePathRow};
pub use users::{UnifiedUserRow, UserIdentityRow};
pub use tasks::TaskInfo;
pub use growth::{MeditationSession, CodeRegistryEntry};
pub use quick_actions::QuickActionRow;

pub struct Database {
    pub(super) conn: Mutex<Connection>,
}

pub(super) fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

impl Database {
    /// Get a locked connection handle (for ad-hoc queries in growth system etc.)
    pub fn get_conn(&self) -> Option<std::sync::MutexGuard<'_, Connection>> {
        self.conn.lock().ok()
    }

    pub fn open(working_dir: &Path) -> Result<Self, String> {
        let db_path = working_dir.join("yiyi.db");
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

            -- Bot conversations: each (bot, group/channel) pair has its own session
            CREATE TABLE IF NOT EXISTS bot_conversations (
                id TEXT PRIMARY KEY,
                bot_id TEXT NOT NULL,
                external_id TEXT NOT NULL,
                platform TEXT NOT NULL,
                display_name TEXT,
                session_id TEXT NOT NULL,
                linked_session_id TEXT,
                trigger_mode TEXT NOT NULL DEFAULT 'mention',
                last_message_at INTEGER,
                message_count INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                UNIQUE(bot_id, external_id),
                FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_bot_conv_bot ON bot_conversations(bot_id);
            CREATE INDEX IF NOT EXISTS idx_bot_conv_last ON bot_conversations(last_message_at);

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
                tier TEXT NOT NULL DEFAULT 'warm',
                confidence REAL NOT NULL DEFAULT 0.5,
                source TEXT NOT NULL DEFAULT 'extraction',
                reviewed_by_meditation INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
            CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
            CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
            -- tier/confidence indexes are created in migrate_tables() after ALTER TABLE

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

        // Reflections table -- post-task self-assessment
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
                signal_type TEXT NOT NULL DEFAULT 'silent_completion',
                confidence REAL NOT NULL DEFAULT 0.50,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_reflections_outcome ON reflections(outcome);
            CREATE INDEX IF NOT EXISTS idx_reflections_created ON reflections(created_at);",
        )
        .map_err(|e| format!("Failed to create reflections table: {}", e))?;

        // Corrections table -- behavioral rules learned from feedback
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS corrections (
                id TEXT PRIMARY KEY,
                trigger_pattern TEXT NOT NULL,
                wrong_behavior TEXT,
                correct_behavior TEXT NOT NULL,
                source TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                hit_count INTEGER NOT NULL DEFAULT 0,
                confidence REAL NOT NULL DEFAULT 0.80,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_corrections_active ON corrections(active);
            CREATE INDEX IF NOT EXISTS idx_corrections_sort ON corrections(active, hit_count DESC, created_at DESC);",
        )
        .map_err(|e| format!("Failed to create corrections table: {}", e))?;

        // Meditation sessions -- daily self-review journal
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meditation_sessions (
                id TEXT PRIMARY KEY,
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                status TEXT DEFAULT 'running',
                sessions_reviewed INTEGER DEFAULT 0,
                memories_updated INTEGER DEFAULT 0,
                principles_changed INTEGER DEFAULT 0,
                memories_archived INTEGER DEFAULT 0,
                journal TEXT,
                error TEXT,
                depth TEXT DEFAULT 'standard',
                phases_completed TEXT DEFAULT '',
                tomorrow_intentions TEXT,
                growth_synthesis TEXT
            );",
        )
        .map_err(|e| format!("Failed to create meditation_sessions table: {}", e))?;

        // Code registry -- tracks scripts/tools YiYi has created
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
            CREATE UNIQUE INDEX IF NOT EXISTS idx_code_registry_name ON code_registry(name);
            CREATE INDEX IF NOT EXISTS idx_code_registry_path ON code_registry(path);
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

        // Drop legacy session_bots table (replaced by bot_conversations)
        conn.execute_batch("DROP TABLE IF EXISTS session_bots;").ok();

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

        // Growth V2: add tier, confidence, source, reviewed_by_meditation to memories
        let has_mem_tier: bool = conn
            .prepare("SELECT tier FROM memories LIMIT 0")
            .is_ok();
        if !has_mem_tier {
            conn.execute_batch(
                "ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'warm';
                 ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
                 ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'extraction';
                 ALTER TABLE memories ADD COLUMN reviewed_by_meditation INTEGER DEFAULT 0;"
            ).map_err(|e| format!("Migration error (memories V2): {}", e))?;
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
                 CREATE INDEX IF NOT EXISTS idx_memories_tier_confidence ON memories(tier, confidence DESC);"
            ).map_err(|e| format!("Migration error (memories V2 indexes): {}", e))?;
            log::info!("Migrated memories table: added tier, confidence, source, reviewed_by_meditation columns");
        }

        // Growth V2: add confidence to corrections
        let has_corr_confidence: bool = conn
            .prepare("SELECT confidence FROM corrections LIMIT 0")
            .is_ok();
        if !has_corr_confidence {
            conn.execute_batch(
                "ALTER TABLE corrections ADD COLUMN confidence REAL NOT NULL DEFAULT 0.80;"
            ).map_err(|e| format!("Migration error (corrections confidence): {}", e))?;
            log::info!("Migrated corrections table: added confidence column");
        }

        // Growth V2: add signal_type, confidence to reflections
        let has_refl_signal: bool = conn
            .prepare("SELECT signal_type FROM reflections LIMIT 0")
            .is_ok();
        if !has_refl_signal {
            conn.execute_batch(
                "ALTER TABLE reflections ADD COLUMN signal_type TEXT NOT NULL DEFAULT 'silent_completion';
                 ALTER TABLE reflections ADD COLUMN confidence REAL NOT NULL DEFAULT 0.50;"
            ).map_err(|e| format!("Migration error (reflections V2): {}", e))?;
            log::info!("Migrated reflections table: added signal_type, confidence columns");
        }

        // Growth V2: add depth, phases_completed, tomorrow_intentions, growth_synthesis to meditation_sessions
        let has_med_depth: bool = conn
            .prepare("SELECT depth FROM meditation_sessions LIMIT 0")
            .is_ok();
        if !has_med_depth {
            conn.execute_batch(
                "ALTER TABLE meditation_sessions ADD COLUMN depth TEXT DEFAULT 'standard';
                 ALTER TABLE meditation_sessions ADD COLUMN phases_completed TEXT DEFAULT '';
                 ALTER TABLE meditation_sessions ADD COLUMN tomorrow_intentions TEXT;
                 ALTER TABLE meditation_sessions ADD COLUMN growth_synthesis TEXT;"
            ).map_err(|e| format!("Migration error (meditation V2): {}", e))?;
            log::info!("Migrated meditation_sessions table: added depth, phases_completed, tomorrow_intentions, growth_synthesis columns");
        }

        // Quick actions table -- user-defined quick action shortcuts
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS quick_actions (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                prompt TEXT NOT NULL,
                icon TEXT NOT NULL DEFAULT 'Zap',
                color TEXT NOT NULL DEFAULT '#6366F1',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .map_err(|e| format!("Failed to create quick_actions table: {}", e))?;

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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn setup_db() -> (Database, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "yiyi_test_{}",
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
