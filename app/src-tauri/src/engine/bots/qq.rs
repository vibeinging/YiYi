use super::{now_ts, update_bot_status, BotConnectionState, IncomingMessage};
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
struct CachedToken {
    token: String,
    expires_at: std::time::Instant,
}

static TOKEN_CACHE: std::sync::OnceLock<
    tokio::sync::RwLock<std::collections::HashMap<String, CachedToken>>,
> = std::sync::OnceLock::new();

fn token_cache(
) -> &'static tokio::sync::RwLock<std::collections::HashMap<String, CachedToken>> {
    TOKEN_CACHE.get_or_init(|| tokio::sync::RwLock::new(std::collections::HashMap::new()))
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

    /// Get the shared running flag for external stop control.
    pub fn running_flag(&self) -> std::sync::Arc<tokio::sync::RwLock<bool>> {
        self.running.clone()
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
            let client = super::http_client();

            loop {
                {
                    let r = running.read().await;
                    if !*r {
                        break;
                    }
                }

                update_bot_status(&bot_id, BotConnectionState::Connecting, Some("Fetching access token".into()));

                // Step 1: Get access token via OAuth
                let access_token = match fetch_access_token(&client, &app_id, &client_secret).await {
                    Ok(t) => t,
                    Err(e) => {
                        log::error!("QQ access_token fetch failed: {}", e);
                        update_bot_status(&bot_id, BotConnectionState::Error, Some(format!("Token fetch failed: {}", e)));
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
                let mut cached_token = CachedToken {
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
                                        cached_token = CachedToken {
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
                                                                        "browser": "yiyi",
                                                                        "device": "yiyi"
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
                                                                let uname = user["username"].as_str().unwrap_or("?");
                                                                log::info!(
                                                                    "QQ Bot authenticated! username={}, id={}",
                                                                    uname,
                                                                    user["id"].as_str().unwrap_or("?")
                                                                );
                                                                update_bot_status(&bot_id, BotConnectionState::Connected, Some(format!("Authenticated as {}", uname)));
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
                        update_bot_status(&bot_id, BotConnectionState::Error, Some(format!("Connect failed: {}", e)));
                    }
                }

                // Reconnect delay
                let r = running.read().await;
                if !*r {
                    break;
                }
                drop(r);
                log::info!("QQ reconnecting in 5s...");
                update_bot_status(&bot_id, BotConnectionState::Reconnecting, Some("Reconnecting in 5s".into()));
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }

            update_bot_status(&bot_id, BotConnectionState::Disconnected, Some("Stopped".into()));
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
        let client = super::http_client();
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

        let resp = client
            .post(&url)
            .header("Authorization", format!("QQBot {}", access_token))
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("QQ guild send failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("QQ guild send failed ({}): {}", status, body));
        }

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
        let client = super::http_client();
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

        let resp = client
            .post(&url)
            .header("Authorization", format!("QQBot {}", access_token))
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("QQ group send failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("QQ group send failed ({}): {}", status, body));
        }

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
        let client = super::http_client();
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

        let resp = client
            .post(&url)
            .header("Authorization", format!("QQBot {}", access_token))
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("QQ c2c send failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("QQ c2c send failed ({}): {}", status, body));
        }

        Ok(())
    }

    /// 发送群聊富媒体消息 (图片/视频/语音/文件)
    /// file_type: 1=图片, 2=视频, 3=语音, 4=文件
    pub async fn send_group_media(
        &self,
        group_openid: &str,
        file_type: u8,
        file_url: &str,
        msg_id: Option<&str>,
    ) -> Result<(), String> {
        let access_token = get_access_token(&self.app_id, &self.client_secret).await?;
        let client = super::http_client();

        // Step 1: Upload media to get file_info
        let upload_url = format!(
            "https://api.sgroup.qq.com/v2/groups/{}/files",
            group_openid
        );
        let mut upload_body = serde_json::json!({
            "file_type": file_type,
            "url": file_url,
            "srv_send_msg": false,
        });

        let upload_resp = client
            .post(&upload_url)
            .header("Authorization", format!("QQBot {}", access_token))
            .json(&upload_body)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("QQ group media upload failed: {}", e))?;

        if !upload_resp.status().is_success() {
            let status = upload_resp.status();
            let body = upload_resp.text().await.unwrap_or_default();
            // Fallback: try srv_send_msg=true (some QQ API versions send directly)
            upload_body["srv_send_msg"] = serde_json::json!(true);
            if let Some(id) = msg_id {
                upload_body["msg_id"] = serde_json::Value::String(id.to_string());
            }
            let retry_resp = client
                .post(&upload_url)
                .header("Authorization", format!("QQBot {}", access_token))
                .json(&upload_body)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("QQ group media upload retry failed: {}", e))?;
            if !retry_resp.status().is_success() {
                return Err(format!("QQ group media upload failed ({}): {}", status, body));
            }
            return Ok(());
        }

        let upload_json: serde_json::Value = upload_resp
            .json()
            .await
            .map_err(|e| format!("QQ group media upload parse failed: {}", e))?;

        let file_info = upload_json.get("file_info")
            .or_else(|| upload_json.get("file_uuid"))
            .cloned()
            .unwrap_or(serde_json::json!(null));

        if file_info.is_null() {
            return Err(format!("QQ group media upload: no file_info in response: {}", upload_json));
        }

        // Step 2: Send message with media reference
        let msg_url = format!(
            "https://api.sgroup.qq.com/v2/groups/{}/messages",
            group_openid
        );
        let media_key = match file_type {
            1 => "image",
            2 => "video",
            3 => "voice",
            _ => "file",
        };
        // msg_type=7 for rich media
        let mut msg_body = serde_json::json!({
            "msg_type": 7,
            "media": { "file_info": file_info },
        });
        if let Some(id) = msg_id {
            msg_body["msg_id"] = serde_json::Value::String(id.to_string());
        }

        let msg_resp = client
            .post(&msg_url)
            .header("Authorization", format!("QQBot {}", access_token))
            .json(&msg_body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("QQ group {} send failed: {}", media_key, e))?;

        if !msg_resp.status().is_success() {
            let status = msg_resp.status();
            let body = msg_resp.text().await.unwrap_or_default();
            return Err(format!("QQ group {} send failed ({}): {}", media_key, status, body));
        }

        log::info!("QQ group media sent: type={}, group={}", file_type, group_openid);
        Ok(())
    }

    /// 发送 C2C 富媒体消息
    pub async fn send_c2c_media(
        &self,
        user_openid: &str,
        file_type: u8,
        file_url: &str,
        msg_id: Option<&str>,
    ) -> Result<(), String> {
        let access_token = get_access_token(&self.app_id, &self.client_secret).await?;
        let client = super::http_client();

        let upload_url = format!(
            "https://api.sgroup.qq.com/v2/users/{}/files",
            user_openid
        );
        let mut upload_body = serde_json::json!({
            "file_type": file_type,
            "url": file_url,
            "srv_send_msg": false,
        });

        let upload_resp = client
            .post(&upload_url)
            .header("Authorization", format!("QQBot {}", access_token))
            .json(&upload_body)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("QQ c2c media upload failed: {}", e))?;

        if !upload_resp.status().is_success() {
            let status = upload_resp.status();
            let body = upload_resp.text().await.unwrap_or_default();
            upload_body["srv_send_msg"] = serde_json::json!(true);
            if let Some(id) = msg_id {
                upload_body["msg_id"] = serde_json::Value::String(id.to_string());
            }
            let retry_resp = client
                .post(&upload_url)
                .header("Authorization", format!("QQBot {}", access_token))
                .json(&upload_body)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("QQ c2c media upload retry failed: {}", e))?;
            if !retry_resp.status().is_success() {
                return Err(format!("QQ c2c media upload failed ({}): {}", status, body));
            }
            return Ok(());
        }

        let upload_json: serde_json::Value = upload_resp
            .json()
            .await
            .map_err(|e| format!("QQ c2c media upload parse failed: {}", e))?;

        let file_info = upload_json.get("file_info")
            .or_else(|| upload_json.get("file_uuid"))
            .cloned()
            .unwrap_or(serde_json::json!(null));

        if file_info.is_null() {
            return Err(format!("QQ c2c media upload: no file_info in response: {}", upload_json));
        }

        let msg_url = format!(
            "https://api.sgroup.qq.com/v2/users/{}/messages",
            user_openid
        );
        let mut msg_body = serde_json::json!({
            "msg_type": 7,
            "media": { "file_info": file_info },
        });
        if let Some(id) = msg_id {
            msg_body["msg_id"] = serde_json::Value::String(id.to_string());
        }

        let msg_resp = client
            .post(&msg_url)
            .header("Authorization", format!("QQBot {}", access_token))
            .json(&msg_body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("QQ c2c media send failed: {}", e))?;

        if !msg_resp.status().is_success() {
            let status = msg_resp.status();
            let body = msg_resp.text().await.unwrap_or_default();
            return Err(format!("QQ c2c media send failed ({}): {}", status, body));
        }

        log::info!("QQ c2c media sent: type={}, user={}", file_type, user_openid);
        Ok(())
    }

    /// 发送频道图片消息
    pub async fn send_guild_image(
        &self,
        channel_id: &str,
        image_url: &str,
        msg_id: Option<&str>,
    ) -> Result<(), String> {
        let access_token = get_access_token(&self.app_id, &self.client_secret).await?;
        let client = super::http_client();
        let url = format!(
            "https://api.sgroup.qq.com/channels/{}/messages",
            channel_id
        );

        let mut body = serde_json::json!({ "image": image_url });
        if let Some(id) = msg_id {
            body["msg_id"] = serde_json::Value::String(id.to_string());
        }

        let resp = client
            .post(&url)
            .header("Authorization", format!("QQBot {}", access_token))
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("QQ guild image send failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("QQ guild image send failed ({}): {}", status, body));
        }

        Ok(())
    }
}

