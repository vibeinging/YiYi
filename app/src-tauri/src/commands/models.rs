use serde::Serialize;
use tauri::State;

use crate::state::AppState;
use crate::state::providers::{
    CustomProviderData, ModelInfo, ModelSlotConfig, ProviderDefinition, ProviderInfo,
    ProviderPlugin, ProviderSettings, ProviderTemplate,
};

/// Extract reply text from various LLM response formats.
/// Prioritizes the final answer over reasoning/thinking content.
/// Returns Some even if only reasoning_content exists (model responded but thinking used all tokens).
fn extract_reply(text: &str) -> Option<String> {
    let body: serde_json::Value = serde_json::from_str(text).ok()?;
    let msg = &body["choices"][0]["message"];

    // 1. OpenAI-compatible: choices[0].message.content (string)
    if let Some(s) = msg["content"].as_str() {
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    // 2. content is array: choices[0].message.content[0].text
    if let Some(arr) = msg["content"].as_array() {
        let parts: Vec<&str> = arr.iter()
            .filter_map(|item| item["text"].as_str())
            .collect();
        if !parts.is_empty() {
            return Some(parts.join(""));
        }
    }
    // 3. Anthropic native: content[0].text
    if let Some(arr) = body["content"].as_array() {
        let parts: Vec<&str> = arr.iter()
            .filter_map(|item| item["text"].as_str())
            .collect();
        if !parts.is_empty() {
            return Some(parts.join(""));
        }
    }
    // 4. If reasoning_content exists but content is empty, the model
    //    did respond (thinking used all tokens). Still counts as connected.
    if msg["reasoning_content"].as_str().is_some_and(|s| !s.is_empty()) {
        return Some("(模型已响应，思考内容已返回)".to_string());
    }

    None
}

/// Send a single test chat completion request.
/// `enable_thinking` — if Some, adds the parameter to the body.
async fn send_test_request(
    client: &reqwest::Client,
    url: &str,
    model: &str,
    api_key: &Option<String>,
    enable_thinking: Option<bool>,
) -> Result<TestConnectionResponse, String> {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": "Reply in one short sentence."},
            {"role": "user", "content": "Say hi and tell me your model name."},
        ],
        "max_tokens": 300,
        "stream": false,
    });
    if let Some(v) = enable_thinking {
        body["enable_thinking"] = serde_json::json!(v);
    }

    let mut req = client.post(url)
        .header("Content-Type", "application/json")
        .json(&body);
    if let Some(key) = api_key {
        req = req.header("Authorization", format!("Bearer {}", key));
    }
    if crate::engine::llm_client::needs_coding_agent_ua(url) {
        req = req.header("User-Agent", crate::engine::llm_client::CODING_AGENT_UA);
    }

    let start = std::time::Instant::now();
    match req.timeout(std::time::Duration::from_secs(10)).send().await {
        Ok(resp) => {
            let latency = start.elapsed().as_millis() as u64;
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if status.is_success() {
                let reply = extract_reply(&text);
                if reply.is_some() {
                    Ok(TestConnectionResponse {
                        success: true,
                        message: format!("{}ms", latency),
                        latency_ms: Some(latency),
                        reply,
                    })
                } else {
                    Ok(TestConnectionResponse {
                        success: false,
                        message: "模型已响应但未返回有效内容（可能 token 不足或格式不兼容）".to_string(),
                        latency_ms: Some(latency),
                        reply: None,
                    })
                }
            } else {
                let err_msg = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| v["error"]["message"].as_str().map(String::from))
                    .unwrap_or(text);
                Ok(TestConnectionResponse {
                    success: false,
                    message: err_msg,
                    latency_ms: Some(latency),
                    reply: None,
                })
            }
        }
        Err(e) => Ok(TestConnectionResponse {
            success: false,
            message: format!("Connection failed: {}", e),
            latency_ms: None,
            reply: None,
        }),
    }
}

