use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::engine::db::{CustomProviderRow, Database};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}

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
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderSettings {
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub extra_models: Vec<ModelInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CustomProviderData {
    pub definition: ProviderDefinition,
    #[serde(default)]
    pub settings: ProviderSettings,
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
}

/// In-memory providers state backed by SQLite.
/// `load()` reads from DB, `save()` writes to DB.
pub struct ProvidersState {
    pub providers: std::collections::HashMap<String, ProviderSettings>,
    pub custom_providers: std::collections::HashMap<String, CustomProviderData>,
    pub active_llm: Option<ModelSlotConfig>,
    db: Arc<Database>,
}

impl ProvidersState {
    pub fn load(db: Arc<Database>) -> Self {
        // Load built-in provider settings
        let mut providers = std::collections::HashMap::new();
        for row in db.get_all_provider_settings() {
            let extra: Vec<ModelInfo> =
                serde_json::from_str(&row.extra_models_json).unwrap_or_default();
            providers.insert(
                row.provider_id,
                ProviderSettings {
                    api_key: row.api_key,
                    base_url: row.base_url,
                    extra_models: extra,
                },
            );
        }

        // Load custom providers
        let mut custom_providers = std::collections::HashMap::new();
        for row in db.get_all_custom_providers() {
            let models: Vec<ModelInfo> =
                serde_json::from_str(&row.models_json).unwrap_or_default();
            custom_providers.insert(
                row.id.clone(),
                CustomProviderData {
                    definition: ProviderDefinition {
                        id: row.id,
                        name: row.name,
                        default_base_url: row.default_base_url,
                        api_key_prefix: row.api_key_prefix,
                        models,
                        is_custom: true,
                        is_local: row.is_local,
                    },
                    settings: ProviderSettings {
                        api_key: row.api_key,
                        base_url: row.base_url,
                        extra_models: Vec::new(),
                    },
                },
            );
        }

        // Load active_llm
        let active_llm = db
            .get_config("active_llm")
            .and_then(|v| serde_json::from_str(&v).ok());

        Self {
            providers,
            custom_providers,
            active_llm,
            db,
        }
    }

    /// Persist current state to SQLite
    pub fn save(&self) -> Result<(), String> {
        // Save built-in provider settings
        for (pid, settings) in &self.providers {
            let extra_json = serde_json::to_string(&settings.extra_models)
                .unwrap_or_else(|_| "[]".into());
            self.db.upsert_provider_setting(
                pid,
                settings.api_key.as_deref(),
                settings.base_url.as_deref(),
                Some(&extra_json),
            )?;
        }

        // Save custom providers
        for (_, custom) in &self.custom_providers {
            let def = &custom.definition;
            let models_json = serde_json::to_string(&def.models)
                .unwrap_or_else(|_| "[]".into());
            self.db.upsert_custom_provider(&CustomProviderRow {
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

        // Save active_llm
        if let Some(active) = &self.active_llm {
            let val = serde_json::to_string(active)
                .map_err(|e| format!("Serialize error: {}", e))?;
            self.db.set_config("active_llm", &val)?;
        }

        Ok(())
    }

    pub fn get_all_providers(&self) -> Vec<ProviderInfo> {
        let builtins = builtin_providers();
        let mut result: Vec<ProviderInfo> = builtins
            .into_iter()
            .map(|def| {
                let settings = self.providers.get(&def.id);
                let extra = settings
                    .map(|s| s.extra_models.clone())
                    .unwrap_or_default();
                ProviderInfo {
                    id: def.id.clone(),
                    name: def.name,
                    default_base_url: def.default_base_url,
                    api_key_prefix: def.api_key_prefix,
                    models: def.models,
                    extra_models: extra,
                    is_custom: false,
                    is_local: def.is_local,
                    configured: settings.map_or(false, |s| s.api_key.is_some()),
                    base_url: settings.and_then(|s| s.base_url.clone()),
                }
            })
            .collect();

        for (_, custom) in &self.custom_providers {
            let def = &custom.definition;
            result.push(ProviderInfo {
                id: def.id.clone(),
                name: def.name.clone(),
                default_base_url: def.default_base_url.clone(),
                api_key_prefix: def.api_key_prefix.clone(),
                models: def.models.clone(),
                extra_models: Vec::new(),
                is_custom: true,
                is_local: def.is_local,
                configured: custom.settings.api_key.is_some(),
                base_url: custom.settings.base_url.clone(),
            });
        }

        result
    }
}

// Built-in providers
pub fn builtin_providers() -> Vec<ProviderDefinition> {
    vec![
        ProviderDefinition {
            id: "openai".into(),
            name: "OpenAI".into(),
            default_base_url: "https://api.openai.com/v1".into(),
            api_key_prefix: "OPENAI_API_KEY".into(),
            models: vec![
                ModelInfo { id: "gpt-5-chat".into(), name: "GPT-5".into() },
                ModelInfo { id: "gpt-5-mini".into(), name: "GPT-5 Mini".into() },
                ModelInfo { id: "gpt-4.1".into(), name: "GPT-4.1".into() },
                ModelInfo { id: "gpt-4.1-mini".into(), name: "GPT-4.1 Mini".into() },
                ModelInfo { id: "o3".into(), name: "o3".into() },
                ModelInfo { id: "o4-mini".into(), name: "o4-mini".into() },
            ],
            is_custom: false,
            is_local: false,
        },
        ProviderDefinition {
            id: "anthropic".into(),
            name: "Anthropic".into(),
            default_base_url: "https://api.anthropic.com".into(),
            api_key_prefix: "ANTHROPIC_API_KEY".into(),
            models: vec![
                ModelInfo { id: "claude-opus-4-6".into(), name: "Claude Opus 4.6".into() },
                ModelInfo { id: "claude-sonnet-4-6".into(), name: "Claude Sonnet 4.6".into() },
                ModelInfo { id: "claude-haiku-4-5-20251001".into(), name: "Claude Haiku 4.5".into() },
            ],
            is_custom: false,
            is_local: false,
        },
        ProviderDefinition {
            id: "google".into(),
            name: "Google AI".into(),
            default_base_url: "https://generativelanguage.googleapis.com/v1beta".into(),
            api_key_prefix: "GOOGLE_API_KEY".into(),
            models: vec![
                ModelInfo { id: "gemini-2.5-pro".into(), name: "Gemini 2.5 Pro".into() },
                ModelInfo { id: "gemini-2.5-flash".into(), name: "Gemini 2.5 Flash".into() },
            ],
            is_custom: false,
            is_local: false,
        },
        ProviderDefinition {
            id: "deepseek".into(),
            name: "DeepSeek".into(),
            default_base_url: "https://api.deepseek.com/v1".into(),
            api_key_prefix: "DEEPSEEK_API_KEY".into(),
            models: vec![
                ModelInfo { id: "deepseek-chat".into(), name: "DeepSeek V3".into() },
                ModelInfo { id: "deepseek-reasoner".into(), name: "DeepSeek R1".into() },
            ],
            is_custom: false,
            is_local: false,
        },
        ProviderDefinition {
            id: "dashscope".into(),
            name: "DashScope".into(),
            default_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".into(),
            api_key_prefix: "DASHSCOPE_API_KEY".into(),
            models: vec![
                ModelInfo { id: "qwen-max".into(), name: "Qwen Max".into() },
                ModelInfo { id: "qwen-plus".into(), name: "Qwen Plus".into() },
                ModelInfo { id: "qwen-turbo".into(), name: "Qwen Turbo".into() },
            ],
            is_custom: false,
            is_local: false,
        },
        ProviderDefinition {
            id: "modelscope".into(),
            name: "ModelScope".into(),
            default_base_url: "https://api-inference.modelscope.cn/v1".into(),
            api_key_prefix: "MODELSCOPE_API_KEY".into(),
            models: vec![
                ModelInfo { id: "qwen-max".into(), name: "Qwen Max".into() },
                ModelInfo { id: "qwen-plus".into(), name: "Qwen Plus".into() },
                ModelInfo { id: "deepseek-v3".into(), name: "DeepSeek V3".into() },
                ModelInfo { id: "deepseek-r1".into(), name: "DeepSeek R1".into() },
            ],
            is_custom: false,
            is_local: false,
        },
        ProviderDefinition {
            id: "coding-plan".into(),
            name: "Aliyun Coding Plan".into(),
            default_base_url: "https://coding.dashscope.aliyuncs.com/v1".into(),
            api_key_prefix: "CODING_PLAN_API_KEY".into(),
            models: vec![
                ModelInfo { id: "qwen3.5-plus".into(), name: "Qwen 3.5 Plus".into() },
                ModelInfo { id: "qwen3-coder-plus".into(), name: "Qwen3 Coder Plus".into() },
                ModelInfo { id: "qwen3-coder-next".into(), name: "Qwen3 Coder Next".into() },
                ModelInfo { id: "qwen3-max-2026-01-23".into(), name: "Qwen3 Max".into() },
                ModelInfo { id: "glm-5".into(), name: "GLM-5".into() },
                ModelInfo { id: "glm-4.7".into(), name: "GLM-4.7".into() },
                ModelInfo { id: "MiniMax-M2.5".into(), name: "MiniMax M2.5".into() },
                ModelInfo { id: "kimi-k2.5".into(), name: "Kimi K2.5".into() },
            ],
            is_custom: false,
            is_local: false,
        },
        ProviderDefinition {
            id: "moonshot".into(),
            name: "Moonshot (Kimi)".into(),
            default_base_url: "https://api.moonshot.cn/v1".into(),
            api_key_prefix: "MOONSHOT_API_KEY".into(),
            models: vec![
                ModelInfo { id: "kimi-k2.5".into(), name: "Kimi K2.5".into() },
                ModelInfo { id: "moonshot-v1-128k".into(), name: "Moonshot V1 128K".into() },
                ModelInfo { id: "moonshot-v1-32k".into(), name: "Moonshot V1 32K".into() },
            ],
            is_custom: false,
            is_local: false,
        },
        ProviderDefinition {
            id: "minimax".into(),
            name: "MiniMax".into(),
            default_base_url: "https://api.minimax.io/v1".into(),
            api_key_prefix: "MINIMAX_API_KEY".into(),
            models: vec![
                ModelInfo { id: "MiniMax-M2.5".into(), name: "MiniMax M2.5".into() },
                ModelInfo { id: "MiniMax-M2.5-highspeed".into(), name: "MiniMax M2.5 Highspeed".into() },
                ModelInfo { id: "MiniMax-M2.1".into(), name: "MiniMax M2.1".into() },
            ],
            is_custom: false,
            is_local: false,
        },
        ProviderDefinition {
            id: "zhipu".into(),
            name: "Zhipu AI (CN)".into(),
            default_base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
            api_key_prefix: "ZHIPU_API_KEY".into(),
            models: vec![
                ModelInfo { id: "glm-5".into(), name: "GLM-5".into() },
                ModelInfo { id: "glm-4.7".into(), name: "GLM-4.7".into() },
                ModelInfo { id: "glm-4-plus".into(), name: "GLM-4 Plus".into() },
                ModelInfo { id: "glm-4-flash".into(), name: "GLM-4 Flash".into() },
            ],
            is_custom: false,
            is_local: false,
        },
        ProviderDefinition {
            id: "zhipu-intl".into(),
            name: "Z.AI (Zhipu Intl)".into(),
            default_base_url: "https://api.z.ai/api/paas/v4".into(),
            api_key_prefix: "ZAI_API_KEY".into(),
            models: vec![
                ModelInfo { id: "glm-5".into(), name: "GLM-5".into() },
                ModelInfo { id: "glm-4.7".into(), name: "GLM-4.7".into() },
                ModelInfo { id: "glm-4-plus".into(), name: "GLM-4 Plus".into() },
                ModelInfo { id: "glm-4-flash".into(), name: "GLM-4 Flash".into() },
            ],
            is_custom: false,
            is_local: false,
        },
    ]
}
