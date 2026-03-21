use tauri::Emitter;

/// Bot management tool definitions.
pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "list_bound_bots",
            "List bots bound to the current chat session. Call this FIRST to discover which bots are available before sending messages. Returns bot names, platforms, and IDs. Bot information is stored in the database, NOT in config files — never try to read config files for bot info.",
            serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        ),
        super::tool_def(
            "send_bot_message",
            "Send a message through a bot bound to the current session. Use this when the user asks you to send a message to an external platform (Discord, Telegram, Feishu, DingTalk, etc.). Call list_bound_bots first if you don't know which bots are available. If bot_id is not specified and only one bot is bound, it will be used automatically.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Target ID: channel ID, group ID, or user ID on the platform" },
                    "content": { "type": "string", "description": "Message content to send" },
                    "bot_id": { "type": "string", "description": "Bot ID to use (optional if only one bot is bound to the session)" }
                },
                "required": ["target", "content"]
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

pub(super) async fn list_bound_bots_tool() -> String {
    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    let session_id = super::get_current_session_id();
    if session_id.is_empty() {
        return "Error: no active session context.".into();
    }

    let bots = match db.list_session_bots(&session_id) {
        Ok(bots) => bots,
        Err(e) => return format!("Error listing bound bots: {}", e),
    };

    if bots.is_empty() {
        return format!(
            "No bots are bound to the current session (session_id: {}). \
            The user can bind bots via the bot icon in the chat toolbar.",
            session_id
        );
    }

    let list: Vec<String> = bots
        .iter()
        .map(|b| {
            let last_conv = db.get_bot_last_conversation(&b.id)
                .unwrap_or_else(|| "none".into());
            format!(
                "- {} (platform: {}, id: {}, enabled: {}, last_target: {})",
                b.name, b.platform, b.id, b.enabled, last_conv
            )
        })
        .collect();

    format!(
        "Bots bound to current session ({}):\n{}\n\n\
        To send a message, use send_bot_message with the bot's id and the last_target as target.\n\
        - Target format: 'c2c:xxx' (private chat), 'group:xxx' (group chat), 'guild:gid:cid' (guild channel)\n\
        - If last_target is 'none', no one has messaged this bot yet — the bot cannot initiate contact. \
        Tell the user that the other person needs to send a message to the bot first.",
        session_id,
        list.join("\n")
    )
}

pub(super) async fn send_bot_message_tool(args: &serde_json::Value) -> String {
    let target = args["target"].as_str().unwrap_or("");
    let content = args["content"].as_str().unwrap_or("");
    let explicit_bot_id = args["bot_id"].as_str();

    if target.is_empty() || content.is_empty() {
        return "Error: both 'target' and 'content' are required".into();
    }

    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    let session_id = super::get_current_session_id();
    if session_id.is_empty() {
        return "Error: no active session. Cannot determine which bots are bound.".into();
    }

    // Get bots bound to this session
    let bound_bots = match db.list_session_bots(&session_id) {
        Ok(bots) => bots,
        Err(e) => return format!("Error listing session bots: {}", e),
    };

    if bound_bots.is_empty() {
        return "Error: no bots are bound to the current session. Ask the user to bind a bot first via the session settings.".into();
    }

    // Determine which bot to use
    let bot = if let Some(bid) = explicit_bot_id {
        match bound_bots.iter().find(|b| b.id == bid) {
            Some(b) => b,
            None => return format!("Error: bot '{}' is not bound to this session", bid),
        }
    } else if bound_bots.len() == 1 {
        &bound_bots[0]
    } else {
        let bot_list: Vec<String> = bound_bots.iter().map(|b| format!("{} ({}, {})", b.name, b.platform, b.id)).collect();
        return format!(
            "Error: multiple bots are bound to this session. Please specify bot_id. Available bots:\n{}",
            bot_list.join("\n")
        );
    };

    // Send via the bot
    match crate::commands::bots::send_to_bot(db, &bot.id, target, content).await {
        Ok(()) => format!("Message sent via {} ({}) to target '{}'", bot.name, bot.platform, target),
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

                    // Auto-bind to current session
                    let session_id = super::get_current_session_id();
                    if !session_id.is_empty() {
                        match db.bind_bot_to_session(&session_id, &bot_id) {
                            Ok(_) => {
                                result.push_str(&format!("\nBot bound to current session ({}).", session_id));
                            }
                            Err(e) => {
                                result.push_str(&format!("\nWarning: failed to bind bot to session: {}", e));
                            }
                        }
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
