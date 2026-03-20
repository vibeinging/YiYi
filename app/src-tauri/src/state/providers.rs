use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::engine::db::{CustomProviderRow, Database};
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

fn zhipu_native_tools() -> Vec<NativeToolConfig> {
    vec![NativeToolConfig {
        tool_type: "web_search".into(),
        tool_config: serde_json::json!({
            "type": "web_search",
            "web_search": { "enable": "True", "search_engine": "search-prime" }
        }),
        inject_mode: "tools_array".into(),
        supported_models: vec![],
        enabled_by_default: true,
    }]
}

fn dashscope_native_tools() -> Vec<NativeToolConfig> {
    vec![NativeToolConfig {
        tool_type: "web_search".into(),
        tool_config: serde_json::json!({ "enable_search": true }),
        inject_mode: "extra_body".into(),
        supported_models: vec![],
        enabled_by_default: true,
    }]
}

fn moonshot_native_tools() -> Vec<NativeToolConfig> {
    vec![NativeToolConfig {
        tool_type: "web_search".into(),
        tool_config: serde_json::json!({
            "type": "builtin_function",
            "function": { "name": "$web_search" }
        }),
        inject_mode: "tools_array".into(),
        supported_models: vec![],
        enabled_by_default: true,
    }]
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
    #[serde(default)]
    pub native_tools: Vec<NativeToolConfig>,
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
                        native_tools: vec![],
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
                    api_key_saved: settings.and_then(|s| s.api_key.clone()),
                    native_tools: def.native_tools,
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
                api_key_saved: custom.settings.api_key.clone(),
                native_tools: def.native_tools.clone(),
            });
        }

        result
    }
}

// Built-in providers
pub fn builtin_providers() -> Vec<ProviderDefinition> {
    vec![
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
            native_tools: vec![],
        },
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
            native_tools: vec![],
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
            native_tools: vec![],
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
            native_tools: vec![],
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
            native_tools: vec![],
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
            native_tools: dashscope_native_tools(),
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
            native_tools: vec![],
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
            native_tools: dashscope_native_tools(),
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
            native_tools: moonshot_native_tools(),
        },
        ProviderDefinition {
            id: "zhipu".into(),
            name: "智谱 AI".into(),
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
            native_tools: zhipu_native_tools(),
        },
    ]
}

// ── Provider Plugin System ──────────────────────────────────────────

/// JSON config file format for a provider plugin.
/// Each file in `plugins/providers/*.json` follows this schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderPlugin {
    /// Unique identifier (e.g. "openrouter")
    pub id: String,
    /// Display name
    pub name: String,
    /// Default API base URL
    #[serde(default)]
    pub default_base_url: String,
    /// Environment variable name for API key lookup
    #[serde(default)]
    pub api_key_env: String,
    /// API compatibility: "openai", "anthropic", or "custom"
    #[serde(default = "default_api_compat")]
    pub api_compat: String,
    /// Whether this is a local provider (e.g. Ollama)
    #[serde(default)]
    pub is_local: bool,
    /// Pre-defined model list
    #[serde(default)]
    pub models: Vec<ModelInfo>,
    /// Optional description
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub native_tools: Vec<NativeToolConfig>,
}

fn default_api_compat() -> String {
    "openai".into()
}

/// A template for quickly creating a provider plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub plugin: ProviderPlugin,
}

/// Return the directory for provider plugin JSON files.
pub fn plugins_dir(working_dir: &Path) -> PathBuf {
    working_dir.join("plugins").join("providers")
}

/// Scan the `plugins/providers/` directory and load all valid `.json` plugin files.
pub fn scan_plugin_files(working_dir: &Path) -> Vec<ProviderPlugin> {
    let dir = plugins_dir(working_dir);
    if !dir.exists() {
        return Vec::new();
    }
    let mut plugins = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "json") {
                match std::fs::read_to_string(&path) {
                    Ok(content) => match serde_json::from_str::<ProviderPlugin>(&content) {
                        Ok(plugin) => {
                            log::info!("Loaded provider plugin: {} from {}", plugin.id, path.display());
                            plugins.push(plugin);
                        }
                        Err(e) => {
                            log::warn!("Invalid provider plugin {}: {}", path.display(), e);
                        }
                    },
                    Err(e) => {
                        log::warn!("Failed to read plugin file {}: {}", path.display(), e);
                    }
                }
            }
        }
    }
    plugins
}

