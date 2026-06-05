//! 微信个人号 Bot —— 腾讯官方 iLink 协议(2026 开放,非 hook、无封号风险)。
//! 模式同 Telegram:扫码登录 → long-polling getupdates 收 → sendmessage 发。无需公网 IP。
//!
//! 关键约束:发消息**必带 context_token**(从收到的消息里取),所以 bot 不能凭空主动推 ——
//! 用户得先开口,YiYi 才能回。定时陪伴 / cronjob 通知推不进微信(留在桌面端)。
//! 见 docs/research/2026-06-04_微信-ilink-接入调研.md。

use super::{now_ts, update_bot_status, BotConnectionState, IncomingMessage};
use base64::Engine;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

pub const DEFAULT_BASE_URL: &str = "https://ilinkai.weixin.qq.com";

pub struct WeixinBot {
    bot_id: String,
    bot_token: String,
    base_url: String,
    running: Arc<RwLock<bool>>,
    /// user_id → 最新 context_token。收消息时更新,回复时查(sendmessage 必带)。
    context_tokens: Arc<RwLock<HashMap<String, String>>>,
}

#[allow(dead_code)]
impl WeixinBot {
    pub fn new(bot_id: String, bot_token: String, base_url: Option<String>) -> Self {
        Self {
            bot_id,
            bot_token,
            base_url: base_url
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
            running: Arc::new(RwLock::new(false)),
            context_tokens: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn running_flag(&self) -> Arc<RwLock<bool>> {
        self.running.clone()
    }

    /// 给 response handler 用:发消息时按 user_id 查 context_token。
    pub fn context_tokens(&self) -> Arc<RwLock<HashMap<String, String>>> {
        self.context_tokens.clone()
    }

    pub fn base_url(&self) -> String {
        self.base_url.clone()
    }

    pub async fn start(&self, tx: mpsc::Sender<IncomingMessage>) {
        let bot_id = self.bot_id.clone();
        let token = self.bot_token.clone();
        let base = self.base_url.clone();
        let running = self.running.clone();
        let ctx_map = self.context_tokens.clone();
        {
            *running.write().await = true;
        }

        tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .unwrap_or_default();
            update_bot_status(&bot_id, BotConnectionState::Connecting, Some("连接 iLink…".into()));

            let mut cursor = String::new(); // get_updates_buf 游标,每次必须更新否则重复收
            let mut connected = false;

            loop {
                {
                    if !*running.read().await {
                        break;
                    }
                }

                let body = serde_json::json!({
                    "get_updates_buf": cursor,
                    "base_info": { "channel_version": "1.0.2" }
                });

                let resp = client
                    .post(format!("{}/ilink/bot/getupdates", base))
                    .header("Authorization", format!("Bearer {}", token))
                    .header("AuthorizationType", "ilink_bot_token")
                    .header("X-WECHAT-UIN", wechat_uin())
                    .json(&body)
                    .send()
                    .await;

                match resp {
                    Ok(r) => {
                        let json = match r.json::<serde_json::Value>().await {
                            Ok(j) => j,
                            Err(e) => {
                                log::warn!("weixin getupdates parse: {e}");
                                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                                continue;
                            }
                        };
                        let ret = json["ret"].as_i64().unwrap_or(-1);
                        if ret == -14 {
                            // 登录 / 会话过期 → 必须重新扫码
                            log::error!("weixin iLink 登录过期(-14),需重新扫码");
                            update_bot_status(
                                &bot_id,
                                BotConnectionState::Error,
                                Some("登录过期,请重新扫码".into()),
                            );
                            break;
                        }
                        if ret != 0 {
                            log::warn!("weixin getupdates ret={ret}: {json}");
                            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                            continue;
                        }
                        if !connected {
                            connected = true;
                            update_bot_status(
                                &bot_id,
                                BotConnectionState::Connected,
                                Some("微信已连接".into()),
                            );
                            log::info!("weixin iLink connected");
                        }
                        if let Some(c) = json["get_updates_buf"].as_str() {
                            cursor = c.to_string();
                        }
                        if let Some(msgs) = json["msgs"].as_array() {
                            for msg in msgs {
                                process_weixin_message(msg, &bot_id, &ctx_map, &tx).await;
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("weixin poll: {e}");
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                }
            }

            update_bot_status(&bot_id, BotConnectionState::Disconnected, Some("Stopped".into()));
            log::info!("weixin polling stopped");
        });
    }

    pub async fn stop(&self) {
        *self.running.write().await = false;
    }

    /// 回复某用户。context_token 从映射取(回复必带);取不到 = 对方还没开口,无法回。
    pub async fn send(&self, to_user_id: &str, text: &str) -> Result<(), String> {
        let ctx = {
            let m = self.context_tokens.read().await;
            m.get(to_user_id).cloned()
        };
        let context_token = ctx.ok_or_else(|| {
            format!("weixin: 没有用户 {to_user_id} 的 context_token(需对方先发一条消息)")
        })?;
        send_message(&self.base_url, &self.bot_token, to_user_id, &context_token, text).await
    }
}

/// 静态发消息(给 response handler 复用,不持有 WeixinBot 实例)。
pub async fn send_message(
    base_url: &str,
    bot_token: &str,
    to_user_id: &str,
    context_token: &str,
    text: &str,
) -> Result<(), String> {
    let client = super::http_client();
    let body = serde_json::json!({
        "msg": {
            "to_user_id": to_user_id,
            "message_type": 2,
            "message_state": 2,
            "context_token": context_token,
            "item_list": [{ "type": 1, "text_item": { "text": text } }]
        }
    });
    let resp = client
        .post(format!("{}/ilink/bot/sendmessage", base_url))
        .header("Authorization", format!("Bearer {}", bot_token))
        .header("AuthorizationType", "ilink_bot_token")
        .header("X-WECHAT-UIN", wechat_uin())
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("weixin send failed: {e}"))?;
    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("weixin send parse: {e}"))?;
    let ret = json["ret"].as_i64().unwrap_or(-1);
    if ret != 0 {
        return Err(format!("weixin send ret={ret}: {json}"));
    }
    Ok(())
}

/// 扫码登录①:拿二维码。返回 `(qrcode 标识用于轮询, 二维码图内容)`。
pub async fn get_login_qrcode(base_url: &str) -> Result<(String, String), String> {
    let client = super::http_client();
    let base = if base_url.is_empty() { DEFAULT_BASE_URL } else { base_url };
    let resp = client
        .get(format!("{}/ilink/bot/get_bot_qrcode?bot_type=3", base))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("weixin 取二维码失败: {e}"))?;
    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("weixin 二维码解析失败: {e}"))?;
    let qrcode = json["qrcode"].as_str().unwrap_or_default().to_string();
    let img = json["qrcode_img_content"].as_str().unwrap_or_default().to_string();
    if qrcode.is_empty() {
        return Err(format!("weixin 二维码响应缺 qrcode: {json}"));
    }
    Ok((qrcode, img))
}

