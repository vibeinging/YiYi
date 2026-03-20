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

            let client = crate::engine::bots::http_client();
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

            let client = crate::engine::bots::http_client();
            let url = format!("https://discord.com/api/v10/channels/{}/messages", target);
            // Discord natively supports Markdown; split on paragraph boundaries
            let chunks = crate::engine::bots::formatter::format_discord(content);
            for chunk in chunks {
                let body = serde_json::json!({ "content": chunk });
                client
                    .post(&url)
                    .header("Authorization", format!("Bot {}", bot_token))
                    .header("Content-Type", "application/json")
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(15))
                    .send()
                    .await
                    .map_err(|e| format!("Discord send failed: {}", e))?;
            }
            Ok(())
        }
        "dingtalk" => {
            // 优先使用 OpenAPI 发送（如果有 client_id/client_secret）
            // 否则降级到 webhook
            let webhook = config["webhook_url"]
                .as_str()
                .map(|s| s.to_string());

            if let Some(url) = webhook {
                let client = crate::engine::bots::http_client();
                // Use markdown format since agent output is typically markdown
                let (title, text) = crate::engine::bots::formatter::format_dingtalk(content);
                let body = serde_json::json!({
                    "msgtype": "markdown",
                    "markdown": { "title": title, "text": text }
                });
                client
                    .post(&url)
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(15))
                    .send()
                    .await
                    .map_err(|e| format!("DingTalk send failed: {}", e))?;
                Ok(())
            } else {
                Err("No DingTalk webhook_url configured. In Stream mode, replies are sent via sessionWebhook automatically.".to_string())
            }
        }
        "feishu" => {
            // 优先使用 IM API 发送
            let app_id = config["app_id"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| std::env::var("FEISHU_APP_ID").ok());
            let app_secret = config["app_secret"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| std::env::var("FEISHU_APP_SECRET").ok());

            if let (Some(aid), Some(asec)) = (app_id, app_secret) {
                // 判断 target 类型
                let (receive_id, id_type) = if target.starts_with("group:") {
                    (target.strip_prefix("group:").unwrap_or(target), "chat_id")
                } else if target.starts_with("dm:") {
                    (target.strip_prefix("dm:").unwrap_or(target), "open_id")
                } else {
                    (target, "chat_id")
                };
                crate::engine::bots::feishu::FeishuBot::send_message(
                    &aid, &asec, receive_id, id_type, content,
                ).await
            } else {
                // 降级到 webhook
                let webhook = config["webhook_url"]
                    .as_str()
                    .ok_or("No Feishu app_id/app_secret or webhook_url configured")?;
                let client = crate::engine::bots::http_client();
                let body = serde_json::json!({
                    "msg_type": "text",
                    "content": { "text": content }
                });
                client
                    .post(webhook)
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(15))
                    .send()
                    .await
                    .map_err(|e| format!("Feishu send failed: {}", e))?;
                Ok(())
            }
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

            // Extract user_id from conversation format "agent_id:user_id"
            let user_id = target.rsplit(':').next().unwrap_or(&target);
            crate::engine::bots::wecom::send_message(
                &corp_id, &corp_secret, &agent_id, user_id, content,
            ).await
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

