use super::{now_ts, ContentPart, IncomingMessage};
use tokio::sync::mpsc;

/// Telegram Bot — Long polling via Bot API
/// https://core.telegram.org/bots/api
pub struct TelegramBot {
    bot_id: String,
    bot_token: String,
    running: std::sync::Arc<tokio::sync::RwLock<bool>>,
}

#[allow(dead_code)]
impl TelegramBot {
    pub fn new(bot_id: String, bot_token: String) -> Self {
        Self {
            bot_id,
            bot_token,
            running: std::sync::Arc::new(tokio::sync::RwLock::new(false)),
        }
    }

    pub async fn start(&self, tx: mpsc::Sender<IncomingMessage>) {
        let token = self.bot_token.clone();
        let bot_id = self.bot_id.clone();
        let running = self.running.clone();

        {
            let mut r = running.write().await;
            *r = true;
        }

        tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .unwrap_or_default();

            let base_url = format!("https://api.telegram.org/bot{}", token);

            // Verify bot token and log bot info
            match client
                .get(format!("{}/getMe", base_url))
                .send()
                .await
            {
                Ok(resp) => {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        if json["ok"].as_bool() == Some(true) {
                            let username = json["result"]["username"]
                                .as_str()
                                .unwrap_or("unknown");
                            log::info!("Telegram bot connected: @{}", username);
                        } else {
                            log::error!("Telegram bot auth failed: {:?}", json);
                            return;
                        }
                    }
                }
                Err(e) => {
                    log::error!("Telegram getMe failed: {}", e);
                    return;
                }
            }

            let mut offset: i64 = 0;

            loop {
                {
                    let r = running.read().await;
                    if !*r {
                        break;
                    }
                }

                // Long poll with 30s timeout
                let url = format!(
                    "{}/getUpdates?offset={}&timeout=30&allowed_updates=[\"message\"]",
                    base_url, offset
                );

                match client.get(&url).send().await {
                    Ok(resp) => {
                        let json = match resp.json::<serde_json::Value>().await {
                            Ok(j) => j,
                            Err(e) => {
                                log::warn!("Telegram parse error: {}", e);
                                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                                continue;
                            }
                        };

                        if json["ok"].as_bool() != Some(true) {
                            log::warn!("Telegram API error: {:?}", json);
                            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                            continue;
                        }

                        if let Some(updates) = json["result"].as_array() {
                            for update in updates {
                                // Update offset to acknowledge this update
                                if let Some(uid) = update["update_id"].as_i64() {
                                    offset = uid + 1;
                                }

                                // Process message
                                if let Some(msg) = update.get("message") {
                                    process_telegram_message(msg, &bot_id, &tx).await;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("Telegram poll error: {}", e);
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                }
            }

            log::info!("Telegram polling stopped");
        });
    }

    pub async fn stop(&self) {
        let mut r = self.running.write().await;
        *r = false;
    }

    pub async fn send(&self, chat_id: &str, content: &str) -> Result<(), String> {
        let client = reqwest::Client::new();
        let base_url = format!("https://api.telegram.org/bot{}", self.bot_token);

        // Telegram message limit is 4096 chars
        let chunks: Vec<String> = if content.len() > 4000 {
            content
                .chars()
                .collect::<Vec<char>>()
                .chunks(4000)
                .map(|c| c.iter().collect::<String>())
                .collect()
        } else {
            vec![content.to_string()]
        };

        for chunk in chunks {
            let body = serde_json::json!({
                "chat_id": chat_id,
                "text": chunk,
                "parse_mode": "Markdown",
            });

            let resp = client
                .post(format!("{}/sendMessage", base_url))
                .json(&body)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Telegram send failed: {}", e))?;

            // If Markdown parsing fails, retry without parse_mode
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if json["ok"].as_bool() != Some(true) {
                    let error_code = json["error_code"].as_i64().unwrap_or(0);
                    // 400 = Bad Request, often due to Markdown parsing issues
                    if error_code == 400 {
                        let fallback_body = serde_json::json!({
                            "chat_id": chat_id,
                            "text": chunk,
                        });
                        client
                            .post(format!("{}/sendMessage", base_url))
                            .json(&fallback_body)
                            .timeout(std::time::Duration::from_secs(15))
                            .send()
                            .await
                            .map_err(|e| format!("Telegram send (fallback) failed: {}", e))?;
                    }
                }
            }
        }

        Ok(())
    }
}

