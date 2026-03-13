use super::{now_ts, update_bot_status, BotConnectionState, ContentPart, IncomingMessage};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::tungstenite::Message;

/// DingTalk Bot — Stream 模式 (WebSocket 长连接)
/// 文档: https://open.dingtalk.com/document/orgapp/robot-receive-message
///
/// 协议流程:
/// 1. POST /v1.0/gateway/connections/open → 获取 WebSocket endpoint + ticket
/// 2. 连接 WS → 接收 SYSTEM(ping) 和 CALLBACK(robot message)
/// 3. 每条消息都要 ACK 回复
/// 4. 通过 sessionWebhook 回复用户消息
pub struct DingTalkBot {
    bot_id: String,
    client_id: String,
    client_secret: String,
    running: Arc<RwLock<bool>>,
    /// 存储 conversation_id → 最新 sessionWebhook 的映射
    session_webhooks: Arc<RwLock<HashMap<String, SessionWebhookEntry>>>,
}

#[derive(Clone)]
pub struct SessionWebhookEntry {
    pub url: String,
    pub expires_at: u64, // unix timestamp in ms
}

const GATEWAY_URL: &str = "https://api.dingtalk.com/v1.0/gateway/connections/open";

#[allow(dead_code)]
impl DingTalkBot {
    pub fn new(bot_id: String, client_id: String, client_secret: String) -> Self {
        Self {
            bot_id,
            client_id,
            client_secret,
            running: Arc::new(RwLock::new(false)),
            session_webhooks: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 获取 session_webhooks 的引用，供 response_handler 使用
    pub fn session_webhooks(&self) -> Arc<RwLock<HashMap<String, SessionWebhookEntry>>> {
        self.session_webhooks.clone()
    }

    /// Get the shared running flag for external stop control.
    pub fn running_flag(&self) -> Arc<RwLock<bool>> {
        self.running.clone()
    }

    pub async fn start(&self, tx: mpsc::Sender<IncomingMessage>) {
        let bot_id = self.bot_id.clone();
        let client_id = self.client_id.clone();
        let client_secret = self.client_secret.clone();
        let running = self.running.clone();
        let session_webhooks = self.session_webhooks.clone();

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

                update_bot_status(&bot_id, BotConnectionState::Connecting, Some("Registering connection".into()));

                // Step 1: 获取 WebSocket 连接端点
                let (endpoint, ticket) = match register_connection(&client, &client_id, &client_secret).await {
                    Ok(r) => r,
                    Err(e) => {
                        log::error!("DingTalk register connection failed: {}", e);
                        update_bot_status(&bot_id, BotConnectionState::Error, Some(format!("Register failed: {}", e)));
                        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                        continue;
                    }
                };

                let ws_url = format!("{}?ticket={}", endpoint, ticket);
                log::info!("DingTalk Stream connecting to: {}...", &endpoint[..endpoint.len().min(50)]);

                // Step 2: 连接 WebSocket
                match tokio_tungstenite::connect_async(&ws_url).await {
                    Ok((mut ws_stream, _)) => {
                        log::info!("DingTalk Stream connected");
                        update_bot_status(&bot_id, BotConnectionState::Connected, Some("Stream connected".into()));

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
                                                let frame_type = frame["type"].as_str().unwrap_or("");
                                                let headers = &frame["headers"];
                                                let topic = headers["topic"].as_str().unwrap_or("");
                                                let message_id = headers["messageId"].as_str().unwrap_or("").to_string();

                                                match (frame_type, topic) {
                                                    ("SYSTEM", "ping") => {
                                                        // 回复 ping ACK
                                                        let ack = serde_json::json!({
                                                            "code": 200,
                                                            "headers": {
                                                                "contentType": "application/json",
                                                                "messageId": message_id,
                                                            },
                                                            "message": "OK",
                                                            "data": "{}",
                                                        });
                                                        ws_stream.send(Message::Text(
                                                            serde_json::to_string(&ack).unwrap().into()
                                                        )).await.ok();
                                                    }
                                                    ("CALLBACK", "/v1.0/im/bot/messages/get") => {
                                                        // 解析机器人消息
                                                        let data_str = frame["data"].as_str().unwrap_or("{}");
                                                        if let Ok(data) = serde_json::from_str::<serde_json::Value>(data_str) {
                                                            // 发送 ACK
                                                            let ack = serde_json::json!({
                                                                "code": 200,
                                                                "headers": {
                                                                    "contentType": "application/json",
                                                                    "messageId": message_id,
                                                                },
                                                                "message": "OK",
                                                                "data": "{}",
                                                            });
                                                            ws_stream.send(Message::Text(
                                                                serde_json::to_string(&ack).unwrap().into()
                                                            )).await.ok();

                                                            // 处理消息
                                                            handle_robot_message(
                                                                &data, &bot_id, &tx, &session_webhooks,
                                                            ).await;
                                                        }
                                                    }
                                                    ("CALLBACK", _) => {
                                                        // 其他回调事件，先 ACK
                                                        let ack = serde_json::json!({
                                                            "code": 200,
                                                            "headers": {
                                                                "contentType": "application/json",
                                                                "messageId": message_id,
                                                            },
                                                            "message": "OK",
                                                            "data": "{}",
                                                        });
                                                        ws_stream.send(Message::Text(
                                                            serde_json::to_string(&ack).unwrap().into()
                                                        )).await.ok();
                                                        log::debug!("DingTalk unhandled callback topic: {}", topic);
                                                    }
                                                    ("SYSTEM", "disconnect") => {
                                                        log::warn!("DingTalk Stream server requested disconnect");
                                                        break;
                                                    }
                                                    _ => {
                                                        log::debug!("DingTalk unknown frame: type={}, topic={}", frame_type, topic);
                                                    }
                                                }
                                            }
                                        }
                                        Some(Ok(Message::Close(_))) | None => {
                                            log::warn!("DingTalk Stream connection closed");
                                            break;
                                        }
                                        Some(Ok(Message::Ping(data))) => {
                                            ws_stream.send(Message::Pong(data)).await.ok();
                                        }
                                        _ => {}
                                    }
                                }
                                // 发送应用层心跳 (每 30s)
                                _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                                    // DingTalk Stream 的心跳由服务端 ping 驱动，客户端只需响应
                                    // 但我们也可以发 WebSocket ping 保活
                                    ws_stream.send(Message::Ping(vec![].into())).await.ok();
                                }
                            }
                        }
                    }
                    Err(e) => {
                        log::error!("DingTalk Stream connect failed: {}", e);
                        update_bot_status(&bot_id, BotConnectionState::Error, Some(format!("Connect failed: {}", e)));
                    }
                }

                // 重连
                let r = running.read().await;
                if !*r {
                    break;
                }
                drop(r);
                log::info!("DingTalk Stream reconnecting in 5s...");
                update_bot_status(&bot_id, BotConnectionState::Reconnecting, Some("Reconnecting in 5s".into()));
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }

            update_bot_status(&bot_id, BotConnectionState::Disconnected, Some("Stopped".into()));
            log::info!("DingTalk Stream stopped");
        });
    }

    pub async fn stop(&self) {
        let mut r = self.running.write().await;
        *r = false;
    }

    /// 通过 sessionWebhook 发送消息
    /// Agent output is typically Markdown, so always use markdown msgtype for
    /// sessionWebhook replies.  DingTalk supports bold, links, lists, headings.
    pub async fn send_via_webhook(webhook_url: &str, content: &str) -> Result<(), String> {
        let client = super::http_client();

        let (title, text) = super::formatter::format_dingtalk(content);
        let body = serde_json::json!({
            "msgtype": "markdown",
            "markdown": {
                "title": title,
                "text": text,
            }
        });

        let resp = client
            .post(webhook_url)
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("DingTalk webhook send failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("DingTalk webhook returned {}: {}", status, text));
        }

        Ok(())
    }
}