/// Start a single bot by its DB row. Returns the bot_id if successfully started,
/// or None if credentials are missing / platform is webhook-only.
/// The `stream_started` set tracks which bots were started in Stream/WS mode
/// (used to distinguish from webhook fallback).
async fn start_one_bot_inner(
    bot: &BotRow,
    manager: &Arc<crate::engine::bots::manager::BotManager>,
    tx: &tokio::sync::mpsc::Sender<crate::engine::bots::IncomingMessage>,
) -> Result<Option<String>, String> {
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
                let running_flag = ch.running_flag();
                ch.start(tx.clone()).await;

                // Register response handler — Discord natively supports Markdown;
                // use smart paragraph-boundary splitting for the 2000-char limit.
                let token_c = token.clone();
                manager.register_handler(&bot_id, move |target, content| {
                    let token = token_c.clone();
                    async move {
                        let channel_id = target
                            .strip_prefix("ch:")
                            .or_else(|| target.strip_prefix("dm:"))
                            .unwrap_or(&target);
                        let client = crate::engine::bots::http_client();
                        let url = format!("https://discord.com/api/v10/channels/{}/messages", channel_id);
                        let chunks = crate::engine::bots::formatter::format_discord(&content.text);
                        for chunk in chunks {
                            let body = serde_json::json!({ "content": chunk });
                            client.post(&url)
                                .header("Authorization", format!("Bot {}", token))
                                .header("Content-Type", "application/json")
                                .json(&body)
                                .timeout(std::time::Duration::from_secs(15))
                                .send().await
                                .map_err(|e| format!("Discord reply failed: {}", e))?;
                        }
                        Ok(())
                    }
                }).await;

                // Track running bot
                manager.register_running_bot(crate::engine::bots::manager::RunningBot {
                    bot_id: bot_id.clone(),
                    running_flag,
                }).await;

                Ok(Some(bot_id))
            } else {
                Ok(None)
            }
        }
        "telegram" => {
            let bot_token = config["bot_token"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| std::env::var("TELEGRAM_BOT_TOKEN").ok());

            if let Some(token) = bot_token {
                let ch = crate::engine::bots::telegram::TelegramBot::new(bot_id.clone(), token.clone());
                let running_flag = ch.running_flag();
                ch.start(tx.clone()).await;

                let token_c = token.clone();
                manager.register_handler(&bot_id, move |target, content| {
                    let token = token_c.clone();
                    async move {
                        let ch = crate::engine::bots::telegram::TelegramBot::new(String::new(), token);
                        ch.send(&target, &content.text).await
                    }
                }).await;

                manager.register_running_bot(crate::engine::bots::manager::RunningBot {
                    bot_id: bot_id.clone(),
                    running_flag,
                }).await;

                Ok(Some(bot_id))
            } else {
                Ok(None)
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
                let running_flag = ch.running_flag();
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

                        // Send text message first (if non-empty)
                        if !content.text.trim().is_empty() {
                            if let Some(rest) = conv_target.strip_prefix("guild:") {
                                let channel_id = rest.rsplit(':').next().unwrap_or(conv_target);
                                qq_bot.send_guild_message(channel_id, &content.text, msg_id.as_deref()).await?;
                            } else if let Some(group_openid) = conv_target.strip_prefix("group:") {
                                qq_bot.send_group_message(group_openid, &content.text, msg_id.as_deref()).await?;
                            } else if let Some(user_openid) = conv_target.strip_prefix("c2c:") {
                                qq_bot.send_c2c_message(user_openid, &content.text, msg_id.as_deref()).await?;
                            }
                        }

                        // Send media attachments
                        for attachment in &content.media {
                            let file_type: u8 = match attachment.media_type {
                                crate::engine::bots::MediaType::Image => 1,
                                crate::engine::bots::MediaType::Video => 2,
                                crate::engine::bots::MediaType::Audio => 3,
                                crate::engine::bots::MediaType::File => 4,
                            };

                            // For local files, we need a publicly accessible URL.
                            // If the path is a URL, use it directly; otherwise log a warning.
                            let media_url = if attachment.path.starts_with("http") {
                                attachment.path.clone()
                            } else {
                                // Local file — QQ API requires a URL, not local path.
                                // Try to use file:// or skip with warning.
                                log::warn!(
                                    "QQ media send: local file '{}' cannot be sent directly (QQ API requires URL). Skipping.",
                                    attachment.path
                                );
                                continue;
                            };

                            let result = if let Some(rest) = conv_target.strip_prefix("guild:") {
                                let channel_id = rest.rsplit(':').next().unwrap_or(conv_target);
                                if file_type == 1 {
                                    qq_bot.send_guild_image(channel_id, &media_url, msg_id.as_deref()).await
                                } else {
                                    // Guild API has limited rich media support
                                    log::warn!("QQ guild: non-image media not supported yet, skipping");
                                    Ok(())
                                }
                            } else if let Some(group_openid) = conv_target.strip_prefix("group:") {
                                qq_bot.send_group_media(group_openid, file_type, &media_url, msg_id.as_deref()).await
                            } else if let Some(user_openid) = conv_target.strip_prefix("c2c:") {
                                qq_bot.send_c2c_media(user_openid, file_type, &media_url, msg_id.as_deref()).await
                            } else {
                                Ok(())
                            };

                            if let Err(e) = result {
                                log::error!("QQ media send failed: {}", e);
                            }
                        }

                        Ok(())
                    }
                }).await;

                manager.register_running_bot(crate::engine::bots::manager::RunningBot {
                    bot_id: bot_id.clone(),
                    running_flag,
                }).await;

                Ok(Some(bot_id))
            } else {
                Ok(None)
            }
        }
        "dingtalk" => {
            // 优先使用 Stream 模式（client_id + client_secret）
            let client_id = config["client_id"]
                .as_str()
                .or_else(|| config["app_key"].as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("DINGTALK_CLIENT_ID").ok());
            let client_secret = config["client_secret"]
                .as_str()
                .or_else(|| config["app_secret"].as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("DINGTALK_CLIENT_SECRET").ok());

            if let (Some(cid), Some(cs)) = (client_id, client_secret) {
                let dt_bot = crate::engine::bots::dingtalk::DingTalkBot::new(
                    bot_id.clone(), cid, cs,
                );
                let session_webhooks = dt_bot.session_webhooks();
                let running_flag = dt_bot.running_flag();
                dt_bot.start(tx.clone()).await;

                // 注册 response handler：通过 sessionWebhook 或 meta 中的 webhook 回复
                let webhooks = session_webhooks.clone();
                manager.register_handler(&bot_id, move |target, content| {
                    let webhooks = webhooks.clone();
                    async move {
                        let raw_conv_id = target
                            .strip_prefix("group:")
                            .or_else(|| target.strip_prefix("dm:"))
                            .unwrap_or(&target);

                        let webhook_url = {
                            let whs = webhooks.read().await;
                            whs.get(raw_conv_id).map(|e| e.url.clone())
                        };

                        if let Some(url) = webhook_url {
                            crate::engine::bots::dingtalk::DingTalkBot::send_via_webhook(
                                &url, &content.text,
                            ).await
                        } else {
                            Err(format!(
                                "DingTalk: no sessionWebhook found for conversation '{}'",
                                target
                            ))
                        }
                    }
                }).await;

                manager.register_running_bot(crate::engine::bots::manager::RunningBot {
                    bot_id: bot_id.clone(),
                    running_flag,
                }).await;

                log::info!("DingTalk bot started in Stream mode");
                Ok(Some(bot_id))
            } else {
                // 降级到 Webhook 模式 — not tracked as a running bot
                log::info!("DingTalk bot: no client_id/client_secret, falling back to webhook mode");
                Ok(None)
            }
        }
        "feishu" => {
            // 优先使用 WebSocket 长连接模式
            let app_id = config["app_id"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| std::env::var("FEISHU_APP_ID").ok());
            let app_secret = config["app_secret"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| std::env::var("FEISHU_APP_SECRET").ok());

            if let (Some(aid), Some(asec)) = (app_id, app_secret) {
                let fs_bot = crate::engine::bots::feishu::FeishuBot::new(
                    bot_id.clone(), aid.clone(), asec.clone(),
                );
                let running_flag = fs_bot.running_flag();
                fs_bot.start(tx.clone()).await;

                // 注册 response handler：通过飞书 IM API 发送消息
                let aid_c = aid.clone();
                let asec_c = asec.clone();
                manager.register_handler(&bot_id, move |target, content| {
                    let aid = aid_c.clone();
                    let asec = asec_c.clone();
                    async move {
                        if let Some(chat_id) = target.strip_prefix("group:") {
                            crate::engine::bots::feishu::FeishuBot::send_message(
                                &aid, &asec, chat_id, "chat_id", &content.text,
                            ).await
                        } else if let Some(open_id) = target.strip_prefix("dm:") {
                            crate::engine::bots::feishu::FeishuBot::send_message(
                                &aid, &asec, open_id, "open_id", &content.text,
                            ).await
                        } else {
                            crate::engine::bots::feishu::FeishuBot::send_message(
                                &aid, &asec, &target, "chat_id", &content.text,
                            ).await
                        }
                    }
                }).await;

                manager.register_running_bot(crate::engine::bots::manager::RunningBot {
                    bot_id: bot_id.clone(),
                    running_flag,
                }).await;

                log::info!("Feishu bot started in WebSocket mode");
                Ok(Some(bot_id))
            } else {
                // 降级到 Webhook 模式
                log::info!("Feishu bot: no app_id/app_secret, falling back to webhook mode");
                Ok(None)
            }
        }
        // Webhook-based platforms don't have long-running connections to track
        "wecom" | "webhook" => {
            Ok(None)
        }
        _ => {
            log::warn!("Unknown platform type: {}", bot.platform);
            Ok(None)
        }
    }
}

