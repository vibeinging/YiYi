use super::{now_ts, IncomingMessage};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// QQ 官方机器人 — WebSocket gateway (v2 OAuth)
/// 需要 app_id 和 client_secret（从 QQ 开放平台获取）
/// 文档: https://bot.q.qq.com/wiki/develop/api-v2/
pub struct QQBot {
    bot_id: String,
    app_id: String,
    client_secret: String,
    running: std::sync::Arc<tokio::sync::RwLock<bool>>,
}

/// Cached access token with expiry
struct AccessToken {
    token: String,
    expires_at: std::time::Instant,
}

#[allow(dead_code)]
impl QQBot {
    pub fn new(bot_id: String, app_id: String, client_secret: String) -> Self {
        Self {
            bot_id,
            app_id,
            client_secret,
            running: std::sync::Arc::new(tokio::sync::RwLock::new(false)),
        }
    }

    pub async fn start(&self, tx: mpsc::Sender<IncomingMessage>) {
        let bot_id = self.bot_id.clone();
        let app_id = self.app_id.clone();
        let client_secret = self.client_secret.clone();
        let running = self.running.clone();

        {
            let mut r = running.write().await;
            *r = true;
        }

        tokio::spawn(async move {
            let client = reqwest::Client::new();

            loop {
                {
                    let r = running.read().await;
                    if !*r {
                        break;
                    }
                }

                // Step 1: Get access token via OAuth
                let access_token = match fetch_access_token(&client, &app_id, &client_secret).await {
                    Ok(t) => t,
                    Err(e) => {
                        log::error!("QQ access_token fetch failed: {}", e);
                        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                        continue;
                    }
                };

                // Step 2: Get WebSocket gateway URL
                let gateway_url = match client
                    .get("https://api.sgroup.qq.com/gateway")
                    .header("Authorization", format!("QQBot {}", access_token))
                    .send()
                    .await
                {
                    Ok(resp) => {
                        if let Ok(json) = resp.json::<serde_json::Value>().await {
                            json["url"]
                                .as_str()
                                .unwrap_or("wss://api.sgroup.qq.com/websocket")
                                .to_string()
                        } else {
                            "wss://api.sgroup.qq.com/websocket".to_string()
                        }
                    }
                    Err(e) => {
                        log::error!("QQ gateway fetch failed: {}", e);
                        "wss://api.sgroup.qq.com/websocket".to_string()
                    }
                };

                log::info!("QQ Bot connecting to gateway: {}", gateway_url);

                // Track token expiry for refresh during connection
                let mut cached_token = AccessToken {
                    token: access_token,
                    // Token is valid for 7200s, refresh at 6000s to be safe
                    expires_at: std::time::Instant::now() + std::time::Duration::from_secs(6000),
                };

                match tokio_tungstenite::connect_async(&gateway_url).await {
                    Ok((mut ws_stream, _)) => {
                        log::info!("QQ gateway connected");

                        let mut heartbeat_interval: u64 = 30000;
                        let mut sequence: Option<i64> = None;
                        let mut identified = false;

                        loop {
                            let r = running.read().await;
                            if !*r {
                                break;
                            }
                            drop(r);

                            // Refresh token if expired
                            if std::time::Instant::now() >= cached_token.expires_at {
                                match fetch_access_token(&client, &app_id, &client_secret).await {
                                    Ok(new_token) => {
                                        log::info!("QQ access_token refreshed");
                                        cached_token = AccessToken {
                                            token: new_token,
                                            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(6000),
                                        };
                                    }
                                    Err(e) => {
                                        log::error!("QQ access_token refresh failed: {}", e);
                                        // Token expired and can't refresh — reconnect
                                        break;
                                    }
                                }
                            }

                            tokio::select! {
                                msg = ws_stream.next() => {
                                    match msg {
                                        Some(Ok(Message::Text(text))) => {
                                            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&text) {
                                                let op = payload["op"].as_i64().unwrap_or(-1);
                                                if let Some(s) = payload["s"].as_i64() {
                                                    sequence = Some(s);
                                                }

                                                match op {
                                                    10 => {
                                                        // Hello — get heartbeat interval
                                                        heartbeat_interval = payload["d"]["heartbeat_interval"]
                                                            .as_u64()
                                                            .unwrap_or(30000);

                                                        // Send Identify (op=2)
                                                        if !identified {
                                                            // QQ Official Bot API v2 Intents:
                                                            // 1 << 0  = GUILDS
                                                            // 1 << 1  = GUILD_MEMBERS
                                                            // 1 << 12 = DIRECT_MESSAGE (频道私信)
                                                            // 1 << 25 = GROUP_AND_C2C_EVENT (群聊+C2C私聊)
                                                            // 1 << 30 = PUBLIC_GUILD_MESSAGES (公域频道)
                                                            let intents = (1 << 0)   // GUILDS
                                                                | (1 << 25)           // GROUP_AND_C2C_EVENT (群+C2C私聊)
                                                                | (1 << 30);          // PUBLIC_GUILD_MESSAGES
                                                            let auth_token = format!("QQBot {}", cached_token.token);
                                                            let identify = serde_json::json!({
                                                                "op": 2,
                                                                "d": {
                                                                    "token": auth_token,
                                                                    "intents": intents,
                                                                    "shard": [0, 1],
                                                                    "properties": {
                                                                        "os": "linux",
                                                                        "browser": "yiclaw",
                                                                        "device": "yiclaw"
                                                                    }
                                                                }
                                                            });
                                                            log::info!("QQ Identify with intents={}, auth=QQBot ***", intents);
                                                            ws_stream.send(Message::Text(
                                                                serde_json::to_string(&identify).unwrap().into()
                                                            )).await.ok();
                                                            identified = true;
                                                        }
                                                    }
                                                    11 => {
                                                        // Heartbeat ACK — ok
                                                    }
                                                    0 => {
                                                        // Dispatch event
                                                        let event_name = payload["t"]
                                                            .as_str()
                                                            .unwrap_or("");

                                                        match event_name {
                                                            "READY" => {
                                                                let user = &payload["d"]["user"];
                                                                log::info!(
                                                                    "QQ Bot authenticated! username={}, id={}",
                                                                    user["username"].as_str().unwrap_or("?"),
                                                                    user["id"].as_str().unwrap_or("?")
                                                                );
                                                            }
                                                            // 频道 @机器人 消息
                                                            "AT_MESSAGE_CREATE" | "MESSAGE_CREATE" => {
                                                                handle_qq_message(&payload["d"], &bot_id, &tx).await;
                                                            }
                                                            // 群聊 @机器人 消息
                                                            "GROUP_AT_MESSAGE_CREATE" => {
                                                                handle_qq_group_message(&payload["d"], &bot_id, &tx).await;
                                                            }
                                                            // C2C 单聊消息
                                                            "C2C_MESSAGE_CREATE" => {
                                                                handle_qq_c2c_message(&payload["d"], &bot_id, &tx).await;
                                                            }
                                                            _ => {}
                                                        }
                                                    }
                                                    7 => {
                                                        // Reconnect requested
                                                        log::warn!("QQ gateway requested reconnect");
                                                        break;
                                                    }
                                                    9 => {
                                                        // Invalid session
                                                        let resumable = payload["d"].as_bool().unwrap_or(false);
                                                        log::warn!(
                                                            "QQ invalid session (resumable={}), full payload: {}",
                                                            resumable,
                                                            serde_json::to_string(&payload).unwrap_or_default()
                                                        );
                                                        identified = false;
                                                        if !resumable {
                                                            break;
                                                        }
                                                    }
                                                    _ => {}
                                                }
                                            }
                                        }
                                        Some(Ok(Message::Close(_))) | None => {
                                            log::warn!("QQ gateway closed");
                                            break;
                                        }
                                        _ => {}
                                    }
                                }
                                _ = tokio::time::sleep(std::time::Duration::from_millis(heartbeat_interval)) => {
                                    // Send heartbeat (op=1)
                                    let hb = serde_json::json!({
                                        "op": 1,
                                        "d": sequence,
                                    });
                                    ws_stream.send(Message::Text(
                                        serde_json::to_string(&hb).unwrap().into()
                                    )).await.ok();
                                }
                            }
                        }
                    }
                    Err(e) => {
                        log::error!("QQ gateway connect failed: {}", e);
                    }
                }

                // Reconnect delay
                let r = running.read().await;
                if !*r {
                    break;
                }
                drop(r);
                log::info!("QQ reconnecting in 5s...");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }

            log::info!("QQ gateway stopped");
        });
    }

    pub async fn stop(&self) {
        let mut r = self.running.write().await;
        *r = false;
    }

    /// 发送频道消息（被动回复）
    /// 当提供 msg_id 时，使用 message_reference 创建引用回复样式
    pub async fn send_guild_message(
        &self,
        channel_id: &str,
        content: &str,
        msg_id: Option<&str>,
    ) -> Result<(), String> {
        let access_token = get_access_token(&self.app_id, &self.client_secret).await?;
        let client = reqwest::Client::new();
        let url = format!(
            "https://api.sgroup.qq.com/channels/{}/messages",
            channel_id
        );

        let mut body = serde_json::json!({ "content": content });
        if let Some(id) = msg_id {
            body["msg_id"] = serde_json::Value::String(id.to_string());
            // message_reference creates a visual reply-quote in the QQ client
            body["message_reference"] = serde_json::json!({
                "message_id": id,
                "ignore_get_message_error": true,
            });
        }

        client
            .post(&url)
            .header("Authorization", format!("QQBot {}", access_token))
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("QQ guild send failed: {}", e))?;

        Ok(())
    }

    /// 发送群聊消息
    pub async fn send_group_message(
        &self,
        group_openid: &str,
        content: &str,
        msg_id: Option<&str>,
    ) -> Result<(), String> {
        let access_token = get_access_token(&self.app_id, &self.client_secret).await?;
        let client = reqwest::Client::new();
        let url = format!(
            "https://api.sgroup.qq.com/v2/groups/{}/messages",
            group_openid
        );

        let mut body = serde_json::json!({
            "content": content,
            "msg_type": 0,
        });
        if let Some(id) = msg_id {
            body["msg_id"] = serde_json::Value::String(id.to_string());
        }

        client
            .post(&url)
            .header("Authorization", format!("QQBot {}", access_token))
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("QQ group send failed: {}", e))?;

        Ok(())
    }

    /// 发送 C2C 私聊消息
    pub async fn send_c2c_message(
        &self,
        user_openid: &str,
        content: &str,
        msg_id: Option<&str>,
    ) -> Result<(), String> {
        let access_token = get_access_token(&self.app_id, &self.client_secret).await?;
        let client = reqwest::Client::new();
        let url = format!(
            "https://api.sgroup.qq.com/v2/users/{}/messages",
            user_openid
        );

        let mut body = serde_json::json!({
            "content": content,
            "msg_type": 0,
        });
        if let Some(id) = msg_id {
            body["msg_id"] = serde_json::Value::String(id.to_string());
        }

        client
            .post(&url)
            .header("Authorization", format!("QQBot {}", access_token))
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("QQ c2c send failed: {}", e))?;

        Ok(())
    }
}

