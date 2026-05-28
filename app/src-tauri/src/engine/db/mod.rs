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
mod inbox;
mod traces;
pub mod usage;
mod quick_actions;
mod companions;
mod companion_groups;

// Re-export all public types
pub use sessions::ChatSession;
pub use messages::ChatMessage;
pub use bots::{BotRow, AgentRouteConfig};
pub use cronjobs::{ExecutionMode, CronJobRow, CronJobExecutionRow, HeartbeatRow};
// Memories now live in MemMe (DuckDB). SQLite memories table kept for schema compat only.
pub use workspace::{AuthorizedFolderRow, SensitivePathRow};
pub use users::{UnifiedUserRow, UserIdentityRow};
pub use tasks::TaskInfo;
pub use growth::{MeditationSession, BuddyDecision, TrustStats, PersonalitySignal, PersonalitySignalRow, SparklingMemory, RecallCandidate, PERSONALITY_BASE_STAT, invalidate_personality_cache};
pub use inbox::{InboxItem, NewInboxItem};
pub use traces::{AgentTrace, NewAgentTrace};
pub use quick_actions::QuickActionRow;
pub use companions::{Companion, CompanionUpdate, NewCompanion};
pub use companion_groups::CompanionGroup;

pub struct Database {
    pub(super) conn: Mutex<Connection>,
}

