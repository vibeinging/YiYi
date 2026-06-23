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
mod questions;

// Re-export all public types
pub use sessions::ChatSession;
pub use messages::ChatMessage;
pub use bots::{BotRow, AgentRouteConfig};
pub use cronjobs::{ExecutionMode, CronJobRow, CronJobExecutionRow, HeartbeatRow};
// Memories now live in MemMe (DuckDB). SQLite memories table kept for schema compat only.
pub use workspace::{AuthorizedFolderRow, SensitivePathRow};
pub use users::{UnifiedUserRow, UserIdentityRow};
pub use tasks::TaskInfo;
pub use growth::{MeditationSession, BuddyDecision, TrustStats, PersonalitySignal, PersonalitySignalRow, PERSONALITY_BASE_STAT, invalidate_personality_cache};
pub use inbox::{InboxItem, NewInboxItem};
pub use traces::{AgentTrace, NewAgentTrace};
pub use quick_actions::QuickActionRow;
pub use companions::{Companion, CompanionUpdate, NewCompanion};
pub use companion_groups::{CompanionGroup, ProjectGroupSummary};
pub use questions::PendingQuestion;

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
        db.migrate_group_scope_tag();
        db.retire_chat_group_sessions();
        db.reap_stale_collaborations();
        Ok(db)
    }

    /// family → group 重命名遗留:旧协作的 `participants_json` 里 `MemoryScope`
    /// 序列化成 `{"family_group":id}`,变体改名 `Group` 后新代码期望 `{"group":id}`。
    /// 一次性把旧 tag 替换掉,免得老协作卡片反序列化失败。幂等(替换后无 family_group)。
    /// 旧的 `family_shared_{id}` MemMe 记忆桶按"老数据可删"约定弃为孤儿,不迁。
    fn migrate_group_scope_tag(&self) {
        if let Some(conn) = self.get_conn() {
            let _ = conn.execute(
                "UPDATE collaboration_steps
                    SET participants_json = REPLACE(participants_json, '\"family_group\"', '\"group\"')
                  WHERE participants_json LIKE '%family_group%'",
                [],
            );
        }
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

            -- (memories 表已退役 —— 记忆现存于 MemMe/DuckDB。旧 SQLite memories
            --  表 + FTS + 触发器由 migrate_tables() 里的一次性 DROP 迁移清理。)

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

        // (memories_fts 虚表 + 同步触发器已随 memories 表一起退役,见上方说明
        //  与 migrate_tables() 的 DROP 迁移。)

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

        // Pending user questions —— `ask_user` 工具的跨会话持久化。agent 抛出的
        // 开放问题在阻塞等待前落一行,关 app 重开后前端能从这里恢复未答卡片;
        // 用户答完写回 answer,同一问题重问命中去重。见 engine/db/questions.rs。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS pending_questions (
                request_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL DEFAULT '',
                collaboration_id INTEGER,              -- 留给 S2 项目模式
                step_id INTEGER,                       -- 留给 S2 项目模式
                companion_id INTEGER NOT NULL DEFAULT 0, -- 提问者(0 = YiYi)
                asker_name TEXT NOT NULL DEFAULT '',
                question TEXT NOT NULL,
                options_json TEXT,                     -- 选项数组 JSON;NULL = 自由文本
                kind TEXT NOT NULL DEFAULT 'text',      -- 'choice' | 'text' | 领域 kind
                status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'answered'
                answer TEXT,
                created_at INTEGER NOT NULL,
                answered_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_pending_questions_session
                ON pending_questions(session_id, status);",
        )
        .map_err(|e| format!("Failed to create pending_questions table: {}", e))?;

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

        // 伙伴/worker 判别器(2026-06-11):work 自动组队产生的临时工标 'worker',
        // 不进伙伴列表(chat×work 正交:持久伙伴 ≠ ephemeral worker)。
        let has_kind = conn.prepare("SELECT kind FROM companions LIMIT 0").is_ok();
        if !has_kind {
            conn.execute_batch(
                "ALTER TABLE companions ADD COLUMN kind TEXT NOT NULL DEFAULT 'companion';",
            )
            .map_err(|e| format!("Failed to add companions.kind column: {}", e))?;
            log::info!("Migrated companions table: added kind column");
        }

        // Companion groups (群) —— 多 companion 共聊 + 共享记忆桶的载体。
        // 多对多关系:companion 可同时在多个组(类比微信群)。每组对应一个
        // group_shared_<id> 记忆桶,通过 MemoryScope::Group(id) 路由。
        // 详见 docs/design/2026-05-27_群会话-host调度群聊.md Approach B。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS companion_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,                   -- 用户起的群名,例如 \"创作小队\"
                emoji TEXT,                           -- 可选 emoji,UI 显示用
                color_hex TEXT,                       -- 可选主色 \"#F97316\"
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                workspace_path TEXT                   -- S2:项目群的隔离工作区绝对路径;NULL=普通群
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

        // Idempotent: 给老库的 companion_groups 补 workspace_path 列(S2 项目工作区)。
        if conn
            .prepare("SELECT workspace_path FROM companion_groups LIMIT 0")
            .is_err()
        {
            conn.execute_batch(
                "ALTER TABLE companion_groups ADD COLUMN workspace_path TEXT;",
            )
            .map_err(|e| format!("Failed to add workspace_path column: {}", e))?;
            log::info!("Migrated companion_groups table: added workspace_path column");
        }

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
                kind TEXT NOT NULL DEFAULT 'chat_group', -- S1(chat×work 2×2): chat_group/chat_single/work_dispatch — 判别 chat 群聊 vs work 派工引擎
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

    /// 启动时清理"上次进程遗留的在途协作"。app 重启 / 崩溃会让正在跑的 collaboration
    /// 的 detached 执行任务直接消失,留下 status='running' 的孤儿 —— 它永不恢复,
    /// 前端却一直显示骨骼屏。开机把这些孤儿(及其 running step)标记为 aborted/failed,
    /// 让前端清掉。只动非终态行,幂等。
    ///
    /// #1(2026-06-14):同步收口 **work_jobs** —— 否则重启后 job 在 Work 列表仍显示
    /// 「进行中」而协作已死(状态撒谎)。把受影响 work 会话的 job 标 failed,并写一条
    /// 「被重启中断,可重发」的可见消息;用户再发一条消息即经 followup 重新激活续做。
    /// 退役 chat 多分身群聊(2026-06-15,用户拍板「直接删除」):删掉所有
    /// **source='chat' 且绑了群**的会话 —— 它们就是已退役的群聊/家族对话。messages /
    /// collaborations / tasks 经 FK ON DELETE CASCADE 一并清掉。**只动 chat 群聊会话**:
    /// work 会话是 source='work'(不命中),companion_groups 表本身留着(work 团队用)。
    /// 幂等:删完就没了,下次开机命中 0 行。
    pub fn retire_chat_group_sessions(&self) {
        let conn = match self.get_conn() {
            Some(c) => c,
            None => return,
        };
        match conn.execute(
            "DELETE FROM sessions WHERE source='chat' AND group_id IS NOT NULL",
            [],
        ) {
            Ok(n) if n > 0 => log::info!("退役 chat 群聊:删除 {n} 个群聊会话(及其消息/协作)"),
            Ok(_) => {}
            Err(e) => log::warn!("retire_chat_group_sessions: {e}"),
        }
    }

    pub fn reap_stale_collaborations(&self) {
        let conn = match self.get_conn() {
            Some(c) => c,
            None => return,
        };
        // 先捞出即将被 reap 的 **work** 会话(intake/dispatch 且非终态),用于随后同步 job。
        let stale_work_sessions: Vec<String> = conn
            .prepare(
                "SELECT DISTINCT chat_session_id FROM collaborations
                  WHERE kind IN ('work_intake','work_dispatch')
                    AND status IN ('running','planning','awaiting_confirm')",
            )
            .and_then(|mut stmt| {
                stmt.query_map([], |r| r.get::<_, String>(0))
                    .map(|rows| rows.filter_map(|x| x.ok()).collect())
            })
            .unwrap_or_default();

        let _ = conn.execute_batch(
            "UPDATE collaboration_steps SET status='failed', error_reason='app 重启,执行中断' \
                 WHERE status='running';
             UPDATE collaborations SET status='aborted', status_reason='app 重启,执行中断' \
                 WHERE status IN ('running','planning','awaiting_confirm');",
        );

        // work_jobs 同步 + 可见提示。job 已是终态的不动(幂等)。
        let now = now_ts();
        for sid in &stale_work_sessions {
            let _ = conn.execute(
                "UPDATE work_jobs SET status='failed', completed_at=?2
                  WHERE session_id=?1 AND status NOT IN ('done','failed','aborted')",
                rusqlite::params![sid, now],
            );
            // 一条诚实的中断消息(context_type=work_job,前端按 work 渲染)。followup
            // 重新激活(failed → clarifying)已存在,用户再发消息即可让团队接着做。
            let _ = conn.execute(
                "INSERT INTO messages (session_id, role, content, timestamp, metadata, context_type)
                 VALUES (?1, 'assistant', ?2, ?3, NULL, 'work_job')",
                rusqlite::params![
                    sid,
                    "⚠️ 这项工作在 app 重启时被中断了。再发一条消息(说要继续做什么),团队就接着干。",
                    now
                ],
            );
        }
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

        // S1(chat×work 2×2 正交化):判别器列。collaborations.kind 区分 chat 群聊 / work 派工
        // 引擎;messages.context_type 让前端消息流按 chat(collab)/ work(work_job)分发渲染。
        // 幂等:老库补列;默认值('chat_group' / 'collab')保证迁移前数据与旧行为不变(一律按 chat)。
        let has_collab_kind: bool = conn
            .prepare("SELECT kind FROM collaborations LIMIT 0")
            .is_ok();
        if !has_collab_kind {
            conn.execute_batch(
                "ALTER TABLE collaborations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat_group';",
            )
            .map_err(|e| format!("Migration error (collaborations.kind): {}", e))?;
            log::info!("Migrated collaborations table: added kind column (chat×work discriminator)");
        }
        let has_msg_context: bool = conn
            .prepare("SELECT context_type FROM messages LIMIT 0")
            .is_ok();
        if !has_msg_context {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN context_type TEXT DEFAULT 'collab';",
            )
            .map_err(|e| format!("Migration error (messages.context_type): {}", e))?;
            log::info!("Migrated messages table: added context_type column (chat/work render discriminator)");
        }

        // R3(work job 一等公民):job 级状态机的薄表。一个 work 会话 = 一个 job;
        // 协作(collaborations)只是 job 下的执行记录(intake N 条 + 派工 M 条),job 的
        // 生命周期状态(clarifying→pending_commit→running→done/failed/aborted)记在这里,
        // 不再从「会话最新协作的 status」倒推(那会把 intake done 错读成"已交付")。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS work_jobs (
                session_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                lead_companion_id INTEGER,
                intent TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER
            );",
        )
        .map_err(|e| format!("Migration error (work_jobs): {}", e))?;
        // 存量回填:work_jobs 表问世前已有的 work 会话(kind=work_dispatch 协作)各自补一行,
        // 状态按其最新协作粗映射。幂等(OR IGNORE,已有行不动)。
        conn.execute_batch(
            "INSERT OR IGNORE INTO work_jobs (session_id, status, intent, created_at, updated_at, completed_at)
             SELECT c.chat_session_id,
                    CASE c.status WHEN 'running' THEN 'running' WHEN 'done' THEN 'done'
                                  WHEN 'failed' THEN 'failed' WHEN 'aborted' THEN 'aborted'
                                  ELSE 'clarifying' END,
                    c.intent, c.created_at, c.created_at, c.completed_at
             FROM collaborations c
             JOIN (SELECT chat_session_id, MAX(id) AS mid FROM collaborations
                   WHERE kind = 'work_dispatch' GROUP BY chat_session_id) latest
               ON latest.mid = c.id;",
        )
        .map_err(|e| format!("Migration error (work_jobs backfill): {}", e))?;

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

        // Add family_mode to sessions table (群会话: host 调度的群聊体验).
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

        // Add group_id to sessions (Approach B 群会话绑定到具名群)。
        // NULL = 无具名群 —— 与 family_mode=1 配合时回落 Phase A 的"全 active"
        // 隐式群 + 单一 family_shared 桶;非 NULL = 该 session 绑定到这个 group。
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

        // 好友私聊:session 绑定到单个 companion(好友列表点进去的专属 1:1 对话)。
        // NULL = 普通单聊(YiYi)或群聊;非 NULL = 和该 agent 私聊。
        let has_session_companion: bool = conn
            .prepare("SELECT companion_id FROM sessions LIMIT 0")
            .is_ok();
        if !has_session_companion {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN companion_id INTEGER DEFAULT NULL;",
            )
            .map_err(|e| format!("Migration error (sessions companion_id): {}", e))?;
            log::info!("Migrated sessions table: added companion_id column");
        }

        // 每窗口思考覆盖:NULL = 跟随全局默认;"off"/"high"/"max" = 本会话覆盖。
        let has_session_thinking: bool = conn
            .prepare("SELECT thinking_mode FROM sessions LIMIT 0")
            .is_ok();
        if !has_session_thinking {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN thinking_mode TEXT DEFAULT NULL;")
                .map_err(|e| format!("Migration error (sessions thinking_mode): {}", e))?;
            log::info!("Migrated sessions table: added thinking_mode column");
        }

        // Per-companion 性格:NULL = YiYi/全局,非 NULL = 该伙伴自己的性格演化(B 期)。
        let has_psignal_companion: bool = conn
            .prepare("SELECT companion_id FROM personality_signals LIMIT 0")
            .is_ok();
        if !has_psignal_companion {
            conn.execute_batch(
                "ALTER TABLE personality_signals ADD COLUMN companion_id INTEGER DEFAULT NULL;
                 CREATE INDEX IF NOT EXISTS idx_psignals_companion ON personality_signals(companion_id);",
            )
            .map_err(|e| format!("Migration error (personality_signals companion_id): {}", e))?;
            log::info!("Migrated personality_signals table: added companion_id column");
        }

        // Per-companion 冥想历史:NULL = YiYi/全局冥想,非 NULL = 该伙伴的反思(C 期)。
        let has_med_companion: bool = conn
            .prepare("SELECT companion_id FROM meditation_sessions LIMIT 0")
            .is_ok();
        if !has_med_companion {
            conn.execute_batch(
                "ALTER TABLE meditation_sessions ADD COLUMN companion_id INTEGER DEFAULT NULL;
                 CREATE INDEX IF NOT EXISTS idx_meditation_companion ON meditation_sessions(companion_id);",
            )
            .map_err(|e| format!("Migration error (meditation_sessions companion_id): {}", e))?;
            log::info!("Migrated meditation_sessions table: added companion_id column");
        }

        // Per-companion 定时冥想配置(C 期):开关 + 时间("HH:MM",本地)。
        let has_companion_meditation: bool = conn
            .prepare("SELECT meditation_enabled FROM companions LIMIT 0")
            .is_ok();
        if !has_companion_meditation {
            conn.execute_batch(
                "ALTER TABLE companions ADD COLUMN meditation_enabled INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE companions ADD COLUMN meditation_time TEXT NOT NULL DEFAULT '03:00';",
            )
            .map_err(|e| format!("Migration error (companions meditation config): {}", e))?;
            log::info!("Migrated companions table: added meditation_enabled / meditation_time columns");
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

        // 退役 memories 表(记忆已迁 MemMe/DuckDB)。一次性 DROP 清理旧 SQLite
        // 残留:先 drop 同步触发器与 FTS 虚表,再 drop 主表与索引,全 IF EXISTS,
        // 旧库新库都安全。表确认 0 写入,DROP 不丢任何用户数据。见防屎山修复 G。
        // 历史上的 access_count / tier / is_sparkling 等 ALTER 迁移随表一并退役。
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS memories_ai;
             DROP TRIGGER IF EXISTS memories_ad;
             DROP TRIGGER IF EXISTS memories_au;
             DROP TABLE IF EXISTS memories_fts;
             DROP TABLE IF EXISTS memories;"
        ).map_err(|e| format!("Migration error (drop retired memories table): {}", e))?;

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

        // (memories is_sparkling 迁移已随 memories 表退役删除 —— 闪光记忆现由 MemMe 承载。)

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

