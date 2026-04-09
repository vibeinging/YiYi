use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::RwLock;

use crate::state::config::Config;

/// Watches config.json for changes and reloads automatically.
pub struct ConfigWatcher {
    config_path: PathBuf,
    config: Arc<RwLock<Config>>,
    working_dir: PathBuf,
    last_modified: Arc<RwLock<Option<SystemTime>>>,
}

impl ConfigWatcher {
    pub fn new(working_dir: PathBuf, config: Arc<RwLock<Config>>) -> Self {
        let config_path = working_dir.join("config.json");
        Self {
            config_path,
            config,
            working_dir,
            last_modified: Arc::new(RwLock::new(None)),
        }
    }

    /// Start polling for config changes (runs until cancelled).
    pub async fn watch(&self) {
        // Initialize last_modified
        if let Ok(meta) = tokio::fs::metadata(&self.config_path).await {
            if let Ok(modified) = meta.modified() {
                *self.last_modified.write().await = Some(modified);
            }
        }

        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
        loop {
            interval.tick().await;

            let current_modified = match tokio::fs::metadata(&self.config_path).await {
                Ok(meta) => meta.modified().ok(),
                Err(_) => continue,
            };

            let last = *self.last_modified.read().await;
            if current_modified != last && current_modified.is_some() {
                *self.last_modified.write().await = current_modified;

                // Reload config
                let new_config = Config::load(&self.working_dir);
                let mut cfg = self.config.write().await;
                *cfg = new_config;
                log::info!("Config reloaded from {}", self.config_path.display());
            }
        }
    }
}