#[derive(Serialize)]
pub struct TestConnectionResponse {
    pub success: bool,
    pub message: String,
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
}

#[derive(Serialize)]
pub struct ActiveModelsInfo {
    pub provider_id: Option<String>,
    pub model: Option<String>,
}

// ── list_providers ──────────────────────────────────────────────────

pub async fn list_providers_impl(state: &AppState) -> Result<Vec<ProviderInfo>, String> {
    let providers = state.providers.read().await;
    Ok(providers.get_all_providers())
}

#[tauri::command]
pub async fn list_providers(state: State<'_, AppState>) -> Result<Vec<ProviderInfo>, String> {
    list_providers_impl(&state).await
}

// ── configure_provider ──────────────────────────────────────────────

pub async fn configure_provider_impl(
    state: &AppState,
    provider_id: String,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<ProviderInfo, String> {
    let mut providers = state.providers.write().await;

    // Check if it's a custom provider
    if let Some(custom) = providers.custom_providers.get_mut(&provider_id) {
        if let Some(key) = api_key {
            custom.settings.api_key = Some(key);
        }
        if let Some(url) = base_url {
            custom.settings.base_url = Some(url);
        }
    } else {
        // Built-in provider
        let settings = providers
            .providers
            .entry(provider_id.clone())
            .or_insert_with(ProviderSettings::default);
        if let Some(key) = api_key {
            settings.api_key = Some(key);
        }
        if let Some(url) = base_url {
            settings.base_url = Some(url);
        }
    }

    providers.save()?;

    let all = providers.get_all_providers();
    all.into_iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("Provider '{}' not found", provider_id))
}

#[tauri::command]
pub async fn configure_provider(
    state: State<'_, AppState>,
    provider_id: String,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<ProviderInfo, String> {
    configure_provider_impl(&state, provider_id, api_key, base_url).await
}

// ── test_provider ───────────────────────────────────────────────────

pub async fn test_provider_impl(
    state: &AppState,
    provider_id: String,
    api_key: Option<String>,
    base_url: Option<String>,
    model_id: Option<String>,
) -> Result<TestConnectionResponse, String> {
    // Resolve API key and base URL: use provided values, fallback to saved config
    let providers = state.providers.read().await;
    let all = providers.get_all_providers();
    let provider = all.iter().find(|p| p.id == provider_id);

    let resolved_url = base_url
        .or_else(|| provider.and_then(|p| p.base_url.clone()))
        .or_else(|| provider.map(|p| p.default_base_url.clone()))
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string());

    let resolved_key = api_key
        .or_else(|| {
            if let Some(custom) = providers.custom_providers.get(&provider_id) {
                custom.settings.api_key.clone()
            } else {
                providers.providers.get(&provider_id).and_then(|s| s.api_key.clone())
            }
        })
        .or_else(|| {
            provider.and_then(|p| std::env::var(&p.api_key_prefix).ok())
        });

    // Pick model: explicit > selected > first available
    let resolved_model = model_id.or_else(|| {
        provider.and_then(|p| p.models.first().map(|m| m.id.clone()))
    });

    drop(providers);

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();
    let start = std::time::Instant::now();

    // Send a real chat completion with "hello"
    if let Some(model) = resolved_model {
        let url = format!("{}/chat/completions", resolved_url.trim_end_matches('/'));

        // First attempt: normal request
        let result = send_test_request(&client, &url, &model, &resolved_key, None).await;

        // If model responded (HTTP 200) but no extractable content,
        // retry with enable_thinking=false — the model may be a thinking model
        // that consumed all tokens on reasoning.
        if let Ok(ref resp) = result {
            if !resp.success && resp.latency_ms.is_some() && resp.reply.is_none() {
                let retry = send_test_request(&client, &url, &model, &resolved_key, Some(false)).await;
                if let Ok(ref r) = retry {
                    if r.success { return retry; }
                }
            }
        }

        result
    } else {
        // No model available, fallback to /models endpoint check
        let test_url = format!("{}/models", resolved_url.trim_end_matches('/'));
        let mut req = client.get(&test_url);
        if let Some(key) = resolved_key {
            req = req.header("Authorization", format!("Bearer {}", key));
        }
        match req.timeout(std::time::Duration::from_secs(10)).send().await {
            Ok(resp) => {
                let latency = start.elapsed().as_millis() as u64;
                if resp.status().is_success() {
                    Ok(TestConnectionResponse {
                        success: true,
                        message: format!("{}ms (no model selected)", latency),
                        latency_ms: Some(latency),
                        reply: None,
                    })
                } else {
                    Ok(TestConnectionResponse {
                        success: false,
                        message: format!("HTTP {}", resp.status()),
                        latency_ms: Some(latency),
                        reply: None,
                    })
                }
            }
            Err(e) => Ok(TestConnectionResponse {
                success: false,
                message: format!("Connection failed: {}", e),
                latency_ms: None,
                reply: None,
            }),
        }
    }
}