/// Start a single bot by its ID. Loads config from DB, starts the bot,
/// registers its handler, and tracks it in the manager.
/// Also ensures the consumer loop is running.
pub async fn start_one_bot(
    state: &AppState,
    bot_id: &str,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let manager = state.bot_manager.clone();

    // Check if already running
    if manager.is_bot_running(bot_id).await {
        return Err(format!("Bot '{}' is already running", bot_id));
    }

    let bot = state.db.get_bot(bot_id)?
        .ok_or_else(|| format!("Bot '{}' not found", bot_id))?;

    if !bot.enabled {
        return Err(format!("Bot '{}' is not enabled", bot_id));
    }

    let tx = manager.get_sender();
    let result = start_one_bot_inner(&bot, &manager, &tx).await?;

    // Ensure the consumer loop is running
    if !manager.is_running().await {
        let app_state = Arc::new(state.clone_shared());
        manager.start(app_state, app_handle).await;
    }

    match result {
        Some(id) => {
            log::info!("Bot '{}' started successfully", id);
            Ok(serde_json::json!({ "status": "ok", "bot_id": id }))
        }
        None => {
            Err(format!("Bot '{}' could not be started (missing credentials or webhook-only platform)", bot_id))
        }
    }
}

/// Stop a single bot by its ID. Signals it to stop, unregisters its handler,
/// and removes it from the running bots tracker.
pub async fn stop_one_bot(
    state: &AppState,
    bot_id: &str,
) -> Result<serde_json::Value, String> {
    let manager = state.bot_manager.clone();

    if !manager.is_bot_running(bot_id).await {
        return Err(format!("Bot '{}' is not running", bot_id));
    }

    // Stop the bot (sets running flag to false)
    let found = manager.unregister_running_bot(bot_id).await;
    if !found {
        return Err(format!("Bot '{}' not found in running bots", bot_id));
    }

    // Unregister its response handler
    manager.unregister_handler(bot_id).await;

    log::info!("Bot '{}' stopped successfully", bot_id);
    Ok(serde_json::json!({ "status": "ok", "bot_id": bot_id }))
}

