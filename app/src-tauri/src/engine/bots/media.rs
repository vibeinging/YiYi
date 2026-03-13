use std::path::{Path, PathBuf};

/// Download media from a platform-specific URL and save it locally.
///
/// Supported URL schemes:
/// - `telegram://file/{file_id}` — Downloads via Telegram Bot API (getFile + download)
/// - `feishu://image/{image_key}` — Downloads via Feishu IM image API
/// - `feishu://file/{file_key}` — Downloads via Feishu IM file API
/// - `feishu://audio/{file_key}` — Downloads via Feishu IM file API
/// - `dingtalk://image/{download_code}` — TODO: DingTalk uses download codes, not yet implemented
/// - `dingtalk://file/{download_code}` — TODO: same as above
/// - `http://...` / `https://...` — Direct download (Discord attachments, etc.)
///
/// Returns the local path where the file was saved, under
/// `{workspace_dir}/.yiyiclaw/media/{platform}/{filename}`.
pub async fn download_bot_media(
    platform: &str,
    url: &str,
    config: &serde_json::Value,
    workspace_dir: &Path,
) -> Result<PathBuf, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Determine the download strategy based on URL scheme
    if let Some(file_id) = url.strip_prefix("telegram://file/") {
        download_telegram_media(&client, file_id, config, platform, workspace_dir).await
    } else if let Some(image_key) = url.strip_prefix("feishu://image/") {
        download_feishu_image(&client, image_key, config, platform, workspace_dir).await
    } else if let Some(file_key) = url.strip_prefix("feishu://file/") {
        download_feishu_file(&client, file_key, config, platform, workspace_dir).await
    } else if let Some(file_key) = url.strip_prefix("feishu://audio/") {
        download_feishu_file(&client, file_key, config, platform, workspace_dir).await
    } else if url.starts_with("dingtalk://") {
        // TODO: DingTalk media download requires OAuth token + special API
        // For now, return an error indicating it's not yet supported
        Err(format!(
            "DingTalk media download not yet implemented for: {}",
            url
        ))
    } else if url.starts_with("http://") || url.starts_with("https://") {
        // Direct URL download (Discord attachments, etc.)
        download_direct_url(&client, url, platform, workspace_dir).await
    } else {
        Err(format!("Unsupported media URL scheme: {}", url))
    }
}

/// Ensure the media directory exists and return it.
fn ensure_media_dir(workspace_dir: &Path, platform: &str) -> Result<PathBuf, String> {
    let media_dir = workspace_dir
        .join(".yiyiclaw")
        .join("media")
        .join(platform);
    std::fs::create_dir_all(&media_dir)
        .map_err(|e| format!("Failed to create media dir {:?}: {}", media_dir, e))?;
    Ok(media_dir)
}

/// Generate a unique filename, preserving extension if possible.
fn unique_filename(hint: &str, extension: Option<&str>) -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    // Clean the hint: take last path segment, remove query params
    let base = hint
        .rsplit('/')
        .next()
        .unwrap_or(hint)
        .split('?')
        .next()
        .unwrap_or(hint);

    if base.contains('.') && base.len() < 200 {
        // Already has an extension, just prepend timestamp for uniqueness
        format!("{}_{}", ts, sanitize_filename(base))
    } else if let Some(ext) = extension {
        format!("{}_{}.{}", ts, sanitize_filename(base), ext)
    } else {
        format!("{}_{}", ts, sanitize_filename(base))
    }
}

