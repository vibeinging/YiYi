use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickActionRow {
    pub id: String,
    pub label: String,
    pub description: String,
    pub prompt: String,
    pub icon: String,
    pub color: String,
    pub sort_order: i32,
}

impl super::Database {
    // -----------------------------------------------------------------------
    // Quick Actions
    // -----------------------------------------------------------------------

    /// List all custom quick actions, ordered by sort_order then created_at.
    pub fn list_quick_actions(&self) -> Vec<QuickActionRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, label, description, prompt, icon, color, sort_order
             FROM quick_actions ORDER BY sort_order ASC, created_at ASC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |row| {
            Ok(QuickActionRow {
                id: row.get(0)?,
                label: row.get(1)?,
                description: row.get(2)?,
                prompt: row.get(3)?,
                icon: row.get(4)?,
                color: row.get(5)?,
                sort_order: row.get(6)?,
            })
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Add a new custom quick action. Returns the generated id.
    pub fn add_quick_action(
        &self,
        label: &str,
        description: &str,
        prompt: &str,
        icon: &str,
        color: &str,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO quick_actions (id, label, description, prompt, icon, color, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
            params![id, label, description, prompt, icon, color, now],
        )
        .map_err(|e| format!("Failed to add quick action: {}", e))?;
        Ok(id)
    }

    /// Update an existing custom quick action.
    pub fn update_quick_action(
        &self,
        id: &str,
        label: &str,
        description: &str,
        prompt: &str,
        icon: &str,
        color: &str,
    ) -> Result<(), String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap();
        let changed = conn
            .execute(
                "UPDATE quick_actions SET label = ?1, description = ?2, prompt = ?3, icon = ?4, color = ?5, updated_at = ?6 WHERE id = ?7",
                params![label, description, prompt, icon, color, now, id],
            )
            .map_err(|e| format!("Failed to update quick action: {}", e))?;
        if changed == 0 {
            return Err(format!("Quick action '{}' not found", id));
        }
        Ok(())
    }

    /// Delete a custom quick action by id.
    pub fn delete_quick_action(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let changed = conn
            .execute("DELETE FROM quick_actions WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete quick action: {}", e))?;
        if changed == 0 {
            return Err(format!("Quick action '{}' not found", id));
        }
        Ok(())
    }
}
