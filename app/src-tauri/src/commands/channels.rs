use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

use crate::engine::channels::manager::ChannelManager;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInfo {
    pub id: String,
    pub name: String,
    pub channel_type: String,
    pub enabled: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelMessage {
    pub session_id: String,
    pub channel_type: String,
    pub user_id: String,
    pub username: Option<String>,
    pub content: String,
    pub timestamp: u64,
}

/// Supported channel types and their display names
fn channel_types() -> HashMap<&'static str, &'static str> {
    let mut m = HashMap::new();
    m.insert("dingtalk", "DingTalk");
    m.insert("feishu", "Feishu");
    m.insert("discord", "Discord");
    m.insert("qq", "QQ");
    m.insert("wecom", "企业微信");
    m.insert("telegram", "Telegram");
    m.insert("webhook", "Webhook");
    m
}

#[tauri::command]
pub async fn channels_list(
    state: State<'_, AppState>,
) -> Result<Vec<ChannelInfo>, String> {
    let config = state.config.read().await;
    let types = channel_types();
    let channels: Vec<ChannelInfo> = config
        .channels
        .iter()
        .map(|(id, cfg)| ChannelInfo {
            id: id.clone(),
            name: types.get(id.as_str()).unwrap_or(&id.as_str()).to_string(),
            channel_type: id.clone(),
            enabled: cfg.enabled,
            status: if cfg.enabled { "ready".into() } else { "disabled".into() },
        })
        .collect();
    Ok(channels)
}

#[tauri::command]
pub async fn channels_list_types() -> Result<Vec<serde_json::Value>, String> {
    let types = channel_types();
    Ok(types
        .into_iter()
        .map(|(k, v)| serde_json::json!({ "id": k, "name": v }))
        .collect())
}

#[tauri::command]
pub async fn channels_get(
    state: State<'_, AppState>,
    channel_name: String,
) -> Result<serde_json::Value, String> {
    let config = state.config.read().await;
    let cfg = config
        .channels
        .get(&channel_name)
        .ok_or_else(|| format!("Channel '{}' not found", channel_name))?;

    Ok(serde_json::json!({
        "id": channel_name,
        "enabled": cfg.enabled,
        "bot_prefix": cfg.bot_prefix,
        "extra": cfg.extra,
    }))
}

#[tauri::command]
pub async fn channels_update(
    state: State<'_, AppState>,
    channel_name: String,
    enabled: Option<bool>,
    bot_prefix: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut config = state.config.write().await;
    let cfg = config
        .channels
        .entry(channel_name.clone())
        .or_insert_with(Default::default);

    if let Some(e) = enabled {
        cfg.enabled = e;
    }
    if let Some(bp) = bot_prefix {
        cfg.bot_prefix = bp;
    }

    config.save(&state.working_dir)?;

    Ok(serde_json::json!({
        "status": "ok",
        "channel": channel_name,
    }))
}

/// Send a message to a channel. Reusable from both Tauri commands and scheduler dispatch.
pub async fn send_to_channel(
    config: &crate::state::config::Config,
    channel_type: &str,
    target: &str,
    content: &str,
) -> Result<(), String> {
    let channel_cfg = config.channels.get(channel_type);

    match channel_type {
        "webhook" => {
            let url = channel_cfg
                .and_then(|c| c.extra.get("webhook_url"))
                .and_then(|v| v.as_str())
                .ok_or("No webhook_url configured")?
                .to_string();

            let client = reqwest::Client::new();
            let body = serde_json::json!({
                "target": target,
                "content": content,
            });

            client
                .post(&url)
                .json(&body)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Webhook send failed: {}", e))?;

            Ok(())
        }
        "discord" => {
            let bot_token = channel_cfg
                .and_then(|c| c.extra.get("bot_token"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("DISCORD_BOT_TOKEN").ok())
                .ok_or("No Discord bot_token configured")?;

            let client = reqwest::Client::new();
            let url = format!(
                "https://discord.com/api/v10/channels/{}/messages",
                target
            );
            let body = serde_json::json!({ "content": content });

            client
                .post(&url)
                .header("Authorization", format!("Bot {}", bot_token))
                .header("Content-Type", "application/json")
                .json(&body)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Discord send failed: {}", e))?;

            Ok(())
        }
        "dingtalk" => {
            let webhook = channel_cfg
                .and_then(|c| c.extra.get("webhook_url"))
                .and_then(|v| v.as_str())
                .ok_or("No DingTalk webhook_url configured")?
                .to_string();

            let client = reqwest::Client::new();
            let body = serde_json::json!({
                "msgtype": "text",
                "text": { "content": content }
            });

            client
                .post(&webhook)
                .json(&body)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("DingTalk send failed: {}", e))?;

            Ok(())
        }
        "feishu" => {
            let webhook = channel_cfg
                .and_then(|c| c.extra.get("webhook_url"))
                .and_then(|v| v.as_str())
                .ok_or("No Feishu webhook_url configured")?
                .to_string();

            let client = reqwest::Client::new();
            let body = serde_json::json!({
                "msg_type": "text",
                "content": { "text": content }
            });

            client
                .post(&webhook)
                .json(&body)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Feishu send failed: {}", e))?;

            Ok(())
        }
        "telegram" => {
            let bot_token = channel_cfg
                .and_then(|c| c.extra.get("bot_token"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("TELEGRAM_BOT_TOKEN").ok())
                .ok_or("No Telegram bot_token configured")?;

            let ch = crate::engine::channels::telegram::TelegramChannel::new(bot_token);
            ch.send(target, content)
                .await
                .map_err(|e| format!("Telegram send failed: {}", e))?;

            Ok(())
        }
        "qq" => {
            let app_id = channel_cfg
                .and_then(|c| c.extra.get("app_id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("QQ_BOT_APP_ID").ok())
                .ok_or("No QQ app_id configured")?;

            let token = channel_cfg
                .and_then(|c| c.extra.get("token"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("QQ_BOT_TOKEN").ok())
                .ok_or("No QQ token configured")?;

            let auth = format!("Bot {}.{}", app_id, token);
            let client = reqwest::Client::new();

            if let Some(group_openid) = target.strip_prefix("group:") {
                let url = format!(
                    "https://api.sgroup.qq.com/v2/groups/{}/messages",
                    group_openid
                );
                let body = serde_json::json!({
                    "content": content,
                    "msg_type": 0,
                });
                client
                    .post(&url)
                    .header("Authorization", &auth)
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(15))
                    .send()
                    .await
                    .map_err(|e| format!("QQ group send failed: {}", e))?;
            } else {
                let url = format!(
                    "https://api.sgroup.qq.com/channels/{}/messages",
                    target
                );
                let body = serde_json::json!({ "content": content });
                client
                    .post(&url)
                    .header("Authorization", &auth)
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(15))
                    .send()
                    .await
                    .map_err(|e| format!("QQ guild send failed: {}", e))?;
            }

            Ok(())
        }
        "wecom" => {
            let corp_id = channel_cfg
                .and_then(|c| c.extra.get("corp_id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("WECOM_CORP_ID").ok())
                .ok_or("No WeCom corp_id configured")?;

            let corp_secret = channel_cfg
                .and_then(|c| c.extra.get("corp_secret"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("WECOM_CORP_SECRET").ok())
                .ok_or("No WeCom corp_secret configured")?;

            let agent_id = channel_cfg
                .and_then(|c| c.extra.get("agent_id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("WECOM_AGENT_ID").ok())
                .ok_or("No WeCom agent_id configured")?;

            let client = reqwest::Client::new();
            let token_url = format!(
                "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={}&corpsecret={}",
                corp_id, corp_secret
            );
            let token_resp = client
                .get(&token_url)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| format!("WeCom token request failed: {}", e))?
                .json::<serde_json::Value>()
                .await
                .map_err(|e| format!("WeCom token parse failed: {}", e))?;

            let access_token = token_resp["access_token"]
                .as_str()
                .ok_or("Failed to get WeCom access_token")?;

            let send_url = format!(
                "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={}",
                access_token
            );
            let body = serde_json::json!({
                "touser": target,
                "msgtype": "text",
                "agentid": agent_id.parse::<i64>().unwrap_or(0),
                "text": { "content": content },
            });

            client
                .post(&send_url)
                .json(&body)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("WeCom send failed: {}", e))?;

            Ok(())
        }
        _ => Err(format!("Channel type '{}' send not implemented", channel_type)),
    }
}

#[tauri::command]
pub async fn channels_send(
    state: State<'_, AppState>,
    channel_type: String,
    target: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let config = state.config.read().await;
    send_to_channel(&config, &channel_type, &target, &content).await?;
    Ok(serde_json::json!({ "status": "ok" }))
}

#[tauri::command]
pub async fn channels_send_to_session(
    session_id: String,
    _content: String,
) -> Result<serde_json::Value, String> {
    if let Some((channel_type, user_id)) = session_id.split_once(':') {
        Ok(serde_json::json!({
            "status": "ok",
            "message": format!("Queued message for {}:{}", channel_type, user_id)
        }))
    } else {
        Err(format!("Invalid session_id format: {}", session_id))
    }
}

#[tauri::command]
pub async fn channels_start(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let config = state.config.read().await;
    let manager = state.channel_manager.clone();
    let tx = manager.get_sender();

    let mut started = Vec::new();

    // Start Discord if enabled
    if let Some(cfg) = config.channels.get("discord") {
        if cfg.enabled {
            let bot_token = cfg
                .extra
                .get("bot_token")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("DISCORD_BOT_TOKEN").ok());

            if let Some(token) = bot_token {
                let ch = crate::engine::channels::discord::DiscordChannel::new(token);
                ch.start(tx.clone()).await;
                started.push("discord");
            }
        }
    }

    // Start QQ Bot if enabled
    if let Some(cfg) = config.channels.get("qq") {
        if cfg.enabled {
            let app_id = cfg
                .extra
                .get("app_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("QQ_BOT_APP_ID").ok());

            let token = cfg
                .extra
                .get("token")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("QQ_BOT_TOKEN").ok());

            if let (Some(app_id), Some(token)) = (app_id, token) {
                let ch = crate::engine::channels::qq::QQChannel::new(app_id, token);
                ch.start(tx.clone()).await;
                started.push("qq");
            }
        }
    }

    // Start Telegram if enabled
    if let Some(cfg) = config.channels.get("telegram") {
        if cfg.enabled {
            let bot_token = cfg
                .extra
                .get("bot_token")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("TELEGRAM_BOT_TOKEN").ok());

            if let Some(token) = bot_token {
                let ch = crate::engine::channels::telegram::TelegramChannel::new(token);
                ch.start(tx.clone()).await;
                started.push("telegram");
            }
        }
    }

    // Start webhook server for DingTalk/Feishu/WeCom if any is enabled
    let dingtalk_enabled = config
        .channels
        .get("dingtalk")
        .map(|c| c.enabled)
        .unwrap_or(false);
    let feishu_enabled = config
        .channels
        .get("feishu")
        .map(|c| c.enabled)
        .unwrap_or(false);
    let wecom_enabled = config
        .channels
        .get("wecom")
        .map(|c| c.enabled)
        .unwrap_or(false);
    let webhook_enabled = config
        .channels
        .get("webhook")
        .map(|c| c.enabled)
        .unwrap_or(false);

    if dingtalk_enabled || feishu_enabled || wecom_enabled || webhook_enabled {
        let port = config
            .channels
            .get("webhook")
            .and_then(|c| c.extra.get("port"))
            .and_then(|v| v.as_u64())
            .unwrap_or(9090) as u16;

        let server =
            crate::engine::channels::webhook_server::WebhookServer::new(port);
        server.start(tx.clone()).await;

        if dingtalk_enabled {
            started.push("dingtalk");
        }
        if feishu_enabled {
            started.push("feishu");
        }
        if wecom_enabled {
            started.push("wecom");
        }
        if webhook_enabled {
            started.push("webhook");
        }
    }

    drop(config);

    // Register response handlers for each started channel
    register_response_handlers(&manager, &state).await;

    // Build AppState clone for the manager
    let app_state = Arc::new(AppState {
        working_dir: state.working_dir.clone(),
        secret_dir: state.secret_dir.clone(),
        config: state.config.clone(),
        providers: state.providers.clone(),
        db: state.db.clone(),
        channel_manager: state.channel_manager.clone(),
        mcp_runtime: state.mcp_runtime.clone(),
        chat_cancelled: state.chat_cancelled.clone(),
        scheduler: state.scheduler.clone(),
    });

    // Start the consumer loop
    manager.start(app_state, app_handle).await;

    Ok(serde_json::json!({
        "status": "ok",
        "channels": started
    }))
}

/// Register response handlers so the manager can send replies back
async fn register_response_handlers(manager: &ChannelManager, state: &AppState) {
    let config = state.config.read().await;

    // Discord response handler
    if let Some(cfg) = config.channels.get("discord") {
        if cfg.enabled {
            let bot_token = cfg
                .extra
                .get("bot_token")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("DISCORD_BOT_TOKEN").ok());

            if let Some(token) = bot_token {
                manager
                    .register_handler("discord", move |target, content| {
                        let token = token.clone();
                        async move {
                            // target = "discord:ch:channel_id" or "discord:dm:user_id"
                            let channel_id = target
                                .strip_prefix("discord:ch:")
                                .or_else(|| target.strip_prefix("discord:dm:"))
                                .unwrap_or(&target);
                            let client = reqwest::Client::new();
                            let url = format!(
                                "https://discord.com/api/v10/channels/{}/messages",
                                channel_id
                            );
                            let body = serde_json::json!({ "content": content });
                            client
                                .post(&url)
                                .header("Authorization", format!("Bot {}", token))
                                .header("Content-Type", "application/json")
                                .json(&body)
                                .timeout(std::time::Duration::from_secs(15))
                                .send()
                                .await
                                .map_err(|e| format!("Discord reply failed: {}", e))?;
                            Ok(())
                        }
                    })
                    .await;
            }
        }
    }

    // DingTalk response handler (webhook-based)
    if let Some(cfg) = config.channels.get("dingtalk") {
        if cfg.enabled {
            let webhook_url = cfg
                .extra
                .get("webhook_url")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if let Some(url) = webhook_url {
                manager
                    .register_handler("dingtalk", move |_target, content| {
                        let url = url.clone();
                        async move {
                            let client = reqwest::Client::new();
                            let body = serde_json::json!({
                                "msgtype": "text",
                                "text": { "content": content }
                            });
                            client
                                .post(&url)
                                .json(&body)
                                .timeout(std::time::Duration::from_secs(15))
                                .send()
                                .await
                                .map_err(|e| format!("DingTalk reply failed: {}", e))?;
                            Ok(())
                        }
                    })
                    .await;
            }
        }
    }

    // QQ response handler
    if let Some(cfg) = config.channels.get("qq") {
        if cfg.enabled {
            let app_id = cfg
                .extra
                .get("app_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("QQ_BOT_APP_ID").ok());

            let token = cfg
                .extra
                .get("token")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("QQ_BOT_TOKEN").ok());

            if let (Some(app_id), Some(token)) = (app_id, token) {
                manager
                    .register_handler("qq", move |target, content| {
                        let app_id = app_id.clone();
                        let token = token.clone();
                        async move {
                            let auth = format!("Bot {}.{}", app_id, token);
                            let client = reqwest::Client::new();

                            // target format: "qq:guild:gid:cid" or "qq:group:goid" or "qq:c2c:uid"
                            if let Some(rest) = target.strip_prefix("qq:guild:") {
                                // Extract channel_id (last segment)
                                let channel_id = rest.rsplit(':').next().unwrap_or(&target);
                                let url = format!(
                                    "https://api.sgroup.qq.com/channels/{}/messages",
                                    channel_id
                                );
                                let body = serde_json::json!({ "content": content });
                                client
                                    .post(&url)
                                    .header("Authorization", &auth)
                                    .json(&body)
                                    .timeout(std::time::Duration::from_secs(15))
                                    .send()
                                    .await
                                    .map_err(|e| format!("QQ guild reply failed: {}", e))?;
                            } else if let Some(group_openid) = target.strip_prefix("qq:group:") {
                                let url = format!(
                                    "https://api.sgroup.qq.com/v2/groups/{}/messages",
                                    group_openid
                                );
                                let body = serde_json::json!({
                                    "content": content,
                                    "msg_type": 0,
                                });
                                client
                                    .post(&url)
                                    .header("Authorization", &auth)
                                    .json(&body)
                                    .timeout(std::time::Duration::from_secs(15))
                                    .send()
                                    .await
                                    .map_err(|e| format!("QQ group reply failed: {}", e))?;
                            } else if let Some(user_openid) = target.strip_prefix("qq:c2c:") {
                                let url = format!(
                                    "https://api.sgroup.qq.com/v2/users/{}/messages",
                                    user_openid
                                );
                                let body = serde_json::json!({
                                    "content": content,
                                    "msg_type": 0,
                                });
                                client
                                    .post(&url)
                                    .header("Authorization", &auth)
                                    .json(&body)
                                    .timeout(std::time::Duration::from_secs(15))
                                    .send()
                                    .await
                                    .map_err(|e| format!("QQ c2c reply failed: {}", e))?;
                            }
                            Ok(())
                        }
                    })
                    .await;
            }
        }
    }

    // WeCom response handler (API-based)
    if let Some(cfg) = config.channels.get("wecom") {
        if cfg.enabled {
            let corp_id = cfg
                .extra
                .get("corp_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("WECOM_CORP_ID").ok());

            let corp_secret = cfg
                .extra
                .get("corp_secret")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("WECOM_CORP_SECRET").ok());

            let agent_id = cfg
                .extra
                .get("agent_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("WECOM_AGENT_ID").ok());

            if let (Some(corp_id), Some(corp_secret), Some(agent_id)) =
                (corp_id, corp_secret, agent_id)
            {
                manager
                    .register_handler("wecom", move |target, content| {
                        let corp_id = corp_id.clone();
                        let corp_secret = corp_secret.clone();
                        let agent_id = agent_id.clone();
                        async move {
                            // target = "wecom:agent_id:user_id"
                            let user_id = target
                                .rsplit(':')
                                .next()
                                .unwrap_or(&target);

                            let client = reqwest::Client::new();
                            // Get access_token
                            let token_url = format!(
                                "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={}&corpsecret={}",
                                corp_id, corp_secret
                            );
                            let token_resp = client
                                .get(&token_url)
                                .timeout(std::time::Duration::from_secs(10))
                                .send()
                                .await
                                .map_err(|e| format!("WeCom token failed: {}", e))?
                                .json::<serde_json::Value>()
                                .await
                                .map_err(|e| format!("WeCom token parse failed: {}", e))?;

                            let access_token = token_resp["access_token"]
                                .as_str()
                                .ok_or("WeCom access_token missing")?
                                .to_string();

                            let send_url = format!(
                                "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={}",
                                access_token
                            );
                            let body = serde_json::json!({
                                "touser": user_id,
                                "msgtype": "text",
                                "agentid": agent_id.parse::<i64>().unwrap_or(0),
                                "text": { "content": content },
                            });

                            client
                                .post(&send_url)
                                .json(&body)
                                .timeout(std::time::Duration::from_secs(15))
                                .send()
                                .await
                                .map_err(|e| format!("WeCom reply failed: {}", e))?;

                            Ok(())
                        }
                    })
                    .await;
            }
        }
    }

    // Telegram response handler
    if let Some(cfg) = config.channels.get("telegram") {
        if cfg.enabled {
            let bot_token = cfg
                .extra
                .get("bot_token")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("TELEGRAM_BOT_TOKEN").ok());

            if let Some(token) = bot_token {
                manager
                    .register_handler("telegram", move |target, content| {
                        let token = token.clone();
                        async move {
                            // target = "telegram:{chat_id}"
                            let chat_id = target
                                .strip_prefix("telegram:")
                                .unwrap_or(&target);
                            let ch = crate::engine::channels::telegram::TelegramChannel::new(
                                token,
                            );
                            ch.send(chat_id, &content).await
                        }
                    })
                    .await;
            }
        }
    }

    // Feishu response handler (webhook-based)
    if let Some(cfg) = config.channels.get("feishu") {
        if cfg.enabled {
            let webhook_url = cfg
                .extra
                .get("webhook_url")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if let Some(url) = webhook_url {
                manager
                    .register_handler("feishu", move |_target, content| {
                        let url = url.clone();
                        async move {
                            let client = reqwest::Client::new();
                            let body = serde_json::json!({
                                "msg_type": "text",
                                "content": { "text": content }
                            });
                            client
                                .post(&url)
                                .json(&body)
                                .timeout(std::time::Duration::from_secs(15))
                                .send()
                                .await
                                .map_err(|e| format!("Feishu reply failed: {}", e))?;
                            Ok(())
                        }
                    })
                    .await;
            }
        }
    }

}

#[tauri::command]
pub async fn channels_stop(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.channel_manager.stop().await;
    Ok(serde_json::json!({ "status": "ok" }))
}

#[tauri::command]
pub async fn channels_list_sessions() -> Result<Vec<ChannelMessage>, String> {
    Ok(Vec::new())
}
