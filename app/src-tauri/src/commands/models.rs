use serde::Serialize;
use tauri::State;

use crate::state::AppState;
use crate::state::providers::{
    CustomProviderData, ModelInfo, ModelSlotConfig, ProviderDefinition, ProviderInfo,
    ProviderSettings,
};

#[derive(Serialize)]
pub struct TestConnectionResponse {
    pub success: bool,
    pub message: String,
    pub latency_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct ActiveModelsInfo {
    pub provider_id: Option<String>,
    pub model: Option<String>,
}

#[tauri::command]
pub async fn list_providers(state: State<'_, AppState>) -> Result<Vec<ProviderInfo>, String> {
    let providers = state.providers.read().await;
    Ok(providers.get_all_providers())
}

#[tauri::command]
pub async fn configure_provider(
    state: State<'_, AppState>,
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
pub async fn test_provider(
    state: State<'_, AppState>,
    provider_id: String,
    api_key: Option<String>,
    base_url: Option<String>,
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

    drop(providers);

    let test_url = format!("{}/models", resolved_url.trim_end_matches('/'));

    let client = reqwest::Client::new();
    let start = std::time::Instant::now();

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
                    message: "Connection successful".to_string(),
                    latency_ms: Some(latency),
                })
            } else {
                Ok(TestConnectionResponse {
                    success: false,
                    message: format!("HTTP {}", resp.status()),
                    latency_ms: Some(latency),
                })
            }
        }
        Err(e) => Ok(TestConnectionResponse {
            success: false,
            message: format!("Connection failed: {}", e),
            latency_ms: None,
        }),
    }
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
    let mut providers = state.providers.write().await;

    let definition = ProviderDefinition {
        id: id.clone(),
        name,
        default_base_url,
        api_key_prefix,
        models,
        is_custom: true,
        is_local: false,
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
pub async fn delete_custom_provider(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<Vec<ProviderInfo>, String> {
    let mut providers = state.providers.write().await;
    providers.custom_providers.remove(&provider_id);
    state.db.delete_custom_provider(&provider_id)?;
    providers.save()?;
    Ok(providers.get_all_providers())
}

#[tauri::command]
pub async fn add_model(
    state: State<'_, AppState>,
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
pub async fn remove_model(
    state: State<'_, AppState>,
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
pub async fn test_model(
    state: State<'_, AppState>,
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

    drop(providers);

    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let start = std::time::Instant::now();

    let body = serde_json::json!({
        "model": model_id,
        "messages": [{"role": "user", "content": "Hi"}],
        "max_tokens": 5,
    });

    match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
    {
        Ok(resp) => {
            let latency = start.elapsed().as_millis() as u64;
            if resp.status().is_success() {
                Ok(TestConnectionResponse {
                    success: true,
                    message: format!("Model '{}' is working", model_id),
                    latency_ms: Some(latency),
                })
            } else {
                let text = resp.text().await.unwrap_or_default();
                Ok(TestConnectionResponse {
                    success: false,
                    message: format!("Model test failed: {}", text),
                    latency_ms: Some(latency),
                })
            }
        }
        Err(e) => Ok(TestConnectionResponse {
            success: false,
            message: format!("Connection failed: {}", e),
            latency_ms: None,
        }),
    }
}

#[tauri::command]
pub async fn get_active_llm(state: State<'_, AppState>) -> Result<ActiveModelsInfo, String> {
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
pub async fn set_active_llm(
    state: State<'_, AppState>,
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
