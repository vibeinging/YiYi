use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::engine::db::Database;
use crate::engine::llm_client::NativeToolInjection;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeToolConfig {
    pub tool_type: String,
    pub tool_config: serde_json::Value,
    #[serde(default = "default_inject_mode")]
    pub inject_mode: String,
    #[serde(default)]
    pub supported_models: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled_by_default: bool,
}

impl NativeToolConfig {
    pub fn to_injection(&self) -> NativeToolInjection {
        NativeToolInjection {
            config: self.tool_config.clone(),
            inject_mode: self.inject_mode.clone(),
        }
    }
}

/// Resolve enabled native tool injections for a given model from a list of configs.
pub fn resolve_native_injections(native_tools: &[NativeToolConfig], model: &str) -> Vec<NativeToolInjection> {
    native_tools
        .iter()
        .filter(|nt| {
            nt.enabled_by_default
                && (nt.supported_models.is_empty()
                    || nt.supported_models.iter().any(|m| m == model))
        })
        .map(|nt| nt.to_injection())
        .collect()
}

fn default_inject_mode() -> String { "tools_array".into() }
fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub default_base_url: String,
    #[serde(default)]
    pub api_key_prefix: String,
    #[serde(default)]
    pub models: Vec<ModelInfo>,
    #[serde(default)]
    pub is_custom: bool,
    #[serde(default)]
    pub is_local: bool,
    #[serde(default)]
    pub native_tools: Vec<NativeToolConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderSettings {
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    /// Kept for backwards compatibility with existing DB rows; always empty in V4-only build.
    #[serde(default)]
    pub extra_models: Vec<ModelInfo>,
}

impl Default for ProviderDefinition {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            default_base_url: String::new(),
            api_key_prefix: String::new(),
            models: Vec::new(),
            is_custom: false,
            is_local: false,
            native_tools: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSlotConfig {
    pub provider_id: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub default_base_url: String,
    pub api_key_prefix: String,
    pub models: Vec<ModelInfo>,
    pub extra_models: Vec<ModelInfo>,
    pub is_custom: bool,
    pub is_local: bool,
    pub configured: bool,
    pub base_url: Option<String>,
    /// Saved API key for display in settings UI.
    pub api_key_saved: Option<String>,
    #[serde(default)]
    pub native_tools: Vec<NativeToolConfig>,
}

/// In-memory providers state backed by SQLite.
/// V4-only build: only DeepSeek (deepseek-v4-pro / deepseek-v4-flash) is supported.
pub struct ProvidersState {
    pub providers: std::collections::HashMap<String, ProviderSettings>,
    pub active_llm: Option<ModelSlotConfig>,
    db: Arc<Database>,
}

impl ProvidersState {
    pub fn load(db: Arc<Database>) -> Self {
        let mut providers = std::collections::HashMap::new();
        for row in db.get_all_provider_settings() {
            // extra_models intentionally ignored in V4-only build
            providers.insert(
                row.provider_id,
                ProviderSettings {
                    api_key: row.api_key,
                    base_url: row.base_url,
                    extra_models: Vec::new(),
                },
            );
        }

        let active_llm = db
            .get_config("active_llm")
            .and_then(|v| serde_json::from_str(&v).ok());

        Self { providers, active_llm, db }
    }

    /// Persist current state to SQLite
    pub fn save(&self) -> Result<(), String> {
        for (pid, settings) in &self.providers {
            self.db.upsert_provider_setting(
                pid,
                settings.api_key.as_deref(),
                settings.base_url.as_deref(),
                Some("[]"),
            )?;
        }

        if let Some(active) = &self.active_llm {
            let val = serde_json::to_string(active)
                .map_err(|e| format!("Serialize error: {}", e))?;
            self.db.set_config("active_llm", &val)?;
        }

        Ok(())
    }

    pub fn get_all_providers(&self) -> Vec<ProviderInfo> {
        builtin_providers()
            .into_iter()
            .map(|def| {
                let settings = self.providers.get(&def.id);
                ProviderInfo {
                    id: def.id.clone(),
                    name: def.name,
                    default_base_url: def.default_base_url,
                    api_key_prefix: def.api_key_prefix,
                    models: def.models,
                    extra_models: Vec::new(),
                    is_custom: false,
                    is_local: def.is_local,
                    configured: settings.map_or(false, |s| s.api_key.is_some()),
                    base_url: settings.and_then(|s| s.base_url.clone()),
                    api_key_saved: settings.and_then(|s| s.api_key.clone()),
                    native_tools: def.native_tools,
                }
            })
            .collect()
    }
}

/// Built-in providers — V4-only build returns just DeepSeek with the two V4 models.
/// `deepseek-v4-pro` is the orchestrator (heavy reasoning, long context).
/// `deepseek-v4-flash` is the worker (fast, cheap, parallel sub-tasks).
pub fn builtin_providers() -> Vec<ProviderDefinition> {
    vec![ProviderDefinition {
        id: "deepseek".into(),
        name: "DeepSeek".into(),
        default_base_url: "https://api.deepseek.com/v1".into(),
        api_key_prefix: "DEEPSEEK_API_KEY".into(),
        models: vec![
            ModelInfo { id: "deepseek-v4-pro".into(), name: "DeepSeek V4 Pro".into() },
            ModelInfo { id: "deepseek-v4-flash".into(), name: "DeepSeek V4 Flash".into() },
        ],
        is_custom: false,
        is_local: false,
        native_tools: vec![],
    }]
}