#[tauri::command]
pub async fn test_provider(
    state: State<'_, AppState>,
    provider_id: String,
    api_key: Option<String>,
    base_url: Option<String>,
    model_id: Option<String>,
) -> Result<TestConnectionResponse, String> {
    test_provider_impl(&state, provider_id, api_key, base_url, model_id).await
}

// ── create_custom_provider ──────────────────────────────────────────

pub async fn create_custom_provider_impl(
    state: &AppState,
    id: String,
    name: String,
    default_base_url: String,
    api_key_prefix: String,
    models: Vec<ModelInfo>,
) -> Result<ProviderInfo, String> {
    let mut providers = state.providers.write().await;

    let definition = ProviderDefinition {
        id: id.clone(),
        name,
        default_base_url,
        api_key_prefix,
        models,
        is_custom: true,
        is_local: false,
        native_tools: vec![],
    };

    providers.custom_providers.insert(
        id.clone(),
        CustomProviderData {
            definition,
            settings: ProviderSettings::default(),
        },
    );

    providers.save()?;

    let all = providers.get_all_providers();
    all.into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "Failed to create provider".to_string())
}

#[tauri::command]
pub async fn create_custom_provider(
    state: State<'_, AppState>,
    id: String,
    name: String,
    default_base_url: String,
    api_key_prefix: String,
    models: Vec<ModelInfo>,
) -> Result<ProviderInfo, String> {
    create_custom_provider_impl(&state, id, name, default_base_url, api_key_prefix, models).await
}

// ── delete_custom_provider ──────────────────────────────────────────

pub async fn delete_custom_provider_impl(
    state: &AppState,
    provider_id: String,
) -> Result<Vec<ProviderInfo>, String> {
    let mut providers = state.providers.write().await;
    providers.custom_providers.remove(&provider_id);
    state.db.delete_custom_provider(&provider_id)?;
    providers.save()?;
    Ok(providers.get_all_providers())
}

#[tauri::command]
pub async fn delete_custom_provider(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<Vec<ProviderInfo>, String> {
    delete_custom_provider_impl(&state, provider_id).await
}

// ── add_model ───────────────────────────────────────────────────────

pub async fn add_model_impl(
    state: &AppState,
    provider_id: String,
    model_id: String,
    model_name: String,
) -> Result<ProviderInfo, String> {
    let mut providers = state.providers.write().await;

    let new_model = ModelInfo {
        id: model_id,
        name: model_name,
    };

    if let Some(custom) = providers.custom_providers.get_mut(&provider_id) {
        custom.definition.models.push(new_model);
    } else {
        let settings = providers
            .providers
            .entry(provider_id.clone())
            .or_insert_with(ProviderSettings::default);
        settings.extra_models.push(new_model);
    }

    providers.save()?;

    let all = providers.get_all_providers();
    all.into_iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("Provider '{}' not found", provider_id))
}

