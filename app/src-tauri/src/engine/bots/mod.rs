pub mod manager;
pub mod discord;
pub mod dingtalk;
pub mod feishu;
pub mod formatter;
pub mod media;
pub mod qq;
pub mod rate_limit;
pub mod retry;
pub mod telegram;
pub mod wecom;
pub mod webhook_server;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

// ---------------------------------------------------------------------------
// Shared HTTP client — reuses connection pool & TLS across all bot modules
// ---------------------------------------------------------------------------

lazy_static::lazy_static! {
    static ref HTTP_CLIENT: reqwest::Client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .pool_max_idle_per_host(5)
        .build()
        .expect("Failed to build HTTP client");
}

/// Return a clone of the shared HTTP client (cheap `Arc` ref-count bump).
pub fn http_client() -> reqwest::Client {
    HTTP_CLIENT.clone()
}

// ---------------------------------------------------------------------------
// Bot connection status monitoring
// ---------------------------------------------------------------------------

/// Connection state of a bot instance
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BotConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

/// Runtime status snapshot for a single bot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotStatus {
    pub bot_id: String,
    pub state: BotConnectionState,
    pub message: Option<String>,
    pub connected_at: Option<u64>,
    pub last_error: Option<String>,
}

lazy_static::lazy_static! {
    /// Global registry of bot connection statuses.
    /// Updated by each bot implementation and read by the frontend command.
    static ref BOT_STATUS: RwLock<HashMap<String, BotStatus>> = RwLock::new(HashMap::new());
}

/// Update the connection status of a bot in the global registry.
pub fn update_bot_status(bot_id: &str, state: BotConnectionState, message: Option<String>) {
    let mut map = BOT_STATUS.write().unwrap();
    let entry = map.entry(bot_id.to_string()).or_insert_with(|| BotStatus {
        bot_id: bot_id.to_string(),
        state: BotConnectionState::Disconnected,
        message: None,
        connected_at: None,
        last_error: None,
    });

    // Track connected_at and last_error
    match &state {
        BotConnectionState::Connected => {
            entry.connected_at = Some(now_ts());
            entry.last_error = None;
        }
        BotConnectionState::Error => {
            entry.last_error = message.clone();
        }
        BotConnectionState::Disconnected => {
            entry.connected_at = None;
        }
        _ => {}
    }

    entry.state = state;
    entry.message = message;
}

/// Read all bot statuses from the global registry.
pub fn get_all_bot_statuses() -> Vec<BotStatus> {
    let map = BOT_STATUS.read().unwrap();
    map.values().cloned().collect()
}

/// Content types for multi-media messages
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
    Image { url: String, alt: Option<String> },
    File { url: String, filename: String, mime_type: Option<String> },
    Audio { url: String },
    Video { url: String },
}

/// Unified incoming message from any bot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingMessage {
    /// Which bot instance received this message
    pub bot_id: String,
    /// Platform type (discord, telegram, qq, etc.)
    pub platform: String,
    /// Conversation identifier within the platform (channel_id, chat_id, etc.)
    pub conversation_id: String,
    pub sender_id: String,
    pub sender_name: Option<String>,
    pub content: String,
    /// Multi-media content parts (optional, for rich messages)
    #[serde(default)]
    pub content_parts: Vec<ContentPart>,
    pub timestamp: u64,
    pub meta: serde_json::Value,
}

impl IncomingMessage {
    /// Generate the session ID for persisting this conversation
    pub fn session_id(&self) -> String {
        format!("bot:{}:{}", self.bot_id, self.conversation_id)
    }
}

/// A response that may contain text and/or media attachments for sending.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RichContent {
    pub text: String,
    pub media: Vec<MediaAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaAttachment {
    pub media_type: MediaType,
    /// Local file path (absolute) or URL
    pub path: String,
    /// Original filename for display
    pub filename: Option<String>,
    /// MIME type if known
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaType {
    Image,
    File,
    Audio,
    Video,
}

impl From<String> for RichContent {
    fn from(text: String) -> Self {
        RichContent { text, media: vec![] }
    }
}

impl From<&str> for RichContent {
    fn from(text: &str) -> Self {
        RichContent { text: text.to_string(), media: vec![] }
    }
}

impl RichContent {
    pub fn text_only(s: impl Into<String>) -> Self {
        RichContent { text: s.into(), media: vec![] }
    }
    pub fn is_text_only(&self) -> bool {
        self.media.is_empty()
    }
}

/// Known media file extensions grouped by type.
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
const AUDIO_EXTS: &[&str] = &["mp3", "wav", "ogg", "opus", "m4a", "aac"];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "avi", "mkv", "webm"];
const DOC_EXTS: &[&str] = &["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "tar", "gz", "txt", "csv", "json"];

/// Classify a file extension into a MediaType, or None if not a recognized media extension.
pub fn classify_extension(ext: &str) -> Option<MediaType> {
    let ext = ext.to_lowercase();
    let ext = ext.as_str();
    if IMAGE_EXTS.contains(&ext) { return Some(MediaType::Image); }
    if AUDIO_EXTS.contains(&ext) { return Some(MediaType::Audio); }
    if VIDEO_EXTS.contains(&ext) { return Some(MediaType::Video); }
    if DOC_EXTS.contains(&ext) { return Some(MediaType::File); }
    None
}

/// Guess MIME type from file extension.
pub fn guess_mime(ext: &str) -> Option<String> {
    Some(match ext.to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "opus" => "audio/opus",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "json" => "application/json",
        "txt" => "text/plain",
        "csv" => "text/csv",
        _ => return None,
    }.to_string())
}