/// Core bot startup logic — used by both the tauri command and auto-start on app launch.
/// Starts all enabled bots by calling `start_one_bot_inner` for each.
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

        // Skip bots that are already running
        if manager.is_bot_running(&bot.id).await {
            started.push(bot.id.clone());
            continue;
        }

        match start_one_bot_inner(bot, &manager, &tx).await {
            Ok(Some(id)) => started.push(id),
            Ok(None) => {
                // Webhook-only or missing credentials — still count as "started" for webhook platforms
                match bot.platform.as_str() {
                    "wecom" | "webhook" => started.push(bot.id.clone()),
                    "dingtalk" | "feishu" => started.push(bot.id.clone()), // webhook fallback
                    _ => {}
                }
            }
            Err(e) => {
                log::error!("Failed to start bot '{}': {}", bot.id, e);
            }
        }
    }

    // Start webhook server if any webhook-based bots are enabled
    let running_ids = manager.list_running_bot_ids().await;
    let webhook_bots: Vec<&BotRow> = bots.iter()
        .filter(|b| {
            if !b.enabled { return false; }
            match b.platform.as_str() {
                "wecom" | "webhook" => true,
                "dingtalk" | "feishu" => !running_ids.contains(&b.id),
                _ => false,
            }
        })
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
        manager.set_webhook_server(server).await;

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
                                let client = crate::engine::bots::http_client();
                                // Use markdown format since agent output is typically markdown
                                let (title, text) = crate::engine::bots::formatter::format_dingtalk(&content.text);
                                let body = serde_json::json!({
                                    "msgtype": "markdown",
                                    "markdown": { "title": title, "text": text }
                                });
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
                                let client = crate::engine::bots::http_client();
                                let body = serde_json::json!({ "msg_type": "text", "content": { "text": content.text } });
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
                                crate::engine::bots::wecom::send_message(
                                    &cid, &cs, &aid, user_id, &content.text,
                                ).await
                            }
                        }).await;
                    }
                }
                _ => {}
            }
        }
    }

    // Build AppState clone for the manager
    let app_state = Arc::new(state.clone_shared());

    // Start the consumer loop
    manager.start(app_state, app_handle.clone()).await;

    // Spawn a background task that periodically emits bot status events to the frontend.
    // This ensures the frontend stays in sync even if it missed an event.
    {
        let ah = app_handle.clone();
        let manager_ref = state.bot_manager.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                if !manager_ref.is_running().await {
                    break;
                }
                let statuses = crate::engine::bots::get_all_bot_statuses();
                for status in &statuses {
                    use tauri::Emitter;
                    ah.emit("bot://status", status).ok();
                }
            }
        });
    }

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
pub async fn bots_start_one(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    bot_id: String,
) -> Result<serde_json::Value, String> {
    start_one_bot(&state, &bot_id, app_handle).await
}

