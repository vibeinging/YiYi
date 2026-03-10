use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::config::Config;
use super::providers::ProvidersState;
use crate::engine::bots::manager::BotManager;
use crate::engine::db::Database;
use crate::engine::mcp_runtime::MCPRuntime;
use crate::engine::scheduler::CronScheduler;

pub struct AppState {
    pub working_dir: PathBuf,       // Internal app data (~/.yiclaw)
    pub user_workspace: std::sync::RwLock<PathBuf>,  // User-facing workspace
    pub secret_dir: PathBuf,
    pub config: Arc<RwLock<Config>>,
    pub providers: Arc<RwLock<ProvidersState>>,
    pub db: Arc<Database>,
    pub bot_manager: Arc<BotManager>,
    pub mcp_runtime: Arc<MCPRuntime>,
    pub chat_cancelled: Arc<AtomicBool>,
    pub scheduler: Arc<RwLock<Option<CronScheduler>>>,
}

impl AppState {
    /// Get the current user workspace path
    pub fn user_workspace(&self) -> PathBuf {
        self.user_workspace.read().unwrap().clone()
    }

    /// Update the user workspace path at runtime
    pub fn set_user_workspace_path(&self, path: PathBuf) {
        *self.user_workspace.write().unwrap() = path;
    }

    pub fn new() -> Self {
        let working_dir = std::env::var("YICLAW_WORKING_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".yiclaw")
            });

        let secret_dir = working_dir
            .parent()
            .unwrap_or(&working_dir)
            .join(".yiclaw.secret");

        // Ensure directories exist
        std::fs::create_dir_all(&working_dir).ok();
        std::fs::create_dir_all(&secret_dir).ok();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&secret_dir, std::fs::Permissions::from_mode(0o700)).ok();
        }

        let config = Config::load(&working_dir);

        // Resolve user workspace: config > env > ~/Documents/YiClaw
        let user_workspace = config
            .agents
            .workspace_dir
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| std::env::var("YICLAW_WORKSPACE").ok().map(PathBuf::from))
            .unwrap_or_else(|| {
                dirs::document_dir()
                    .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
                    .join("YiClaw")
            });
        std::fs::create_dir_all(&user_workspace).ok();

        // Load .env if exists
        let env_path = working_dir.join(".env");
        if env_path.exists() {
            dotenv::from_path(&env_path).ok();
        }

        // Open SQLite database (migrates chats.json automatically)
        let db = Database::open(&working_dir).expect("Failed to open database");
        let db = Arc::new(db);

        // Migrate JSON files to SQLite (one-time)
        db.migrate_providers_from_json(&secret_dir).ok();
        db.migrate_jobs_from_json(&working_dir).ok();
        db.migrate_heartbeat_from_json(&working_dir).ok();
        db.migrate_memory_from_files(&working_dir).ok();

        // Migrate channels from config.json to bots table (one-time)
        migrate_channels_to_bots(&db, &config);

        // Load providers from database
        let providers = ProvidersState::load(db.clone());

        Self {
            working_dir,
            user_workspace: std::sync::RwLock::new(user_workspace),
            secret_dir,
            config: Arc::new(RwLock::new(config)),
            providers: Arc::new(RwLock::new(providers)),
            db,
            bot_manager: Arc::new(BotManager::new()),
            mcp_runtime: Arc::new(MCPRuntime::new()),
            chat_cancelled: Arc::new(AtomicBool::new(false)),
            scheduler: Arc::new(RwLock::new(None)),
        }
    }
}

/// One-time migration: convert channels in config.json to bot rows in SQLite
fn migrate_channels_to_bots(db: &Database, config: &Config) {
    // Check if we already migrated
    if db.get_config("channels_migrated").is_some() {
        return;
    }

    if config.channels.is_empty() {
        db.set_config("channels_migrated", "true").ok();
        return;
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let platform_names: std::collections::HashMap<&str, &str> = [
        ("discord", "Discord Bot"),
        ("telegram", "Telegram Bot"),
        ("qq", "QQ Bot"),
        ("dingtalk", "DingTalk Bot"),
        ("feishu", "Feishu Bot"),
        ("wecom", "WeCom Bot"),
        ("webhook", "Webhook Bot"),
    ].iter().cloned().collect();

    for (channel_type, channel_cfg) in &config.channels {
        let bot_id = uuid::Uuid::new_v4().to_string();
        let name = platform_names
            .get(channel_type.as_str())
            .unwrap_or(&channel_type.as_str())
            .to_string();

        let config_json = serde_json::to_string(&channel_cfg.extra).unwrap_or_else(|_| "{}".into());
        let access_json = serde_json::to_string(&channel_cfg.access).ok();

        let row = crate::engine::db::BotRow {
            id: bot_id.clone(),
            name,
            platform: channel_type.clone(),
            enabled: channel_cfg.enabled,
            config_json,
            persona: None,
            access_json,
            created_at: now,
            updated_at: now,
        };

        if let Err(e) = db.upsert_bot(&row) {
            log::warn!("Failed to migrate channel '{}' to bot: {}", channel_type, e);
        } else {
            log::info!("Migrated channel '{}' to bot '{}'", channel_type, bot_id);
        }
    }

    db.set_config("channels_migrated", "true").ok();
    log::info!("Channel-to-bot migration complete ({} channels)", config.channels.len());
}