/// Characters that delimit the end of a file path in text.
fn is_path_delimiter(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | ')' | '"' | '\'' | ']' | '>' | '`' | ';' | ',' | '|')
}

/// Characters that can precede a valid path start.
fn is_path_prefix(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '(' | '"' | '\'' | '[' | ':' | '`' | '=' | ',')
}

/// Scan agent reply text for local file paths and HTTP(S) media URLs.
/// Returns a RichContent with the original text plus any detected media attachments.
/// Local files: only includes files under the user's home directory or /tmp for security.
/// HTTP URLs: includes any URL ending with a recognized media extension.
pub async fn extract_media_from_text(text: &str) -> RichContent {
    let mut content = RichContent { text: text.to_string(), media: vec![] };

    // Build allowed path prefixes for security (local files only)
    let home = std::env::var("HOME").unwrap_or_default();
    let allowed_prefixes: Vec<&str> = if home.is_empty() {
        vec!["/tmp/"]
    } else {
        vec![home.as_str(), "/tmp/"]
    };

    // --- 1. Extract Markdown image syntax: ![alt](url) ---
    static MD_IMG_RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"!\[[^\]]*\]\(([^)]+)\)").unwrap());
    for cap in MD_IMG_RE.captures_iter(text) {
        let url = cap[1].trim();
        if url.starts_with("http") {
            try_push_url_media(&mut content, url);
        }
    }

    // --- 2. Extract HTTP(S) URLs and local file paths from plain text ---
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut idx = 0;

    while idx < chars.len() {
        let (byte_pos, ch) = chars[idx];

        // Detect http:// or https:// URLs
        if ch == 'h' && text[byte_pos..].starts_with("http") {
            let start_byte = byte_pos;
            let mut end_idx = idx;
            while end_idx < chars.len() && !is_url_delimiter(chars[end_idx].1) {
                end_idx += 1;
            }
            let end_byte = if end_idx < chars.len() { chars[end_idx].0 } else { text.len() };
            let url_str = &text[start_byte..end_byte];
            idx = end_idx;

            if url_str.starts_with("http://") || url_str.starts_with("https://") {
                try_push_url_media(&mut content, url_str);
            }
            continue;
        }

        // Detect local file paths: '/' preceded by a delimiter or start of string
        if ch == '/' && (idx == 0 || is_path_prefix(chars[idx - 1].1)) {
            let start_byte = byte_pos;
            let mut end_idx = idx;
            while end_idx < chars.len() && !is_path_delimiter(chars[end_idx].1) {
                end_idx += 1;
            }
            let end_byte = if end_idx < chars.len() { chars[end_idx].0 } else { text.len() };
            let path_str = &text[start_byte..end_byte];
            idx = end_idx;

            if let Some(dot_pos) = path_str.rfind('.') {
                let ext = &path_str[dot_pos + 1..];
                if let Some(media_type) = classify_extension(ext) {
                    let allowed = allowed_prefixes.iter().any(|p| path_str.starts_with(p));
                    if allowed {
                        let path = std::path::Path::new(path_str);
                        if tokio::fs::try_exists(path).await.unwrap_or(false) && !content.media.iter().any(|m| m.path == path_str) {
                            content.media.push(MediaAttachment {
                                media_type,
                                path: path_str.to_string(),
                                filename: path.file_name().map(|f| f.to_string_lossy().to_string()),
                                mime_type: guess_mime(ext),
                            });
                        }
                    }
                }
            }
        } else {
            idx += 1;
        }
    }

    content
}

/// Characters that delimit the end of a URL in text.
fn is_url_delimiter(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | ')' | '"' | '\'' | ']' | '>' | '`' | ';' | '|' | '，' | '。' | '）' | '】')
}

/// Strip query string and fragment from a URL, returning just the path portion.
fn strip_url_params(url: &str) -> &str {
    let s = url.split('?').next().unwrap_or(url);
    s.split('#').next().unwrap_or(s)
}

/// Extract the media file extension from a URL, ignoring query params and fragments.
fn url_media_extension(url: &str) -> Option<&str> {
    let last_seg = strip_url_params(url).rsplit('/').next()?;
    let dot_pos = last_seg.rfind('.')?;
    let ext = &last_seg[dot_pos + 1..];
    (!ext.is_empty() && ext.len() <= 5).then_some(ext)
}

/// Extract filename from a URL path.
fn url_filename(url: &str) -> Option<String> {
    strip_url_params(url).rsplit('/').next()
        .filter(|s| !s.is_empty() && s.contains('.'))
        .map(|s| s.to_string())
}

/// Try to extract media info from a URL and push to content.media if valid.
fn try_push_url_media(content: &mut RichContent, url: &str) {
    if let Some(ext) = url_media_extension(url) {
        if let Some(media_type) = classify_extension(ext) {
            if !content.media.iter().any(|m| m.path == url) {
                content.media.push(MediaAttachment {
                    media_type,
                    path: url.to_string(),
                    filename: url_filename(url),
                    mime_type: guess_mime(ext),
                });
            }
        }
    }
}

/// Supported platform types
pub fn platform_types() -> Vec<(&'static str, &'static str)> {
    vec![
        ("discord", "Discord"),
        ("telegram", "Telegram"),
        ("qq", "QQ"),
        ("dingtalk", "DingTalk"),
        ("feishu", "Feishu"),
        ("wecom", "WeCom"),
        ("webhook", "Webhook"),
    ]
}

fn now_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