/// Process an incoming Telegram message into IncomingMessage
async fn process_telegram_message(
    msg: &serde_json::Value,
    bot_id: &str,
    tx: &mpsc::Sender<IncomingMessage>,
) {
    // Extract text from message or caption
    let text = msg["text"]
        .as_str()
        .or_else(|| msg["caption"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    // Parse multimedia content parts
    let mut content_parts = Vec::new();
    if !text.is_empty() {
        content_parts.push(ContentPart::Text { text: text.clone() });
    }

    // Photo: array of PhotoSize, pick largest (last)
    if let Some(photos) = msg["photo"].as_array() {
        if let Some(photo) = photos.last() {
            let file_id = photo["file_id"].as_str().unwrap_or("").to_string();
            if !file_id.is_empty() {
                // Use file_id as URL placeholder — actual download needs bot token
                content_parts.push(ContentPart::Image {
                    url: format!("telegram://file/{}", file_id),
                    alt: None,
                });
            }
        }
    }

    // Document
    if let Some(doc) = msg.get("document") {
        let file_id = doc["file_id"].as_str().unwrap_or("").to_string();
        let filename = doc["file_name"].as_str().unwrap_or("file").to_string();
        let mime = doc["mime_type"].as_str().map(|s| s.to_string());
        if !file_id.is_empty() {
            content_parts.push(ContentPart::File {
                url: format!("telegram://file/{}", file_id),
                filename,
                mime_type: mime,
            });
        }
    }

    // Voice/Audio
    if let Some(voice) = msg.get("voice").or_else(|| msg.get("audio")) {
        let file_id = voice["file_id"].as_str().unwrap_or("").to_string();
        if !file_id.is_empty() {
            content_parts.push(ContentPart::Audio {
                url: format!("telegram://file/{}", file_id),
            });
        }
    }

    // Video
    if let Some(video) = msg.get("video") {
        let file_id = video["file_id"].as_str().unwrap_or("").to_string();
        if !file_id.is_empty() {
            content_parts.push(ContentPart::Video {
                url: format!("telegram://file/{}", file_id),
            });
        }
    }

    // Skip if no content at all
    if text.is_empty() && content_parts.is_empty() {
        return;
    }

    let chat_id = msg["chat"]["id"].as_i64().unwrap_or(0);
    let user_id = msg["from"]["id"].as_i64().unwrap_or(0);
    let username = msg["from"]["username"]
        .as_str()
        .or_else(|| msg["from"]["first_name"].as_str())
        .map(|s| s.to_string());
    let message_id = msg["message_id"].as_i64().unwrap_or(0);

    let is_group = matches!(
        msg["chat"]["type"].as_str(),
        Some("group" | "supergroup" | "channel")
    );

    let is_command = msg["entities"]
        .as_array()
        .map(|entities| {
            entities.iter().any(|e| {
                e["type"].as_str() == Some("bot_command") && e["offset"].as_i64() == Some(0)
            })
        })
        .unwrap_or(false);

    let incoming = IncomingMessage {
        bot_id: bot_id.to_string(),
        platform: "telegram".into(),
        conversation_id: chat_id.to_string(),
        sender_id: user_id.to_string(),
        sender_name: username,
        content: text,
        timestamp: now_ts(),
        meta: serde_json::json!({
            "chat_id": chat_id,
            "message_id": message_id,
            "is_group": is_group,
            "is_command": is_command,
        }),
        content_parts,
    };

    tx.send(incoming).await.ok();
}
