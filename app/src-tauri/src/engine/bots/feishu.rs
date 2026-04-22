use super::{now_ts, update_bot_status, BotConnectionState, ContentPart, IncomingMessage};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::tungstenite::Message;

/// Global token cache keyed by app_id, shared across all static method calls
/// so that send_message / reply_message reuse tokens instead of requesting new ones each time.
static GLOBAL_TOKEN_CACHE: std::sync::LazyLock<RwLock<HashMap<String, Arc<RwLock<Option<CachedToken>>>>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// Get or create a cached token entry for the given app_id from the global cache.
async fn global_cached_token(app_id: &str) -> Arc<RwLock<Option<CachedToken>>> {
    {
        let cache = GLOBAL_TOKEN_CACHE.read().await;
        if let Some(entry) = cache.get(app_id) {
            return entry.clone();
        }
    }
    let mut cache = GLOBAL_TOKEN_CACHE.write().await;
    cache.entry(app_id.to_string())
        .or_insert_with(|| Arc::new(RwLock::new(None)))
        .clone()
}

/// Feishu Bot — WebSocket 长连接模式
/// 文档: https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks
///
/// 协议流程:
/// 1. POST /auth/v3/app_access_token/internal → 获取 app_access_token
/// 2. POST /callback/ws/endpoint → 获取 WebSocket URL
/// 3. 连接 WS → 接收事件 (im.message.receive_v1)
/// 4. 通过 REST API POST /im/v1/messages 回复
pub struct FeishuBot {
    bot_id: String,
    app_id: String,
    app_secret: String,
    running: Arc<RwLock<bool>>,
    /// 缓存的 tenant_access_token
    cached_token: Arc<RwLock<Option<CachedToken>>>,
}

struct CachedToken {
    token: String,
    expires_at: std::time::Instant,
}

const AUTH_URL: &str = "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal";
const WS_ENDPOINT_URL: &str = "https://open.feishu.cn/callback/ws/endpoint";
const SEND_MSG_URL: &str = "https://open.feishu.cn/open-apis/im/v1/messages";

#[allow(dead_code)]
impl FeishuBot {
    pub fn new(bot_id: String, app_id: String, app_secret: String) -> Self {
        Self {
            bot_id,
            app_id,
            app_secret,
            running: Arc::new(RwLock::new(false)),
            cached_token: Arc::new(RwLock::new(None)),
        }
    }

    /// Get the shared running flag for external stop control.
    pub fn running_flag(&self) -> Arc<RwLock<bool>> {
        self.running.clone()
    }

    /// 获取 tenant_access_token（带缓存）
    async fn get_token(
        client: &reqwest::Client,
        app_id: &str,
        app_secret: &str,
        cached: &Arc<RwLock<Option<CachedToken>>>,
    ) -> Result<String, String> {
        // 检查缓存
        {
            let cache = cached.read().await;
            if let Some(ref ct) = *cache {
                if std::time::Instant::now() < ct.expires_at {
                    return Ok(ct.token.clone());
                }
            }
        }

        // 请求新 token
        let body = serde_json::json!({
            "app_id": app_id,
            "app_secret": app_secret,
        });

        let resp = client
            .post(AUTH_URL)
            .json(&body)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| format!("Feishu auth request failed: {}", e))?;

        let json = resp
            .json::<serde_json::Value>()
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

        // 飞书返回的是 app_access_token（同时也可用作 tenant_access_token 对于自建应用）
        let token = json["app_access_token"]
            .as_str()
            .or_else(|| json["tenant_access_token"].as_str())
            .ok_or_else(|| format!("Feishu auth: no token in response: {}", json))?
            .to_string();

        let expire = json["expire"].as_u64().unwrap_or(7200);

        // 缓存，提前 5 分钟过期
        let mut cache = cached.write().await;
        *cache = Some(CachedToken {
            token: token.clone(),
            expires_at: std::time::Instant::now()
                + std::time::Duration::from_secs(expire.saturating_sub(300)),
        });

