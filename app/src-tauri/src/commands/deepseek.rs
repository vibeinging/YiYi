//! DeepSeek-platform integration commands.
//!
//! Currently only `get_deepseek_balance` lives here — it queries the user's
//! current balance via DeepSeek's `/user/balance` endpoint. The API key never
//! leaves the Rust process; the frontend gets back only the parsed balance.
//!
//! The "open in-app webview to platform.deepseek.com" flow is driven entirely
//! from the frontend via Tauri's `WebviewWindow` JS API, gated by the
//! `deepseek-window` capability file (zero IPC permissions). That keeps
//! third-party web content from ever calling our Tauri commands.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeepSeekBalanceInfo {
    pub currency: String,
    pub total_balance: String,
    pub granted_balance: String,
    pub topped_up_balance: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeepSeekBalance {
    pub is_available: bool,
    pub balance_infos: Vec<DeepSeekBalanceInfo>,
}

/// Query the user's current DeepSeek balance.
///
/// Reads the saved API key for the `deepseek` provider, calls
/// `GET https://api.deepseek.com/user/balance`, and returns the parsed
/// response. Returns an error if no key is configured or the request fails.
#[tauri::command]
pub async fn get_deepseek_balance(
    state: State<'_, AppState>,
) -> Result<DeepSeekBalance, String> {
    let (api_key, base_url) = {
        let providers = state.providers.read().await;
        let key = providers
            .providers
            .get("deepseek")
            .and_then(|s| s.api_key.clone())
            .or_else(|| std::env::var("DEEPSEEK_API_KEY").ok())
            .ok_or_else(|| "尚未配置 DeepSeek API Key".to_string())?;
        let url = providers
            .providers
            .get("deepseek")
            .and_then(|s| s.base_url.clone())
            .unwrap_or_else(|| "https://api.deepseek.com/v1".to_string());
        (key, url)
    };

    // Balance endpoint lives at /user/balance — the OpenAI-compatible /v1
    // suffix on the saved base_url is for chat completions; strip it.
    let host = base_url
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_string();
    let url = format!("{host}/user/balance");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // Try to extract DeepSeek's error message; otherwise fall back to status.
        let detail = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(format!("查询余额失败: {detail}"));
    }

    serde_json::from_str::<DeepSeekBalance>(&text)
        .map_err(|e| format!("解析响应失败: {e}; body: {}", text.chars().take(200).collect::<String>()))
}
