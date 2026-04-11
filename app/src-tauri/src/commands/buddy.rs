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

/// Toggle buddy hosted mode (global).
#[tauri::command]
pub async fn toggle_buddy_hosted(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<bool, String> {
    let mut config = state.config.write().await;
    config.buddy.hosted_mode = enabled;
    config.save(&state.working_dir)?;
    // Global hosted mode is read from config by is_hosted(), no per-session flag needed
    log::info!("Buddy hosted mode toggled: {}", enabled);
    Ok(enabled)
}

/// Get current hosted mode status.
#[tauri::command]
pub async fn get_buddy_hosted(state: State<'_, AppState>) -> Result<bool, String> {
    let config = state.config.read().await;
    Ok(config.buddy.hosted_mode)
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
    stats: std::collections::HashMap<String, i64>,
) -> Result<Option<String>, String> {
    let llm_config = resolve_llm(&state)
        .await
        .ok_or("No LLM configured")?;

    let context = recent_messages.join("\n");

    // Build personality traits from stats
    let energy = stats.get("ENERGY").copied().unwrap_or(50);
    let warmth = stats.get("WARMTH").copied().unwrap_or(50);
    let mischief = stats.get("MISCHIEF").copied().unwrap_or(50);
    let wit = stats.get("WIT").copied().unwrap_or(50);
    let sass = stats.get("SASS").copied().unwrap_or(50);

    let stats_desc = format!(
        "你的性格属性：活力{energy} 温柔{warmth} 调皮{mischief} 聪慧{wit} 犀利{sass}（满分100）。\n\
         属性越高，对应的表达倾向越强。比如犀利高就爱吐槽，温柔高就更温暖体贴，调皮高就更搞怪。"
    );

    let system_prompt = format!(
        "你是{name}，用户的 AI 伴侣。你的化身形象是一只小{species}。\n\
         你的情绪表达风格：{style}\n\
         {stats_desc}\n\n\
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
        stats_desc = stats_desc,
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

// ── Memory browsing commands ─────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct MemoryEntry {
    pub id: String,
    pub content: String,
    pub categories: Vec<String>,
    pub importance: f64,
    pub created_at: String,
}

#[derive(serde::Serialize)]
pub struct MemoryStats {
    pub total: usize,
    pub by_category: std::collections::HashMap<String, usize>,
}

/// Get memory statistics.
#[tauri::command]
pub async fn get_memory_stats() -> Result<MemoryStats, String> {
    let store = crate::engine::tools::get_memme_store()
        .ok_or("记忆引擎未初始化")?;

    let all = store.list_traces(
        memme_core::ListOptions::new(crate::engine::tools::MEMME_USER_ID).limit(10000),
    ).map_err(|e| format!("查询失败: {}", e))?;

    let mut by_category: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for m in &all {
        let cat = m.categories.as_ref()
            .and_then(|c| c.first().cloned())
            .unwrap_or_else(|| "uncategorized".into());
        *by_category.entry(cat).or_insert(0) += 1;
    }

    Ok(MemoryStats { total: all.len(), by_category })
}

/// List recent memories.
#[tauri::command]
pub async fn list_recent_memories(limit: Option<usize>) -> Result<Vec<MemoryEntry>, String> {
    let store = crate::engine::tools::get_memme_store()
        .ok_or("记忆引擎未初始化")?;

    let rows = store.list_traces(
        memme_core::ListOptions::new(crate::engine::tools::MEMME_USER_ID)
            .limit(limit.unwrap_or(20)),
    ).map_err(|e| format!("查询失败: {}", e))?;

    Ok(rows.iter().map(|m| MemoryEntry {
        id: m.id.clone(),
        content: m.content.clone(),
        categories: m.categories.clone().unwrap_or_default(),
        importance: m.importance.unwrap_or(0.0) as f64,
        created_at: m.created_at.clone(),
    }).collect())
}

/// Search memories by query.
#[tauri::command]
pub async fn search_memories(query: String, limit: Option<usize>) -> Result<Vec<MemoryEntry>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let store = crate::engine::tools::get_memme_store()
        .ok_or("记忆引擎未初始化")?;

    let results = store.search(
        &query,
        memme_core::SearchOptions::new(crate::engine::tools::MEMME_USER_ID)
            .limit(limit.unwrap_or(10))
            .keyword_search(true),
    ).map_err(|e| format!("搜索失败: {}", e))?;

    Ok(results.iter().map(|m| MemoryEntry {
        id: m.id.clone(),
        content: m.content.clone(),
        categories: m.categories.clone().unwrap_or_default(),
        importance: m.importance.unwrap_or(0.0) as f64,
        created_at: m.created_at.clone(),
    }).collect())
}

/// Delete a memory by id.
#[tauri::command]
pub async fn delete_memory(id: String) -> Result<(), String> {
    let store = crate::engine::tools::get_memme_store()
        .ok_or("记忆引擎未初始化")?;
    store.delete_trace(&id).map_err(|e| format!("删除失败: {}", e))
}

/// List learned behavioral corrections.
#[tauri::command]
pub async fn list_corrections(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let corrections = state.db.get_all_active_corrections();
    Ok(corrections.iter().map(|(trigger, wrong, correct, conf)| {
        serde_json::json!({
            "trigger": trigger,
            "wrong_behavior": wrong,
            "correct_behavior": correct,
            "confidence": conf,
        })
    }).collect())
}
