use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

use crate::engine::bots::platform_types;
use crate::engine::db::BotRow;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotInfo {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub enabled: bool,
    pub config: serde_json::Value,
    pub persona: Option<String>,
    pub access: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<BotRow> for BotInfo {
    fn from(row: BotRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            platform: row.platform,
            enabled: row.enabled,
            config: serde_json::from_str(&row.config_json).unwrap_or(serde_json::json!({})),
            persona: row.persona,
            access: row.access_json.and_then(|s| serde_json::from_str(&s).ok()),
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[tauri::command]
pub async fn bots_list(state: State<'_, AppState>) -> Result<Vec<BotInfo>, String> {
    let rows = state.db.list_bots()?;
    Ok(rows.into_iter().map(BotInfo::from).collect())
}

#[tauri::command]
pub async fn bots_list_platforms() -> Result<Vec<serde_json::Value>, String> {
    Ok(platform_types()
        .into_iter()
        .map(|(id, name)| serde_json::json!({ "id": id, "name": name }))
        .collect())
}

#[tauri::command]
pub async fn bots_get(
    state: State<'_, AppState>,
    bot_id: String,
) -> Result<BotInfo, String> {
    let row = state.db.get_bot(&bot_id)?
        .ok_or_else(|| format!("Bot '{}' not found", bot_id))?;
    Ok(BotInfo::from(row))
}

#[tauri::command]
pub async fn bots_create(
    state: State<'_, AppState>,
    name: String,
    platform: String,
    config: serde_json::Value,
    persona: Option<String>,
    access: Option<serde_json::Value>,
) -> Result<BotInfo, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let row = BotRow {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        platform,
        enabled: true,
        config_json: serde_json::to_string(&config).unwrap_or_else(|_| "{}".into()),
        persona,
        access_json: access.map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "{}".into())),
        created_at: now,
        updated_at: now,
    };

    state.db.upsert_bot(&row)?;
    Ok(BotInfo::from(row))
}

#[tauri::command]
pub async fn bots_update(
    state: State<'_, AppState>,
    bot_id: String,
    name: Option<String>,
    enabled: Option<bool>,
    config: Option<serde_json::Value>,
    persona: Option<String>,
    access: Option<serde_json::Value>,
) -> Result<BotInfo, String> {
    let mut row = state.db.get_bot(&bot_id)?
        .ok_or_else(|| format!("Bot '{}' not found", bot_id))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    if let Some(n) = name { row.name = n; }
    if let Some(e) = enabled { row.enabled = e; }
    if let Some(c) = config {
        row.config_json = serde_json::to_string(&c).unwrap_or_else(|_| "{}".into());
    }
    // Allow setting persona to empty string (clear) or new value
    if let Some(p) = persona {
        row.persona = if p.is_empty() { None } else { Some(p) };
    }
    if let Some(a) = access {
        row.access_json = Some(serde_json::to_string(&a).unwrap_or_else(|_| "{}".into()));
    }
    row.updated_at = now;

    state.db.upsert_bot(&row)?;
    Ok(BotInfo::from(row))
}

#[tauri::command]
pub async fn bots_delete(
    state: State<'_, AppState>,
    bot_id: String,
) -> Result<(), String> {
    state.db.delete_bot(&bot_id)
}