/// Test DingTalk credentials by calling the gateway connections/open endpoint.
pub async fn test_connection(client_id: &str, client_secret: &str) -> Result<String, String> {
    let client = super::http_client();

    let body = serde_json::json!({
        "clientId": client_id,
        "clientSecret": client_secret,
        "subscriptions": [{ "type": "EVENT", "id": "*" }],
    });

    let resp = client
        .post(GATEWAY_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("DingTalk request failed: {}", e))?;

    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("DingTalk response parse failed: {}", e))?;

    if status.is_success() && json.get("endpoint").is_some() {
        Ok("DingTalk credentials verified successfully".to_string())
    } else {
        let msg = json["message"]
            .as_str()
            .or_else(|| json["errmsg"].as_str())
            .unwrap_or("Unknown error");
        Err(format!("DingTalk auth failed: {}", msg))
    }
}

/// 注册 Stream 连接，获取 WebSocket 端点和 ticket
async fn register_connection(
    client: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
) -> Result<(String, String), String> {
    let body = serde_json::json!({
        "clientId": client_id,
        "clientSecret": client_secret,
    });

    let resp = client
        .post(GATEWAY_URL)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("DingTalk gateway request failed: {}", e))?;

    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("DingTalk gateway response parse failed: {}", e))?;

    let endpoint = json["endpoint"]
        .as_str()
        .ok_or_else(|| format!("DingTalk gateway: no endpoint in response: {}", json))?
        .to_string();

    let ticket = json["ticket"]
        .as_str()
        .ok_or_else(|| format!("DingTalk gateway: no ticket in response: {}", json))?
        .to_string();

    Ok((endpoint, ticket))
}

