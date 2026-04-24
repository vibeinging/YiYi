use tauri::State;

use crate::engine::llm_client::{self, LLMMessage, MessageContent};
use crate::state::AppState;
use crate::state::config::BuddyConfig;

/// Resolve LLM config from state (same pattern as heartbeat.rs)
async fn resolve_llm(state: &AppState) -> Option<llm_client::LLMConfig> {
    let providers = state.providers.read().await;
    llm_client::resolve_config_from_providers(&providers).ok()
}

pub async fn get_buddy_config_impl(state: &AppState) -> Result<BuddyConfig, String> {
    let config = state.config.read().await;
    Ok(config.buddy.clone())
}

#[tauri::command]
pub async fn get_buddy_config(state: State<'_, AppState>) -> Result<BuddyConfig, String> {
    get_buddy_config_impl(&state).await
}

pub async fn save_buddy_config_impl(
    state: &AppState,
    config: BuddyConfig,
) -> Result<BuddyConfig, String> {
    let mut app_config = state.config.write().await;
    app_config.buddy = config.clone();
    app_config.save(&state.working_dir)?;
    Ok(config)
}

#[tauri::command]
pub async fn save_buddy_config(
    state: State<'_, AppState>,
    config: BuddyConfig,
) -> Result<BuddyConfig, String> {
    save_buddy_config_impl(&state, config).await
}