#[tauri::command]
pub async fn add_model(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: String,
    model_name: String,
) -> Result<ProviderInfo, String> {
    add_model_impl(&state, provider_id, model_id, model_name).await
}

// ── remove_model ────────────────────────────────────────────────────

pub async fn remove_model_impl(
    state: &AppState,
    provider_id: String,
    model_id: String,
) -> Result<ProviderInfo, String> {
    let mut providers = state.providers.write().await;

    if let Some(custom) = providers.custom_providers.get_mut(&provider_id) {
        custom.definition.models.retain(|m| m.id != model_id);
    } else if let Some(settings) = providers.providers.get_mut(&provider_id) {
        settings.extra_models.retain(|m| m.id != model_id);
    }

    providers.save()?;

    let all = providers.get_all_providers();
    all.into_iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("Provider '{}' not found", provider_id))
}

#[tauri::command]
pub async fn remove_model(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: String,
) -> Result<ProviderInfo, String> {
    remove_model_impl(&state, provider_id, model_id).await
}

// ── test_model ──────────────────────────────────────────────────────

pub async fn test_model_impl(
    state: &AppState,
    provider_id: String,
    model_id: String,
) -> Result<TestConnectionResponse, String> {
    let providers = state.providers.read().await;
    let all = providers.get_all_providers();
    let provider = all.iter().find(|p| p.id == provider_id)
        .ok_or_else(|| format!("Provider '{}' not found", provider_id))?;

    let base_url = provider.base_url.as_deref()
        .unwrap_or(&provider.default_base_url);

    let api_key = if let Some(custom) = providers.custom_providers.get(&provider_id) {
        custom.settings.api_key.clone()
    } else {
        providers.providers.get(&provider_id).and_then(|s| s.api_key.clone())
    };
    let api_key = api_key
        .or_else(|| std::env::var(&provider.api_key_prefix).ok())
        .ok_or("No API key configured")?;

    // Capture URL before dropping the read-lock (borrows from `provider`).
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    drop(providers);

    let client = reqwest::Client::new();
    let api_key_opt = Some(api_key);

    let result = send_test_request(&client, &url, &model_id, &api_key_opt, None).await;
    if let Ok(ref resp) = result {
        if !resp.success && resp.latency_ms.is_some() && resp.reply.is_none() {
            let retry = send_test_request(&client, &url, &model_id, &api_key_opt, Some(false)).await;
            if let Ok(ref r) = retry {
                if r.success { return retry; }
            }
        }
    }
    result
}

#[tauri::command]
pub async fn test_model(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: String,
) -> Result<TestConnectionResponse, String> {
    test_model_impl(&state, provider_id, model_id).await
}

// ── get_active_llm ──────────────────────────────────────────────────

pub async fn get_active_llm_impl(state: &AppState) -> Result<ActiveModelsInfo, String> {
    let providers = state.providers.read().await;
    match &providers.active_llm {
        Some(slot) => Ok(ActiveModelsInfo {
            provider_id: Some(slot.provider_id.clone()),
            model: Some(slot.model.clone()),
        }),
        None => Ok(ActiveModelsInfo {
            provider_id: None,
            model: None,
        }),
    }
}

#[tauri::command]
pub async fn get_active_llm(state: State<'_, AppState>) -> Result<ActiveModelsInfo, String> {
    get_active_llm_impl(&state).await
}

// ── set_active_llm ──────────────────────────────────────────────────

pub async fn set_active_llm_impl(
    state: &AppState,
    provider_id: String,
    model: String,
) -> Result<ActiveModelsInfo, String> {
    let mut providers = state.providers.write().await;
    providers.active_llm = Some(ModelSlotConfig {
        provider_id: provider_id.clone(),
        model: model.clone(),
    });
    providers.save()?;

    Ok(ActiveModelsInfo {
        provider_id: Some(provider_id),
        model: Some(model),
    })
}

