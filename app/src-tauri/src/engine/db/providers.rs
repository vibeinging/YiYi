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

#[derive(Debug, Clone)]
pub struct CustomProviderRow {
    pub id: String,
    pub name: String,
    pub default_base_url: String,
    pub api_key_prefix: String,
    pub models_json: String,
    pub is_local: bool,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl super::Database {
    // === Provider Settings ===

    pub fn get_all_provider_settings(&self) -> Vec<ProviderSettingRow> {
        let conn = self.conn.lock().unwrap();
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
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn upsert_provider_setting(
        &self,
        provider_id: &str,
        api_key: Option<&str>,
        base_url: Option<&str>,
        extra_models_json: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        // Get existing row
        let existing = conn
            .query_row(
                "SELECT api_key, base_url, extra_models FROM provider_settings WHERE provider_id = ?1",
                params![provider_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?)),
            )
            .ok();

        let (final_key, final_url, final_models) = match existing {
            Some((old_key, old_url, old_models)) => (
                api_key.map(|s| s.to_string()).or(old_key),
                base_url.map(|s| s.to_string()).or(old_url),
                extra_models_json.unwrap_or(&old_models).to_string(),
            ),
            None => (
                api_key.map(|s| s.to_string()),
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

    // === Custom Providers ===

    pub fn get_all_custom_providers(&self) -> Vec<CustomProviderRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, default_base_url, api_key_prefix, models, is_local, api_key, base_url FROM custom_providers")
            .unwrap();
        stmt.query_map([], |row| {
            Ok(CustomProviderRow {
                id: row.get(0)?,
                name: row.get(1)?,
                default_base_url: row.get(2)?,
                api_key_prefix: row.get(3)?,
                models_json: row.get(4)?,
                is_local: row.get(5)?,
                api_key: row.get(6)?,
                base_url: row.get(7)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn upsert_custom_provider(&self, row: &CustomProviderRow) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO custom_providers (id, name, default_base_url, api_key_prefix, models, is_local, api_key, base_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![row.id, row.name, row.default_base_url, row.api_key_prefix, row.models_json, row.is_local, row.api_key, row.base_url],
        )
        .map_err(|e| format!("Failed to save custom provider: {}", e))?;
        Ok(())
    }

    pub fn delete_custom_provider(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM custom_providers WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete custom provider: {}", e))?;
        Ok(())
    }

    // === App Config (key-value) ===

    pub fn get_config(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM app_config WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok()
    }

    pub fn set_config(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO app_config (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|e| format!("Failed to set config: {}", e))?;
        Ok(())
    }

    /// Migrate providers.json into the database (one-time)
    pub fn migrate_providers_from_json(&self, secret_dir: &Path) -> Result<(), String> {
        let json_path = secret_dir.join("providers.json");
        if !json_path.exists() {
            return Ok(());
        }

        // Check if we already have provider data
        {
            let conn = self.conn.lock().unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM provider_settings", [], |row| row.get(0))
                .unwrap_or(0);
            let custom_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM custom_providers", [], |row| row.get(0))
                .unwrap_or(0);
            let config_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM app_config WHERE key = 'active_llm'", [], |row| row.get(0))
                .unwrap_or(0);
            if count > 0 || custom_count > 0 || config_count > 0 {
                // Already migrated
                let backup = secret_dir.join("providers.json.bak");
                std::fs::rename(&json_path, &backup).ok();
                return Ok(());
            }
        }

        let content = std::fs::read_to_string(&json_path)
            .map_err(|e| format!("Failed to read providers.json: {}", e))?;

        // Reuse the old ProvidersData structure for deserialization
        #[derive(Deserialize, Default)]
        struct OldModelInfo { id: String, name: String }
        #[derive(Deserialize, Default)]
        struct OldProviderSettings {
            #[serde(default)] base_url: Option<String>,
            #[serde(default)] api_key: Option<String>,
            #[serde(default)] extra_models: Vec<OldModelInfo>,
        }
        #[derive(Deserialize, Default)]
        struct OldProviderDef {
            id: String, name: String,
            #[serde(default)] default_base_url: String,
            #[serde(default)] api_key_prefix: String,
            #[serde(default)] models: Vec<OldModelInfo>,
            #[serde(default)] is_local: bool,
        }
        #[derive(Deserialize, Default)]
        struct OldCustom {
            definition: OldProviderDef,
            #[serde(default)] settings: OldProviderSettings,
        }
        #[derive(Deserialize, serde::Serialize, Default)]
        struct OldModelSlot { provider_id: String, model: String }
        #[derive(Deserialize, Default)]
        struct OldData {
            #[serde(default)] providers: std::collections::HashMap<String, OldProviderSettings>,
            #[serde(default)] custom_providers: std::collections::HashMap<String, OldCustom>,
            #[serde(default)] active_llm: Option<OldModelSlot>,
        }

        let old: OldData = serde_json::from_str(&content).unwrap_or_default();

        // Migrate provider settings
        for (pid, settings) in &old.providers {
            let extra_json = serde_json::to_string(&settings.extra_models.iter().map(|m| serde_json::json!({"id": m.id, "name": m.name})).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into());
            self.upsert_provider_setting(pid, settings.api_key.as_deref(), settings.base_url.as_deref(), Some(&extra_json))?;
        }

        // Migrate custom providers
        for (_, custom) in &old.custom_providers {
            let def = &custom.definition;
            let models_json = serde_json::to_string(&def.models.iter().map(|m| serde_json::json!({"id": m.id, "name": m.name})).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into());
            self.upsert_custom_provider(&CustomProviderRow {
                id: def.id.clone(),
                name: def.name.clone(),
                default_base_url: def.default_base_url.clone(),
                api_key_prefix: def.api_key_prefix.clone(),
                models_json,
                is_local: def.is_local,
                api_key: custom.settings.api_key.clone(),
                base_url: custom.settings.base_url.clone(),
            })?;
        }

        // Migrate active_llm
        if let Some(active) = &old.active_llm {
            let val = serde_json::to_string(active).unwrap_or_default();
            self.set_config("active_llm", &val)?;
        }

        log::info!("Migrated providers.json to SQLite ({} providers, {} custom)", old.providers.len(), old.custom_providers.len());
        let backup = secret_dir.join("providers.json.bak");
        std::fs::rename(&json_path, &backup).ok();
        Ok(())
    }
}