/// Hatch the buddy avatar for YiYi.
/// No LLM call needed — the name comes from SOUL.md and the personality (reaction style)
/// is chosen by the user in the UI.
pub async fn hatch_buddy_impl(
    state: &AppState,
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

#[tauri::command]
pub async fn hatch_buddy(
    state: State<'_, AppState>,
    name: String,
    personality: String,
) -> Result<BuddyConfig, String> {
    hatch_buddy_impl(&state, name, personality).await
}

/// Toggle buddy hosted mode (global).
pub async fn toggle_buddy_hosted_impl(
    state: &AppState,
    enabled: bool,
) -> Result<bool, String> {
    let mut config = state.config.write().await;
    config.buddy.hosted_mode = enabled;
    config.save(&state.working_dir)?;
    // Global hosted mode is read from config by is_hosted(), no per-session flag needed
    log::info!("Buddy hosted mode toggled: {}", enabled);
    Ok(enabled)
}

#[tauri::command]
pub async fn toggle_buddy_hosted(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<bool, String> {
    toggle_buddy_hosted_impl(&state, enabled).await
}

/// Get current hosted mode status.
pub async fn get_buddy_hosted_impl(state: &AppState) -> Result<bool, String> {
    let config = state.config.read().await;
    Ok(config.buddy.hosted_mode)
}

#[tauri::command]
pub async fn get_buddy_hosted(state: State<'_, AppState>) -> Result<bool, String> {
    get_buddy_hosted_impl(&state).await
}

/// YiYi observes the conversation and decides whether to react with an emotional bubble.
/// This is YiYi's "emotional side" — casual, expressive, in-character reactions.
pub async fn buddy_observe_impl(
    state: &AppState,
    recent_messages: Vec<String>,
    ai_name: String,
    species_label: String,
    reaction_style: String,
    stats: std::collections::HashMap<String, i64>,
) -> Result<Option<String>, String> {
    let llm_config = resolve_llm(state)
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
    let json_str = crate::engine::mem::meditation::extract_json_from_response(&text);

    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_str) {
        if parsed["react"].as_bool().unwrap_or(false) {
            if let Some(reaction) = parsed["text"].as_str() {
                return Ok(Some(reaction.to_string()));
            }
        }
    }

    Ok(None)
}

#[tauri::command]
pub async fn buddy_observe(
    state: State<'_, AppState>,
    recent_messages: Vec<String>,
    ai_name: String,
    species_label: String,
    reaction_style: String,
    stats: std::collections::HashMap<String, i64>,
) -> Result<Option<String>, String> {
    buddy_observe_impl(
        &state,
        recent_messages,
        ai_name,
        species_label,
        reaction_style,
        stats,
    )
    .await
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
pub async fn get_memory_stats_impl(state: &AppState) -> Result<MemoryStats, String> {
    let all = state
        .memme_store
        .list_traces(
            memme_core::ListOptions::new(crate::engine::tools::MEMME_USER_ID).limit(10000),
        )
        .map_err(|e| format!("查询失败: {}", e))?;

    let mut by_category: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for m in &all {
        let cat = m.categories.as_ref()
            .and_then(|c| c.first().cloned())
            .unwrap_or_else(|| "未归类".into());
        *by_category.entry(cat).or_insert(0) += 1;
    }

    Ok(MemoryStats { total: all.len(), by_category })
}

#[tauri::command]
pub async fn get_memory_stats(state: State<'_, AppState>) -> Result<MemoryStats, String> {
    get_memory_stats_impl(&state).await
}

#[derive(serde::Serialize)]
pub struct EpisodeEntry {
    pub episode_id: String,
    pub title: String,
    pub summary: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub significance: f64,
    pub outcome: Option<String>,
}

/// List recent episodes (compacted conversation summaries).
pub async fn list_recent_episodes_impl(
    state: &AppState,
    limit: Option<usize>,
) -> Result<Vec<EpisodeEntry>, String> {
    let opts = memme_core::ListEpisodesOptions::new(crate::engine::tools::MEMME_USER_ID)
        .limit(limit.unwrap_or(15));
    let rows = state
        .memme_store
        .list_episodes(opts)
        .map_err(|e| format!("查询失败: {}", e))?;

    Ok(rows.iter().map(|e| EpisodeEntry {
        episode_id: e.episode_id.clone(),
        title: e.title.clone(),
        summary: e.summary.clone(),
        started_at: e.started_at.clone(),
        ended_at: e.ended_at.clone(),
        significance: e.significance as f64,
        outcome: e.outcome.clone(),
    }).collect())
}

#[tauri::command]
pub async fn list_recent_episodes(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<EpisodeEntry>, String> {
    list_recent_episodes_impl(&state, limit).await
}

/// List recent memories.
pub async fn list_recent_memories_impl(
    state: &AppState,
    limit: Option<usize>,
) -> Result<Vec<MemoryEntry>, String> {
    let rows = state
        .memme_store
        .list_traces(
            memme_core::ListOptions::new(crate::engine::tools::MEMME_USER_ID)
                .limit(limit.unwrap_or(20)),
        )
        .map_err(|e| format!("查询失败: {}", e))?;

    Ok(rows.iter().map(|m| MemoryEntry {
        id: m.id.clone(),
        content: m.content.clone(),
        categories: m.categories.clone().unwrap_or_default(),
        importance: m.importance.unwrap_or(0.0) as f64,
        created_at: m.created_at.clone(),
    }).collect())
}

#[tauri::command]
pub async fn list_recent_memories(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<MemoryEntry>, String> {
    list_recent_memories_impl(&state, limit).await
}

/// Search memories by query.
pub async fn search_memories_impl(
    state: &AppState,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<MemoryEntry>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let results = state
        .memme_store
        .search(
            &query,
            memme_core::SearchOptions::new(crate::engine::tools::MEMME_USER_ID)
                .limit(limit.unwrap_or(10))
                .keyword_search(true),
        )
        .map_err(|e| format!("搜索失败: {}", e))?;

    Ok(results.iter().map(|m| MemoryEntry {
        id: m.id.clone(),
        content: m.content.clone(),
        categories: m.categories.clone().unwrap_or_default(),
        importance: m.importance.unwrap_or(0.0) as f64,
        created_at: m.created_at.clone(),
    }).collect())
}

#[tauri::command]
pub async fn search_memories(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<MemoryEntry>, String> {
    search_memories_impl(&state, query, limit).await
}

/// Delete a memory by id.
pub async fn delete_memory_impl(state: &AppState, id: String) -> Result<(), String> {
    state
        .memme_store
        .delete_trace(&id)
        .map_err(|e| format!("删除失败: {}", e))
}

#[tauri::command]
pub async fn delete_memory(state: State<'_, AppState>, id: String) -> Result<(), String> {
    delete_memory_impl(&state, id).await
}

/// List learned behavioral corrections.
pub async fn list_corrections_impl(
    state: &AppState,
) -> Result<Vec<serde_json::Value>, String> {
    let corrections = state.db.get_all_active_corrections();
    Ok(corrections.iter().map(|(trigger, correct, source, conf)| {
        serde_json::json!({
            "trigger": trigger,
            "correct_behavior": correct,
            "source": source,
            "confidence": conf,
        })
    }).collect())
}

#[tauri::command]
pub async fn list_corrections(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    list_corrections_impl(&state).await
}

/// List recent meditation sessions (for diary display).
pub async fn list_meditation_sessions_impl(
    state: &AppState,
    limit: Option<usize>,
) -> Result<Vec<crate::engine::db::MeditationSession>, String> {
    Ok(state.db.list_meditation_sessions(limit.unwrap_or(10)))
}

#[tauri::command]
pub async fn list_meditation_sessions(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<crate::engine::db::MeditationSession>, String> {
    list_meditation_sessions_impl(&state, limit).await
}

// ── Decision log & trust ─────────────────────────────────────────────

/// List recent buddy decisions.
pub async fn list_buddy_decisions_impl(
    state: &AppState,
    limit: Option<usize>,
) -> Result<Vec<crate::engine::db::BuddyDecision>, String> {
    Ok(state.db.list_buddy_decisions(limit.unwrap_or(20)))
}

#[tauri::command]
pub async fn list_buddy_decisions(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<crate::engine::db::BuddyDecision>, String> {
    list_buddy_decisions_impl(&state, limit).await
}

/// Record user feedback on a buddy decision.
pub async fn set_decision_feedback_impl(
    state: &AppState,
    decision_id: String,
    feedback: String,
) -> Result<(), String> {
    if feedback != "good" && feedback != "bad" {
        return Err("feedback must be 'good' or 'bad'".into());
    }
    state.db.set_decision_feedback(&decision_id, &feedback);

    // Recalculate trust scores
    let stats = state.db.get_trust_stats();
    let mut config = state.config.write().await;
    config.buddy.trust_overall = stats.accuracy;
    for (ctx, ct) in &stats.by_context {
        config.buddy.trust_scores.insert(ctx.clone(), ct.accuracy);
    }
    config.save(&state.working_dir)?;

    Ok(())
}

#[tauri::command]
pub async fn set_decision_feedback(
    state: State<'_, AppState>,
    decision_id: String,
    feedback: String,
) -> Result<(), String> {
    set_decision_feedback_impl(&state, decision_id, feedback).await
}

/// Get trust statistics.
pub async fn get_trust_stats_impl(
    state: &AppState,
) -> Result<crate::engine::db::TrustStats, String> {
    Ok(state.db.get_trust_stats())
}

#[tauri::command]
pub async fn get_trust_stats(
    state: State<'_, AppState>,
) -> Result<crate::engine::db::TrustStats, String> {
    get_trust_stats_impl(&state).await
}