#[tauri::command]
pub async fn set_active_llm(
    state: State<'_, AppState>,
    provider_id: String,
    model: String,
) -> Result<ActiveModelsInfo, String> {
    set_active_llm_impl(&state, provider_id, model).await
}

// ── Provider Plugin Commands ────────────────────────────────────────

pub fn list_provider_templates_impl() -> Vec<ProviderTemplate> {
    crate::state::providers::builtin_templates()
}

#[tauri::command]
pub async fn list_provider_templates() -> Result<Vec<ProviderTemplate>, String> {
    Ok(list_provider_templates_impl())
}

// ── import_provider_plugin ──────────────────────────────────────────

pub async fn import_provider_plugin_impl(
    state: &AppState,
    plugin: ProviderPlugin,
) -> Result<ProviderInfo, String> {
    let mut providers = state.providers.write().await;
    providers.import_plugin(&state.working_dir, plugin)
}

#[tauri::command]
pub async fn import_provider_plugin(
    state: State<'_, AppState>,
    plugin: ProviderPlugin,
) -> Result<ProviderInfo, String> {
    import_provider_plugin_impl(&state, plugin).await
}

// ── export_provider_config ──────────────────────────────────────────

pub async fn export_provider_config_impl(
    state: &AppState,
    provider_id: String,
) -> Result<ProviderPlugin, String> {
    let providers = state.providers.read().await;

    // Try custom providers first
    if let Some(custom) = providers.custom_providers.get(&provider_id) {
        let def = &custom.definition;
        return Ok(ProviderPlugin {
            id: def.id.clone(),
            name: def.name.clone(),
            default_base_url: def.default_base_url.clone(),
            api_key_env: def.api_key_prefix.clone(),
            api_compat: "openai".into(),
            is_local: def.is_local,
            models: def.models.clone(),
            description: None,
            native_tools: def.native_tools.clone(),
        });
    }

    // Try built-in providers
    let builtins = crate::state::providers::builtin_providers();
    if let Some(def) = builtins.iter().find(|b| b.id == provider_id) {
        return Ok(ProviderPlugin {
            id: def.id.clone(),
            name: def.name.clone(),
            default_base_url: def.default_base_url.clone(),
            api_key_env: def.api_key_prefix.clone(),
            api_compat: "openai".into(),
            is_local: def.is_local,
            models: def.models.clone(),
            description: None,
            native_tools: def.native_tools.clone(),
        });
    }

    Err(format!("Provider '{}' not found", provider_id))
}

#[tauri::command]
pub async fn export_provider_config(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<ProviderPlugin, String> {
    export_provider_config_impl(&state, provider_id).await
}

// ── scan_provider_plugins ───────────────────────────────────────────

pub async fn scan_provider_plugins_impl(state: &AppState) -> Result<Vec<ProviderInfo>, String> {
    let mut providers = state.providers.write().await;
    providers.load_plugins(&state.working_dir);
    Ok(providers.get_all_providers())
}

#[tauri::command]
pub async fn scan_provider_plugins(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderInfo>, String> {
    scan_provider_plugins_impl(&state).await
}

// ── import_provider_from_template ───────────────────────────────────

pub async fn import_provider_from_template_impl(
    state: &AppState,
    template_id: String,
) -> Result<ProviderInfo, String> {
    let templates = crate::state::providers::builtin_templates();
    let template = templates
        .iter()
        .find(|t| t.id == template_id)
        .ok_or_else(|| format!("Template '{}' not found", template_id))?;

    let mut providers = state.providers.write().await;
    providers.import_plugin(&state.working_dir, template.plugin.clone())
}

#[tauri::command]
pub async fn import_provider_from_template(
    state: State<'_, AppState>,
    template_id: String,
) -> Result<ProviderInfo, String> {
    import_provider_from_template_impl(&state, template_id).await
}