/// S1(chat×work 2×2 正交化):collaboration 的 chat/work 判别器读写。
/// `kind ∈ {chat_group, chat_single, work_dispatch}` —— work 引擎落地后(S5/S6)
/// 派工协作 submit 时标 `work_dispatch`,前端据此与 chat 群聊分流。
impl Database {
    /// 设置某协作的 kind(派工路径在 submit 后调,标 work_dispatch)。
    pub fn set_collaboration_kind(&self, collab_id: i64, kind: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE collaborations SET kind = ?1 WHERE id = ?2",
            params![kind, collab_id],
        )
        .map_err(|e| format!("set_collaboration_kind: {e}"))?;
        Ok(())
    }

    /// 读某协作的 kind(缺省 'chat_group');不存在返回 None。
    pub fn get_collaboration_kind(&self, collab_id: i64) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT kind FROM collaborations WHERE id = ?1",
            params![collab_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
    }

    /// 列出某 kind 的所有协作 id(按新→旧)。
    pub fn list_collaborations_by_kind(&self, kind: &str) -> Vec<i64> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn
            .prepare("SELECT id FROM collaborations WHERE kind = ?1 ORDER BY created_at DESC")
        {
            Ok(s) => s,
            Err(e) => {
                log::warn!("list_collaborations_by_kind prepare: {e}");
                return Vec::new();
            }
        };
        stmt.query_map(params![kind], |r| r.get::<_, i64>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    /// 协作 → 所属会话 id(worker 给 work 工具绑上下文用)。
    pub fn collaboration_session_id(&self, collab_id: i64) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT chat_session_id FROM collaborations WHERE id = ?1",
            params![collab_id],
            |r| r.get(0),
        )
        .ok()
    }

    // ── work_jobs(R3:job 一等公民,job 级状态机)─────────────────────────

    /// 新建 work job(launch 时调)。已存在(同会话重复 launch)则只刷新 updated_at。
    pub fn create_work_job(
        &self,
        session_id: &str,
        intent: &str,
        lead_companion_id: Option<i64>,
    ) -> Result<(), String> {
        let now = now_ts();
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO work_jobs (session_id, status, lead_companion_id, intent, created_at, updated_at)
             VALUES (?1, 'clarifying', ?2, ?3, ?4, ?4)
             ON CONFLICT(session_id) DO UPDATE SET updated_at = ?4",
            params![session_id, lead_companion_id, intent, now],
        )
        .map_err(|e| format!("create_work_job: {e}"))?;
        Ok(())
    }

    /// 推进 job 状态机。终态(done/failed/aborted)写 completed_at;非终态清空它
    /// (done 后 followup 重新激活 → 回 clarifying)。
    pub fn set_work_job_status(&self, session_id: &str, status: &str) -> Result<(), String> {
        let now = now_ts();
        let terminal = matches!(status, "done" | "failed" | "aborted");
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE work_jobs SET status = ?2, updated_at = ?3,
                    completed_at = CASE WHEN ?4 THEN ?3 ELSE NULL END
              WHERE session_id = ?1",
            params![session_id, status, now, terminal],
        )
        .map_err(|e| format!("set_work_job_status: {e}"))?;
        Ok(())
    }

    /// 读 job 当前状态。无此 job → None。
    pub fn get_work_job_status(&self, session_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT status FROM work_jobs WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )
        .ok()
    }

    /// 读 job 固化的牵头者(followup 复用,不重选,防 PM 漂移)。
    pub fn get_work_job_lead(&self, session_id: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT lead_companion_id FROM work_jobs WHERE session_id = ?1",
            params![session_id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
    }

    /// 该 work 会话是否有**进行中的 intake 协作**(牵头者还在处理上一条)——followup 互斥
    /// 守卫:有则拒绝新建,防并发多 PM 竞态。
    pub fn has_active_work_intake(&self, session_id: &str) -> bool {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT COUNT(*) FROM collaborations
              WHERE chat_session_id = ?1 AND kind = 'work_intake'
                AND status NOT IN ('done', 'aborted', 'failed')",
            params![session_id],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false)
    }

    /// 该 work 会话最近的**已完成 work 步产出**((发言者名, 产出文本),旧→新)——intake 跨轮
    /// 记忆用:牵头者自己说过的话(澄清问题/方案)不在 messages 表(在 step output),光注入
    /// 消息历史它仍不知道自己问过什么。文本截断由调用方做。
    pub fn recent_work_step_outputs(&self, session_id: &str, limit: usize) -> Vec<(String, String)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT s.participants_json, s.output_json
             FROM collaboration_steps s
             JOIN collaborations c ON c.id = s.collaboration_id
             WHERE c.chat_session_id = ?1 AND c.kind IN ('work_intake', 'work_dispatch')
               AND s.status = 'completed' AND s.output_json IS NOT NULL
             ORDER BY s.finished_at DESC LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let mut rows: Vec<(String, String)> = stmt
            .query_map(params![session_id, limit as i64], |r| {
                let parts: String = r.get(0)?;
                let out: String = r.get(1)?;
                Ok((parts, out))
            })
            .map(|it| {
                it.filter_map(|r| r.ok())
                    .filter_map(|(parts, out)| {
                        let name = serde_json::from_str::<serde_json::Value>(&parts)
                            .ok()
                            .and_then(|v| {
                                v.get(0)?.get("name").and_then(|n| n.as_str()).map(String::from)
                            })
                            .unwrap_or_else(|| "牵头者".to_string());
                        let text = serde_json::from_str::<serde_json::Value>(&out)
                            .ok()
                            .and_then(|v| {
                                v.get("full_output").and_then(|t| t.as_str()).map(String::from)
                            })?;
                        if text.trim().is_empty() {
                            return None;
                        }
                        Some((name, text))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        rows.reverse(); // 旧→新
        rows
    }

    /// 列出该 work 会话所有**非终态**的 work 协作 id(intake + 派工)——abort 用。
    pub fn list_active_work_collabs(&self, session_id: &str) -> Vec<i64> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT id FROM collaborations
              WHERE chat_session_id = ?1 AND kind IN ('work_intake', 'work_dispatch')
                AND status NOT IN ('done', 'aborted', 'failed')",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![session_id], |r| r.get(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    /// 列出所有 work job 摘要,新→旧 —— WorkPage 监控列表用。
    ///
    /// R3 起读 `work_jobs` 薄表:status 是 **job 级状态机**(clarifying/pending_commit/
    /// running/done/failed/aborted),不再从「会话最新协作的 status」倒推(那会把 intake
    /// done 错读成"已交付")。LEFT JOIN sessions + companion_groups 取标题与分组字段。
    /// INNER JOIN sessions:会话已删的孤儿 job 不再出现(幽灵条目)。
    pub fn list_work_jobs(&self) -> Vec<WorkJobSummary> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        // #3(2026-06-14):带上派工步进度 + token 成本。来源 = 本会话派工协作(work_dispatch)
        // 的 collaboration_steps —— 进度按终态步/总步,成本用 json_extract 从 output_json 的
        // tokens_used 汇总(token_usage 表对 work 步未必落,步产出 JSON 是确定有的)。
        // 相关子查询逐行算,列表小(监控用)无虑。
        let mut stmt = match conn.prepare(
            "SELECT w.rowid, w.session_id, COALESCE(s.name, w.intent) AS title,
                    w.status, w.created_at, w.completed_at,
                    s.group_id, g.name, g.emoji, g.workspace_path,
                    (SELECT COUNT(*) FROM collaboration_steps cs JOIN collaborations c
                       ON c.id = cs.collaboration_id
                      WHERE c.chat_session_id = w.session_id AND c.kind = 'work_dispatch') AS steps_total,
                    (SELECT COUNT(*) FROM collaboration_steps cs JOIN collaborations c
                       ON c.id = cs.collaboration_id
                      WHERE c.chat_session_id = w.session_id AND c.kind = 'work_dispatch'
                        AND cs.status IN ('completed','failed','skipped')) AS steps_done,
                    (SELECT COALESCE(SUM(
                         COALESCE(json_extract(cs.output_json,'$.tokens_used.input'),0)
                       + COALESCE(json_extract(cs.output_json,'$.tokens_used.output'),0)),0)
                       FROM collaboration_steps cs JOIN collaborations c
                       ON c.id = cs.collaboration_id
                      WHERE c.chat_session_id = w.session_id AND c.kind = 'work_dispatch') AS tokens
             FROM work_jobs w
             JOIN sessions s ON s.id = w.session_id
             LEFT JOIN companion_groups g ON g.id = s.group_id
             ORDER BY w.created_at DESC",
        ) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("list_work_jobs prepare: {e}");
                return Vec::new();
            }
        };
        stmt.query_map([], |r| {
            Ok(WorkJobSummary {
                id: r.get(0)?,
                session_id: r.get(1)?,
                intent: r.get(2)?,
                status: r.get(3)?,
                created_at: r.get(4)?,
                completed_at: r.get(5)?,
                group_id: r.get(6)?,
                group_name: r.get(7)?,
                group_emoji: r.get(8)?,
                workspace_path: r.get(9)?,
                steps_total: r.get(10)?,
                steps_done: r.get(11)?,
                tokens: r.get(12)?,
            })
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }
}

/// work job 摘要 —— WorkPage 监控列表项(R3:来自 work_jobs 薄表)。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkJobSummary {
    /// work_jobs 行 id(列表 key 用;选中/跳转用 session_id)。
    pub id: i64,
    /// 所属 work 会话(选中后右栏嵌入该会话看团队推进)。
    pub session_id: String,
    /// 任务标题(优先会话名,回退 job intent)。
    pub intent: String,
    /// job 级状态机:clarifying / pending_commit / running / done / failed / aborted。
    pub status: String,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    // ── 分组字段(前端按文件夹/团队分组;LEFT JOIN 可能为 NULL)──
    /// 所属团队群 id。
    pub group_id: Option<i64>,
    /// 团队群名(分组组头)。
    pub group_name: Option<String>,
    /// 团队群 emoji。
    pub group_emoji: Option<String>,
    /// 团队项目工作区绝对路径(团队在里面干活的文件夹)。
    pub workspace_path: Option<String>,
    // ── #3 监控字段:派工步进度 + token 成本 ──
    /// 派工总步数(work_dispatch 协作的步;含自动追加的验证步)。
    pub steps_total: i64,
    /// 已完成/失败/跳过的步数(进度分子)。
    pub steps_done: i64,
    /// 累计 token(input+output,从步产出汇总;监控成本用)。
    pub tokens: i64,
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
