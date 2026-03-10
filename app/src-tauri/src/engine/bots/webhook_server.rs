use axum::{extract::State as AxumState, routing::post, Json, Router};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

use super::{now_ts, ContentPart, IncomingMessage};

/// Webhook callback server for DingTalk, Feishu, WeCom, and custom webhooks.
/// Runs on a configurable port (default 9090).
pub struct WebhookServer {
    port: u16,
    shutdown_tx: Arc<tokio::sync::RwLock<Option<tokio::sync::oneshot::Sender<()>>>>,
}

#[derive(Clone)]
struct WebhookState {
    tx: mpsc::Sender<IncomingMessage>,
    /// Maps platform name to bot_id (e.g. "dingtalk" -> "my-dingtalk-bot")
    bot_ids: HashMap<String, String>,
}

impl WebhookServer {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            shutdown_tx: Arc::new(tokio::sync::RwLock::new(None)),
        }
    }

    pub async fn start(
        &self,
        tx: mpsc::Sender<IncomingMessage>,
        bot_ids: HashMap<String, String>,
    ) {
        let state = WebhookState { tx, bot_ids };
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        {
            let mut stx = self.shutdown_tx.write().await;
            *stx = Some(shutdown_tx);
        }

        let port = self.port;

        let app = Router::new()
            .route("/webhook/dingtalk", post(handle_dingtalk))
            .route("/webhook/feishu", post(handle_feishu))
            .route("/webhook/wecom", post(handle_wecom))
            .route("/webhook/generic", post(handle_generic))
            .with_state(state);

        tokio::spawn(async move {
            let listener = match tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await {
                Ok(l) => l,
                Err(e) => {
                    log::error!("Failed to bind webhook server on port {}: {}", port, e);
                    return;
                }
            };

            log::info!("Webhook server listening on port {}", port);

            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    shutdown_rx.await.ok();
                })
                .await
                .ok();

            log::info!("Webhook server stopped");
        });
    }

    #[allow(dead_code)]
    pub async fn stop(&self) {
        let mut stx = self.shutdown_tx.write().await;
        if let Some(tx) = stx.take() {
            tx.send(()).ok();
        }
    }
}

/// DingTalk stream callback
async fn handle_dingtalk(
    AxumState(state): AxumState<WebhookState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let msg_type = body["msgtype"]
        .as_str()
        .or_else(|| body["contentType"].as_str())
        .unwrap_or("text")
        .to_lowercase();

    let sender_id = body["senderStaffId"]
        .as_str()
        .or_else(|| body["senderId"].as_str())
        .unwrap_or("unknown")
        .to_string();

    let conversation_id = body["conversationId"]
        .as_str()
        .or_else(|| body["chatId"].as_str())
        .unwrap_or(&sender_id)
        .to_string();

    let sender_name = body["senderNick"]
        .as_str()
        .map(|s| s.to_string());

    let (content, content_parts) = match msg_type.as_str() {
        "text" => {
            let text = body["text"]["content"]
                .as_str()
                .or_else(|| body["content"].as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                (String::new(), Vec::new())
            } else {
                (text.clone(), vec![ContentPart::Text { text }])
            }
        }
        "image" => {
            let url = body["image"]["url"]
                .as_str()
                .or_else(|| body["mediaUrl"].as_str())
                .unwrap_or("")
                .to_string();
            if url.is_empty() {
                (String::new(), Vec::new())
            } else {
                let filename = url.rsplit('/').next().unwrap_or("image.jpg").to_string();
                ("[图片]".to_string(), vec![ContentPart::Image { url, alt: Some(filename) }])
            }
        }
        "file" => {
            let url = body["file"]["url"]
                .as_str()
                .or_else(|| body["mediaUrl"].as_str())
                .unwrap_or("")
                .to_string();
            let filename = body["file"]["fileName"]
                .as_str()
                .or_else(|| body["fileName"].as_str())
                .unwrap_or("file")
                .to_string();
            if url.is_empty() {
                (String::new(), Vec::new())
            } else {
                (format!("[文件: {}]", filename), vec![ContentPart::File { url, filename, mime_type: None }])
            }
        }
        _ => {
            // Unknown type, try to get any text
            let text = body["content"].as_str().unwrap_or("").to_string();
            (text.clone(), vec![ContentPart::Text { text }])
        }
    };

    if !content.is_empty() || !content_parts.is_empty() {
        let bot_id = state.bot_ids.get("dingtalk").cloned().unwrap_or_default();

        let incoming = IncomingMessage {
            bot_id,
            platform: "dingtalk".into(),
            conversation_id,
            sender_id,
            sender_name,
            content,
            timestamp: now_ts(),
            meta: body.clone(),
            content_parts,
        };

        state.tx.send(incoming).await.ok();
    }

    Json(serde_json::json!({ "msgtype": "empty" }))
}

