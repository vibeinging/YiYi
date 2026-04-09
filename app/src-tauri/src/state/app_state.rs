use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::config::Config;
use super::providers::ProvidersState;
use crate::engine::bots::manager::BotManager;
use crate::engine::db::Database;
use crate::engine::infra::mcp_runtime::MCPRuntime;
use crate::engine::scheduler::CronScheduler;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSnapshot {
    pub name: String,
    pub status: String, // "running" or "done"
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnAgentSnapshot {
    pub name: String,
    pub task: String,
    pub status: String, // "running" or "complete"
    pub content: String,
    pub tools: Vec<ToolSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamingSnapshot {
    pub is_active: bool,
    pub accumulated_text: String,
    pub tools: Vec<ToolSnapshot>,
    pub spawn_agents: Vec<SpawnAgentSnapshot>,
}

pub struct AppState {
    pub working_dir: PathBuf,       // Internal app data (~/.yiyi)
    pub user_workspace: std::sync::RwLock<PathBuf>,  // User-facing workspace
    pub secret_dir: PathBuf,
    pub config: Arc<RwLock<Config>>,
    pub providers: Arc<RwLock<ProvidersState>>,
    pub db: Arc<Database>,
    pub bot_manager: Arc<BotManager>,
    pub mcp_runtime: Arc<MCPRuntime>,
    pub chat_cancelled: Arc<AtomicBool>,
    pub scheduler: Arc<RwLock<Option<CronScheduler>>>,
    pub streaming_state: Arc<std::sync::Mutex<HashMap<String, StreamingSnapshot>>>,
    pub task_cancellations: Arc<std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub pty_manager: Arc<crate::engine::infra::pty_manager::PtyManager>,
    /// Guard to prevent concurrent meditation sessions.
    pub meditation_running: Arc<AtomicBool>,
    /// MemMe vector memory store.
    pub memme_store: Arc<memme_core::MemoryStore>,
    /// Voice session manager.
    pub voice_manager: Arc<tokio::sync::RwLock<crate::engine::voice::VoiceSessionManager>>,
    /// Agent definition registry.
    pub agent_registry: Arc<tokio::sync::RwLock<crate::engine::agents::AgentRegistry>>,
    /// Plugin registry.
    pub plugin_registry: Arc<std::sync::RwLock<crate::engine::plugins::PluginRegistry>>,
}

impl AppState {
    /// Create a shallow clone that shares all `Arc` fields with the original.
    ///
    /// The only non-Arc field (`user_workspace`) is snapshot-copied via a new
    /// `RwLock`, so the clone is safe to move into a background task without
    /// risking deadlocks on the original's lock.
    pub fn clone_shared(&self) -> Self {
        Self {
            working_dir: self.working_dir.clone(),
            user_workspace: std::sync::RwLock::new(self.user_workspace()),
            secret_dir: self.secret_dir.clone(),
            config: self.config.clone(),
            providers: self.providers.clone(),
            db: self.db.clone(),
            bot_manager: self.bot_manager.clone(),
            mcp_runtime: self.mcp_runtime.clone(),
            chat_cancelled: self.chat_cancelled.clone(),
            scheduler: self.scheduler.clone(),
            streaming_state: self.streaming_state.clone(),
            task_cancellations: self.task_cancellations.clone(),
            pty_manager: self.pty_manager.clone(),
            meditation_running: self.meditation_running.clone(),
            memme_store: self.memme_store.clone(),
            voice_manager: self.voice_manager.clone(),
            agent_registry: self.agent_registry.clone(),
            plugin_registry: self.plugin_registry.clone(),
        }
    }

    /// Get the current user workspace path
    pub fn user_workspace(&self) -> PathBuf {
        self.user_workspace.read().unwrap().clone()
    }

    /// Update the user workspace path at runtime
    pub fn set_user_workspace_path(&self, path: PathBuf) {
        *self.user_workspace.write().unwrap() = path;
    }

    /// Get or create a cancellation signal for a task
    pub fn get_or_create_task_cancel(&self, task_id: &str) -> Arc<AtomicBool> {
        let mut cancellations = self.task_cancellations.lock().unwrap();
        cancellations
            .entry(task_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    /// Set the cancellation signal for a task
    pub fn cancel_task_signal(&self, task_id: &str) -> bool {
        let cancellations = self.task_cancellations.lock().unwrap();
        if let Some(signal) = cancellations.get(task_id) {
            signal.store(true, std::sync::atomic::Ordering::Relaxed);
            true
        } else {
            false
        }
    }

    /// Clean up the cancellation signal for a completed/cancelled task
    pub fn cleanup_task_signal(&self, task_id: &str) {
        let mut cancellations = self.task_cancellations.lock().unwrap();
        cancellations.remove(task_id);
    }

    pub fn new() -> Self {
        let working_dir = std::env::var("YIYI_WORKING_DIR")
            .or_else(|_| std::env::var("YIYICLAW_WORKING_DIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".yiyi")
            });

        let secret_dir = working_dir
            .parent()
            .unwrap_or(&working_dir)
            .join(".yiyi.secret");

        // Ensure directories exist
        std::fs::create_dir_all(&working_dir).ok();
        std::fs::create_dir_all(&secret_dir).ok();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&secret_dir, std::fs::Permissions::from_mode(0o700)).ok();
        }

        let config = Config::load(&working_dir);

        // Resolve user workspace: config > env > ~/Documents/YiYi
        let user_workspace = config
            .agents
            .workspace_dir
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| std::env::var("YIYI_WORKSPACE")
                .or_else(|_| std::env::var("YIYICLAW_WORKSPACE"))
                .ok()
                .map(PathBuf::from))
            .unwrap_or_else(|| {
                dirs::document_dir()
                    .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
                    .join("YiYi")
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
        // Memory migration to SQLite removed — memories now live in MemMe (DuckDB).

        // Migrate channels from config.json to bots table (one-time)
        migrate_channels_to_bots(&db, &config);

        // Load providers from database
        let providers = ProvidersState::load(db.clone());

        // Initialize MemMe vector memory store
        let memme_db_path = working_dir.join("memme.duckdb").to_string_lossy().to_string();
        let memme_cfg = &config.memme;
        let dims = memme_cfg.embedding_dims;

        // Build embedder based on configuration
        let memme_embedder: std::sync::Arc<dyn memme_embeddings::Embedder> =
            match memme_cfg.embedding_provider.as_str() {
                "openai" => {
                    let api_key = if memme_cfg.embedding_api_key.is_empty() {
                        // Fall back to first configured provider's API key
                        providers.providers.values()
                            .find_map(|s| s.api_key.as_deref())
                            .unwrap_or("")
                            .to_string()
                    } else {
                        memme_cfg.embedding_api_key.clone()
                    };
                    if api_key.is_empty() {
                        log::warn!("MemMe: OpenAI embedding selected but no API key, falling back to Mock");
                        std::sync::Arc::new(memme_embeddings::mock::MockEmbedder::default_mini())
                    } else {
                        log::info!("MemMe: Using OpenAI embedding (model={}, dims={})", memme_cfg.embedding_model, dims);
                        let base_url = if memme_cfg.embedding_base_url.is_empty() {
                            "https://api.openai.com/v1".to_string()
                        } else {
                            memme_cfg.embedding_base_url.clone()
                        };
                        let emb = memme_embeddings::openai::OpenAiEmbedder::new(&api_key, &base_url)
                            .with_model(match memme_cfg.embedding_model.as_str() {
                                "text-embedding-3-large" => memme_embeddings::openai::OpenAiModel::TextEmbedding3Large,
                                _ => memme_embeddings::openai::OpenAiModel::TextEmbedding3Small,
                            });
                        std::sync::Arc::new(emb)
                    }
                }
                _ => {
                    log::info!("MemMe: Using Mock embedder (no semantic search)");
                    std::sync::Arc::new(memme_embeddings::mock::MockEmbedder::default_mini())
                }
            };

        let mut memme_config = memme_core::MemoryConfig::new(&memme_db_path, dims);
        memme_config.enable_graph = memme_cfg.enable_graph;
        memme_config.enable_forgetting_curve = memme_cfg.enable_forgetting_curve;
        // extraction_depth removed in MemMe dev; config field kept for backward compat
        memme_config.custom_categories = Some(vec![
            ("fact".into(), "Facts and knowledge about the user".into()),
            ("preference".into(), "User preferences and likes/dislikes".into()),
            ("experience".into(), "Experiences and events".into()),
            ("decision".into(), "Decisions made by or for the user".into()),
            ("note".into(), "General notes".into()),
            ("principle".into(), "Behavioral principles learned from interactions".into()),
        ]);

        let memme_store = Arc::new(
            match memme_core::MemoryStore::new(memme_config.clone(), memme_embedder.clone()) {
                Ok(store) => store,
                Err(e) => {
                    let wal_path = format!("{}.wal", memme_db_path);

                    // Retry 1: remove WAL only (loses last uncommitted writes)
                    log::warn!("MemMe init failed: {e}. Removing WAL and retrying...");
                    let _ = std::fs::remove_file(&wal_path);
                    match memme_core::MemoryStore::new(memme_config.clone(), memme_embedder.clone()) {
                        Ok(store) => {
                            log::info!("MemMe recovered after WAL removal");
                            store
                        }
                        Err(e2) => {
                            // Retry 2: create new DB, migrate data from old DB
                            log::warn!("MemMe still failed after WAL removal: {e2}. Attempting migration...");
                            migrate_memme_db(&memme_db_path, memme_config, memme_embedder)
                        }
                    }
                }
            },
        );

        // Configure MemMe LLM from active provider (for compact/meditate/add_smart)
        if let Some(llm) = build_memme_llm(&providers) {
            memme_store.set_llm_provider(llm);
        }

        let providers = Arc::new(RwLock::new(providers));

        // Load agent definitions before moving working_dir into Self
        let agent_registry = crate::engine::agents::AgentRegistry::load(&working_dir, None);

        // Load plugins from ~/.yiyi/plugins/
        let plugin_registry = crate::engine::plugins::PluginRegistry::load(&working_dir.join("plugins"));

        Self {
            working_dir,
            user_workspace: std::sync::RwLock::new(user_workspace),
            secret_dir,
            config: Arc::new(RwLock::new(config)),
            providers,
            db,
            bot_manager: Arc::new(BotManager::new()),
            mcp_runtime: Arc::new(MCPRuntime::new()),
            chat_cancelled: Arc::new(AtomicBool::new(false)),
            scheduler: Arc::new(RwLock::new(None)),
            streaming_state: Arc::new(std::sync::Mutex::new(HashMap::new())),
            task_cancellations: Arc::new(std::sync::Mutex::new(HashMap::new())),
            pty_manager: Arc::new(crate::engine::infra::pty_manager::PtyManager::new()),
            meditation_running: Arc::new(AtomicBool::new(false)),
            memme_store,
            voice_manager: Arc::new(tokio::sync::RwLock::new(
                crate::engine::voice::VoiceSessionManager::new(),
            )),
            agent_registry: Arc::new(tokio::sync::RwLock::new(agent_registry)),
            plugin_registry: Arc::new(std::sync::RwLock::new(plugin_registry)),
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

/// Build a MemMe LLM provider from YiYi's active LLM provider configuration.
fn build_memme_llm(providers: &ProvidersState) -> Option<std::sync::Arc<dyn memme_llm::LlmProvider>> {
    let slot = providers.active_llm.as_ref()?;
    let provider_settings = providers.providers.get(&slot.provider_id)?;
    let api_key = provider_settings.api_key.as_deref().unwrap_or("").to_string();
    let base_url = provider_settings.base_url.clone().unwrap_or_default();

    if api_key.is_empty() {
        log::warn!("MemMe LLM: No API key for provider '{}', skipping LLM setup", slot.provider_id);
        return None;
    }

    let model = slot.model.clone();
    let provider_id = slot.provider_id.to_lowercase();
    let url = if base_url.is_empty() { "https://api.openai.com".to_string() } else { base_url };

    log::info!("MemMe LLM: Using OpenAI-compatible provider '{}' with model '{}'", slot.provider_id, model);

    // All YiYi providers use OpenAI-compatible chat completions API
    let config = memme_llm::openai::OpenAIConfig::new(&api_key, &url, &model);
    Some(std::sync::Arc::new(memme_llm::openai::OpenAIProvider::new(config)))
}

/// Migrate a corrupt MemMe DB: rename old → create new → export/import data.
fn migrate_memme_db(
    db_path: &str,
    config: memme_core::MemoryConfig,
    embedder: std::sync::Arc<dyn memme_embeddings::Embedder>,
) -> memme_core::MemoryStore {
    let embedder_for_migrate = embedder.clone();
    let config_copy = config.clone();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let corrupt_path = format!("{}.corrupt.{}", db_path, ts);

    // Step 1: Rename corrupt DB
    if let Err(e) = std::fs::rename(db_path, &corrupt_path) {
        log::error!("Failed to rename corrupt MemMe DB: {e}");
        panic!("MemMe DB is corrupt and cannot be renamed. Please manually check {}", db_path);
    }
    let _ = std::fs::remove_file(format!("{}.wal", db_path));
    log::info!("Corrupt MemMe DB moved to {corrupt_path}");

    // Step 2: Create new empty DB
    let new_store = memme_core::MemoryStore::new(config, embedder)
        .expect("Failed to create new MemMe DB after migration");

    // Step 3: Try to export data from corrupt DB and import into new store
    let dims = config_copy.embedding_dims;
    match migrate_via_export(&corrupt_path, &new_store, dims, &embedder_for_migrate) {
        Ok(count) if count > 0 => {
            log::info!("Migrated {count} memories from corrupt DB");
        }
        Ok(_) => {
            log::info!("No memories to migrate. Starting fresh.");
        }
        Err(e) => {
            log::warn!("Migration failed: {e}. Corrupt DB preserved at: {corrupt_path}");
        }
    }

    new_store
}

/// Try to open the corrupt DB via a temporary MemMe store and export/import data.
fn migrate_via_export(
    corrupt_path: &str,
    new_store: &memme_core::MemoryStore,
    dims: usize,
    embedder: &std::sync::Arc<dyn memme_embeddings::Embedder>,
) -> Result<usize, String> {
    // Remove WAL from corrupt DB before trying to open
    let _ = std::fs::remove_file(format!("{}.wal", corrupt_path));

    // Try to open the corrupt DB with a temporary MemMe store
    let temp_config = memme_core::MemoryConfig::new(corrupt_path, dims);
    let temp_store = memme_core::MemoryStore::new(temp_config, embedder.clone())
        .map_err(|e| format!("Cannot open corrupt DB for export: {e}"))?;

    // Export all memories (no user filter — export everything)
    let exported = temp_store.export(None)
        .map_err(|e| format!("Export failed: {e}"))?;

    if exported.is_empty() {
        return Ok(0);
    }

    // Import into new store
    let count = exported.len();
    new_store.import_memories(&exported)
        .map_err(|e| format!("Import failed: {e}"))?;

    Ok(count)
}