        log::info!("Feishu token obtained, expires_in={}s", expire);
        Ok(token)
    }

    pub async fn start(&self, tx: mpsc::Sender<IncomingMessage>) {
        let bot_id = self.bot_id.clone();
        let app_id = self.app_id.clone();
        let app_secret = self.app_secret.clone();
        let running = self.running.clone();
        let cached_token = self.cached_token.clone();

        {
            let mut r = running.write().await;
            *r = true;
        }

        tokio::spawn(async move {
            let client = super::http_client();

            loop {
                {
                    let r = running.read().await;
                    if !*r {
                        break;
                    }
                }

                update_bot_status(&bot_id, BotConnectionState::Connecting, Some("Getting token".into()));

                // Step 1: 获取 token
                let token = match Self::get_token(&client, &app_id, &app_secret, &cached_token).await {
                    Ok(t) => t,
                    Err(e) => {
                        log::error!("Feishu get token failed: {}", e);
                        update_bot_status(&bot_id, BotConnectionState::Error, Some(format!("Token failed: {}", e)));
                        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                        continue;
                    }
                };

                // Step 2: 获取 WebSocket 端点
                let ws_url = match register_ws_endpoint(&client, &token, &app_id).await {
                    Ok(url) => url,
                    Err(e) => {
                        log::error!("Feishu WS endpoint registration failed: {}", e);
                        update_bot_status(&bot_id, BotConnectionState::Error, Some(format!("WS endpoint failed: {}", e)));
                        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                        continue;
                    }
                };

                log::info!("Feishu WebSocket connecting to: {}...", &ws_url[..ws_url.len().min(60)]);

                // Step 3: 连接 WebSocket
                match tokio_tungstenite::connect_async(&ws_url).await {
                    Ok((mut ws_stream, _)) => {
                        log::info!("Feishu WebSocket connected");
                        update_bot_status(&bot_id, BotConnectionState::Connected, Some("WebSocket connected".into()));

                        loop {
                            let r = running.read().await;
                            if !*r {
                                break;
                            }
                            drop(r);

                            tokio::select! {
                                msg = ws_stream.next() => {
                                    match msg {
                                        Some(Ok(Message::Text(text))) => {
                                            if let Ok(frame) = serde_json::from_str::<serde_json::Value>(&text) {
                                                handle_feishu_frame(
                                                    &frame, &bot_id, &tx, &mut ws_stream,
                                                ).await;
                                            }
                                        }
                                        Some(Ok(Message::Close(_))) | None => {
                                            log::warn!("Feishu WebSocket closed");
                                            break;
                                        }
                                        Some(Ok(Message::Ping(data))) => {
                                            ws_stream.send(Message::Pong(data)).await.ok();
                                        }
                                        _ => {}
                                    }
                                }
                                // WebSocket 保活 ping
                                _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                                    ws_stream.send(Message::Ping(vec![].into())).await.ok();
                                }
                            }
                        }
                    }
                    Err(e) => {
                        log::error!("Feishu WebSocket connect failed: {}", e);
                        update_bot_status(&bot_id, BotConnectionState::Error, Some(format!("Connect failed: {}", e)));
                    }
                }

                // 重连
                let r = running.read().await;
                if !*r {
                    break;
                }
                drop(r);
                // token 可能过期导致 WS 断连，清除缓存
                {
                    let mut cache = cached_token.write().await;
                    *cache = None;
                }
                log::info!("Feishu WebSocket reconnecting in 5s...");
                update_bot_status(&bot_id, BotConnectionState::Reconnecting, Some("Reconnecting in 5s".into()));
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }

            update_bot_status(&bot_id, BotConnectionState::Disconnected, Some("Stopped".into()));
            log::info!("Feishu WebSocket stopped");
        });
    }

    pub async fn stop(&self) {
        let mut r = self.running.write().await;
        *r = false;
    }

    /// 通过 REST API 发送消息
    /// Detects markdown content and uses the appropriate msg_type.
    /// For messages with rich formatting, uses "post" type; otherwise "text".
    pub async fn send_message(
        app_id: &str,
        app_secret: &str,
        receive_id: &str,
        receive_id_type: &str,
        content: &str,
    ) -> Result<(), String> {
        let client = super::http_client();
        let cached = global_cached_token(app_id).await;
        let token = Self::get_token(&client, app_id, app_secret, &cached).await?;

        let url = format!("{}?receive_id_type={}", SEND_MSG_URL, receive_id_type);

        // Use post type for content with markdown formatting, text otherwise
        let (msg_type, content_json) = if super::formatter::has_markdown_formatting(content) {
            super::formatter::format_feishu_post(content)
        } else {
            super::formatter::format_feishu(content)
        };

        let body = serde_json::json!({
            "receive_id": receive_id,
            "msg_type": msg_type,
            "content": content_json,
        });

        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json; charset=utf-8")
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("Feishu send message failed: {}", e))?;

        let json = resp
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("Feishu send response parse failed: {}", e))?;

        let code = json["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            // If post type failed, fall back to plain text
            if msg_type == "post" {
                log::warn!("Feishu post send failed (code={}), falling back to text", code);
                let fallback_body = serde_json::json!({
                    "receive_id": receive_id,
                    "msg_type": "text",
                    "content": serde_json::json!({"text": content}).to_string(),
                });
                let resp2 = client
                    .post(&url)
                    .header("Authorization", format!("Bearer {}", token))
                    .header("Content-Type", "application/json; charset=utf-8")
                    .json(&fallback_body)
                    .timeout(std::time::Duration::from_secs(15))
                    .send()
                    .await
                    .map_err(|e| format!("Feishu send (fallback) failed: {}", e))?;
                let json2 = resp2
                    .json::<serde_json::Value>()
                    .await
                    .map_err(|e| format!("Feishu fallback response parse failed: {}", e))?;
                let code2 = json2["code"].as_i64().unwrap_or(-1);
                if code2 != 0 {
                    return Err(format!(
                        "Feishu send failed: code={}, msg={}",
                        code2,
                        json2["msg"].as_str().unwrap_or("unknown")
                    ));
                }
                return Ok(());
            }
            return Err(format!(
                "Feishu send failed: code={}, msg={}",
                code,
                json["msg"].as_str().unwrap_or("unknown")
            ));
        }

        Ok(())
    }

    /// 通过 REST API 回复消息（引用回复）
    /// Uses post type for markdown content, with fallback to text.
    pub async fn reply_message(
        app_id: &str,
        app_secret: &str,
        message_id: &str,
        content: &str,
    ) -> Result<(), String> {
        let client = super::http_client();
        let cached = global_cached_token(app_id).await;
        let token = Self::get_token(&client, app_id, app_secret, &cached).await?;

        let url = format!(
            "https://open.feishu.cn/open-apis/im/v1/messages/{}/reply",
            message_id
        );

        // Use post type for content with markdown formatting
        let (msg_type, content_json) = if super::formatter::has_markdown_formatting(content) {
            super::formatter::format_feishu_post(content)
        } else {
            super::formatter::format_feishu(content)
        };

        let body = serde_json::json!({
            "msg_type": msg_type,
            "content": content_json,
        });

        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json; charset=utf-8")
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("Feishu reply failed: {}", e))?;

        let json = resp
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("Feishu reply response parse failed: {}", e))?;

        let code = json["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            // Fall back to plain text if post type failed
            if msg_type == "post" {
                log::warn!("Feishu post reply failed (code={}), falling back to text", code);
                let fallback_body = serde_json::json!({
                    "msg_type": "text",
                    "content": serde_json::json!({"text": content}).to_string(),
                });
                let resp2 = client
                    .post(&url)
                    .header("Authorization", format!("Bearer {}", token))
                    .header("Content-Type", "application/json; charset=utf-8")
                    .json(&fallback_body)
                    .timeout(std::time::Duration::from_secs(15))
                    .send()
                    .await
                    .map_err(|e| format!("Feishu reply (fallback) failed: {}", e))?;
                let json2 = resp2
                    .json::<serde_json::Value>()
                    .await
                    .map_err(|e| format!("Feishu fallback reply parse failed: {}", e))?;
                let code2 = json2["code"].as_i64().unwrap_or(-1);
                if code2 != 0 {
                    return Err(format!(
                        "Feishu reply failed: code={}, msg={}",
                        code2,
                        json2["msg"].as_str().unwrap_or("unknown")
                    ));
                }
                return Ok(());
            }
            return Err(format!(
                "Feishu reply failed: code={}, msg={}",
                code,
                json["msg"].as_str().unwrap_or("unknown")
            ));
        }

        Ok(())
    }
}

