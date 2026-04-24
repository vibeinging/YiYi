use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Playwright bridge state: Node.js child process + HTTP port.
pub(super) struct BrowserState {
    child: tokio::process::Child,
    port: u16,
    client: reqwest::Client,
}

impl BrowserState {
    pub(super) fn is_alive(&self) -> bool {
        if let Some(id) = self.child.id() {
            #[cfg(unix)]
            {
                let pid = match i32::try_from(id) {
                    Ok(p) => p,
                    Err(_) => return false,
                };
                let ret = unsafe { libc::kill(pid, 0) };
                if ret == 0 {
                    true
                } else {
                    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
                }
            }
            #[cfg(not(unix))]
            {
                let _ = id;
                true // On Windows, assume alive if we have a PID
            }
        } else {
            false
        }
    }

    pub(super) async fn shutdown(mut self) {
        // Send stop action to cleanly close browser
        let _ = self.client
            .post(format!("http://127.0.0.1:{}/action", self.port))
            .json(&serde_json::json!({"action": "stop"}))
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await;
        // Kill the Node.js process
        let _ = self.child.kill().await;
    }
}

pub(super) static BROWSER_STATE: std::sync::LazyLock<Arc<Mutex<Option<BrowserState>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(None)));

/// Response from the Playwright bridge.
#[derive(Debug, Deserialize, Default)]
struct BridgeResponse {
    text: String,
    #[serde(default)]
    images: Vec<String>,
}

/// Browser tool definitions.
pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "browser_use",
            "Drive a persistent Chromium session with INTERACTION (click/type/scroll/login). Cookies + sessions survive restarts via a named profile. Prefer the cheaper `browser_screenshot` or `browser_fetch` if you only need to see or read a page — those use system Chrome and don't spawn Playwright. Typical interactive flow: start → open(url) → ai_snapshot → act(element=N, operation=click). 'stop' disconnects (kill=true also quits Chrome). Action vocab is in the `action` enum below.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["start", "open", "goto", "get_url", "snapshot", "ai_snapshot", "act", "screenshot",
                                 "click", "type", "press_key", "scroll", "wait", "evaluate",
                                 "find_elements", "select", "upload", "cookies",
                                 "list_frames", "switch_frame", "evaluate_in_frame", "stop"],
                        "description": "Browser action to perform"
                    },
                    "url": { "type": "string", "description": "URL for 'open'/'goto' actions" },
                    "selector": { "type": "string", "description": "CSS selector for element actions" },
                    "text": { "type": "string", "description": "Text for 'type' action" },
                    "clear": { "type": "boolean", "description": "Clear existing input value before typing (for 'type', default: false)" },
                    "headed": { "type": "boolean", "description": "Launch visible browser (for 'start', default: false)" },
                    "expression": { "type": "string", "description": "JavaScript code (for 'evaluate' / 'evaluate_in_frame')" },
                    "key": { "type": "string", "description": "Key name: Enter, Tab, Escape, Backspace, ArrowDown, etc. (for 'press_key')" },
                    "direction": { "type": "string", "enum": ["up", "down", "left", "right"], "description": "Scroll direction (default: down)" },
                    "amount": { "type": "number", "description": "Scroll pixels (default: 500)" },
                    "timeout": { "type": "number", "description": "Wait timeout in ms (default: 5000, max: 30000)" },
                    "value": { "type": "string", "description": "Option value for 'select', or cookie value for 'cookies set'" },
                    "file_path": { "type": "string", "description": "Local file path for 'upload'" },
                    "limit": { "type": "number", "description": "Max elements to return (for 'find_elements', default: 20)" },
                    "attributes": { "type": "array", "items": {"type": "string"}, "description": "Attributes to extract (for 'find_elements', e.g. [\"href\", \"class\"])" },
                    "operation": { "type": "string", "description": "For 'cookies': get/set/delete. For 'act': click/type/select (default: click)" },
                    "name": { "type": "string", "description": "Cookie name (for 'cookies')" },
                    "domain": { "type": "string", "description": "Cookie domain (for 'cookies set')" },
                    "frame_index": { "type": "number", "description": "Frame index from list_frames (for 'switch_frame' / 'evaluate_in_frame')" },
                    "frame_url": { "type": "string", "description": "Frame URL pattern to match (for 'switch_frame' / 'evaluate_in_frame')" },
                    "element": { "type": "number", "description": "Element number from ai_snapshot (for 'act' action)" },
                    "profile": { "type": "string", "description": "Persistent Chrome profile name for 'start' (default: 'default'). Each profile has its own user-data-dir." },
                    "kill": { "type": "boolean", "description": "For 'stop' only: also kill the Chrome process and wipe profile state (default: false)." }
                },
                "required": ["action"]
            }),
        ),
    ]
}

/// Helper: if browser state exists but is dead, clean it up and set to None.
async fn cleanup_dead_browser() {
    let mut state_lock = BROWSER_STATE.lock().await;
    let is_dead = state_lock.as_ref().map_or(false, |s| !s.is_alive());
    if is_dead {
        if let Some(state) = state_lock.take() {
            log::warn!("Playwright bridge process died, cleaning up");
            state.shutdown().await;
        }
    }
}

/// Resolve the path to the playwright-bridge server.js script.
fn playwright_bridge_script() -> String {
    // In dev, it's relative to the src-tauri directory
    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("playwright-bridge")
        .join("server.js");
    if dev_path.exists() {
        return dev_path.to_string_lossy().to_string();
    }
    // In production bundle, look in resource dir
    if let Some(app) = super::APP_HANDLE.get() {
        use tauri::Manager;
        if let Ok(resource_dir) = app.path().resource_dir() {
            let bundled: std::path::PathBuf = resource_dir.join("playwright-bridge").join("server.js");
            if bundled.exists() {
                return bundled.to_string_lossy().to_string();
            }
        }
    }
    dev_path.to_string_lossy().to_string()
}