pub(crate) fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Idempotent FK-removal migration for tables where the FK turned out to
/// be unhelpful (weakly-associated derived data that should outlive its
/// parent). Checks `sqlite_master.sql` for the keyword; if present, drops
/// and recreates the table from `create_sql`. No-op when the FK is gone.
///
/// `create_sql` must include both the `CREATE TABLE` and any indices the
/// table needs — it's executed inside the same `execute_batch` as the
/// DROP so the schema lands atomically.
fn drop_fk_if_present(
    conn: &Connection,
    table: &str,
    create_sql: &str,
) -> Result<(), String> {
    let has_fk: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = ?1 AND sql LIKE '%FOREIGN KEY%'",
            [table],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !has_fk {
        return Ok(());
    }
    let batch = format!("DROP TABLE {table};\n{create_sql}");
    conn.execute_batch(&batch)
        .map_err(|e| format!("Migration error ({table} FK removal): {e}"))?;
    log::info!("Migrated {table} table: removed FK to collaborations");
    Ok(())
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
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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

            -- Personality signals: tracks Buddy personality evolution from interactions
            CREATE TABLE IF NOT EXISTS personality_signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trait TEXT NOT NULL,
                delta REAL NOT NULL,
                evidence TEXT NOT NULL,
                memory_id TEXT,
                meditation_session_id TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_psignals_trait ON personality_signals(trait);
            CREATE INDEX IF NOT EXISTS idx_psignals_created ON personality_signals(created_at);

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

        // Token usage tracking (per API call, aggregatable by session/time).
        // V4-only build: column names align with DeepSeek's response shape
        // (prompt_cache_hit_tokens / prompt_cache_miss_tokens). Old DBs are
        // migrated via ALTER TABLE RENAME COLUMN in `migrate_tables`.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS token_usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                prompt_cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
                prompt_cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
                recorded_at INTEGER NOT NULL,
                source TEXT NOT NULL DEFAULT 'main'
            );
            CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id);
            CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage(recorded_at);
            -- idx_token_usage_source is created in migrate_tables, AFTER the
            -- ALTER TABLE that adds the column for existing DBs. For fresh
            -- DBs the column is present immediately, but the index is still
            -- created during migrate_tables (idempotent IF NOT EXISTS).",
        )
        .map_err(|e| format!("Failed to create token_usage table: {}", e))?;

        // Buddy decision log — tracks every delegation decision for trust calibration
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS buddy_decisions (
                id TEXT PRIMARY KEY,
                question TEXT NOT NULL,
                context TEXT NOT NULL,
                buddy_answer TEXT NOT NULL,
                buddy_confidence REAL NOT NULL,
                user_feedback TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_buddy_decisions_ts ON buddy_decisions(created_at);
            CREATE INDEX IF NOT EXISTS idx_buddy_decisions_ctx ON buddy_decisions(context);",
        )
        .map_err(|e| format!("Failed to create buddy_decisions table: {}", e))?;

        // Growth V3 — Inbox: agent 提议的成长草稿，等用户审阅
        // 主动行为（skill 创建/合并/归档、principle 添加）走这里。
        // pending 项不影响线上行为，approve/reject 后落到对应主体（文件 / DB）。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS inbox_items (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,                     -- 'skill_create' | 'skill_merge' | 'skill_archive' | 'principle_add'
                status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'edited'
                draft_json TEXT NOT NULL,               -- 草稿内容，结构按 kind 区分
                source TEXT NOT NULL,                   -- 'meditation' | 'user_request'
                reason TEXT NOT NULL,                   -- agent 给的理由（人类可读）
                confidence REAL NOT NULL DEFAULT 0.5,   -- agent 自评置信度
                evidence_json TEXT,                     -- 证据：session_ids、命中次数等
                created_at INTEGER NOT NULL,
                reviewed_at INTEGER,
                applied_at INTEGER,
                user_action TEXT,                       -- 'approve' | 'reject' | 'edit_approve' | 'withdraw'
                user_edited_json TEXT,                  -- 用户编辑后的版本
                user_note TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items(status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_inbox_kind ON inbox_items(kind, status);",
        )
        .map_err(|e| format!("Failed to create inbox_items table: {}", e))?;

        // Companions: user-adopted agent instances. Each row represents the
        // *relationship* between the user and an agent role — distinct from
        // the AgentDefinition file (the role template). One agent_definition_name
        // can spawn multiple companions with different names / personas / stats.
        // See engine/db/companions.rs for CRUD; docs/design/2026-05-15_companions-system.md
        // for the broader design.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS companions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,                  -- 用户起的名字，例如 \"阿狸\"
                agent_definition_name TEXT NOT NULL,        -- 工具权限模板（code_reviewer / blank / ...）
                avatar_emoji TEXT NOT NULL,                 -- 🦉 / 🐧 / 🦊 ...
                color_hex TEXT NOT NULL,                    -- 主色 \"#F97316\" 等
                persona_md_path TEXT,                       -- 用户编辑的人格 prompt 文件（绝对路径）
                memory_user_id TEXT NOT NULL UNIQUE,        -- MemMe 用户隔离 key
                adopted_at INTEGER NOT NULL,                -- 收养时间（millis）
                retired_at INTEGER,                         -- NULL = 在职；非 NULL = 归隐时间（millis）
                personality_stats_json TEXT,                -- Phase 2 用，本期 NULL
                invocation_count INTEGER NOT NULL DEFAULT 0,-- 一起做过 X 件事
                last_used_at INTEGER,
                metadata_json TEXT,
                role_label TEXT                             -- UI 显示用「擅长」短句，与 agent_definition_name 解耦
            );
            CREATE INDEX IF NOT EXISTS idx_companions_retired ON companions(retired_at);
            CREATE INDEX IF NOT EXISTS idx_companions_adopted ON companions(adopted_at);",
        )
        .map_err(|e| format!("Failed to create companions table: {}", e))?;

        // Migration: companions.role_label was added 2026-05-18 to decouple
        // the user-facing "擅长" label from the agent_definition_name
        // template slug (which is just tool-permission grouping).
        // Idempotent: only ALTER if the column doesn't exist yet.
        let has_role_label = conn
            .prepare("SELECT role_label FROM companions LIMIT 0")
            .is_ok();
        if !has_role_label {
            conn.execute_batch(
                "ALTER TABLE companions ADD COLUMN role_label TEXT DEFAULT NULL;",
            )
            .map_err(|e| format!("Failed to add role_label column: {}", e))?;
            log::info!("Migrated companions table: added role_label column");
        }

        // Companion groups (家族) —— 多 companion 共聊 + 共享记忆桶的载体。
        // 多对多关系:companion 可同时在多个组(类比微信群)。每组对应一个
        // family_shared_<id> 记忆桶,通过 MemoryScope::FamilyGroup(id) 路由。
        // 详见 docs/design/2026-05-27_家族会话-host调度群聊.md Approach B。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS companion_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,                   -- 用户起的家族名,例如 \"创作小队\"
                emoji TEXT,                           -- 可选 emoji,UI 显示用
                color_hex TEXT,                       -- 可选主色 \"#F97316\"
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS companion_group_members (
                group_id INTEGER NOT NULL,
                companion_id INTEGER NOT NULL,
                added_at INTEGER NOT NULL,
                PRIMARY KEY (group_id, companion_id),
                FOREIGN KEY (group_id) REFERENCES companion_groups(id) ON DELETE CASCADE,
                FOREIGN KEY (companion_id) REFERENCES companions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_group_members_companion ON companion_group_members(companion_id);
            CREATE INDEX IF NOT EXISTS idx_group_members_group ON companion_group_members(group_id);",
        )
        .map_err(|e| format!("Failed to create companion_groups tables: {}", e))?;

        // Agent traces: turn-level ShareGPT-format trace for offline fine-tune
        // data path. OPT-IN — gated by `config.tracing.enabled`.
        // See engine/db/traces.rs for read/write API.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_traces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                task_id TEXT,
                turn_index INTEGER NOT NULL,
                role TEXT NOT NULL,                 -- 'user' | 'assistant' | 'tool' | 'system'
                content TEXT,
                reasoning_content TEXT,             -- DeepSeek V4 thinking trace
                tool_calls_json TEXT,
                tool_call_id TEXT,
                model TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_traces_session ON agent_traces(session_id, turn_index);
            CREATE INDEX IF NOT EXISTS idx_traces_age ON agent_traces(created_at);",
        )
        .map_err(|e| format!("Failed to create agent_traces table: {}", e))?;

        // Collaboration system (Phase 2+) — concept-driven协作: jury / single
        // companion call / dispatch / plan DAG 都是 collaboration_steps 的实
        // 例化。详见 docs/design/2026-05-15_jury-collaboration-design.md。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS collaborations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_session_id TEXT NOT NULL,
                intent TEXT NOT NULL,              -- 用户原始 prompt
                mode_json TEXT NOT NULL,           -- CollaborationMode: Manual / Dispatched{by}
                status TEXT NOT NULL,              -- planning / awaiting_confirm / running / done / aborted / failed
                status_reason TEXT,                -- Failed 时的 reason 描述
                plan_json TEXT NOT NULL,           -- CollaborationPlan (DAG)
                parent_id INTEGER,                 -- 再开一轮 / expand_verdict 链表
                created_at INTEGER NOT NULL,
                completed_at INTEGER,
                FOREIGN KEY (chat_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (parent_id) REFERENCES collaborations(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_collab_session ON collaborations(chat_session_id);
            CREATE INDEX IF NOT EXISTS idx_collab_status ON collaborations(status);
            CREATE INDEX IF NOT EXISTS idx_collab_parent ON collaborations(parent_id);

            -- step.id is scoped within one collaboration (clients author
            -- plans with ids 1..N); composite PK lets each协作 reuse the
            -- same step ids without a global counter.
            CREATE TABLE IF NOT EXISTS collaboration_steps (
                collaboration_id INTEGER NOT NULL,
                id INTEGER NOT NULL,
                kind TEXT NOT NULL,                -- single_agent / parallel_agents / host_summarize / user_confirmation
                participants_json TEXT NOT NULL,   -- Vec<Participant>
                depends_on_json TEXT NOT NULL DEFAULT '[]', -- Vec<step_id>
                input_json TEXT NOT NULL,
                output_json TEXT,
                status TEXT NOT NULL,              -- pending / running / completed / failed / skipped
                error_reason TEXT,
                started_at INTEGER,
                finished_at INTEGER,
                position INTEGER NOT NULL,         -- DAG 拓扑序，前端渲染顺序
                PRIMARY KEY (collaboration_id, id),
                FOREIGN KEY (collaboration_id) REFERENCES collaborations(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_collab_steps_position ON collaboration_steps(collaboration_id, position);
            CREATE INDEX IF NOT EXISTS idx_collab_steps_status ON collaboration_steps(status);

            -- Audit log. Intentionally no FK to collaborations: audit is an
            -- append-only derived stream that can outlive its collaboration
            -- (archive / replay / sync scenarios) and shouldn't block tests
            -- from inserting standalone records.
            CREATE TABLE IF NOT EXISTS collaboration_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collaboration_id INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                actor_json TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_collab_audit_collab ON collaboration_audit(collaboration_id, timestamp);

            -- Learning signals from user 干预 — feeds DispatchStrategy.
            -- Intentionally no FK to collaborations: signals are historical
            -- training data, weakly associated; deleting a collaboration
            -- should not cascade or block. Allows offline / synced signals
            -- to land before their collaboration row is materialised too.
            CREATE TABLE IF NOT EXISTS learning_signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                collaboration_id INTEGER,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_learning_kind_time ON learning_signals(kind, created_at);",
        )
        .map_err(|e| format!("Failed to create collaboration tables: {}", e))?;

        Ok(())
    }

    fn migrate_tables(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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

        // collaboration_steps: an earlier Phase 2A revision had a global
        // AUTOINCREMENT PRIMARY KEY which collided when multiple
        // collaborations reused the same scoped step id (1, 2, 3...).
        // Switch to composite (collaboration_id, id). Idempotent: the
        // helper detects the old AUTOINCREMENT signature.
        let steps_has_autoincrement: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'collaboration_steps'
                   AND sql LIKE '%AUTOINCREMENT%'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if steps_has_autoincrement {
            conn.execute_batch(
                "DROP TABLE collaboration_steps;
                 CREATE TABLE collaboration_steps (
                    collaboration_id INTEGER NOT NULL,
                    id INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    participants_json TEXT NOT NULL,
                    depends_on_json TEXT NOT NULL DEFAULT '[]',
                    input_json TEXT NOT NULL,
                    output_json TEXT,
                    status TEXT NOT NULL,
                    error_reason TEXT,
                    started_at INTEGER,
                    finished_at INTEGER,
                    position INTEGER NOT NULL,
                    PRIMARY KEY (collaboration_id, id),
                    FOREIGN KEY (collaboration_id) REFERENCES collaborations(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_collab_steps_position
                    ON collaboration_steps(collaboration_id, position);
                 CREATE INDEX IF NOT EXISTS idx_collab_steps_status
                    ON collaboration_steps(status);",
            )
            .map_err(|e| format!("Migration error (collaboration_steps composite PK): {e}"))?;
            log::info!("Migrated collaboration_steps: switched to (collaboration_id, id) composite PK");
        }

        // learning_signals + collaboration_audit: earlier Phase 2A revision
        // had FOREIGN KEY to collaborations(id) which blocked test inserts
        // (these are weakly-associated derived data — must outlive their
        // parent协作 for tests + future sync). Idempotent: no-op if FK
        // already absent.
        drop_fk_if_present(
            &conn,
            "learning_signals",
            "CREATE TABLE learning_signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                collaboration_id INTEGER,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_learning_kind_time
                ON learning_signals(kind, created_at);",
        )?;
        drop_fk_if_present(
            &conn,
            "collaboration_audit",
            "CREATE TABLE collaboration_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collaboration_id INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                actor_json TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_collab_audit_collab
                ON collaboration_audit(collaboration_id, timestamp);",
        )?;

        // Collaboration cross-reference columns on messages — added Phase 2A.
        // Lets any chat row backtrack to the协作 / step / speaker companion.
        let has_collab_link: bool = conn
            .prepare("SELECT collaboration_id FROM messages LIMIT 0")
            .is_ok();
        if !has_collab_link {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN collaboration_id INTEGER DEFAULT NULL;
                 ALTER TABLE messages ADD COLUMN step_id INTEGER DEFAULT NULL;
                 ALTER TABLE messages ADD COLUMN companion_id INTEGER DEFAULT NULL;
                 CREATE INDEX IF NOT EXISTS idx_messages_collab ON messages(collaboration_id, step_id);
                 CREATE INDEX IF NOT EXISTS idx_messages_companion ON messages(companion_id);"
            ).map_err(|e| format!("Migration error (messages collab cols): {}", e))?;
            log::info!("Migrated messages table: added collaboration_id, step_id, companion_id columns");
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

        // Add family_mode to sessions table (家族会话: host 调度的群聊体验).
        // 0 = off (普通单聊), 1 = on (主精灵按 family roster 路由给成员)。
        let has_family_mode: bool = conn
            .prepare("SELECT family_mode FROM sessions LIMIT 0")
            .is_ok();
        if !has_family_mode {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN family_mode INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(|e| format!("Migration error (sessions family_mode): {}", e))?;
            log::info!("Migrated sessions table: added family_mode column");
        }

        // Add group_id to sessions (Approach B 家族会话绑定到具名家族)。
        // NULL = 无具名家族 —— 与 family_mode=1 配合时回落 Phase A 的"全 active"
        // 隐式家族 + 单一 family_shared 桶;非 NULL = 该 session 绑定到这个 group。
        let has_group_id: bool = conn
            .prepare("SELECT group_id FROM sessions LIMIT 0")
            .is_ok();
        if !has_group_id {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN group_id INTEGER DEFAULT NULL;",
            )
            .map_err(|e| format!("Migration error (sessions group_id): {}", e))?;
            log::info!("Migrated sessions table: added group_id column");
        }

        // Drop legacy session_bots table (replaced by bot_conversations)
        conn.execute_batch("DROP TABLE IF EXISTS session_bots;").ok();

        // Add source column to token_usage (cost breakdown by UsageSource —
        // see engine/usage.rs). Old rows default to 'main'.
        let has_usage_source: bool = conn
            .prepare("SELECT source FROM token_usage LIMIT 0")
            .is_ok();
        if !has_usage_source {
            conn.execute_batch(
                "ALTER TABLE token_usage ADD COLUMN source TEXT NOT NULL DEFAULT 'main';
                 CREATE INDEX IF NOT EXISTS idx_token_usage_source ON token_usage(source, recorded_at);"
            ).map_err(|e| format!("Migration error (token_usage source): {}", e))?;
            log::info!("Migrated token_usage table: added source column");
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

        // Bot conversations: add agent_config_json for per-conversation agent routing
        let has_agent_config: bool = conn
            .prepare("SELECT agent_config_json FROM bot_conversations LIMIT 0")
            .is_ok();
        if !has_agent_config {
            conn.execute_batch(
                "ALTER TABLE bot_conversations ADD COLUMN agent_config_json TEXT DEFAULT NULL;"
            ).map_err(|e| format!("Migration error (bot_conversations agent_config_json): {}", e))?;
            log::info!("Migrated bot_conversations table: added agent_config_json column");
        }

        // Buddy: add is_sparkling (闪光记忆) to memories table
        let has_sparkling: bool = conn
            .prepare("SELECT is_sparkling FROM memories LIMIT 0")
            .is_ok();
        if !has_sparkling {
            conn.execute_batch(
                "ALTER TABLE memories ADD COLUMN is_sparkling INTEGER NOT NULL DEFAULT 0;"
            ).map_err(|e| format!("Migration error (memories is_sparkling): {}", e))?;
            log::info!("Migrated memories table: added is_sparkling column (闪光记忆)");
        }

        // V4-only build: rename token_usage cache columns to DeepSeek semantics
        // (cache_read_tokens → prompt_cache_hit_tokens,
        //  cache_write_tokens → prompt_cache_miss_tokens). No data loss —
        // values are preserved 1:1 since the old "read" was always a hit and
        // the old "write" was effectively the miss for non-Anthropic models.
        let has_new_hit: bool = conn
            .prepare("SELECT prompt_cache_hit_tokens FROM token_usage LIMIT 0")
            .is_ok();
        if !has_new_hit {
            // Old DB: rename columns. SQLite 3.25+ supports RENAME COLUMN.
            conn.execute_batch(
                "ALTER TABLE token_usage RENAME COLUMN cache_read_tokens TO prompt_cache_hit_tokens;
                 ALTER TABLE token_usage RENAME COLUMN cache_write_tokens TO prompt_cache_miss_tokens;"
            ).map_err(|e| format!("Migration error (token_usage rename cache cols): {}", e))?;
            log::info!("Migrated token_usage table: renamed cache columns to DeepSeek semantics");
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

        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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
