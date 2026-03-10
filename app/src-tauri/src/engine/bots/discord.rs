use super::{now_ts, ContentPart, IncomingMessage};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// Discord bot using WebSocket gateway
pub struct DiscordBot {
    bot_id: String,
    bot_token: String,
    running: std::sync::Arc<tokio::sync::RwLock<bool>>,
}

#[allow(dead_code)]
impl DiscordBot {
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
            // Get gateway URL
            let client = reqwest::Client::new();
            let gateway_url = match client
                .get("https://discord.com/api/v10/gateway/bot")
                .header("Authorization", format!("Bot {}", token))
                .send()
                .await
            {
                Ok(resp) => {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        json["url"]
                            .as_str()
                            .unwrap_or("wss://gateway.discord.gg")
                            .to_string()
                    } else {
                        "wss://gateway.discord.gg".to_string()
                    }
                }
                Err(_) => "wss://gateway.discord.gg".to_string(),
            };

            let ws_url = format!("{}/?v=10&encoding=json", gateway_url);

            log::info!("Discord connecting to gateway: {}", ws_url);

            loop {
                {
                    let r = running.read().await;
                    if !*r {
                        break;
                    }
                }

                match tokio_tungstenite::connect_async(&ws_url).await {
                    Ok((mut ws_stream, _)) => {
                        log::info!("Discord gateway connected");

                        let mut heartbeat_interval: u64 = 41250;
                        let mut sequence: Option<i64> = None;
                        let mut identified = false;
                        let token_clone = token.clone();

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
                                            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&text) {
                                                let op = payload["op"].as_i64().unwrap_or(-1);
                                                if let Some(s) = payload["s"].as_i64() {
                                                    sequence = Some(s);
                                                }

                                                match op {
                                                    10 => {
                                                        // Hello - get heartbeat interval
                                                        heartbeat_interval = payload["d"]["heartbeat_interval"]
                                                            .as_u64()
                                                            .unwrap_or(41250);

                                                        // Send Identify
                                                        if !identified {
                                                            let identify = serde_json::json!({
                                                                "op": 2,
                                                                "d": {
                                                                    "token": token_clone,
                                                                    "intents": 33281, // GUILDS + GUILD_MESSAGES + DM_MESSAGES + MESSAGE_CONTENT
                                                                    "properties": {
                                                                        "os": "macos",
                                                                        "browser": "yiclaw",
                                                                        "device": "yiclaw"
                                                                    }
                                                                }
                                                            });
                                                            ws_stream.send(Message::Text(
                                                                serde_json::to_string(&identify).unwrap().into()
                                                            )).await.ok();
                                                            identified = true;
                                                        }
                                                    }
                                                    11 => {
                                                        // Heartbeat ACK
                                                    }
                                                    0 => {
                                                        // Dispatch
                                                        let event_name = payload["t"]
                                                            .as_str()
                                                            .unwrap_or("");

                                                        if event_name == "MESSAGE_CREATE" {
                                                            let d = &payload["d"];
                                                            // Skip bot's own messages
                                                            if d["author"]["bot"].as_bool().unwrap_or(false) {
                                                                continue;
                                                            }

                                                            let content = d["content"]
                                                                .as_str()
                                                                .unwrap_or("")
                                                                .to_string();

                                                            // Parse attachments into ContentParts
                                                            let mut content_parts = Vec::new();
                                                            if !content.is_empty() {
                                                                content_parts.push(ContentPart::Text { text: content.clone() });
                                                            }
                                                            if let Some(attachments) = d["attachments"].as_array() {
                                                                for att in attachments {
                                                                    let url = att["url"].as_str().unwrap_or("").to_string();
                                                                    let filename = att["filename"].as_str().unwrap_or("").to_string();
                                                                    let content_type = att["content_type"].as_str().unwrap_or("");
                                                                    if url.is_empty() { continue; }
                                                                    if content_type.starts_with("image/") {
                                                                        content_parts.push(ContentPart::Image { url, alt: Some(filename) });
                                                                    } else {
                                                                        content_parts.push(ContentPart::File { url, filename, mime_type: Some(content_type.to_string()) });
                                                                    }
                                                                }
                                                            }

                                                            // Skip if no content at all
                                                            if content.is_empty() && content_parts.is_empty() {
                                                                continue;
                                                            }

                                                            let channel_id = d["channel_id"]
                                                                .as_str()
                                                                .unwrap_or("")
                                                                .to_string();
                                                            let author_id = d["author"]["id"]
                                                                .as_str()
                                                                .unwrap_or("")
                                                                .to_string();
                                                            let author_name = d["author"]["username"]
                                                                .as_str()
                                                                .map(|s| s.to_string());
                                                            let guild_id = d["guild_id"]
                                                                .as_str()
                                                                .map(|s| s.to_string());

                                                            let conversation_id = match &guild_id {
                                                                Some(_) => format!("ch:{}", channel_id),
                                                                None => format!("dm:{}", author_id),
                                                            };

                                                            let incoming = IncomingMessage {
                                                                bot_id: bot_id.clone(),
                                                                platform: "discord".into(),
                                                                conversation_id,
                                                                sender_id: author_id,
                                                                sender_name: author_name,
                                                                content,
                                                                timestamp: now_ts(),
                                                                meta: serde_json::json!({
                                                                    "channel_id": channel_id,
                                                                    "guild_id": guild_id,
                                                                    "message_id": d["id"],
                                                                }),
                                                                content_parts,
                                                            };

                                                            tx.send(incoming).await.ok();
                                                        }
                                                    }
                                                    _ => {}
                                                }
                                            }
                                        }
                                        Some(Ok(Message::Close(_))) | None => {
                                            log::warn!("Discord gateway closed");
                                            break;
                                        }
                                        _ => {}
                                    }
                                }
                                _ = tokio::time::sleep(std::time::Duration::from_millis(heartbeat_interval)) => {
                                    // Send heartbeat
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
                        log::error!("Discord connect failed: {}", e);
                    }
                }

                // Reconnect delay
                let r = running.read().await;
                if !*r {
                    break;
                }
                drop(r);
                log::info!("Discord reconnecting in 5s...");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }

            log::info!("Discord gateway stopped");
        });
    }

    pub async fn stop(&self) {
        let mut r = self.running.write().await;
        *r = false;
    }

    pub async fn send(&self, channel_id: &str, content: &str) -> Result<(), String> {
        let client = reqwest::Client::new();
        let url = format!(
            "https://discord.com/api/v10/channels/{}/messages",
            channel_id
        );

        // Discord has 2000 char limit
        let chunks: Vec<String> = if content.len() > 2000 {
            content
                .chars()
                .collect::<Vec<char>>()
                .chunks(2000)
                .map(|c| c.iter().collect::<String>())
                .collect()
        } else {
            vec![content.to_string()]
        };

        for chunk in chunks {
            let body = serde_json::json!({ "content": chunk });

            client
                .post(&url)
                .header("Authorization", format!("Bot {}", self.bot_token))
                .header("Content-Type", "application/json")
                .json(&body)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Discord send failed: {}", e))?;
        }

        Ok(())
    }
}
