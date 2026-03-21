use rusqlite::params;
use serde::{Deserialize, Serialize};

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

impl super::Database {
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
                    params![uuid::Uuid::new_v4().to_string(), pattern, super::now_ts()],
                )
                .ok();
            }
        }
    }

    /// Migrate old sandbox_paths entries to authorized_folders (one-time).
    pub(super) fn migrate_sandbox_to_authorized_folders(&self) {
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

        let now = super::now_ts();
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
}