/// Feishu event callback
async fn handle_feishu(
    AxumState(state): AxumState<WebhookState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    // Handle Feishu verification challenge
    if let Some(challenge) = body["challenge"].as_str() {
        return Json(serde_json::json!({ "challenge": challenge }));
    }

    // Handle event
    if let Some(event) = body.get("event") {
        let msg = event.get("message").unwrap_or(event);
        let msg_type = msg["msg_type"]
            .as_str()
            .unwrap_or("text")
            .to_lowercase();

        // Parse content JSON string
        let content_json: serde_json::Value = msg["content"]
            .as_str()
            .and_then(|c| serde_json::from_str(c).ok())
            .unwrap_or(serde_json::json!({}));

        let (content, content_parts) = match msg_type.as_str() {
            "text" => {
                let text = content_json["text"].as_str().unwrap_or("").to_string();
                if text.is_empty() {
                    (String::new(), Vec::new())
                } else {
                    (text.clone(), vec![ContentPart::Text { text }])
                }
            }
            "image" => {
                let key = content_json["image_key"].as_str().unwrap_or("");
                if key.is_empty() {
                    (String::new(), Vec::new())
                } else {
                    let url = format!("https://open.feishu.cn/open-apis/im/v1/images/{}", key);
                    ("[图片]".to_string(), vec![ContentPart::Image { url, alt: None }])
                }
            }
            "file" => {
                let file_key = content_json["file_key"].as_str().unwrap_or("");
                let filename = content_json["file_name"].as_str().unwrap_or("file").to_string();
                if file_key.is_empty() {
                    (String::new(), Vec::new())
                } else {
                    let url = format!("feishu://file/{}", file_key);
                    (format!("[文件: {}]", filename), vec![ContentPart::File { url, filename, mime_type: None }])
                }
            }
            _ => {
                // Try to get any text
                let text = content_json["text"].as_str().unwrap_or("").to_string();
                (text.clone(), vec![ContentPart::Text { text }])
            }
        };

        if !content.is_empty() || !content_parts.is_empty() {
            let chat_id = msg["chat_id"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();
            let sender_id = event["sender"]["sender_id"]["open_id"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();
            let bot_id = state.bot_ids.get("feishu").cloned().unwrap_or_default();

            let incoming = IncomingMessage {
                bot_id,
                platform: "feishu".into(),
                conversation_id: chat_id,
                sender_id,
                sender_name: None,
                content,
                timestamp: now_ts(),
                meta: body.clone(),
                content_parts,
            };

            state.tx.send(incoming).await.ok();
        }
    }

    Json(serde_json::json!({ "code": 0 }))
}

/// 企业微信 (WeCom) event callback
/// 文档: https://developer.work.weixin.qq.com/document/path/90930
async fn handle_wecom(
    AxumState(state): AxumState<WebhookState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    // 企业微信验证 URL 回调 (echostr)
    if let Some(echostr) = body["echostr"].as_str() {
        return Json(serde_json::json!({ "echostr": echostr }));
    }

    let msg_type = body["MsgType"]
        .as_str()
        .or_else(|| body["msgtype"].as_str())
        .unwrap_or("");

    // 只处理文本消息
    if msg_type != "text" {
        return Json(serde_json::json!({ "errcode": 0, "errmsg": "ok" }));
    }

    let text = body["Content"]
        .as_str()
        .or_else(|| body["content"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if !text.is_empty() {
        let from_user = body["FromUserName"]
            .as_str()
            .or_else(|| body["from_user"].as_str())
            .unwrap_or("unknown")
            .to_string();

        let agent_id = body["AgentID"]
            .as_str()
            .or_else(|| body["agent_id"].as_str())
            .unwrap_or("")
            .to_string();

        let sender_name = body["FromUserName"]
            .as_str()
            .map(|s| s.to_string());

        let bot_id = state.bot_ids.get("wecom").cloned().unwrap_or_default();

        let incoming = IncomingMessage {
            bot_id,
            platform: "wecom".into(),
            conversation_id: format!("{}:{}", agent_id, from_user),
            sender_id: from_user,
            sender_name,
            content: text,
            timestamp: now_ts(),
            meta: body.clone(),
            content_parts: Vec::new(),
        };

        state.tx.send(incoming).await.ok();
    }

    Json(serde_json::json!({ "errcode": 0, "errmsg": "ok" }))
}

/// Generic webhook (custom integrations)
async fn handle_generic(
    AxumState(state): AxumState<WebhookState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let content = body["content"]
        .as_str()
        .or_else(|| body["message"].as_str())
        .or_else(|| body["text"].as_str())
        .unwrap_or("")
        .to_string();

    if !content.is_empty() {
        let channel = body["channel"]
            .as_str()
            .unwrap_or("webhook")
            .to_string();
        let sender = body["sender"]
            .as_str()
            .or_else(|| body["user_id"].as_str())
            .unwrap_or("unknown")
            .to_string();

        let bot_id = state.bot_ids.get(&channel).cloned().unwrap_or_default();

        let incoming = IncomingMessage {
            bot_id,
            platform: channel,
            conversation_id: sender.clone(),
            sender_id: sender,
            sender_name: body["sender_name"].as_str().map(|s| s.to_string()),
            content,
            timestamp: now_ts(),
            meta: body.clone(),
            content_parts: Vec::new(),
        };

        state.tx.send(incoming).await.ok();
    }

    Json(serde_json::json!({ "status": "ok" }))
}