/// Fetch a new access_token from QQ OAuth endpoint.
/// POST https://bots.qq.com/app/getAppAccessToken
/// Body: { "appId": "xxx", "clientSecret": "xxx" }
/// Response: { "access_token": "xxx", "expires_in": "7200" }
async fn fetch_access_token(
    client: &reqwest::Client,
    app_id: &str,
    client_secret: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "appId": app_id,
        "clientSecret": client_secret,
    });

    let resp = client
        .post("https://bots.qq.com/app/getAppAccessToken")
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("QQ OAuth request failed: {}", e))?;

    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("QQ OAuth response parse failed: {}", e))?;

    log::info!("QQ OAuth: access_token obtained, expires_in={}", json["expires_in"]);

    json["access_token"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("QQ OAuth: no access_token in response: {}", json))
}

/// Convenience wrapper: fetch access_token for send methods.
async fn get_access_token(app_id: &str, client_secret: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    fetch_access_token(&client, app_id, client_secret).await
}

/// Strip QQ mention tags like `<@!12345>`, `<@12345>` and `<qqbot-at-everyone/>` from content.
fn strip_qq_mentions(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();

    while let Some(&ch) = chars.peek() {
        if ch == '<' {
            // Try to match <@!digits> or <@digits> or <qqbot-at-everyone/>
            let remaining: String = chars.clone().collect();
            if remaining.starts_with("<qqbot-at-everyone/>") {
                // Skip the entire tag
                for _ in 0.."<qqbot-at-everyone/>".len() {
                    chars.next();
                }
                continue;
            }
            if remaining.starts_with("<@!") || remaining.starts_with("<@") {
                // Find closing >
                if let Some(end) = remaining.find('>') {
                    let tag = &remaining[..=end];
                    // Verify it matches <@!digits> or <@digits>
                    let inner = if tag.starts_with("<@!") {
                        &tag[3..tag.len() - 1]
                    } else {
                        &tag[2..tag.len() - 1]
                    };
                    if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
                        // Skip the entire mention tag
                        for _ in 0..=end {
                            chars.next();
                        }
                        continue;
                    }
                }
            }
        }
        result.push(ch);
        chars.next();
    }

    result.trim().to_string()
}

