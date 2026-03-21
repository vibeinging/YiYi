use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedUserRow {
    pub id: String,
    pub display_name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserIdentityRow {
    pub platform: String,
    pub platform_user_id: String,
    pub unified_user_id: String,
    pub bot_id: String,
    pub display_name: Option<String>,
    pub created_at: i64,
}

impl super::Database {
    // === Unified Users (cross-platform identity) ===

    pub fn create_unified_user(&self, display_name: Option<&str>) -> Result<UnifiedUserRow, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO unified_users (id, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, display_name, now, now],
        )
        .map_err(|e| format!("Failed to create unified user: {}", e))?;
        Ok(UnifiedUserRow {
            id,
            display_name: display_name.map(|s| s.to_string()),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn get_unified_user(&self, id: &str) -> Result<Option<UnifiedUserRow>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT id, display_name, created_at, updated_at FROM unified_users WHERE id = ?1",
            params![id],
            |row| {
                Ok(UnifiedUserRow {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            },
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }

    pub fn list_unified_users(&self) -> Result<Vec<UnifiedUserRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, display_name, created_at, updated_at FROM unified_users ORDER BY updated_at DESC")
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(UnifiedUserRow {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Link a platform identity to a unified user.
    /// If the identity already exists for this (platform, platform_user_id, bot_id),
    /// it is re-linked to the new unified_user_id.
    pub fn link_identity(
        &self,
        platform: &str,
        platform_user_id: &str,
        bot_id: &str,
        unified_user_id: &str,
        display_name: Option<&str>,
    ) -> Result<(), String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()
            .map_err(|e| format!("Failed to begin transaction: {}", e))?;
        tx.execute(
            "INSERT OR REPLACE INTO user_identities (platform, platform_user_id, unified_user_id, bot_id, display_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![platform, platform_user_id, unified_user_id, bot_id, display_name, now],
        )
        .map_err(|e| format!("Failed to link identity: {}", e))?;

        // Touch the unified user's updated_at
        tx.execute(
            "UPDATE unified_users SET updated_at = ?1 WHERE id = ?2",
            params![now, unified_user_id],
        )
        .map_err(|e| format!("Failed to update unified user: {}", e))?;
        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        Ok(())
    }

    pub fn unlink_identity(
        &self,
        platform: &str,
        platform_user_id: &str,
        bot_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM user_identities WHERE platform = ?1 AND platform_user_id = ?2 AND bot_id = ?3",
            params![platform, platform_user_id, bot_id],
        )
        .map_err(|e| format!("Failed to unlink identity: {}", e))?;
        Ok(())
    }

    /// Look up the unified_user_id for a given platform identity.
    pub fn get_unified_user_by_identity(
        &self,
        platform: &str,
        platform_user_id: &str,
        bot_id: &str,
    ) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT unified_user_id FROM user_identities WHERE platform = ?1 AND platform_user_id = ?2 AND bot_id = ?3",
            params![platform, platform_user_id, bot_id],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }

    /// List all identities linked to a unified user.
    pub fn list_user_identities(&self, unified_user_id: &str) -> Result<Vec<UserIdentityRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT platform, platform_user_id, unified_user_id, bot_id, display_name, created_at
                 FROM user_identities WHERE unified_user_id = ?1 ORDER BY created_at"
            )
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map(params![unified_user_id], |row| {
                Ok(UserIdentityRow {
                    platform: row.get(0)?,
                    platform_user_id: row.get(1)?,
                    unified_user_id: row.get(2)?,
                    bot_id: row.get(3)?,
                    display_name: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn delete_unified_user(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM unified_users WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete unified user: {}", e))?;
        Ok(())
    }
}