/// Returns (text_content, image_data_uris).
pub(super) async fn browser_use_tool(args: &serde_json::Value) -> (String, Vec<String>) {
    let action = args["action"].as_str().unwrap_or("");

    // SSRF guard: any action that takes a URL must be checked before we
    // forward the request to the Playwright bridge. (Control actions like
    // click / type / scroll don't receive URLs.)
    if matches!(action, "open" | "goto") {
        if let Some(url) = args.get("url").and_then(|v| v.as_str()) {
            if let super::url_guard::UrlVerdict::Deny(code) = super::url_guard::check_url(url) {
                log::warn!("browser_use {} blocked by URL guard: {} ({})", action, code, url);
                return (super::url_guard::deny_message(code, url), vec![]);
            }
        }
    }

    // "start" needs special handling: launch the bridge process
    if action == "start" {
        let mut state_lock = BROWSER_STATE.lock().await;
        // Shut down old bridge if any
        if let Some(old) = state_lock.take() {
            log::info!("Shutting down previous Playwright bridge");
            old.shutdown().await;
        }

        let script_path = playwright_bridge_script();
        log::info!("Launching Playwright bridge: {}", script_path);

        let mut child = match tokio::process::Command::new("node")
            .arg(&script_path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => return (format!("Failed to start Playwright bridge: {}. Make sure Node.js is installed.", e), vec![]),
        };

        // Read stdout until we get READY:{port}
        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => return (format!("Failed to capture stdout from Playwright bridge process."), vec![]),
        };
        let mut reader = tokio::io::BufReader::new(stdout);
        let mut line = String::new();
        let ready_timeout = std::time::Duration::from_secs(15);

        let port: u16 = match tokio::time::timeout(ready_timeout, async {
            use tokio::io::AsyncBufReadExt;
            loop {
                line.clear();
                let n = reader.read_line(&mut line).await.map_err(|e| format!("IO error: {}", e))?;
                if n == 0 { return Err("Bridge process exited before becoming ready".to_string()); }
                let trimmed = line.trim();
                if let Some(port_str) = trimmed.strip_prefix("READY:") {
                    return port_str.parse::<u16>().map_err(|e| format!("Invalid port: {}", e));
                }
            }
        }).await {
            Ok(Ok(p)) => p,
            Ok(Err(e)) => {
                let _ = child.kill().await;
                return (format!("Playwright bridge failed to start: {}", e), vec![]);
            }
            Err(_) => {
                let _ = child.kill().await;
                return ("Playwright bridge startup timed out (15s)".to_string(), vec![]);
            }
        };

        let client = reqwest::Client::new();

        // Forward the actual start action (with headed flag) to the bridge
        let resp = client
            .post(format!("http://127.0.0.1:{}/action", port))
            .json(args)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await;

        match resp {
            Ok(r) => {
                let body: BridgeResponse = r.json().await.unwrap_or_default();
                if body.text.starts_with("Error:") {
                    // Browser launch failed inside bridge, kill the process
                    let _ = child.kill().await;
                    return (body.text, vec![]);
                }
                *state_lock = Some(BrowserState { child, port, client });
                return (body.text, body.images);
            }
            Err(e) => {
                let _ = child.kill().await;
                return (format!("Bridge start request failed: {}", e), vec![]);
            }
        }
    }

    // "stop" shuts down the bridge
    if action == "stop" {
        let mut state_lock = BROWSER_STATE.lock().await;
        if let Some(state) = state_lock.take() {
            state.shutdown().await;
        }
        return ("Browser stopped.".to_string(), vec![]);
    }

    // All other actions: proxy to the bridge via HTTP
    cleanup_dead_browser().await;
    let state_lock = BROWSER_STATE.lock().await;
    let state = match state_lock.as_ref() {
        Some(s) => s,
        None => return ("Error: Browser not started. Call browser_use with action='start' first.".to_string(), vec![]),
    };

    let timeout = if action == "screenshot" || action == "ai_snapshot" {
        std::time::Duration::from_secs(30)
    } else if action == "wait" {
        std::time::Duration::from_secs(35)
    } else {
        std::time::Duration::from_secs(60)
    };

    match state.client
        .post(format!("http://127.0.0.1:{}/action", state.port))
        .json(args)
        .timeout(timeout)
        .send()
        .await
    {
        Ok(r) => {
            let body: BridgeResponse = r.json().await.unwrap_or_default();
            // Actions that return page content (snapshots, find_elements,
            // evaluate, get_url) are wrapped in the external-content
            // envelope — their output came from an arbitrary webpage and
            // can contain attacker-authored text. Control actions
            // (click/type/scroll/start/stop/cookies set/delete) just
            // return status strings from our own bridge and don't need
            // wrapping.
            let returns_page_content = matches!(
                action,
                "snapshot"
                    | "ai_snapshot"
                    | "evaluate"
                    | "evaluate_in_frame"
                    | "find_elements"
                    | "get_url"
                    | "list_frames"
            );
            let text = if returns_page_content && !body.text.starts_with("Error:") {
                super::output_envelope::wrap_external(
                    &format!("browser_{}", action),
                    super::output_envelope::Trust::Low,
                    &body.text,
                )
            } else {
                body.text
            };
            (text, body.images)
        }
        Err(e) => (format!("Browser bridge error: {}", e), vec![]),
    }
}