/// 处理机器人消息
async fn handle_robot_message(
    data: &serde_json::Value,
    bot_id: &str,
    tx: &mpsc::Sender<IncomingMessage>,
    session_webhooks: &Arc<RwLock<HashMap<String, SessionWebhookEntry>>>,
) {
    let msg_type = data["msgtype"].as_str().unwrap_or("text");
    let conversation_id = data["conversationId"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let conversation_type = data["conversationType"]
        .as_str()
        .unwrap_or("1");
    let sender_id = data["senderStaffId"]
        .as_str()
        .or_else(|| data["senderId"].as_str())
        .unwrap_or("unknown")
        .to_string();
    let sender_name = data["senderNick"]
        .as_str()
        .map(|s| s.to_string());
    let msg_id = data["msgId"]
        .as_str()
        .unwrap_or("")
        .to_string();

    // 存储 sessionWebhook
    if let Some(webhook) = data["sessionWebhook"].as_str() {
        let expires = data["sessionWebhookExpiredTime"].as_u64().unwrap_or(0);
        let mut webhooks = session_webhooks.write().await;
        webhooks.insert(
            conversation_id.clone(),
            SessionWebhookEntry {
                url: webhook.to_string(),
                expires_at: expires,
            },
        );
        // 清理过期条目
        let now_ms = now_ts() * 1000;
        webhooks.retain(|_, v| v.expires_at > now_ms || v.expires_at == 0);
    }

    // 解析消息内容
    let (content, content_parts) = match msg_type {
        "text" => {
            let text = data["text"]["content"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                return;
            }
            (text.clone(), vec![ContentPart::Text { text }])
        }
        "richText" | "markdown" => {
            let text = data["text"]["content"]
                .as_str()
                .or_else(|| data["content"]["content"].as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                return;
            }
            (text.clone(), vec![ContentPart::Text { text }])
        }
        "picture" => {
            let url = data["content"]["downloadCode"]
                .as_str()
                .or_else(|| data["content"]["pictureDownloadCode"].as_str())
                .unwrap_or("")
                .to_string();
            if url.is_empty() {
                return;
            }
            (
                "[图片]".to_string(),
                vec![ContentPart::Image {
                    url: format!("dingtalk://image/{}", url),
                    alt: None,
                }],
            )
        }
        "file" => {
            let download_code = data["content"]["downloadCode"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let filename = data["content"]["fileName"]
                .as_str()
                .unwrap_or("file")
                .to_string();
            if download_code.is_empty() {
                return;
            }
            (
                format!("[文件: {}]", filename),
                vec![ContentPart::File {
                    url: format!("dingtalk://file/{}", download_code),
                    filename,
                    mime_type: None,
                }],
            )
        }
        _ => {
            // 尝试提取文本
            let text = data["text"]["content"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                log::debug!("DingTalk: unsupported msg type '{}', skipping", msg_type);
                return;
            }
            (text.clone(), vec![ContentPart::Text { text }])
        }
    };

    // 构造 conversation_id: 区分单聊/群聊
    let conv_id = match conversation_type {
        "2" => format!("group:{}", conversation_id),
        _ => format!("dm:{}", sender_id),
    };

    let incoming = IncomingMessage {
        bot_id: bot_id.to_string(),
        platform: "dingtalk".into(),
        conversation_id: conv_id,
        sender_id,
        sender_name,
        content,
        timestamp: now_ts(),
        meta: serde_json::json!({
            "msg_id": msg_id,
            "conversation_type": conversation_type,
            "raw_conversation_id": conversation_id,
            "session_webhook": data["sessionWebhook"],
        }),
        content_parts,
    };

    tx.send(incoming).await.ok();
}
