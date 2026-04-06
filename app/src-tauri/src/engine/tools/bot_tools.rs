use tauri::Emitter;

/// Bot management tool definitions.
pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "list_bot_conversations",
            "List all active bot conversations (groups, channels, DMs). Call this to discover where bots are active and get conversation IDs for sending messages. Each conversation has its own isolated context.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "bot_id": { "type": "string", "description": "Filter by bot ID (optional, lists all if omitted)" }
                },
                "required": []
            }),
        ),
        super::tool_def(
            "send_bot_message",
            "Send a message through a bot to a specific conversation (group/channel/DM). Call list_bot_conversations first to get available conversation IDs.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "conversation_id": { "type": "string", "description": "Conversation ID from list_bot_conversations" },
                    "content": { "type": "string", "description": "Message content to send" },
                    "bot_id": { "type": "string", "description": "Bot ID (optional, auto-detected from conversation)" }
                },
                "required": ["conversation_id", "content"]
            }),
        ),
        super::tool_def(
            "manage_bot",
            "Manage platform bots (Discord, Telegram, QQ, DingTalk, Feishu, WeCom, Webhook). \
            Use this to create, list, update, enable, disable, or delete bots.\n\
            Supported platforms and their required config fields:\n\
            - discord: bot_token\n\
            - telegram: bot_token\n\
            - qq: app_id, client_secret\n\
            - dingtalk: webhook_url, secret\n\
            - feishu: app_id, app_secret, webhook_url\n\
            - wecom: corp_id, corp_secret, agent_id\n\
            - webhook: webhook_url, port\n\
            When user asks to add a bot, use browser_use to guide them through the platform's developer console \
            to obtain credentials, then create the bot with this tool.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "list", "update", "delete", "enable", "disable", "start", "stop"],
                        "description": "Action to perform"
                    },
                    "platform": {
                        "type": "string",
                        "enum": ["discord", "telegram", "qq", "dingtalk", "feishu", "wecom", "webhook"],
                        "description": "Platform type (required for create)"
                    },
                    "name": { "type": "string", "description": "Bot display name (required for create)" },
                    "config": {
                        "type": "object",
                        "description": "Platform-specific config (required for create/update). E.g. {\"app_id\": \"cli_xxx\", \"app_secret\": \"xxx\"}"
                    },
                    "bot_id": { "type": "string", "description": "Bot ID (required for update/delete/enable/disable)" }
                },
                "required": ["action"]
            }),
        ),
    ]
}

pub(super) async fn list_bot_conversations_tool(args: &serde_json::Value) -> String {
    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    let bot_id = args["bot_id"].as_str();
    let convs = match db.list_conversations(bot_id) {
        Ok(c) => c,
        Err(e) => return format!("Error listing conversations: {}", e),
    };

    if convs.is_empty() {
        return "No active bot conversations. Bots will auto-create conversations when they receive messages in groups/channels.".into();
    }

    // Get bot names for display
    let bots = db.list_bots().unwrap_or_default();
    let bot_name = |id: &str| -> String {
        bots.iter().find(|b| b.id == id).map(|b| b.name.clone()).unwrap_or_else(|| id.to_string())
    };

    let list: Vec<String> = convs.iter().map(|c| {
        let name = c.display_name.as_deref().unwrap_or(&c.external_id);
        let age = c.last_message_at.map(|t| {
            let secs = super::db::now_ts() - t;
            if secs < 60 { format!("{}s ago", secs) }
            else if secs < 3600 { format!("{}m ago", secs / 60) }
            else { format!("{}h ago", secs / 3600) }
        }).unwrap_or_else(|| "never".into());
        format!(
            "- **{}** ({}) · {} [{}] — {} msgs, last: {}\n  conversation_id: {}",
            name, bot_name(&c.bot_id), c.platform, c.trigger_mode,
            c.message_count, age, c.id
        )
    }).collect();

    format!(
        "Active conversations ({}):\n{}\n\nTo send a message, use send_bot_message with the conversation_id.",
        convs.len(),
        list.join("\n")
    )
}

pub(super) async fn send_bot_message_tool(args: &serde_json::Value) -> String {
    let conversation_id = args["conversation_id"].as_str().unwrap_or("");
    let content = args["content"].as_str().unwrap_or("");

    if conversation_id.is_empty() || content.is_empty() {
        return "Error: both 'conversation_id' and 'content' are required. Use list_bot_conversations to find available conversation IDs.".into();
    }

    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    // Look up conversation to get bot_id and external_id
    let conv = match db.get_conversation(conversation_id) {
        Ok(Some(c)) => c,
        Ok(None) => return format!("Error: conversation '{}' not found. Use list_bot_conversations to see available IDs.", conversation_id),
        Err(e) => return format!("Error: {}", e),
    };

    // Send via the bot using external_id as target
    match crate::commands::bots::send_to_bot(db, &conv.bot_id, &conv.external_id, content).await {
        Ok(()) => {
            let name = conv.display_name.as_deref().unwrap_or(&conv.external_id);
            format!("Message sent to {} ({}) via bot {}", name, conv.platform, conv.bot_id)
        }
        Err(e) => format!("Error sending message: {}", e),
    }
}