/// Convert a ProviderPlugin into a CustomProviderData for registration.
fn plugin_to_custom_data(plugin: &ProviderPlugin) -> CustomProviderData {
    CustomProviderData {
        definition: ProviderDefinition {
            id: plugin.id.clone(),
            name: plugin.name.clone(),
            default_base_url: plugin.default_base_url.clone(),
            api_key_prefix: plugin.api_key_env.clone(),
            models: plugin.models.clone(),
            is_custom: true,
            is_local: plugin.is_local,
            native_tools: plugin.native_tools.clone(),
        },
        settings: ProviderSettings::default(),
    }
}

/// Save a ProviderPlugin as a JSON file in the plugins directory.
pub fn save_plugin_file(working_dir: &Path, plugin: &ProviderPlugin) -> Result<PathBuf, String> {
    let dir = plugins_dir(working_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create plugins directory: {}", e))?;
    let file_path = dir.join(format!("{}.json", plugin.id));
    let json = serde_json::to_string_pretty(plugin)
        .map_err(|e| format!("Failed to serialize plugin: {}", e))?;
    std::fs::write(&file_path, json)
        .map_err(|e| format!("Failed to write plugin file: {}", e))?;
    Ok(file_path)
}

/// Built-in provider templates for common third-party services.
pub fn builtin_templates() -> Vec<ProviderTemplate> {
    vec![
        ProviderTemplate {
            id: "openrouter".into(),
            name: "OpenRouter".into(),
            description: "Unified API gateway for 200+ models from OpenAI, Anthropic, Google, Meta, etc.".into(),
            plugin: ProviderPlugin {
                id: "openrouter".into(),
                name: "OpenRouter".into(),
                default_base_url: "https://openrouter.ai/api/v1".into(),
                api_key_env: "OPENROUTER_API_KEY".into(),
                api_compat: "openai".into(),
                is_local: false,
                models: vec![
                    ModelInfo { id: "openai/gpt-4.1".into(), name: "GPT-4.1".into() },
                    ModelInfo { id: "anthropic/claude-sonnet-4-6".into(), name: "Claude Sonnet 4.6".into() },
                    ModelInfo { id: "google/gemini-2.5-pro".into(), name: "Gemini 2.5 Pro".into() },
                    ModelInfo { id: "meta-llama/llama-4-maverick".into(), name: "Llama 4 Maverick".into() },
                    ModelInfo { id: "deepseek/deepseek-r1".into(), name: "DeepSeek R1".into() },
                ],
                description: Some("Unified API gateway for 200+ models".into()),
                native_tools: vec![],
            },
        },
        ProviderTemplate {
            id: "together".into(),
            name: "Together AI".into(),
            description: "Fast inference for open-source models: Llama, Mixtral, Qwen, etc.".into(),
            plugin: ProviderPlugin {
                id: "together".into(),
                name: "Together AI".into(),
                default_base_url: "https://api.together.xyz/v1".into(),
                api_key_env: "TOGETHER_API_KEY".into(),
                api_compat: "openai".into(),
                is_local: false,
                models: vec![
                    ModelInfo { id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-Turbo".into(), name: "Llama 4 Maverick Turbo".into() },
                    ModelInfo { id: "Qwen/Qwen3-235B-A22B-fp8-tput".into(), name: "Qwen3 235B".into() },
                    ModelInfo { id: "deepseek-ai/DeepSeek-R1".into(), name: "DeepSeek R1".into() },
                ],
                description: Some("Fast inference for open-source models".into()),
                native_tools: vec![],
            },
        },
        ProviderTemplate {
            id: "groq".into(),
            name: "Groq".into(),
            description: "Ultra-fast LPU inference for Llama, Mixtral, Gemma models.".into(),
            plugin: ProviderPlugin {
                id: "groq".into(),
                name: "Groq".into(),
                default_base_url: "https://api.groq.com/openai/v1".into(),
                api_key_env: "GROQ_API_KEY".into(),
                api_compat: "openai".into(),
                is_local: false,
                models: vec![
                    ModelInfo { id: "llama-3.3-70b-versatile".into(), name: "Llama 3.3 70B".into() },
                    ModelInfo { id: "llama-3.1-8b-instant".into(), name: "Llama 3.1 8B Instant".into() },
                    ModelInfo { id: "mixtral-8x7b-32768".into(), name: "Mixtral 8x7B".into() },
                    ModelInfo { id: "gemma2-9b-it".into(), name: "Gemma2 9B".into() },
                ],
                description: Some("Ultra-fast LPU inference".into()),
                native_tools: vec![],
            },
        },
        ProviderTemplate {
            id: "ollama".into(),
            name: "Ollama (Local)".into(),
            description: "Run models locally with Ollama. No API key needed.".into(),
            plugin: ProviderPlugin {
                id: "ollama".into(),
                name: "Ollama (Local)".into(),
                default_base_url: "http://localhost:11434/v1".into(),
                api_key_env: String::new(),
                api_compat: "openai".into(),
                is_local: true,
                models: vec![
                    ModelInfo { id: "llama3.3".into(), name: "Llama 3.3".into() },
                    ModelInfo { id: "qwen3:32b".into(), name: "Qwen3 32B".into() },
                    ModelInfo { id: "deepseek-r1:32b".into(), name: "DeepSeek R1 32B".into() },
                    ModelInfo { id: "gemma3:27b".into(), name: "Gemma 3 27B".into() },
                ],
                description: Some("Run models locally with Ollama".into()),
                native_tools: vec![],
            },
        },
        ProviderTemplate {
            id: "lmstudio".into(),
            name: "LM Studio (Local)".into(),
            description: "Run local models via LM Studio. No API key needed.".into(),
            plugin: ProviderPlugin {
                id: "lmstudio".into(),
                name: "LM Studio (Local)".into(),
                default_base_url: "http://localhost:1234/v1".into(),
                api_key_env: String::new(),
                api_compat: "openai".into(),
                is_local: true,
                models: vec![
                    ModelInfo { id: "local-model".into(), name: "Local Model".into() },
                ],
                description: Some("Run local models via LM Studio".into()),
                native_tools: vec![],
            },
        },
        ProviderTemplate {
            id: "siliconflow".into(),
            name: "SiliconFlow".into(),
            description: "Chinese cloud inference platform with competitive pricing.".into(),
            plugin: ProviderPlugin {
                id: "siliconflow".into(),
                name: "SiliconFlow".into(),
                default_base_url: "https://api.siliconflow.cn/v1".into(),
                api_key_env: "SILICONFLOW_API_KEY".into(),
                api_compat: "openai".into(),
                is_local: false,
                models: vec![
                    ModelInfo { id: "deepseek-ai/DeepSeek-V3".into(), name: "DeepSeek V3".into() },
                    ModelInfo { id: "deepseek-ai/DeepSeek-R1".into(), name: "DeepSeek R1".into() },
                    ModelInfo { id: "Qwen/Qwen2.5-72B-Instruct".into(), name: "Qwen2.5 72B".into() },
                ],
                description: Some("Chinese cloud inference platform".into()),
                native_tools: vec![],
            },
        },
    ]
}

impl ProvidersState {
    /// Load provider plugins from the plugins directory and register them
    /// as custom providers (if not already registered in DB).
    pub fn load_plugins(&mut self, working_dir: &Path) {
        let plugins = scan_plugin_files(working_dir);
        let mut changed = false;
        for plugin in plugins {
            if !self.custom_providers.contains_key(&plugin.id) {
                // Check if it conflicts with a built-in provider
                let builtins = builtin_providers();
                if builtins.iter().any(|b| b.id == plugin.id) {
                    log::warn!(
                        "Plugin '{}' conflicts with built-in provider, skipping",
                        plugin.id
                    );
                    continue;
                }
                log::info!("Registering plugin provider: {}", plugin.id);
                self.custom_providers
                    .insert(plugin.id.clone(), plugin_to_custom_data(&plugin));
                changed = true;
            }
        }
        if changed {
            if let Err(e) = self.save() {
                log::error!("Failed to save after loading plugins: {}", e);
            }
        }
    }

    /// Import a plugin from its JSON definition: save the file and register.
    pub fn import_plugin(
        &mut self,
        working_dir: &Path,
        plugin: ProviderPlugin,
    ) -> Result<ProviderInfo, String> {
        // Save as JSON file
        save_plugin_file(working_dir, &plugin)?;

        // Register in memory
        let data = plugin_to_custom_data(&plugin);
        let id = plugin.id.clone();
        self.custom_providers.insert(id.clone(), data);
        self.save()?;

        self.get_all_providers()
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| "Failed to register plugin provider".into())
    }

}

// ── Plugin Directory Watcher ────────────────────────────────────────

/// Watches the `plugins/providers/` directory for changes and reloads plugins.
pub struct PluginWatcher {
    working_dir: PathBuf,
    providers: Arc<tokio::sync::RwLock<ProvidersState>>,
    last_scan: Arc<tokio::sync::RwLock<Option<std::time::SystemTime>>>,
}

impl PluginWatcher {
    pub fn new(
        working_dir: PathBuf,
        providers: Arc<tokio::sync::RwLock<ProvidersState>>,
    ) -> Self {
        Self {
            working_dir,
            providers,
            last_scan: Arc::new(tokio::sync::RwLock::new(None)),
        }
    }

    /// Start polling for plugin directory changes (runs forever).
    pub async fn watch(&self) {
        let dir = plugins_dir(&self.working_dir);

        // Ensure directory exists
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log::warn!("Failed to create plugins/providers dir: {}", e);
        }

        // Get initial modification time
        if let Ok(meta) = tokio::fs::metadata(&dir).await {
            if let Ok(modified) = meta.modified() {
                *self.last_scan.write().await = Some(modified);
            }
        }

        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            interval.tick().await;

            // Check if directory modification time changed
            let current_modified = match tokio::fs::metadata(&dir).await {
                Ok(meta) => meta.modified().ok(),
                Err(_) => continue,
            };

            // Also check individual file mtimes for more accurate detection
            let max_file_mtime = self.max_file_mtime(&dir).await;
            let effective_mtime = match (current_modified, max_file_mtime) {
                (Some(a), Some(b)) => Some(std::cmp::max(a, b)),
                (a, b) => a.or(b),
            };

            let last = *self.last_scan.read().await;
            if effective_mtime != last && effective_mtime.is_some() {
                *self.last_scan.write().await = effective_mtime;

                // Reload plugins
                let plugins = scan_plugin_files(&self.working_dir);
                let mut providers = self.providers.write().await;

                // Track which plugin IDs exist on disk
                let plugin_ids: std::collections::HashSet<String> =
                    plugins.iter().map(|p| p.id.clone()).collect();

                // Add new plugins
                let mut changed = false;
                for plugin in &plugins {
                    if !providers.custom_providers.contains_key(&plugin.id) {
                        let builtins = builtin_providers();
                        if builtins.iter().any(|b| b.id == plugin.id) {
                            continue;
                        }
                        providers
                            .custom_providers
                            .insert(plugin.id.clone(), plugin_to_custom_data(plugin));
                        changed = true;
                        log::info!("Hot-loaded provider plugin: {}", plugin.id);
                    }
                }

                // Remove plugins whose files were deleted
                // (only remove those that were originally loaded from plugin files)
                let dir_path = plugins_dir(&self.working_dir);
                let to_remove: Vec<String> = providers
                    .custom_providers
                    .keys()
                    .filter(|id| {
                        // Only auto-remove if the plugin file previously existed
                        let file = dir_path.join(format!("{}.json", id));
                        !plugin_ids.contains(*id) && !file.exists()
                            // Don't remove user-created custom providers (those without plugin files)
                            && providers.custom_providers.get(*id).map_or(false, |_| {
                                // Check if there was ever a plugin file for this
                                false
                            })
                    })
                    .cloned()
                    .collect();

                for id in to_remove {
                    providers.custom_providers.remove(&id);
                    changed = true;
                    log::info!("Removed provider plugin (file deleted): {}", id);
                }

                if changed {
                    if let Err(e) = providers.save() {
                        log::error!("Failed to save after plugin reload: {}", e);
                    }
                }
            }
        }
    }

    async fn max_file_mtime(&self, dir: &Path) -> Option<std::time::SystemTime> {
        let mut max = None;
        if let Ok(mut entries) = tokio::fs::read_dir(dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                if path.extension().map_or(false, |e| e == "json") {
                    if let Ok(meta) = tokio::fs::metadata(&path).await {
                        if let Ok(mtime) = meta.modified() {
                            max = Some(max.map_or(mtime, |m: std::time::SystemTime| m.max(mtime)));
                        }
                    }
                }
            }
        }
        max
    }
}