/// 扫码登录②:轮询状态。`confirmed` 时返回 `Some((bot_token, baseurl))`,否则 `None`(待扫)。
pub async fn poll_login_status(
    base_url: &str,
    qrcode: &str,
) -> Result<Option<(String, String)>, String> {
    let client = super::http_client();
    let base = if base_url.is_empty() { DEFAULT_BASE_URL } else { base_url };
    let resp = client
        .get(format!("{}/ilink/bot/get_qrcode_status?qrcode={}", base, qrcode))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("weixin 轮询状态失败: {e}"))?;
    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("weixin 状态解析失败: {e}"))?;
    if json["status"].as_str() == Some("confirmed") {
        let token = json["bot_token"].as_str().unwrap_or_default().to_string();
        let url = json["baseurl"].as_str().unwrap_or(base).to_string();
        if token.is_empty() {
            return Err(format!("weixin 已确认但缺 bot_token: {json}"));
        }
        Ok(Some((token, url)))
    } else {
        Ok(None)
    }
}

/// `X-WECHAT-UIN`:base64(随机 u32 的字符串),每次随机防重放。无 rand 依赖,用时钟纳秒散一下。
fn wechat_uin() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let v = (nanos as u64).wrapping_mul(2654435761) as u32;
    base64::engine::general_purpose::STANDARD.encode(v.to_string())
}

/// iLink 入站消息 → IncomingMessage,顺手把 context_token 存进映射。先只处理文本,媒体第二步。
async fn process_weixin_message(
    msg: &serde_json::Value,
    bot_id: &str,
    ctx_map: &Arc<RwLock<HashMap<String, String>>>,
    tx: &mpsc::Sender<IncomingMessage>,
) {
    let from = msg["from_user_id"].as_str().unwrap_or("").to_string();
    if from.is_empty() {
        return;
    }
    // 回复必带 context_token —— 来一条存一条(覆盖旧的)。
    if let Some(ct) = msg["context_token"].as_str() {
        if !ct.is_empty() {
            ctx_map.write().await.insert(from.clone(), ct.to_string());
        }
    }
    // 提取文本(item_list[].type == 1 是文本)。媒体(2图/3语音/4文件/5视频)第二步再做。
    let mut text = String::new();
    if let Some(items) = msg["item_list"].as_array() {
        for it in items {
            if it["type"].as_i64() == Some(1) {
                if let Some(t) = it["text_item"]["text"].as_str() {
                    text.push_str(t);
                }
            }
        }
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return; // 纯媒体消息先跳过(第二步支持)
    }

    let incoming = IncomingMessage {
        bot_id: bot_id.to_string(),
        platform: "weixin".into(),
        conversation_id: from.clone(), // 单聊:会话 = 用户
        sender_id: from.clone(),
        sender_name: None, // iLink 入站不直接带昵称
        content: text,
        timestamp: now_ts(),
        meta: serde_json::json!({ "is_group": false }),
        content_parts: Vec::new(),
    };
    tx.send(incoming).await.ok();
}