pub(super) async fn manage_bot_tool(args: &serde_json::Value) -> String {
    let action = args["action"].as_str().unwrap_or("");
    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    match action {
        "list" => {
            let bots = match db.list_bots() {
                Ok(b) => b,
                Err(e) => return format!("Error listing bots: {}", e),
            };
            if bots.is_empty() {
                return "No bots configured. Use action='create' to add one.".into();
            }
            let list: Vec<String> = bots.iter().map(|b| {
                format!("- {} | platform: {} | enabled: {} | id: {}", b.name, b.platform, b.enabled, b.id)
            }).collect();
            format!("Bots:\n{}", list.join("\n"))
        }
        "create" => {
            let platform = match args["platform"].as_str() {
                Some(p) => p,
                None => return "Error: 'platform' is required for create".into(),
            };
            let name = match args["name"].as_str() {
                Some(n) => n,
                None => return "Error: 'name' is required for create".into(),
            };
            let config = match args.get("config") {
                Some(c) if c.is_object() => c.clone(),
                _ => return "Error: 'config' object is required for create".into(),
            };

            let valid_platforms = ["discord", "telegram", "qq", "dingtalk", "feishu", "wecom", "webhook"];
            if !valid_platforms.contains(&platform) {
                return format!("Error: invalid platform '{}'. Valid: {:?}", platform, valid_platforms);
            }

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;

            let row = crate::engine::db::BotRow {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.to_string(),
                platform: platform.to_string(),
                enabled: true,
                config_json: serde_json::to_string(&config).unwrap_or_else(|_| "{}".into()),
                persona: None,
                access_json: None,
                created_at: now,
                updated_at: now,
            };

            let bot_id = row.id.clone();
            let bot_name = name.to_string();
            let bot_platform = platform.to_string();
            match db.upsert_bot(&row) {
                Ok(()) => {
                    let mut result = format!(
                        "Bot '{}' created successfully!\nPlatform: {}\nBot ID: {}",
                        bot_name, bot_platform, bot_id
                    );

                    // Notify frontend to auto-start the bot
                    if let Some(app_handle) = super::APP_HANDLE.get() {
                        app_handle.emit("bot://auto-start", serde_json::json!({
                            "bot_id": bot_id,
                        })).ok();
                        result.push_str("\nBot start signal sent.");
                    }

                    result
                }
                Err(e) => format!("Error creating bot: {}", e),
            }
        }
        "update" => {
            let bot_id = match args["bot_id"].as_str() {
                Some(id) => id,
                None => return "Error: 'bot_id' is required for update".into(),
            };
            let mut row = match db.get_bot(bot_id) {
                Ok(Some(r)) => r,
                Ok(None) => return format!("Error: bot '{}' not found", bot_id),
                Err(e) => return format!("Error: {}", e),
            };

            if let Some(n) = args["name"].as_str() { row.name = n.to_string(); }
            if let Some(c) = args.get("config").filter(|c| c.is_object()) {
                row.config_json = serde_json::to_string(c).unwrap_or_else(|_| "{}".into());
            }
            row.updated_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;

            match db.upsert_bot(&row) {
                Ok(()) => format!("Bot '{}' updated successfully.", row.name),
                Err(e) => format!("Error updating bot: {}", e),
            }
        }
        "enable" | "disable" => {
            let bot_id = match args["bot_id"].as_str() {
                Some(id) => id,
                None => return format!("Error: 'bot_id' is required for {}", action),
            };
            let mut row = match db.get_bot(bot_id) {
                Ok(Some(r)) => r,
                Ok(None) => return format!("Error: bot '{}' not found", bot_id),
                Err(e) => return format!("Error: {}", e),
            };
            row.enabled = action == "enable";
            row.updated_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            match db.upsert_bot(&row) {
                Ok(()) => format!("Bot '{}' {}d.", row.name, action),
                Err(e) => format!("Error: {}", e),
            }
        }
        "delete" => {
            let bot_id = match args["bot_id"].as_str() {
                Some(id) => id,
                None => return "Error: 'bot_id' is required for delete".into(),
            };
            match db.delete_bot(bot_id) {
                Ok(()) => format!("Bot '{}' deleted.", bot_id),
                Err(e) => format!("Error deleting bot: {}", e),
            }
        }
        "start" => {
            let bot_id = match args["bot_id"].as_str() {
                Some(id) => id,
                None => return "Error: 'bot_id' is required for start".into(),
            };
            // Verify bot exists
            match db.get_bot(bot_id) {
                Ok(Some(_)) => {}
                Ok(None) => return format!("Error: bot '{}' not found", bot_id),
                Err(e) => return format!("Error: {}", e),
            }
            match super::APP_HANDLE.get() {
                Some(app_handle) => {
                    app_handle.emit("bot://auto-start", serde_json::json!({
                        "bot_id": bot_id,
                    })).ok();
                    format!("Bot '{}' start signal sent.", bot_id)
                }
                None => "Error: app runtime not available".into(),
            }
        }
        "stop" => {
            let bot_id = match args["bot_id"].as_str() {
                Some(id) => id,
                None => return "Error: 'bot_id' is required for stop".into(),
            };
            // Verify bot exists
            match db.get_bot(bot_id) {
                Ok(Some(_)) => {}
                Ok(None) => return format!("Error: bot '{}' not found", bot_id),
                Err(e) => return format!("Error: {}", e),
            }
            match super::APP_HANDLE.get() {
                Some(app_handle) => {
                    app_handle.emit("bot://auto-stop", serde_json::json!({
                        "bot_id": bot_id,
                    })).ok();
                    format!("Bot '{}' stop signal sent.", bot_id)
                }
                None => "Error: app runtime not available".into(),
            }
        }
        _ => format!("Unknown action '{}'. Valid: create, list, update, delete, enable, disable, start, stop", action),
    }
}
