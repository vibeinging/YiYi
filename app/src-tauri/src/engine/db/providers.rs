use rusqlite::params;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ProviderSettingRow {
    pub provider_id: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub extra_models_json: String,
}

impl super::Database {
    // === Provider Settings ===

    pub fn get_all_provider_settings(&self) -> Vec<ProviderSettingRow> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare("SELECT provider_id, api_key, base_url, extra_models FROM provider_settings")
            .unwrap();
        stmt.query_map([], |row| {
            Ok(ProviderSettingRow {
                provider_id: row.get(0)?,
                api_key: row.get(1)?,
                base_url: row.get(2)?,
                extra_models_json: row.get(3)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.map_err(|e| log::warn!("Row parse error: {}", e)).ok())
        .collect()
    }

    pub fn upsert_provider_setting(
        &self,
        provider_id: &str,
        api_key: Option<&str>,
        base_url: Option<&str>,
        extra_models_json: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let existing = conn
            .query_row(
                "SELECT api_key, base_url, extra_models FROM provider_settings WHERE provider_id = ?1",
                params![provider_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?)),
            )
            .ok();

        let db_key_value = api_key.map(|k| k.to_string());

        let (final_key, final_url, final_models) = match existing {
            Some((old_key, old_url, old_models)) => (
                db_key_value.or(old_key),
                base_url.map(|s| s.to_string()).or(old_url),
                extra_models_json.unwrap_or(&old_models).to_string(),
            ),
            None => (
                db_key_value,
                base_url.map(|s| s.to_string()),
                extra_models_json.unwrap_or("[]").to_string(),
            ),
        };

        conn.execute(
            "INSERT OR REPLACE INTO provider_settings (provider_id, api_key, base_url, extra_models) VALUES (?1, ?2, ?3, ?4)",
            params![provider_id, final_key, final_url, final_models],
        )
        .map_err(|e| format!("Failed to save provider setting: {}", e))?;
        Ok(())
    }

    // === App Config (key-value) ===

    pub fn get_config(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT value FROM app_config WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok()
    }

    pub fn set_config(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT OR REPLACE INTO app_config (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|e| format!("Failed to set config: {}", e))?;
        Ok(())
    }

    /// Migrate providers.json into the database (one-time).
    /// V4-only build: only DeepSeek provider settings + active_llm are migrated.
    /// custom_providers from old configs are intentionally dropped.
    pub fn migrate_providers_from_json(&self, secret_dir: &Path) -> Result<(), String> {
        let json_path = secret_dir.join("providers.json");
        if !json_path.exists() {
            return Ok(());
        }

        {
            let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM provider_settings", [], |row| row.get(0))
                .unwrap_or(0);
            let config_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM app_config WHERE key = 'active_llm'", [], |row| row.get(0))
                .unwrap_or(0);
            if count > 0 || config_count > 0 {
                let backup = secret_dir.join("providers.json.bak");
                std::fs::rename(&json_path, &backup).ok();
                return Ok(());
            }
        }

        let content = std::fs::read_to_string(&json_path)
            .map_err(|e| format!("Failed to read providers.json: {}", e))?;

        #[derive(Deserialize, Default)]
        struct OldProviderSettings {
            #[serde(default)] base_url: Option<String>,
            #[serde(default)] api_key: Option<String>,
        }
        #[derive(Deserialize, serde::Serialize, Default)]
        struct OldModelSlot { provider_id: String, model: String }
        #[derive(Deserialize, Default)]
        struct OldData {
            #[serde(default)] providers: std::collections::HashMap<String, OldProviderSettings>,
            #[serde(default)] active_llm: Option<OldModelSlot>,
        }

        let old: OldData = serde_json::from_str(&content).unwrap_or_default();

        for (pid, settings) in &old.providers {
            self.upsert_provider_setting(pid, settings.api_key.as_deref(), settings.base_url.as_deref(), Some("[]"))?;
        }

        if let Some(active) = &old.active_llm {
            let val = serde_json::to_string(active).unwrap_or_default();
            self.set_config("active_llm", &val)?;
        }

        log::info!("Migrated providers.json to SQLite ({} providers)", old.providers.len());
        let backup = secret_dir.join("providers.json.bak");
        std::fs::rename(&json_path, &backup).ok();
        Ok(())
    }
}