#[tauri::command]
pub async fn bots_stop_one(
    state: State<'_, AppState>,
    bot_id: String,
) -> Result<serde_json::Value, String> {
    stop_one_bot(&state, &bot_id).await
}

#[tauri::command]
pub async fn bots_running_list(
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    Ok(state.bot_manager.list_running_bot_ids().await)
}

#[tauri::command]
pub async fn bots_list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<crate::engine::db::ChatSession>, String> {
    state.db.list_sessions_by_source("bot")
}

// === Test Connection Command ===

#[tauri::command]
pub async fn bots_test_connection(
    platform: String,
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let result = match platform.as_str() {
        "discord" => {
            let token = config["bot_token"]
                .as_str()
                .ok_or("Missing bot_token in config")?;
            crate::engine::bots::discord::test_connection(token).await
        }
        "telegram" => {
            let token = config["bot_token"]
                .as_str()
                .ok_or("Missing bot_token in config")?;
            crate::engine::bots::telegram::test_connection(token).await
        }
        "qq" => {
            let app_id = config["app_id"]
                .as_str()
                .ok_or("Missing app_id in config")?;
            let client_secret = config["client_secret"]
                .as_str()
                .ok_or("Missing client_secret in config")?;
            crate::engine::bots::qq::test_connection(app_id, client_secret).await
        }
        "dingtalk" => {
            let client_id = config["client_id"]
                .as_str()
                .or_else(|| config["app_key"].as_str())
                .ok_or("Missing client_id in config")?;
            let client_secret = config["client_secret"]
                .as_str()
                .or_else(|| config["app_secret"].as_str())
                .ok_or("Missing client_secret in config")?;
            crate::engine::bots::dingtalk::test_connection(client_id, client_secret).await
        }
        "feishu" => {
            let app_id = config["app_id"]
                .as_str()
                .ok_or("Missing app_id in config")?;
            let app_secret = config["app_secret"]
                .as_str()
                .ok_or("Missing app_secret in config")?;
            crate::engine::bots::feishu::test_connection(app_id, app_secret).await
        }
        "wecom" => {
            let corp_id = config["corp_id"]
                .as_str()
                .ok_or("Missing corp_id in config")?;
            let corp_secret = config["corp_secret"]
                .as_str()
                .ok_or("Missing corp_secret in config")?;
            crate::engine::bots::wecom::test_connection(corp_id, corp_secret).await
        }
        _ => {
            return Ok(serde_json::json!({
                "success": false,
                "message": format!("Platform '{}' does not support connection testing", platform)
            }));
        }
    };

    match result {
        Ok(msg) => Ok(serde_json::json!({ "success": true, "message": msg })),
        Err(e) => Ok(serde_json::json!({ "success": false, "message": e })),
    }
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

// === Bot Status Commands ===

#[tauri::command]
pub async fn bots_get_status() -> Result<Vec<crate::engine::bots::BotStatus>, String> {
    Ok(crate::engine::bots::get_all_bot_statuses())
}