/// Test Feishu credentials by requesting an app_access_token.
pub async fn test_connection(app_id: &str, app_secret: &str) -> Result<String, String> {
    let client = super::http_client();

    let body = serde_json::json!({
        "app_id": app_id,
        "app_secret": app_secret,
    });

    let resp = client
        .post(AUTH_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Feishu request failed: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Feishu response parse failed: {}", e))?;

    if json["code"].as_i64() == Some(0) {
        Ok("Feishu credentials verified successfully".to_string())
    } else {
        let msg = json["msg"].as_str().unwrap_or("Unknown error");
        Err(format!("Feishu auth failed: {}", msg))
    }
}

/// 注册 WebSocket 端点，获取连接 URL
async fn register_ws_endpoint(
    client: &reqwest::Client,
    token: &str,
    app_id: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "app_id": app_id,
    });

    let resp = client
        .post(WS_ENDPOINT_URL)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Feishu WS endpoint request failed: {}", e))?;

    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Feishu WS endpoint response parse failed: {}", e))?;

    let code = json["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        return Err(format!(
            "Feishu WS endpoint failed: code={}, msg={}",
            code,
            json["msg"].as_str().unwrap_or("unknown")
        ));
    }

    // 从 data 中提取 WebSocket URL
    let url = json["data"]["URL"]
        .as_str()
        .or_else(|| json["data"]["url"].as_str())
        .ok_or_else(|| format!("Feishu WS endpoint: no URL in response: {}", json))?
        .to_string();

    Ok(url)
}