/// Remove unsafe characters from a filename.
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Guess file extension from Content-Type header.
fn extension_from_content_type(content_type: &str) -> Option<&'static str> {
    let ct = content_type.split(';').next().unwrap_or("").trim();
    match ct {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "audio/ogg" => Some("ogg"),
        "audio/mpeg" => Some("mp3"),
        "audio/wav" => Some("wav"),
        "video/mp4" => Some("mp4"),
        "application/pdf" => Some("pdf"),
        "application/zip" => Some("zip"),
        "text/plain" => Some("txt"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

/// Download a file from Telegram using the Bot API two-step process:
/// 1. GET /getFile?file_id=xxx → get file_path
/// 2. Download from https://api.telegram.org/file/bot{token}/{file_path}
async fn download_telegram_media(
    client: &reqwest::Client,
    file_id: &str,
    config: &serde_json::Value,
    platform: &str,
    workspace_dir: &Path,
) -> Result<PathBuf, String> {
    let token = config["bot_token"]
        .as_str()
        .ok_or("Telegram bot_token not found in bot config")?;

    let base_url = format!("https://api.telegram.org/bot{}", token);

    // Step 1: getFile to obtain file_path
    let get_file_url = format!("{}/getFile?file_id={}", base_url, file_id);
    let resp = client
        .get(&get_file_url)
        .send()
        .await
        .map_err(|e| format!("Telegram getFile request failed: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Telegram getFile response parse error: {}", e))?;

    if json["ok"].as_bool() != Some(true) {
        return Err(format!(
            "Telegram getFile failed: {}",
            json["description"].as_str().unwrap_or("unknown error")
        ));
    }

    let file_path = json["result"]["file_path"]
        .as_str()
        .ok_or("Telegram getFile: no file_path in response")?;

    // Step 2: Download the actual file
    let download_url = format!(
        "https://api.telegram.org/file/bot{}/{}",
        token, file_path
    );

    let media_dir = ensure_media_dir(workspace_dir, platform)?;
    let filename = unique_filename(file_path, None);
    let local_path = media_dir.join(&filename);

    download_to_file(client, &download_url, &local_path, None).await?;

    log::info!(
        "Telegram media downloaded: file_id={} -> {:?}",
        file_id,
        local_path
    );
    Ok(local_path)
}

// ---------------------------------------------------------------------------
// Feishu
// ---------------------------------------------------------------------------

/// Get a Feishu access token from the bot config.
/// The config should contain `app_id` and `app_secret`.
async fn get_feishu_token(
    client: &reqwest::Client,
    config: &serde_json::Value,
) -> Result<String, String> {
    let app_id = config["app_id"]
        .as_str()
        .ok_or("Feishu app_id not found in bot config")?;
    let app_secret = config["app_secret"]
        .as_str()
        .ok_or("Feishu app_secret not found in bot config")?;

    let body = serde_json::json!({
        "app_id": app_id,
        "app_secret": app_secret,
    });

    let resp = client
        .post("https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal")
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Feishu auth request failed: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Feishu auth response parse failed: {}", e))?;

    let code = json["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        return Err(format!(
            "Feishu auth failed: code={}, msg={}",
            code,
            json["msg"].as_str().unwrap_or("unknown")
        ));
    }

    json["app_access_token"]
        .as_str()
        .or_else(|| json["tenant_access_token"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Feishu auth: no token in response: {}", json))
}

/// Download an image from Feishu.
/// API: GET https://open.feishu.cn/open-apis/im/v1/images/{image_key}
async fn download_feishu_image(
    client: &reqwest::Client,
    image_key: &str,
    config: &serde_json::Value,
    platform: &str,
    workspace_dir: &Path,
) -> Result<PathBuf, String> {
    let token = get_feishu_token(client, config).await?;

    let url = format!(
        "https://open.feishu.cn/open-apis/im/v1/images/{}",
        image_key
    );

    let media_dir = ensure_media_dir(workspace_dir, platform)?;
    // Feishu images are typically JPEG or PNG; we'll detect from content-type
    let filename = unique_filename(image_key, Some("jpg"));
    let local_path = media_dir.join(&filename);

    download_to_file(
        client,
        &url,
        &local_path,
        Some(&format!("Bearer {}", token)),
    )
    .await?;

    log::info!(
        "Feishu image downloaded: image_key={} -> {:?}",
        image_key,
        local_path
    );
    Ok(local_path)
}

/// Download a file/audio from Feishu.
/// API: GET https://open.feishu.cn/open-apis/im/v1/messages/{message_id}/resources/{file_key}
/// Note: file download requires message_id which we may not have in this context.
/// Fallback: try the image endpoint which also works for some file types.
async fn download_feishu_file(
    client: &reqwest::Client,
    file_key: &str,
    config: &serde_json::Value,
    platform: &str,
    workspace_dir: &Path,
) -> Result<PathBuf, String> {
    let token = get_feishu_token(client, config).await?;

    // Try the image endpoint first (works for images and some files)
    let url = format!(
        "https://open.feishu.cn/open-apis/im/v1/images/{}",
        file_key
    );

    let media_dir = ensure_media_dir(workspace_dir, platform)?;
    let filename = unique_filename(file_key, None);
    let local_path = media_dir.join(&filename);

    download_to_file(
        client,
        &url,
        &local_path,
        Some(&format!("Bearer {}", token)),
    )
    .await?;

    log::info!(
        "Feishu file downloaded: file_key={} -> {:?}",
        file_key,
        local_path
    );
    Ok(local_path)
}

// ---------------------------------------------------------------------------
// Direct URL (Discord, etc.)
// ---------------------------------------------------------------------------

/// Download from a direct HTTP(S) URL (e.g., Discord attachment URLs).
async fn download_direct_url(
    client: &reqwest::Client,
    url: &str,
    platform: &str,
    workspace_dir: &Path,
) -> Result<PathBuf, String> {
    let media_dir = ensure_media_dir(workspace_dir, platform)?;
    let filename = unique_filename(url, None);
    let local_path = media_dir.join(&filename);

    download_to_file(client, url, &local_path, None).await?;

    log::info!("Media downloaded: {} -> {:?}", url, local_path);
    Ok(local_path)
}

// ---------------------------------------------------------------------------
// Shared download helper
// ---------------------------------------------------------------------------

/// Download a URL to a local file, optionally with an Authorization header.
async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    local_path: &Path,
    auth_header: Option<&str>,
) -> Result<(), String> {
    let mut req = client.get(url);
    if let Some(auth) = auth_header {
        req = req.header("Authorization", auth);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Download request failed for {}: {}", url, e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Download failed for {} — HTTP {}",
            url,
            resp.status()
        ));
    }

    // Check content-type and potentially rename with correct extension
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read download body for {}: {}", url, e))?;

    if bytes.is_empty() {
        return Err(format!("Downloaded empty file from {}", url));
    }

    // If the local_path has no extension but we can detect one, rename
    let final_path = if local_path.extension().is_none() {
        if let Some(ext) = extension_from_content_type(&content_type) {
            local_path.with_extension(ext)
        } else {
            local_path.to_path_buf()
        }
    } else {
        local_path.to_path_buf()
    };

    std::fs::write(&final_path, &bytes)
        .map_err(|e| format!("Failed to write file {:?}: {}", final_path, e))?;

    log::debug!(
        "Saved {} bytes to {:?} (content-type: {})",
        bytes.len(),
        final_path,
        content_type
    );

    Ok(())
}

