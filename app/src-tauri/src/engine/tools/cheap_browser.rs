//! Tier-1 browser tools backed by the user's system Chrome in headless mode.
//!
//! Covers the ~80% case ("show me this URL" / "grab the HTML of this page")
//! without spawning the full Playwright bridge + our bundled chromium-shell.
//! Claude Code uses a similar pattern for `WebFetchTool` (see
//! `/Users/Four/PersonalProjects/Claude-Code-Source-Study-main/docs/` — text
//! fetch via curl/headless, separate from interactive Playwright).
//!
//! Design:
//!   - Zero bundled dependency — we shell out to whatever Chrome / Chromium
//!     is on `$PATH` or at a standard macOS/Linux/Windows install location.
//!   - All URLs pass through `url_guard::check_url` (SSRF protection reused
//!     from `browser_use`).
//!   - All external content is wrapped by `output_envelope::wrap_external`
//!     so the LLM treats it as data, not instructions.
//!   - Every invocation is an isolated Chrome process — no cookies, no
//!     cross-request state. For anything needing session state or
//!     interaction (click/type/scroll), agent must fall back to
//!     `browser_use` (Playwright).
//!   - Timeout is enforced at the tokio level; Chrome sometimes ignores
//!     `--virtual-time-budget` and hangs on slow pages.

use std::path::PathBuf;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// Hard limit on a single cheap-browser invocation to prevent hanging agent loops.
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MAX_TIMEOUT_MS: u64 = 45_000;

/// Upper bound on returned HTML size (chars). Real web pages commonly hit
/// this; we truncate and tell the LLM it was truncated.
const MAX_DOM_CHARS: usize = 32_000;

/// Resolve a Chrome / Chromium binary path.
///
/// Checks, in order:
///   1. `$YIYI_CHROME_PATH` env override
///   2. macOS canonical bundle paths (Chrome, Chrome Canary, Chromium, Edge)
///   3. `$PATH` entries (`google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge`, `chrome`)
///   4. Windows Program Files canonical path
fn find_chrome_binary() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("YIYI_CHROME_PATH") {
        let p = PathBuf::from(custom);
        if p.exists() {
            return Some(p);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let mac_paths = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];
        for p in &mac_paths {
            if std::path::Path::new(p).exists() {
                return Some(PathBuf::from(*p));
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let win_paths = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        ];
        for p in &win_paths {
            if std::path::Path::new(p).exists() {
                return Some(PathBuf::from(*p));
            }
        }
    }

    // PATH lookup — used on Linux primarily, but works everywhere.
    let names = [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "chrome",
    ];
    for name in &names {
        if let Some(p) = which::which(name).ok() {
            return Some(p);
        }
    }

    None
}

fn missing_chrome_error() -> String {
    "Error: browser_binary_not_found. YiYi couldn't find Google Chrome / Chromium / Edge on this machine. Either install Chrome (https://www.google.com/chrome/) or point the YIYI_CHROME_PATH env var at your browser binary. If the user specifically needs automation that works without a system browser, fall back to `browser_use` (which bundles its own chromium).".to_string()
}

/// Pre-flight: check URL and resolve browser. Returns `Err(error_string)` if either fails.
fn preflight(url: &str) -> Result<PathBuf, String> {
    match super::url_guard::check_url(url) {
        super::url_guard::UrlVerdict::Deny(code) => {
            Err(super::url_guard::deny_message(code, url))
        }
        super::url_guard::UrlVerdict::Allow => {
            find_chrome_binary().ok_or_else(missing_chrome_error)
        }
    }
}

/// Common Chrome CLI flags that make a headless, isolated, short-lived run.
fn base_args() -> Vec<&'static str> {
    vec![
        "--headless",
        "--disable-gpu",
        "--incognito",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-translate",
        "--disable-client-side-phishing-detection",
        "--disable-default-apps",
        "--hide-scrollbars",
        "--mute-audio",
        "--no-pings",
    ]
}

// ── browser_screenshot ─────────────────────────────────────────────────────

pub(super) fn screenshot_def() -> super::ToolDefinition {
    super::tool_def(
        "browser_screenshot",
        "Take a PNG screenshot of a URL using headless Chrome. Zero-setup, no session state, no interaction. Use this for 'show me this page' tasks; use `browser_use` if you need to click/type/scroll or preserve login state.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "url":     { "type": "string", "description": "HTTP(S) URL to capture." },
                "width":   { "type": "integer", "description": "Viewport width px (default 1280)." },
                "height":  { "type": "integer", "description": "Viewport height px (default 800)." },
                "wait_ms": { "type": "integer", "description": "Virtual-time budget before capture in ms (default 3000, max 45000)." }
            },
            "required": ["url"]
        }),
    )
}