/// Send a message through a specific bot to a target
pub async fn send_to_bot(
    db: &crate::engine::db::Database,
    bot_id: &str,
    target: &str,
    content: &str,
) -> Result<(), String> {
    let bot = db.get_bot(bot_id)?
        .ok_or_else(|| format!("Bot '{}' not found", bot_id))?;

    let config: serde_json::Value = serde_json::from_str(&bot.config_json).unwrap_or(serde_json::json!({}));

    match bot.platform.as_str() {
        "webhook" => {
            let url = config["webhook_url"]
                .as_str()
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
            let bot_token = config["bot_token"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| std::env::var("DISCORD_BOT_TOKEN").ok())
                .ok_or("No Discord bot_token configured")?;

            let client = reqwest::Client::new();
            let url = format!("https://discord.com/api/v10/channels/{}/messages", target);
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
            let webhook = config["webhook_url"]
                .as_str()
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
            let webhook = config["webhook_url"]
                .as_str()
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
            let bot_token = config["bot_token"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| std::env::var("TELEGRAM_BOT_TOKEN").ok())
                .ok_or("No Telegram bot_token configured")?;

            let ch = crate::engine::bots::telegram::TelegramBot::new(String::new(), bot_token);
            ch.send(target, content).await
        }
        "qq" => {
            let app_id = config["app_id"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| std::env::var("QQ_BOT_APP_ID").ok())
                .ok_or("No QQ app_id configured")?;

            let client_secret = config["client_secret"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| std::env::var("QQ_BOT_CLIENT_SECRET").ok())
                .ok_or("No QQ client_secret configured")?;

            let qq_bot = crate::engine::bots::qq::QQBot::new(String::new(), app_id, client_secret);

            if let Some(group_openid) = target.strip_prefix("group:") {
                qq_bot.send_group_message(group_openid, content, None).await?;
            } else if let Some(user_openid) = target.strip_prefix("c2c:") {
                qq_bot.send_c2c_message(user_openid, content, None).await?;
            } else {
                qq_bot.send_guild_message(target, content, None).await?;
            }
            Ok(())
        }
        "wecom" => {
            let corp_id = config["corp_id"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| std::env::var("WECOM_CORP_ID").ok())
                .ok_or("No WeCom corp_id configured")?;

            let corp_secret = config["corp_secret"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| std::env::var("WECOM_CORP_SECRET").ok())
                .ok_or("No WeCom corp_secret configured")?;

            let agent_id = config["agent_id"]
                .as_str()
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
        _ => Err(format!("Platform '{}' send not implemented", bot.platform)),
    }
}

#[tauri::command]
pub async fn bots_send(
    state: State<'_, AppState>,
    bot_id: String,
    target: String,
    content: String,
) -> Result<serde_json::Value, String> {
    send_to_bot(&state.db, &bot_id, &target, &content).await?;
    Ok(serde_json::json!({ "status": "ok" }))
}

/// Core bot startup logic — used by both the tauri command and auto-start on app launch.
pub async fn start_all_bots(
    state: &AppState,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let bots = state.db.list_bots()?;
    let manager = state.bot_manager.clone();
    let tx = manager.get_sender();

    let mut started = Vec::new();

    for bot in &bots {
        if !bot.enabled {
            continue;
        }

        let config: serde_json::Value = serde_json::from_str(&bot.config_json).unwrap_or(serde_json::json!({}));
        let bot_id = bot.id.clone();

        match bot.platform.as_str() {
            "discord" => {
                let bot_token = config["bot_token"]
                    .as_str()
                    .map(|s| s.to_string())
                    .or_else(|| std::env::var("DISCORD_BOT_TOKEN").ok());

                if let Some(token) = bot_token {
                    let ch = crate::engine::bots::discord::DiscordBot::new(bot_id.clone(), token.clone());
                    ch.start(tx.clone()).await;

                    // Register response handler
                    let token_c = token.clone();
                    manager.register_handler(&bot_id, move |target, content| {
                        let token = token_c.clone();
                        async move {
                            let channel_id = target
                                .strip_prefix("ch:")
                                .or_else(|| target.strip_prefix("dm:"))
                                .unwrap_or(&target);
                            let client = reqwest::Client::new();
                            let url = format!("https://discord.com/api/v10/channels/{}/messages", channel_id);
                            let body = serde_json::json!({ "content": content });
                            client.post(&url)
                                .header("Authorization", format!("Bot {}", token))
                                .header("Content-Type", "application/json")
                                .json(&body)
                                .timeout(std::time::Duration::from_secs(15))
                                .send().await
                                .map_err(|e| format!("Discord reply failed: {}", e))?;
                            Ok(())
                        }
                    }).await;

                    started.push(bot_id);
                }
            }
            "telegram" => {
                let bot_token = config["bot_token"]
                    .as_str()
                    .map(|s| s.to_string())
                    .or_else(|| std::env::var("TELEGRAM_BOT_TOKEN").ok());

                if let Some(token) = bot_token {
                    let ch = crate::engine::bots::telegram::TelegramBot::new(bot_id.clone(), token.clone());
                    ch.start(tx.clone()).await;

                    let token_c = token.clone();
                    manager.register_handler(&bot_id, move |target, content| {
                        let token = token_c.clone();
                        async move {
                            let ch = crate::engine::bots::telegram::TelegramBot::new(String::new(), token);
                            ch.send(&target, &content).await
                        }
                    }).await;

                    started.push(bot_id);
                }
            }
            "qq" => {
                let app_id = config["app_id"]
                    .as_str()
                    .map(|s| s.to_string())
                    .or_else(|| std::env::var("QQ_BOT_APP_ID").ok());
                let client_secret = config["client_secret"]
                    .as_str()
                    .map(|s| s.to_string())
                    .or_else(|| std::env::var("QQ_BOT_CLIENT_SECRET").ok());

                if let (Some(app_id), Some(client_secret)) = (app_id, client_secret) {
                    let ch = crate::engine::bots::qq::QQBot::new(bot_id.clone(), app_id.clone(), client_secret.clone());
                    ch.start(tx.clone()).await;

                    let app_id_c = app_id.clone();
                    let secret_c = client_secret.clone();
                    manager.register_handler(&bot_id, move |target, content| {
                        let app_id = app_id_c.clone();
                        let secret = secret_c.clone();
                        async move {
                            let qq_bot = crate::engine::bots::qq::QQBot::new(String::new(), app_id, secret);

                            // Extract msg_id from target (format: "prefix:id#msg_id=xxx")
                            let (conv_target, msg_id) = if let Some(idx) = target.find("#msg_id=") {
                                (&target[..idx], Some(target[idx + 8..].to_string()))
                            } else {
                                (target.as_str(), None)
                            };

                            if let Some(rest) = conv_target.strip_prefix("guild:") {
                                let channel_id = rest.rsplit(':').next().unwrap_or(conv_target);
                                qq_bot.send_guild_message(channel_id, &content, msg_id.as_deref()).await?;
                            } else if let Some(group_openid) = conv_target.strip_prefix("group:") {
                                qq_bot.send_group_message(group_openid, &content, msg_id.as_deref()).await?;
                            } else if let Some(user_openid) = conv_target.strip_prefix("c2c:") {
                                qq_bot.send_c2c_message(user_openid, &content, msg_id.as_deref()).await?;
                            }
                            Ok(())
                        }
                    }).await;

                    started.push(bot_id);
                }
            }
            // Webhook-based platforms (dingtalk, feishu, wecom, webhook)
            "dingtalk" | "feishu" | "wecom" | "webhook" => {
                // Webhook bots are handled via shared webhook server
                // We'll start the webhook server once for all webhook-based bots
                started.push(bot_id);
            }
            _ => {
                log::warn!("Unknown platform type: {}", bot.platform);
            }
        }
    }

    // Start webhook server if any webhook-based bots are enabled
    let webhook_bots: Vec<&BotRow> = bots.iter()
        .filter(|b| b.enabled && matches!(b.platform.as_str(), "dingtalk" | "feishu" | "wecom" | "webhook"))
        .collect();

    if !webhook_bots.is_empty() {
        let mut bot_ids_map = HashMap::new();
        for bot in &webhook_bots {
            bot_ids_map.insert(bot.platform.clone(), bot.id.clone());
        }

        // Find port from any webhook bot config
        let port = webhook_bots.iter()
            .find(|b| b.platform == "webhook")
            .and_then(|b| serde_json::from_str::<serde_json::Value>(&b.config_json).ok())
            .and_then(|c| c["port"].as_u64())
            .unwrap_or(9090) as u16;

        let server = crate::engine::bots::webhook_server::WebhookServer::new(port);
        server.start(tx.clone(), bot_ids_map).await;

        // Register response handlers for webhook-based bots
        for bot in &webhook_bots {
            let bot_config: serde_json::Value = serde_json::from_str(&bot.config_json).unwrap_or(serde_json::json!({}));
            let bid = bot.id.clone();

            match bot.platform.as_str() {
                "dingtalk" => {
                    if let Some(url) = bot_config["webhook_url"].as_str().map(|s| s.to_string()) {
                        manager.register_handler(&bid, move |_target, content| {
                            let url = url.clone();
                            async move {
                                let client = reqwest::Client::new();
                                let body = serde_json::json!({ "msgtype": "text", "text": { "content": content } });
                                client.post(&url).json(&body).timeout(std::time::Duration::from_secs(15))
                                    .send().await.map_err(|e| format!("DingTalk reply failed: {}", e))?;
                                Ok(())
                            }
                        }).await;
                    }
                }
                "feishu" => {
                    if let Some(url) = bot_config["webhook_url"].as_str().map(|s| s.to_string()) {
                        manager.register_handler(&bid, move |_target, content| {
                            let url = url.clone();
                            async move {
                                let client = reqwest::Client::new();
                                let body = serde_json::json!({ "msg_type": "text", "content": { "text": content } });
                                client.post(&url).json(&body).timeout(std::time::Duration::from_secs(15))
                                    .send().await.map_err(|e| format!("Feishu reply failed: {}", e))?;
                                Ok(())
                            }
                        }).await;
                    }
                }
                "wecom" => {
                    let corp_id = bot_config["corp_id"].as_str().map(|s| s.to_string())
                        .or_else(|| std::env::var("WECOM_CORP_ID").ok());
                    let corp_secret = bot_config["corp_secret"].as_str().map(|s| s.to_string())
                        .or_else(|| std::env::var("WECOM_CORP_SECRET").ok());
                    let agent_id = bot_config["agent_id"].as_str().map(|s| s.to_string())
                        .or_else(|| std::env::var("WECOM_AGENT_ID").ok());

                    if let (Some(cid), Some(cs), Some(aid)) = (corp_id, corp_secret, agent_id) {
                        manager.register_handler(&bid, move |target, content| {
                            let cid = cid.clone();
                            let cs = cs.clone();
                            let aid = aid.clone();
                            async move {
                                let user_id = target.rsplit(':').next().unwrap_or(&target);
                                let client = reqwest::Client::new();
                                let token_url = format!("https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={}&corpsecret={}", cid, cs);
                                let token_resp = client.get(&token_url).timeout(std::time::Duration::from_secs(10))
                                    .send().await.map_err(|e| format!("WeCom token failed: {}", e))?
                                    .json::<serde_json::Value>().await.map_err(|e| format!("WeCom token parse failed: {}", e))?;
                                let access_token = token_resp["access_token"].as_str().ok_or("WeCom access_token missing")?.to_string();
                                let send_url = format!("https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={}", access_token);
                                let body = serde_json::json!({
                                    "touser": user_id, "msgtype": "text",
                                    "agentid": aid.parse::<i64>().unwrap_or(0),
                                    "text": { "content": content },
                                });
                                client.post(&send_url).json(&body).timeout(std::time::Duration::from_secs(15))
                                    .send().await.map_err(|e| format!("WeCom reply failed: {}", e))?;
                                Ok(())
                            }
                        }).await;
                    }
                }
                _ => {}
            }
        }
    }

    // Build AppState clone for the manager
    let app_state = Arc::new(AppState {
        working_dir: state.working_dir.clone(),
        user_workspace: std::sync::RwLock::new(state.user_workspace()),
        secret_dir: state.secret_dir.clone(),
        config: state.config.clone(),
        providers: state.providers.clone(),
        db: state.db.clone(),
        bot_manager: state.bot_manager.clone(),
        mcp_runtime: state.mcp_runtime.clone(),
        chat_cancelled: state.chat_cancelled.clone(),
        scheduler: state.scheduler.clone(),
    });

    // Start the consumer loop
    manager.start(app_state, app_handle).await;

    log::info!("Bots started: {:?}", started);

    Ok(serde_json::json!({
        "status": "ok",
        "bots": started
    }))
}

#[tauri::command]
pub async fn bots_start(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    start_all_bots(&state, app_handle).await
}

#[tauri::command]
pub async fn bots_stop(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.bot_manager.stop().await;
    Ok(serde_json::json!({ "status": "ok" }))
}

#[tauri::command]
pub async fn bots_list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<crate::engine::db::ChatSession>, String> {
    state.db.list_sessions_by_source("bot")
}

// === Session-Bot Binding Commands ===

#[tauri::command]
pub async fn session_bind_bot(
    state: State<'_, AppState>,
    session_id: String,
    bot_id: String,
) -> Result<Option<String>, String> {
    // Verify bot exists
    state.db.get_bot(&bot_id)?
        .ok_or_else(|| format!("Bot '{}' not found", bot_id))?;
    // Returns previous session_id if the bot was moved from another session
    state.db.bind_bot_to_session(&session_id, &bot_id)
}

#[tauri::command]
pub async fn session_unbind_bot(
    state: State<'_, AppState>,
    session_id: String,
    bot_id: String,
) -> Result<(), String> {
    state.db.unbind_bot_from_session(&session_id, &bot_id)
}

#[tauri::command]
pub async fn session_list_bots(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<BotInfo>, String> {
    let rows = state.db.list_session_bots(&session_id)?;
    Ok(rows.into_iter().map(BotInfo::from).collect())
}