/// 处理频道消息
async fn handle_qq_message(d: &serde_json::Value, bot_id: &str, tx: &mpsc::Sender<IncomingMessage>) {
    let raw_content = d["content"].as_str().unwrap_or("").trim();
    let content = strip_qq_mentions(raw_content);
    if content.is_empty() {
        return;
    }

    let channel_id = d["channel_id"].as_str().unwrap_or("").to_string();
    let guild_id = d["guild_id"].as_str().unwrap_or("").to_string();
    let author_id = d["author"]["id"].as_str().unwrap_or("").to_string();
    let author_name = d["author"]["username"]
        .as_str()
        .map(|s| s.to_string());
    let msg_id = d["id"].as_str().unwrap_or("").to_string();

    let incoming = IncomingMessage {
        bot_id: bot_id.to_string(),
        platform: "qq".into(),
        conversation_id: format!("guild:{}:{}", guild_id, channel_id),
        sender_id: author_id,
        sender_name: author_name,
        content,
        timestamp: now_ts(),
        meta: serde_json::json!({
            "guild_id": guild_id,
            "channel_id": channel_id,
            "msg_id": msg_id,
            "msg_type": "guild",
        }),
        content_parts: Vec::new(),
    };

    tx.send(incoming).await.ok();
}

/// 处理群聊消息
async fn handle_qq_group_message(
    d: &serde_json::Value,
    bot_id: &str,
    tx: &mpsc::Sender<IncomingMessage>,
) {
    let raw_content = d["content"].as_str().unwrap_or("").trim();
    let content = strip_qq_mentions(raw_content);
    if content.is_empty() {
        return;
    }

    let group_openid = d["group_openid"].as_str().unwrap_or("").to_string();
    let author_openid = d["author"]["member_openid"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let msg_id = d["id"].as_str().unwrap_or("").to_string();

    let incoming = IncomingMessage {
        bot_id: bot_id.to_string(),
        platform: "qq".into(),
        conversation_id: format!("group:{}", group_openid),
        sender_id: author_openid,
        sender_name: None,
        content,
        timestamp: now_ts(),
        meta: serde_json::json!({
            "group_openid": group_openid,
            "msg_id": msg_id,
            "msg_type": "group",
        }),
        content_parts: Vec::new(),
    };

    tx.send(incoming).await.ok();
}

/// 处理 C2C 单聊消息
async fn handle_qq_c2c_message(
    d: &serde_json::Value,
    bot_id: &str,
    tx: &mpsc::Sender<IncomingMessage>,
) {
    let content = d["content"].as_str().unwrap_or("").trim().to_string();
    if content.is_empty() {
        return;
    }

    let user_openid = d["author"]["user_openid"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let msg_id = d["id"].as_str().unwrap_or("").to_string();

    let incoming = IncomingMessage {
        bot_id: bot_id.to_string(),
        platform: "qq".into(),
        conversation_id: format!("c2c:{}", user_openid),
        sender_id: user_openid,
        sender_name: None,
        content,
        timestamp: now_ts(),
        meta: serde_json::json!({
            "msg_id": msg_id,
            "msg_type": "c2c",
        }),
        content_parts: Vec::new(),
    };

    tx.send(incoming).await.ok();
}