pub(super) async fn browser_screenshot_tool(args: &serde_json::Value) -> (String, Vec<String>) {
    let url = match args["url"].as_str() {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => return ("Error: missing_required_param (url).".to_string(), vec![]),
    };

    let chrome = match preflight(&url) {
        Ok(p) => p,
        Err(e) => return (e, vec![]),
    };

    let width = args["width"].as_u64().unwrap_or(1280).clamp(320, 3840);
    let height = args["height"].as_u64().unwrap_or(800).clamp(240, 2400);
    let wait_ms = args["wait_ms"].as_u64().unwrap_or(3000).min(MAX_TIMEOUT_MS);

    // Chrome writes the PNG to disk; we read it back and return as base64.
    let tmp = std::env::temp_dir().join(format!(
        "yiyi-shot-{}.png",
        uuid::Uuid::new_v4().simple()
    ));
    let tmp_str = tmp.to_string_lossy().to_string();

    let mut args_v = base_args();
    let screenshot_arg = format!("--screenshot={}", tmp_str);
    let window_arg = format!("--window-size={},{}", width, height);
    let time_arg = format!("--virtual-time-budget={}", wait_ms);
    args_v.extend([
        screenshot_arg.as_str(),
        window_arg.as_str(),
        time_arg.as_str(),
        &url,
    ]);

    let total_timeout = Duration::from_millis(wait_ms + DEFAULT_TIMEOUT_MS);

    let output = tokio::time::timeout(
        total_timeout,
        tokio::process::Command::new(&chrome)
            .args(&args_v)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await;

    match output {
        Err(_) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            (
                format!(
                    "Error: browser_screenshot_timeout (url={}, wait_ms={}). \
                     Page did not finish loading within budget. \
                     Try again with a shorter wait_ms, or fall back to browser_use for complex pages.",
                    url, wait_ms
                ),
                vec![],
            )
        }
        Ok(Err(e)) => (
            format!("Error: chrome_spawn_failed ({}). Chrome binary at `{}` could not be executed.", e, chrome.display()),
            vec![],
        ),
        Ok(Ok(out)) => {
            if !tmp.exists() || tmp.metadata().map(|m| m.len()).unwrap_or(0) == 0 {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let tail: String = stderr.chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
                let _ = tokio::fs::remove_file(&tmp).await;
                return (
                    format!("Error: chrome_exit_without_image (url={}). Chrome stderr tail: {}", url, tail),
                    vec![],
                );
            }

            let bytes = match tokio::fs::read(&tmp).await {
                Ok(b) => b,
                Err(e) => {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    return (format!("Error: read_screenshot_failed ({}).", e), vec![]);
                }
            };
            let _ = tokio::fs::remove_file(&tmp).await;

            let b64 = base64_encode_png(&bytes);
            let data_uri = format!("data:image/png;base64,{}", b64);
            let summary = format!(
                "Screenshot captured: {} bytes, {}x{} from {}. (Image attached; analyze visually.)",
                bytes.len(),
                width,
                height,
                url
            );
            (summary, vec![data_uri])
        }
    }
}

// ── browser_fetch ──────────────────────────────────────────────────────────

pub(super) fn fetch_def() -> super::ToolDefinition {
    super::tool_def(
        "browser_fetch",
        "Fetch a URL's rendered HTML via headless Chrome (JS-evaluated DOM, not raw HTTP). Cheap + zero-session. Use for 'read this page'; use `browser_use` for interaction or login-gated pages.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "url":     { "type": "string", "description": "HTTP(S) URL to fetch." },
                "wait_ms": { "type": "integer", "description": "Virtual-time budget in ms (default 3000, max 45000)." }
            },
            "required": ["url"]
        }),
    )
}