/// Test QQ bot credentials by requesting an access token.
pub async fn test_connection(app_id: &str, client_secret: &str) -> Result<String, String> {
    let client = super::http_client();

    let body = serde_json::json!({
        "appId": app_id,
        "clientSecret": client_secret,
    });

    let resp = client
        .post("https://bots.qq.com/app/getAppAccessToken")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("QQ request failed: {}", e))?;

    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("QQ response parse failed: {}", e))?;

    if status.is_success() && json.get("access_token").is_some() {
        Ok("QQ bot credentials verified successfully".to_string())
    } else {
        let msg = json["message"].as_str().unwrap_or("Invalid credentials");
        Err(format!("QQ auth failed: {}", msg))
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

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("QQ OAuth failed ({}): {}", status, text));
    }

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

/// Convenience wrapper: fetch access_token with caching for send methods.
async fn get_access_token(app_id: &str, client_secret: &str) -> Result<String, String> {
    let cache = token_cache();
    // Check cache
    {
        let c = cache.read().await;
        if let Some(ct) = c.get(app_id) {
            if std::time::Instant::now() < ct.expires_at {
                return Ok(ct.token.clone());
            }
        }
    }
    // Fetch new token
    let client = super::http_client();
    let token = fetch_access_token(&client, app_id, client_secret).await?;
    // Cache with 6000s expiry (refresh before 7200s actual expiry)
    {
        let mut c = cache.write().await;
        c.insert(
            app_id.to_string(),
            CachedToken {
                token: token.clone(),
                expires_at: std::time::Instant::now() + std::time::Duration::from_secs(6000),
            },
        );
    }
    Ok(token)
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

/// Parse attachments from QQ message payload into ContentPart items.
fn parse_qq_attachments(d: &serde_json::Value) -> Vec<super::ContentPart> {
    let mut parts = Vec::new();
    if let Some(attachments) = d["attachments"].as_array() {
        for att in attachments {
            let url = att["url"].as_str().unwrap_or("").to_string();
            if url.is_empty() { continue; }
            // Ensure URL has scheme
            let full_url = if url.starts_with("http://") || url.starts_with("https://") {
                url
            } else {
                format!("https://{}", url)
            };
            let content_type = att["content_type"].as_str().unwrap_or("");
            let filename = att["filename"].as_str().unwrap_or("").to_string();

            // Determine type from content_type first, fallback to filename extension
            if content_type.starts_with("image/") {
                parts.push(super::ContentPart::Image { url: full_url, alt: Some(filename) });
            } else if content_type.starts_with("audio/") {
                parts.push(super::ContentPart::Audio { url: full_url });
            } else if content_type.starts_with("video/") {
                parts.push(super::ContentPart::Video { url: full_url });
            } else if !content_type.is_empty() {
                // Known non-media content_type → file
                parts.push(super::ContentPart::File {
                    url: full_url,
                    filename,
                    mime_type: Some(content_type.to_string()),
                });
            } else {
                // No content_type — fallback to filename extension
                let ext = filename.rsplit('.').next().unwrap_or("");
                match super::classify_extension(ext) {
                    Some(super::MediaType::Image) => {
                        parts.push(super::ContentPart::Image { url: full_url, alt: Some(filename) });
                    }
                    Some(super::MediaType::Audio) => {
                        parts.push(super::ContentPart::Audio { url: full_url });
                    }
                    Some(super::MediaType::Video) => {
                        parts.push(super::ContentPart::Video { url: full_url });
                    }
                    _ => {
                        parts.push(super::ContentPart::File {
                            url: full_url,
                            filename,
                            mime_type: None,
                        });
                    }
                }
            }
        }
    }
    parts
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
        content_parts: parse_qq_attachments(d),
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
        content_parts: parse_qq_attachments(d),
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
        content_parts: parse_qq_attachments(d),
    };

    tx.send(incoming).await.ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_qq_mentions_removes_at_user_tag() {
        assert_eq!(strip_qq_mentions("<@12345> hello"), "hello");
        assert_eq!(strip_qq_mentions("<@!67890>  hi there"), "hi there");
    }

    #[test]
    fn strip_qq_mentions_removes_at_everyone() {
        assert_eq!(strip_qq_mentions("<qqbot-at-everyone/> message"), "message");
    }

    #[test]
    fn strip_qq_mentions_preserves_non_mention_angle_brackets() {
        assert_eq!(strip_qq_mentions("compare <a> tag"), "compare <a> tag");
    }

    #[test]
    fn strip_qq_mentions_trims_surrounding_whitespace() {
        assert_eq!(strip_qq_mentions("   <@42>   content   "), "content");
    }

    #[test]
    fn parse_qq_attachments_classifies_by_content_type() {
        let d = serde_json::json!({
            "attachments": [
                { "url": "https://x/a.png", "content_type": "image/png", "filename": "a.png" },
                { "url": "https://x/b.mp3", "content_type": "audio/mpeg", "filename": "b.mp3" },
                { "url": "https://x/c.mp4", "content_type": "video/mp4", "filename": "c.mp4" },
                { "url": "https://x/d.pdf", "content_type": "application/pdf", "filename": "d.pdf" },
            ],
        });
        let parts = parse_qq_attachments(&d);
        assert_eq!(parts.len(), 4);
        assert!(matches!(parts[0], super::super::ContentPart::Image { .. }));
        assert!(matches!(parts[1], super::super::ContentPart::Audio { .. }));
        assert!(matches!(parts[2], super::super::ContentPart::Video { .. }));
        assert!(matches!(parts[3], super::super::ContentPart::File { .. }));
    }

    #[test]
    fn parse_qq_attachments_adds_https_when_missing_scheme() {
        let d = serde_json::json!({
            "attachments": [{ "url": "x.y/pic.png", "content_type": "image/png", "filename": "pic.png" }],
        });
        let parts = parse_qq_attachments(&d);
        match &parts[0] {
            super::super::ContentPart::Image { url, .. } => {
                assert!(url.starts_with("https://"));
            }
            _ => panic!("expected image"),
        }
    }

    #[test]
    fn parse_qq_attachments_skips_entries_with_empty_url() {
        let d = serde_json::json!({
            "attachments": [{ "url": "", "content_type": "image/png", "filename": "" }],
        });
        assert!(parse_qq_attachments(&d).is_empty());
    }

    #[test]
    fn parse_qq_attachments_falls_back_to_extension_when_no_content_type() {
        let d = serde_json::json!({
            "attachments": [{ "url": "https://x/a.png", "content_type": "", "filename": "a.png" }],
        });
        let parts = parse_qq_attachments(&d);
        assert!(matches!(parts[0], super::super::ContentPart::Image { .. }));
    }
}
