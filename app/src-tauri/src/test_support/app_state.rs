//! Construct an isolated `AppState` for tests, using `TempDb` + `TempWorkspace`
//! + `FakeEmbedder` instead of real disk / network / ONNX resources.

use crate::engine::bots::manager::BotManager;
use crate::engine::infra::mcp_runtime::MCPRuntime;
use crate::state::{config::Config, providers::ProvidersState, AppState};
use crate::test_support::{FakeEmbedder, TempDb, TempWorkspace};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Owns the tempdirs backing a test `AppState`. The tempdirs are cleaned up
/// when this struct is dropped, so keep it alive for the whole test.
pub struct TestAppState {
    pub app_state: AppState,
    _ws: TempWorkspace,
    _db: TempDb,
}

impl TestAppState {
    pub fn state(&self) -> &AppState {
        &self.app_state
    }
}

/// Build a minimal but fully-wired AppState for integration tests.
/// Owns its tempdirs; the returned `TestAppState` must be kept alive.
pub async fn build_test_app_state() -> TestAppState {
    let ws = TempWorkspace::new();
    let db = TempDb::new();

    // MemMe store with FakeEmbedder — no ONNX, no network.
    let embedder: Arc<dyn memme_embeddings::Embedder> = Arc::new(FakeEmbedder::new());
    let memme_db_path = ws
        .path()
        .join("memme.sqlite")
        .to_string_lossy()
        .to_string();
    let memme_cfg = memme_core::MemoryConfig::new(&memme_db_path, 512);
    let memme_store = Arc::new(
        memme_core::MemoryStore::new(memme_cfg, embedder)
            .expect("failed to construct MemoryStore in test"),
    );

    let app_state = AppState {
        working_dir: ws.path().to_path_buf(),
        user_workspace: std::sync::RwLock::new(ws.path().to_path_buf()),
        secret_dir: ws.path().join("secrets"),
        config: Arc::new(RwLock::new(Config::default())),
        // ProvidersState has no Default — load from the empty test DB.
        providers: Arc::new(RwLock::new(ProvidersState::load(db.db()))),
        db: db.db(),
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
        agent_registry: Arc::new(tokio::sync::RwLock::new(
            crate::engine::agents::AgentRegistry::load(ws.path(), None),
        )),
        plugin_registry: Arc::new(std::sync::RwLock::new(
            crate::engine::plugins::PluginRegistry::load(&ws.path().join("plugins")),
        )),
    };

    TestAppState {
        app_state,
        _ws: ws,
        _db: db,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[tokio::test(flavor = "multi_thread")]
    #[serial]
    async fn build_test_app_state_constructs_without_panic() {
        let t = build_test_app_state().await;
        assert!(t.state().working_dir.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    #[serial]
    async fn build_test_app_state_is_isolated_per_call() {
        let a = build_test_app_state().await;
        let b = build_test_app_state().await;
        assert_ne!(a.state().working_dir, b.state().working_dir);
    }
}