pub(super) async fn browser_fetch_tool(args: &serde_json::Value) -> String {
    let url = match args["url"].as_str() {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => return "Error: missing_required_param (url).".to_string(),
    };

    let chrome = match preflight(&url) {
        Ok(p) => p,
        Err(e) => return e,
    };

    let wait_ms = args["wait_ms"].as_u64().unwrap_or(3000).min(MAX_TIMEOUT_MS);

    let mut args_v = base_args();
    args_v.push("--dump-dom");
    let time_arg = format!("--virtual-time-budget={}", wait_ms);
    args_v.push(time_arg.as_str());
    args_v.push(&url);

    let total_timeout = Duration::from_millis(wait_ms + DEFAULT_TIMEOUT_MS);

    let mut cmd = tokio::process::Command::new(&chrome);
    cmd.args(&args_v)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return format!("Error: chrome_spawn_failed ({}).", e),
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => return "Error: chrome_stdout_capture_failed.".to_string(),
    };

    let read_task = async {
        let mut out = Vec::with_capacity(64 * 1024);
        let mut buf = [0u8; 16 * 1024];
        let mut reader = stdout;
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    out.extend_from_slice(&buf[..n]);
                    if out.len() > MAX_DOM_CHARS * 4 {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        out
    };

    let result = tokio::time::timeout(total_timeout, read_task).await;
    let _ = child.kill().await;

    let bytes = match result {
        Ok(b) => b,
        Err(_) => {
            return format!(
                "Error: browser_fetch_timeout (url={}, wait_ms={}). Try a shorter wait_ms or a simpler page.",
                url, wait_ms
            );
        }
    };

    let raw = String::from_utf8_lossy(&bytes).to_string();
    let (final_body, truncated) = if raw.chars().count() > MAX_DOM_CHARS {
        let trimmed: String = raw.chars().take(MAX_DOM_CHARS).collect();
        (trimmed, true)
    } else {
        (raw, false)
    };

    let header = if truncated {
        format!(
            "(truncated to {} chars — full page was larger; ask user to be more specific or use browser_use with targeted selectors)\n",
            MAX_DOM_CHARS
        )
    } else {
        String::new()
    };

    super::output_envelope::wrap_external_with_url(
        "browser_fetch",
        super::output_envelope::Trust::Low,
        &url,
        &format!("{}{}", header, final_body),
    )
}

// ── base64 — tiny inline encoder to avoid adding a dependency for this one use ─

fn base64_encode_png(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut chunks = input.chunks_exact(3);
    for chunk in chunks.by_ref() {
        let n = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | (chunk[2] as u32);
        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 6) & 0x3F) as usize] as char);
        out.push(TABLE[(n & 0x3F) as usize] as char);
    }
    let rem = chunks.remainder();
    match rem.len() {
        0 => {}
        1 => {
            let n = (rem[0] as u32) << 16;
            out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
            out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = ((rem[0] as u32) << 16) | ((rem[1] as u32) << 8);
            out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
            out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
            out.push(TABLE[((n >> 6) & 0x3F) as usize] as char);
            out.push('=');
        }
        _ => unreachable!(),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encodes_simple_bytes() {
        assert_eq!(base64_encode_png(b""), "");
        assert_eq!(base64_encode_png(b"f"), "Zg==");
        assert_eq!(base64_encode_png(b"fo"), "Zm8=");
        assert_eq!(base64_encode_png(b"foo"), "Zm9v");
        assert_eq!(base64_encode_png(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode_png(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode_png(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_roundtrip_short_png_magic() {
        // 8-byte PNG magic number
        let bytes: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(base64_encode_png(&bytes), "iVBORw0KGgo=");
    }

    #[test]
    fn preflight_rejects_bad_url() {
        assert!(preflight("http://localhost/").is_err());
        assert!(preflight("file:///etc/passwd").is_err());
        assert!(preflight("http://169.254.169.254/").is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn screenshot_rejects_missing_url() {
        let (out, imgs) = browser_screenshot_tool(&serde_json::json!({})).await;
        assert!(out.starts_with("Error: missing_required_param"));
        assert!(imgs.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fetch_rejects_missing_url() {
        let out = browser_fetch_tool(&serde_json::json!({})).await;
        assert!(out.starts_with("Error: missing_required_param"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fetch_rejects_private_ip_before_spawn() {
        // Must reject WITHOUT spawning chrome (we can't easily mock spawn here,
        // so we rely on url_guard running first). If this test hangs, the
        // preflight ordering regressed.
        let out = browser_fetch_tool(
            &serde_json::json!({ "url": "http://192.168.1.1/" }),
        )
        .await;
        assert!(out.starts_with("Error: url_private_rfc1918_blocked"));
    }
}
