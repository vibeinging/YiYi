use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::page::Page;
use futures::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

struct BrowserInstance {
    browser: Browser,
    page: Option<Page>,
    _handler: tokio::task::JoinHandle<()>,
}

static BROWSERS: std::sync::LazyLock<Arc<RwLock<HashMap<String, BrowserInstance>>>> =
    std::sync::LazyLock::new(|| Arc::new(RwLock::new(HashMap::new())));

#[derive(Debug, Clone, Serialize)]
pub struct BrowserInfo {
    pub browser_id: String,
    pub status: String,
}

#[tauri::command]
pub async fn launch_browser(_headless: bool) -> Result<BrowserInfo, String> {
    let id = uuid::Uuid::new_v4().to_string();

    let config = if _headless {
        BrowserConfig::builder().window_size(1280, 900).build()
    } else {
        BrowserConfig::builder()
            .with_head()
            .window_size(1280, 900)
            .build()
    };
    let config = config.map_err(|e| format!("Failed to build browser config: {}", e))?;

    let (browser, mut handler) = Browser::launch(config)
        .await
        .map_err(|e| format!("Failed to launch browser: {}", e))?;

    let handle = tokio::spawn(async move {
        while let Some(h) = handler.next().await {
            if h.is_err() {
                break;
            }
        }
    });

    {
        let mut browsers = BROWSERS.write().await;
        browsers.insert(
            id.clone(),
            BrowserInstance {
                browser,
                page: None,
                _handler: handle,
            },
        );
    }

    Ok(BrowserInfo {
        browser_id: id,
        status: "launched".to_string(),
    })
}

#[tauri::command]
pub async fn browser_navigate(browser_id: String, url: String) -> Result<(), String> {
    let mut browsers = BROWSERS.write().await;
    let instance = browsers
        .get_mut(&browser_id)
        .ok_or_else(|| format!("Browser '{}' not found", browser_id))?;

    if let Some(page) = &instance.page {
        // Reuse existing page — navigate to the new URL
        page.goto(&url)
            .await
            .map_err(|e| format!("Navigation failed: {}", e))?;
    } else {
        // First navigation — create a new page (tab)
        let page = instance
            .browser
            .new_page(&url)
            .await
            .map_err(|e| format!("Navigation failed: {}", e))?;
        instance.page = Some(page);
    }

    Ok(())
}

#[tauri::command]
pub async fn browser_screenshot(
    browser_id: String,
    _full_page: bool,
) -> Result<String, String> {
    let browsers = BROWSERS.read().await;
    let instance = browsers
        .get(&browser_id)
        .ok_or_else(|| format!("Browser '{}' not found", browser_id))?;

    let page = instance
        .page
        .as_ref()
        .ok_or("No page open")?;

    let png_data = page
        .screenshot(
            chromiumoxide::page::ScreenshotParams::builder()
                .full_page(_full_page)
                .build(),
        )
        .await
        .map_err(|e| format!("Screenshot failed: {}", e))?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_data);

    Ok(format!("data:image/png;base64,{}", b64))
}

#[tauri::command]
pub async fn close_browser(browser_id: String) -> Result<(), String> {
    let mut browsers = BROWSERS.write().await;
    if let Some(mut instance) = browsers.remove(&browser_id) {
        instance.browser.close().await.ok();
        instance._handler.abort();
    }
    Ok(())
}
