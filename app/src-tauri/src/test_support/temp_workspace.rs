//! Temporary workspace directory simulating ~/.yiyi/ for tests.
//!
//! Creates an isolated tempdir with an empty `config.json`. The tempdir is
//! removed automatically when the `TempWorkspace` is dropped.

use std::path::{Path, PathBuf};
use tempfile::TempDir;

pub struct TempWorkspace {
    dir: TempDir,
}

impl TempWorkspace {
    /// Create a fresh temporary workspace with a minimal `config.json`.
    pub fn new() -> Self {
        let dir = TempDir::new().expect("failed to create tempdir");
        let config_path = dir.path().join("config.json");
        std::fs::write(&config_path, "{}").expect("failed to write config.json");
        Self { dir }
    }

    /// Absolute path to the workspace root (analogous to ~/.yiyi/).
    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    /// Path to the config.json inside this workspace.
    pub fn config_path(&self) -> PathBuf {
        self.dir.path().join("config.json")
    }
}

impl Default for TempWorkspace {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_workspace_creates_directory_and_config_file() {
        let ws = TempWorkspace::new();
        assert!(ws.path().exists());
        assert!(ws.path().is_dir());
        assert!(ws.config_path().exists());
        let content = std::fs::read_to_string(ws.config_path()).unwrap();
        assert_eq!(content, "{}");
    }

    #[test]
    fn temp_workspace_is_unique_per_instance() {
        let a = TempWorkspace::new();
        let b = TempWorkspace::new();
        assert_ne!(a.path(), b.path());
    }

    #[test]
    fn temp_workspace_cleans_up_on_drop() {
        let path = {
            let ws = TempWorkspace::new();
            ws.path().to_path_buf()
        };
        assert!(!path.exists(), "tempdir should be removed after drop");
    }
}
