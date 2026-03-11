use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// A Playwright bridge instance: a Node.js child process communicating via HTTP.
struct BrowserInstance {
    child: tokio::process::Child,
    port: u16,
    client: reqwest::Client,
}

impl BrowserInstance {
    fn is_alive(&self) -> bool {
        if let Some(id) = self.child.id() {
            let pid = match i32::try_from(id) {
                Ok(p) => p,
                Err(_) => return false,
            };
            let ret = unsafe { libc::kill(pid, 0) };
            if ret == 0 {
                true
            } else {
                // EPERM means the process exists but we lack permission to signal it
                std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
            }
        } else {
            false
        }
    }

    async fn shutdown(mut self) {
        let _ = self.client
            .post(format!("http://127.0.0.1:{}/action", self.port))
            .json(&serde_json::json!({"action": "stop"}))
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await;
        let _ = self.child.kill().await;
    }
}

#[derive(Debug, Deserialize, Default)]
struct BridgeResponse {
    text: String,
    #[serde(default)]
    images: Vec<String>,
}

static BROWSERS: std::sync::LazyLock<Arc<RwLock<HashMap<String, BrowserInstance>>>> =
    std::sync::LazyLock::new(|| Arc::new(RwLock::new(HashMap::new())));

#[derive(Debug, Clone, Serialize)]
pub struct BrowserInfo {
    pub browser_id: String,
    pub status: String,
}

async fn cleanup_dead_browsers() {
    let mut browsers = BROWSERS.write().await;
    let dead_ids: Vec<String> = browsers
        .iter()
        .filter(|(_, inst)| !inst.is_alive())
        .map(|(id, _)| id.clone())
        .collect();
    for id in dead_ids {
        if let Some(inst) = browsers.remove(&id) {
            log::warn!("Auto-cleaning dead browser instance: {}", id);
            inst.shutdown().await;
        }
    }
}

/// Resolve the playwright-bridge server.js path.
fn bridge_script_path() -> String {
    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("playwright-bridge")
        .join("server.js");
    dev_path.to_string_lossy().to_string()
}

/// Spawn a new Playwright bridge process and wait for it to be ready.
async fn spawn_bridge(headless: bool) -> Result<BrowserInstance, String> {
    let script_path = bridge_script_path();

    let mut child = tokio::process::Command::new("node")
        .arg(&script_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start Playwright bridge: {}", e))?;

    let stdout = child.stdout.take().unwrap();
    let mut reader = tokio::io::BufReader::new(stdout);
    let mut line = String::new();

    let port: u16 = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        use tokio::io::AsyncBufReadExt;
        loop {
            line.clear();
            let n = reader.read_line(&mut line).await.map_err(|e| format!("IO: {}", e))?;
            if n == 0 { return Err("Bridge exited".to_string()); }
            if let Some(p) = line.trim().strip_prefix("READY:") {
                return p.parse::<u16>().map_err(|e| format!("Bad port: {}", e));
            }
        }
    })
    .await
    .map_err(|_| "Bridge startup timed out".to_string())??;

    let client = reqwest::Client::new();

    // Send start action with headed flag
    client
        .post(format!("http://127.0.0.1:{}/action", port))
        .json(&serde_json::json!({"action": "start", "headed": !headless}))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Bridge start failed: {}", e))?;

    Ok(BrowserInstance { child, port, client })
}

#[tauri::command]
pub async fn launch_browser(headless: bool) -> Result<BrowserInfo, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let instance = spawn_bridge(headless).await?;
    BROWSERS.write().await.insert(id.clone(), instance);
    Ok(BrowserInfo {
        browser_id: id,
        status: "launched".to_string(),
    })
}

#[tauri::command]
pub async fn browser_navigate(browser_id: String, url: String) -> Result<(), String> {
    cleanup_dead_browsers().await;
    let browsers = BROWSERS.read().await;
    let instance = browsers
        .get(&browser_id)
        .ok_or_else(|| format!("Browser '{}' not found", browser_id))?;
    if !instance.is_alive() {
        return Err(format!("Browser '{}' has disconnected", browser_id));
    }

    // Use "open" (creates page if needed) instead of "goto" (requires existing page)
    let resp = instance.client
        .post(format!("http://127.0.0.1:{}/action", instance.port))
        .json(&serde_json::json!({"action": "open", "url": url}))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Navigation failed: {}", e))?;

    let body: BridgeResponse = resp.json().await.unwrap_or_default();
    if body.text.starts_with("Error:") {
        Err(body.text)
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn browser_screenshot(
    browser_id: String,
    full_page: bool,
) -> Result<String, String> {
    cleanup_dead_browsers().await;
    let browsers = BROWSERS.read().await;
    let instance = browsers
        .get(&browser_id)
        .ok_or_else(|| format!("Browser '{}' not found", browser_id))?;
    if !instance.is_alive() {
        return Err(format!("Browser '{}' has disconnected", browser_id));
    }

    let resp = instance.client
        .post(format!("http://127.0.0.1:{}/action", instance.port))
        .json(&serde_json::json!({"action": "screenshot", "fullPage": full_page}))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Screenshot failed: {}", e))?;

    let body: BridgeResponse = resp.json().await.unwrap_or_default();
    if body.images.is_empty() {
        Err(body.text)
    } else {
        Ok(body.images[0].clone())
    }
}

#[tauri::command]
pub async fn close_browser(browser_id: String) -> Result<(), String> {
    let mut browsers = BROWSERS.write().await;
    if let Some(instance) = browsers.remove(&browser_id) {
        instance.shutdown().await;
    }
    Ok(())
}