/// 处理飞书 WebSocket 帧
async fn handle_feishu_frame<S>(
    frame: &serde_json::Value,
    bot_id: &str,
    tx: &mpsc::Sender<IncomingMessage>,
    ws_stream: &mut S,
) where
    S: futures_util::Sink<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::fmt::Debug,
{
    let frame_type = frame["type"].as_str()
        .or_else(|| frame["header"]["type"].as_str())
        .unwrap_or("");

    match frame_type {
        // 飞书 SDK WebSocket 协议的 pong/控制帧
        "pong" => {}

        // 事件推送
        "event" => {
            let header = &frame["header"];
            let event_type = header["event_type"]
                .as_str()
                .unwrap_or("");
            let event_id = header["event_id"]
                .as_str()
                .unwrap_or("")
                .to_string();

            // 发送 ACK（如果协议要求）
            if !event_id.is_empty() {
                let ack = serde_json::json!({
                    "type": "ack",
                    "event_id": event_id,
                });
                ws_stream.send(Message::Text(
                    serde_json::to_string(&ack).unwrap().into()
                )).await.ok();
            }

            match event_type {
                "im.message.receive_v1" => {
                    handle_message_event(&frame["event"], bot_id, tx).await;
                }
                _ => {
                    log::debug!("Feishu unhandled event: {}", event_type);
                }
            }
        }

        // URL 验证（WebSocket 模式下可能不需要，但保险起见处理）
        "url_verification" => {
            if let Some(challenge) = frame["challenge"].as_str() {
                let resp = serde_json::json!({
                    "challenge": challenge,
                });
                ws_stream.send(Message::Text(
                    serde_json::to_string(&resp).unwrap().into()
                )).await.ok();
            }
        }

        _ => {
            // 可能是裸事件（直接包含 header.event_type）
            if let Some(event_type) = frame.get("header")
                .and_then(|h| h["event_type"].as_str())
            {
                let event_id = frame["header"]["event_id"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();

                if !event_id.is_empty() {
                    let ack = serde_json::json!({
                        "type": "ack",
                        "event_id": event_id,
                    });
                    ws_stream.send(Message::Text(
                        serde_json::to_string(&ack).unwrap().into()
                    )).await.ok();
                }

                if event_type == "im.message.receive_v1" {
                    handle_message_event(&frame["event"], bot_id, tx).await;
                }
            } else {
                log::debug!("Feishu unknown frame type: {}", frame_type);
            }
        }
    }
}

/// 处理 im.message.receive_v1 事件
async fn handle_message_event(
    event: &serde_json::Value,
    bot_id: &str,
    tx: &mpsc::Sender<IncomingMessage>,
) {
    let message = &event["message"];
    let sender = &event["sender"];

    let chat_id = message["chat_id"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let message_id = message["message_id"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let msg_type = message["msg_type"]
        .as_str()
        .unwrap_or("text");
    let chat_type = message["chat_type"]
        .as_str()
        .unwrap_or("p2p"); // p2p 或 group

    let sender_id = sender["sender_id"]["open_id"]
        .as_str()
        .or_else(|| sender["sender_id"]["user_id"].as_str())
        .unwrap_or("unknown")
        .to_string();
    let sender_type = sender["sender_type"]
        .as_str()
        .unwrap_or("user");

    // 跳过机器人自己的消息
    if sender_type == "app" {
        return;
    }

    // 解析消息内容（content 是 JSON 字符串）
    let content_str = message["content"]
        .as_str()
        .unwrap_or("{}");
    let content_json: serde_json::Value =
        serde_json::from_str(content_str).unwrap_or(serde_json::json!({}));

    let (content, content_parts) = match msg_type {
        "text" => {
            let text = content_json["text"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_string();
            // 去除 @机器人 的 mention 标记
            let clean_text = strip_feishu_mentions(&text);
            if clean_text.is_empty() {
                return;
            }
            (clean_text.clone(), vec![ContentPart::Text { text: clean_text }])
        }
        "image" => {
            let image_key = content_json["image_key"]
                .as_str()
                .unwrap_or("")
                .to_string();
            if image_key.is_empty() {
                return;
            }
            (
                "[图片]".to_string(),
                vec![ContentPart::Image {
                    url: format!("feishu://image/{}", image_key),
                    alt: None,
                }],
            )
        }
        "file" => {
            let file_key = content_json["file_key"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let filename = content_json["file_name"]
                .as_str()
                .unwrap_or("file")
                .to_string();
            if file_key.is_empty() {
                return;
            }
            (
                format!("[文件: {}]", filename),
                vec![ContentPart::File {
                    url: format!("feishu://file/{}", file_key),
                    filename,
                    mime_type: None,
                }],
            )
        }
        "audio" => {
            let file_key = content_json["file_key"]
                .as_str()
                .unwrap_or("")
                .to_string();
            if file_key.is_empty() {
                return;
            }
            (
                "[语音]".to_string(),
                vec![ContentPart::Audio {
                    url: format!("feishu://audio/{}", file_key),
                }],
            )
        }
        "post" => {
            // 富文本消息，提取纯文本
            let text = extract_post_text(&content_json);
            if text.is_empty() {
                return;
            }
            (text.clone(), vec![ContentPart::Text { text }])
        }
        _ => {
            log::debug!("Feishu: unsupported msg type '{}', skipping", msg_type);
            return;
        }
    };

    let conv_id = match chat_type {
        "group" => format!("group:{}", chat_id),
        _ => format!("dm:{}", sender_id),
    };

    let incoming = IncomingMessage {
        bot_id: bot_id.to_string(),
        platform: "feishu".into(),
        conversation_id: conv_id,
        sender_id,
        sender_name: None,
        content,
        timestamp: now_ts(),
        meta: serde_json::json!({
            "chat_id": chat_id,
            "message_id": message_id,
            "chat_type": chat_type,
            "msg_type": msg_type,
        }),
        content_parts,
    };

    tx.send(incoming).await.ok();
}

/// 去除飞书 @mention 标记
/// 飞书文本中 @机器人 显示为 `@_user_1` 或类似格式
fn strip_feishu_mentions(text: &str) -> String {
    let mut result = text.to_string();
    // 飞书 @mention 格式: @_user_N 或 @_all
    while let Some(start) = result.find("@_user_") {
        if let Some(end) = result[start..].find(' ') {
            result.replace_range(start..start + end, "");
        } else {
            result.truncate(start);
        }
    }
    result = result.replace("@_all", "");
    result.trim().to_string()
}

/// 从飞书 post (富文本) 消息中提取纯文本
fn extract_post_text(content: &serde_json::Value) -> String {
    let mut texts = Vec::new();

    // post 格式: {"zh_cn": {"title": "xxx", "content": [[{"tag":"text","text":"xxx"}, ...]]}}
    // 或直接: {"content": [[...]]}
    let post = content.get("zh_cn")
        .or_else(|| content.get("en_us"))
        .or_else(|| content.get("ja_jp"))
        .unwrap_or(content);

    if let Some(title) = post["title"].as_str() {
        if !title.is_empty() {
            texts.push(title.to_string());
        }
    }

    if let Some(paragraphs) = post["content"].as_array() {
        for paragraph in paragraphs {
            if let Some(elements) = paragraph.as_array() {
                for elem in elements {
                    let tag = elem["tag"].as_str().unwrap_or("");
                    match tag {
                        "text" => {
                            if let Some(t) = elem["text"].as_str() {
                                texts.push(t.to_string());
                            }
                        }
                        "a" => {
                            if let Some(t) = elem["text"].as_str() {
                                let href = elem["href"].as_str().unwrap_or("");
                                if href.is_empty() {
                                    texts.push(t.to_string());
                                } else {
                                    texts.push(format!("[{}]({})", t, href));
                                }
                            }
                        }
                        "at" => {
                            // 跳过 @mention
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    texts.join(" ").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_feishu_mentions_removes_at_user() {
        assert_eq!(strip_feishu_mentions("@_user_1 hello"), "hello");
        assert_eq!(strip_feishu_mentions("hi @_user_42 there"), "hi  there".trim());
    }

    #[test]
    fn strip_feishu_mentions_removes_at_all() {
        assert_eq!(strip_feishu_mentions("@_all attention!"), "attention!");
    }

    #[test]
    fn strip_feishu_mentions_preserves_plain_text() {
        assert_eq!(strip_feishu_mentions("plain message"), "plain message");
    }

    #[test]
    fn extract_post_text_handles_zh_cn_structure() {
        let content = serde_json::json!({
            "zh_cn": {
                "title": "Hello",
                "content": [[
                    { "tag": "text", "text": "world" },
                    { "tag": "a", "text": "docs", "href": "https://x" },
                    { "tag": "at", "user_id": "u1" },
                ]],
            }
        });
        let extracted = extract_post_text(&content);
        assert!(extracted.contains("Hello"));
        assert!(extracted.contains("world"));
        assert!(extracted.contains("[docs](https://x)"));
    }

    #[test]
    fn extract_post_text_falls_back_to_en_us() {
        let content = serde_json::json!({
            "en_us": {
                "title": "Greetings",
                "content": [[{ "tag": "text", "text": "hi" }]],
            }
        });
        let extracted = extract_post_text(&content);
        assert!(extracted.contains("Greetings"));
        assert!(extracted.contains("hi"));
    }

    #[test]
    fn extract_post_text_handles_root_content_without_locale() {
        let content = serde_json::json!({
            "content": [[{ "tag": "text", "text": "raw" }]],
        });
        let extracted = extract_post_text(&content);
        assert!(extracted.contains("raw"));
    }

    #[test]
    fn extract_post_text_empty_on_missing_content() {
        let content = serde_json::json!({});
        assert_eq!(extract_post_text(&content), "");
    }
}
