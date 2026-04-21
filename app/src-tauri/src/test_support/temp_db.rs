//! Temporary SQLite database backed by a tempdir. Runs the same migrations as
//! production via `Database::open`, so tables have the real schema.

use crate::engine::db::Database;
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;

pub struct TempDb {
    _dir: TempDir,
    db: Arc<Database>,
    db_path: PathBuf,
}

impl TempDb {
    /// Create a fresh tempdir + fully-migrated SQLite database.
    pub fn new() -> Self {
        let dir = TempDir::new().expect("failed to create tempdir");
        let db = Database::open(dir.path())
            .expect("Database::open failed on fresh tempdir");
        let db_path = dir.path().join("yiyi.db");
        Self {
            _dir: dir,
            db: Arc::new(db),
            db_path,
        }
    }

    /// Shared handle. Clone freely — cheap Arc clone.
    pub fn db(&self) -> Arc<Database> {
        self.db.clone()
    }

    /// Path to the SQLite file (yiyi.db) inside the tempdir.
    pub fn path(&self) -> &std::path::Path {
        &self.db_path
    }
}

impl Default for TempDb {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial]
    fn temp_db_creates_sqlite_file_and_runs_migrations() {
        let t = TempDb::new();
        assert!(t.path().exists());
        let db = t.db();
        let conn = db.get_conn().expect("conn mutex");
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='sessions'",
                [],
                |r| r.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(count, 1);
    }

    #[test]
    #[serial]
    fn temp_db_is_isolated_per_instance() {
        let a = TempDb::new();
        let b = TempDb::new();
        assert_ne!(a.path(), b.path());
    }
}