/// Check whether a URL is a platform-specific scheme that needs downloading
/// (as opposed to an already-accessible HTTP URL).
pub fn is_platform_media_url(url: &str) -> bool {
    url.starts_with("telegram://")
        || url.starts_with("feishu://")
        || url.starts_with("dingtalk://")
}

/// Process all media content parts in a message, downloading platform-specific
/// media and returning enrichment text to append to the message content.
///
/// For each non-text content part with a platform-specific URL:
/// - Attempts to download the media file
/// - On success: adds a note like "[Image saved to: /path/to/file.jpg]"
/// - On failure: adds a note like "[Image download failed: reason]"
///
/// For direct HTTP URLs (Discord), also downloads for local access.
///
/// Returns a string to append to the message content, and a list of
/// successfully downloaded local file paths.
pub async fn enrich_media_content(
    content_parts: &[super::ContentPart],
    platform: &str,
    config: &serde_json::Value,
    workspace_dir: &Path,
) -> (String, Vec<PathBuf>) {
    let mut notes = Vec::new();
    let mut downloaded_paths = Vec::new();

    for part in content_parts {
        match part {
            super::ContentPart::Image { url, alt } => {
                if is_platform_media_url(url) || url.starts_with("http") {
                    match download_bot_media(platform, url, config, workspace_dir).await {
                        Ok(path) => {
                            let alt_text = alt
                                .as_deref()
                                .filter(|a| !a.is_empty())
                                .map(|a| format!(" ({})", a))
                                .unwrap_or_default();
                            notes.push(format!(
                                "[Image{} saved to: {}]",
                                alt_text,
                                path.display()
                            ));
                            downloaded_paths.push(path);
                        }
                        Err(e) => {
                            log::warn!("Failed to download image {}: {}", url, e);
                            notes.push(format!("[Image download failed: {}]", e));
                        }
                    }
                }
            }
            super::ContentPart::File {
                url,
                filename,
                mime_type: _,
            } => {
                if is_platform_media_url(url) || url.starts_with("http") {
                    match download_bot_media(platform, url, config, workspace_dir).await {
                        Ok(path) => {
                            notes.push(format!(
                                "[File \"{}\" saved to: {}]",
                                filename,
                                path.display()
                            ));
                            downloaded_paths.push(path);
                        }
                        Err(e) => {
                            log::warn!("Failed to download file {}: {}", url, e);
                            notes.push(format!(
                                "[File \"{}\" download failed: {}]",
                                filename, e
                            ));
                        }
                    }
                }
            }
            super::ContentPart::Audio { url } => {
                if is_platform_media_url(url) || url.starts_with("http") {
                    match download_bot_media(platform, url, config, workspace_dir).await {
                        Ok(path) => {
                            notes.push(format!("[Audio saved to: {}]", path.display()));
                            downloaded_paths.push(path);
                        }
                        Err(e) => {
                            log::warn!("Failed to download audio {}: {}", url, e);
                            notes.push(format!("[Audio download failed: {}]", e));
                        }
                    }
                }
            }
            super::ContentPart::Video { url } => {
                if is_platform_media_url(url) || url.starts_with("http") {
                    match download_bot_media(platform, url, config, workspace_dir).await {
                        Ok(path) => {
                            notes.push(format!("[Video saved to: {}]", path.display()));
                            downloaded_paths.push(path);
                        }
                        Err(e) => {
                            log::warn!("Failed to download video {}: {}", url, e);
                            notes.push(format!("[Video download failed: {}]", e));
                        }
                    }
                }
            }
            super::ContentPart::Text { .. } => {
                // Text parts don't need downloading
            }
        }
    }

    (notes.join("\n"), downloaded_paths)
}
