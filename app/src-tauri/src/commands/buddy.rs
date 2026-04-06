use serde::{Deserialize, Serialize};
use tauri::State;

use crate::engine::llm_client::{self, LLMMessage, MessageContent};
use crate::state::AppState;
use crate::state::config::BuddyConfig;

/// Resolve LLM config from state (same pattern as heartbeat.rs)
async fn resolve_llm(state: &AppState) -> Option<llm_client::LLMConfig> {
    let providers = state.providers.read().await;
    llm_client::resolve_config_from_providers(&providers).ok()
}

#[tauri::command]
pub async fn get_buddy_config(state: State<'_, AppState>) -> Result<BuddyConfig, String> {
    let config = state.config.read().await;
    Ok(config.buddy.clone())
}

#[tauri::command]
pub async fn save_buddy_config(
    state: State<'_, AppState>,
    config: BuddyConfig,
) -> Result<BuddyConfig, String> {
    let mut app_config = state.config.write().await;
    app_config.buddy = config.clone();
    app_config.save(&state.working_dir)?;
    Ok(config)
}

/// Hatch the buddy avatar for YiYi.
/// No LLM call needed — the name comes from SOUL.md and the personality (reaction style)
/// is chosen by the user in the UI.
#[tauri::command]
pub async fn hatch_buddy(
    state: State<'_, AppState>,
    name: String,
    personality: String,
) -> Result<BuddyConfig, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let mut app_config = state.config.write().await;
    app_config.buddy.name = name;
    app_config.buddy.personality = personality;
    app_config.buddy.hatched_at = now;
    app_config.save(&state.working_dir)?;

    Ok(app_config.buddy.clone())
}

/// YiYi observes the conversation and decides whether to react with an emotional bubble.
/// This is YiYi's "emotional side" — casual, expressive, in-character reactions.
#[tauri::command]
pub async fn buddy_observe(
    state: State<'_, AppState>,
    recent_messages: Vec<String>,
    ai_name: String,
    species_label: String,
    reaction_style: String,
) -> Result<Option<String>, String> {
    let llm_config = resolve_llm(&state)
        .await
        .ok_or("No LLM configured")?;

    let context = recent_messages.join("\n");

    let system_prompt = format!(
        "你是{name}，用户的 AI 伴侣。你的化身形象是一只小{species}。\n\
         你的情绪表达风格：{style}\n\n\
         主对话窗口里你在认真回答问题，但你的小精灵化身可以表达更感性、更随意的反应。\n\
         这些反应出现在你的化身旁边的语音泡泡里。\n\n\
         规则：\n\
         - 只在有感触的时候反应（约 30% 的概率），大部分时候安静\n\
         - 泡泡文字要简短、情绪化（不超过 20 个字）\n\
         - 用你的情绪风格说话，可以用语气词、颜文字\n\
         - 不要重复主对话里已经说过的内容\n\
         - 可以表达：开心、担心、好奇、骄傲、疲惫、吐槽、鼓励\n\
         - 如果对话很普通，不需要反应\n\n\
         回复格式（仅 JSON）：{{\"react\": true/false, \"text\": \"泡泡文字\"}}",
        name = ai_name,
        species = species_label,
        style = reaction_style,
    );

    let messages = vec![
        LLMMessage {
            role: "system".into(),
            content: Some(MessageContent::text(&system_prompt)),
            tool_calls: None,
            tool_call_id: None,
        },
        LLMMessage {
            role: "user".into(),
            content: Some(MessageContent::text(&format!("最近的对话：\n{}", context))),
            tool_calls: None,
            tool_call_id: None,
        },
    ];

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        llm_client::chat_completion(&llm_config, &messages, &[]),
    )
    .await
    .map_err(|_| "Buddy observe timed out")?
    .map_err(|e| format!("LLM error: {}", e))?;

    let text = response.message.content.as_ref().and_then(|c| c.as_text()).unwrap_or("").to_string();
    let json_str = extract_json(&text).unwrap_or(&text);

    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_str) {
        if parsed["react"].as_bool().unwrap_or(false) {
            if let Some(reaction) = parsed["text"].as_str() {
                return Ok(Some(reaction.to_string()));
            }
        }
    }

    Ok(None)
}

/// Extract JSON object from text that may contain markdown fences.
fn extract_json(text: &str) -> Option<&str> {
    if let Some(start) = text.find("```json") {
        let after = &text[start + 7..];
        if let Some(end) = after.find("```") {
            return Some(after[..end].trim());
        }
    }
    if let Some(start) = text.find("```") {
        let after = &text[start + 3..];
        if let Some(end) = after.find("```") {
            return Some(after[..end].trim());
        }
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end > start {
        Some(&text[start..=end])
    } else {
        None
    }
}
