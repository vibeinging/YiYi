use serde::Serialize;
use tauri::State;

use crate::state::AppState;
use crate::state::providers::{ModelSlotConfig, ProviderInfo, ProviderSettings};

/// Extract reply text from various LLM response formats.
/// Prioritizes the final answer over reasoning/thinking content.
fn extract_reply(text: &str) -> Option<String> {
    let body: serde_json::Value = serde_json::from_str(text).ok()?;
    let msg = &body["choices"][0]["message"];

    if let Some(s) = msg["content"].as_str() {
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    if let Some(arr) = msg["content"].as_array() {
        let parts: Vec<&str> = arr.iter()
            .filter_map(|item| item["text"].as_str())
            .collect();
        if !parts.is_empty() {
            return Some(parts.join(""));
        }
    }
    if let Some(arr) = body["content"].as_array() {
        let parts: Vec<&str> = arr.iter()
            .filter_map(|item| item["text"].as_str())
            .collect();
        if !parts.is_empty() {
            return Some(parts.join(""));
        }
    }
    if msg["reasoning_content"].as_str().is_some_and(|s| !s.is_empty()) {
        return Some("(模型已响应，思考内容已返回)".to_string());
    }

    None
}

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
        // 官方格式:thinking:{type}(此前误用顶层 enable_thinking 布尔)。
        body["thinking"] = serde_json::json!({ "type": if v { "enabled" } else { "disabled" } });
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
    let providers = state.providers.read().await;
    let all = providers.get_all_providers();
    let provider = all.iter().find(|p| p.id == provider_id);

    let resolved_url = base_url
        .or_else(|| provider.and_then(|p| p.base_url.clone()))
        .or_else(|| provider.map(|p| p.default_base_url.clone()))
        .unwrap_or_else(|| "https://api.deepseek.com/v1".to_string());

    let resolved_key = api_key
        .or_else(|| {
            providers.providers.get(&provider_id).and_then(|s| s.api_key.clone())
        })
        .or_else(|| {
            provider.and_then(|p| std::env::var(&p.api_key_prefix).ok())
        });

    let resolved_model = model_id.or_else(|| {
        provider.and_then(|p| p.models.first().map(|m| m.id.clone()))
    });

    drop(providers);

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();
    let start = std::time::Instant::now();

    if let Some(model) = resolved_model {
        let url = format!("{}/chat/completions", resolved_url.trim_end_matches('/'));

        let result = send_test_request(&client, &url, &model, &resolved_key, None).await;

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

    let api_key = providers.providers.get(&provider_id).and_then(|s| s.api_key.clone());
    let api_key = api_key
        .or_else(|| std::env::var(&provider.api_key_prefix).ok())
        .ok_or("No API key configured")?;

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
