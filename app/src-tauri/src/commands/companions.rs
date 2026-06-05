//! Tauri commands for the Companion system (Buddy > 群).
//!
//! Companions are user-adopted agent instances. See
//! `docs/design/2026-05-15_companions-system.md`.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::agent::resolve_llm_config;
use crate::engine::db::{Companion, CompanionUpdate, NewCompanion};
use crate::engine::llm_client::{chat_completion_tracked, LLMMessage, MessageContent};
use crate::engine::usage::UsageSource;
use crate::state::AppState;

// ── Adopt ────────────────────────────────────────────────────────────


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdoptCompanionInput {
    pub name: String,
    pub agent_definition_name: String,
    pub avatar_emoji: String,
    pub color_hex: String,
    /// Optional persona override text. If provided we write it to a per-
    /// companion `persona.md` file under `<working_dir>/companions/<id>/`
    /// and record the path. Empty/None leaves persona unset.
    pub persona_md: Option<String>,
    pub metadata_json: Option<String>,
    /// Free-text "擅长" label shown in the UI (e.g. "小红书爆款写手").
    /// Optional — when absent the UI falls back to a template-derived label.
    pub role_label: Option<String>,
}

#[tauri::command]
pub async fn adopt_companion(
    state: State<'_, AppState>,
    input: AdoptCompanionInput,
) -> Result<i64, String> {
    validate_name(&input.name)?;
    validate_emoji(&input.avatar_emoji)?;
    validate_color(&input.color_hex)?;
    let now = chrono::Utc::now().timestamp_millis();
    let memory_user_id = format!("companion_{}_{}", now, slugify(&input.name));

    let id = state.db.adopt_companion(&NewCompanion {
        name: input.name.clone(),
        agent_definition_name: input.agent_definition_name,
        avatar_emoji: input.avatar_emoji,
        color_hex: input.color_hex,
        persona_md_path: None,
        memory_user_id,
        metadata_json: input.metadata_json,
        role_label: input.role_label.and_then(|s| {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        }),
    })?;

    if let Some(path) = persist_persona(state.working_dir.as_path(), id, input.persona_md.as_deref())? {
        state.db.update_companion(
            id,
            &CompanionUpdate {
                persona_md_path: Some(Some(path)),
                ..Default::default()
            },
        )?;
    }

    Ok(id)
}

/// Persists the user's adopt / dismiss action on a CompanionDraftCard
/// back into the source message's `metadata.draft_state`. Refreshing the
/// session afterwards keeps the card in its terminal state.
#[tauri::command]
pub async fn update_companion_draft_state(
    state: State<'_, AppState>,
    message_id: i64,
    new_state: String,
    adopted_companion_id: Option<i64>,
) -> Result<(), String> {
    state
        .db
        .update_companion_draft_state(message_id, &new_state, adopted_companion_id)
}

// ── Update ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateCompanionInput {
    pub name: Option<String>,
    pub avatar_emoji: Option<String>,
    pub color_hex: Option<String>,
    /// Persona body text. `Some("")` clears the persona. `None` leaves untouched.
    pub persona_md: Option<String>,
    pub metadata_json: Option<Option<String>>,
    /// Free-text "擅长" label. `Some(Some("x"))` sets, `Some(None)` clears,
    /// `None` leaves untouched. (Same three-state convention as the other
    /// nullable fields here.)
    pub role_label: Option<Option<String>>,
}

#[tauri::command]
pub async fn update_companion(
    state: State<'_, AppState>,
    id: i64,
    input: UpdateCompanionInput,
) -> Result<(), String> {
    if let Some(n) = &input.name {
        validate_name(n)?;
    }
    if let Some(e) = &input.avatar_emoji {
        validate_emoji(e)?;
    }
    if let Some(c) = &input.color_hex {
        validate_color(c)?;
    }

    // Mirror persona_md into the CompanionUpdate's three-state field:
    // None → leave persona unchanged
    // Some(empty) → clear (delete file)
    // Some(text) → write file, store new path
    let persona_md_path_update: Option<Option<String>> = match input.persona_md.as_deref() {
        None => None,
        Some(body) => Some(persist_persona(state.working_dir.as_path(), id, Some(body))?),
    };

    state.db.update_companion(
        id,
        &CompanionUpdate {
            name: input.name,
            avatar_emoji: input.avatar_emoji,
            color_hex: input.color_hex,
            persona_md_path: persona_md_path_update,
            metadata_json: input.metadata_json,
            role_label: input.role_label,
            ..Default::default()
        },
    )?;
    Ok(())
}

// ── Retire ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn retire_companion(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.db.retire_companion(id)?;
    Ok(())
}

// ── Per-companion 定时冥想配置(C 期)──────────────────────────────────

#[derive(serde::Serialize)]
pub struct CompanionMeditationConfig {
    pub enabled: bool,
    pub start_time: String,
}

#[tauri::command]
pub async fn get_companion_meditation_config(
    state: State<'_, AppState>,
    companion_id: i64,
) -> Result<CompanionMeditationConfig, String> {
    let c = state
        .db
        .get_companion(companion_id)
        .ok_or_else(|| format!("Companion {} not found", companion_id))?;
    Ok(CompanionMeditationConfig { enabled: c.meditation_enabled, start_time: c.meditation_time })
}

#[tauri::command]
pub async fn set_companion_meditation_config(
    state: State<'_, AppState>,
    companion_id: i64,
    enabled: bool,
    start_time: String,
) -> Result<(), String> {
    state.db.set_companion_meditation(companion_id, enabled, &start_time)?;
    Ok(())
}

/// 读这个伙伴的人设/角色定义(persona.md 内容)。没写过自定义人设则返回 None。
#[tauri::command]
pub async fn get_companion_persona(
    state: State<'_, AppState>,
    companion_id: i64,
) -> Result<Option<String>, String> {
    let c = state
        .db
        .get_companion(companion_id)
        .ok_or_else(|| format!("companion {companion_id} 不存在"))?;
    match c.persona_md_path {
        Some(path) => Ok(std::fs::read_to_string(&path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())),
        None => Ok(None),
    }
}

// ── List ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_companions(
    state: State<'_, AppState>,
    include_retired: Option<bool>,
) -> Result<Vec<Companion>, String> {
    let mut list = state.db.list_active_companions();
    if include_retired.unwrap_or(false) {
        list.extend(state.db.list_retired_companions());
    }
    Ok(list)
}

#[tauri::command]
pub async fn get_companion(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<Companion>, String> {
    Ok(state.db.get_companion(id))
}

// ── Preview persona tone (live slider feedback) ──────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewPersonaToneInput {
    /// Companion role description (e.g. "代码评审员", "产品军师"). Free text.
    pub role: String,
    /// 0..=10: 0 = 毒舌, 10 = 温和
    pub harshness: u8,
    /// 0..=10: 0 = 严谨, 10 = 随性
    pub formality: u8,
    /// 0..=10: 0 = 话痨, 10 = 惜字
    pub verbosity: u8,
}

#[tauri::command]
pub async fn preview_persona_tone(
    state: State<'_, AppState>,
    input: PreviewPersonaToneInput,
) -> Result<String, String> {
    let config = resolve_llm_config(&state).await?;
    let prompt = build_preview_prompt(&input);
    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
        reasoning_content: None,
    }];
    let resp = chat_completion_tracked(UsageSource::Growth, &config, &messages, &[]).await?;
    Ok(resp
        .message
        .content
        .map(|c| c.into_text())
        .unwrap_or_default()
        .trim()
        .to_string())
}

fn build_preview_prompt(i: &PreviewPersonaToneInput) -> String {
    let h = clamp(i.harshness);
    let f = clamp(i.formality);
    let v = clamp(i.verbosity);
    let harsh_desc = match h {
        0..=3 => "毒舌、犀利、不留情面",
        4..=6 => "中性、就事论事",
        _ => "温和、体贴、鼓励为主",
    };
    let formal_desc = match f {
        0..=3 => "严谨、用书面语",
        4..=6 => "适度正式",
        _ => "随性、口语化",
    };
    let verbose_desc = match v {
        0..=3 => "话痨，喜欢展开讲细节",
        4..=6 => "适中长度",
        _ => "惜字如金，一两句话说完",
    };
    format!(
        "你正在为用户预览一只「伙伴」的说话口吻。这只伙伴的角色是「{role}」。它的脾气：\n\
         - 措辞风格：{harsh}\n\
         - 正式程度：{formal}\n\
         - 表达详略：{verbose}\n\n\
         请用这只伙伴的口吻，对「我刚写完一段 retry 逻辑，没有上界」这件事说一句话。\n\
         **只输出一句话**，不超过 30 字，不要加引号、不要解释、不要署名。",
        role = i.role,
        harsh = harsh_desc,
        formal = formal_desc,
        verbose = verbose_desc,
    )
}

fn clamp(n: u8) -> u8 {
    n.min(10)
}

// ── Generate companion from one line (YiYi 辅助生成) ──────────────────

/// LLM 据用户一句话描述生成的伙伴雏形,回填收养向导(用户仍可逐项改)。
#[derive(Debug, Clone, Serialize)]
pub struct GeneratedCompanion {
    pub avatar_emoji: String,
    pub name: String,
    pub role_label: String,
    pub harshness: u8,
    pub formality: u8,
    pub verbosity: u8,
}

/// 「YiYi 帮我想」:据一句话描述,让 LLM 生成 emoji / 名字 / 擅长 / 脾气,回填收养向导。
/// 结构化产出(关思考)。解析对数字/字符串都容错,字段缺省给中性默认。
#[tauri::command]
pub async fn generate_companion(
    state: State<'_, AppState>,
    description: String,
) -> Result<GeneratedCompanion, String> {
    let desc = description.trim();
    if desc.is_empty() {
        return Err("先写一句描述吧".into());
    }
    let mut config = resolve_llm_config(&state).await?;
    config.enable_thinking = Some(false);
    let prompt = format!(
        "用户想养一只 AI 伙伴,他的描述是:「{desc}」\n\n\
         据此设计这只伙伴。**只输出一个 JSON 对象**,不要代码块、不要解释:\n\
         {{\"avatar_emoji\": \"一个最贴切的 emoji\", \"name\": \"2-6 字中文名,顺口有个性\", \
         \"role_label\": \"它擅长什么,6-12 字\", \"harshness\": 0到10的整数(0毒舌/5中性/10温和), \
         \"formality\": 0到10的整数(0严谨/10随性), \"verbosity\": 0到10的整数(0话痨/10惜字)}}"
    );
    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
        reasoning_content: None,
    }];
    let resp = chat_completion_tracked(UsageSource::Growth, &config, &messages, &[]).await?;
    let text = resp.message.content.map(|c| c.into_text()).unwrap_or_default();
    let json = extract_json_object(&text)
        .ok_or_else(|| "YiYi 这次没说清,再试一次".to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("生成结果格式不对({e}),再试一次"))?;
    let dial = |key: &str| -> u8 {
        v.get(key)
            .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.trim().parse().ok())))
            .unwrap_or(5)
            .min(10) as u8
    };
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("生成的名字是空的,再试一次".into());
    }
    let emoji = {
        let e = v.get("avatar_emoji").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if e.is_empty() { "🦊".to_string() } else { e }
    };
    Ok(GeneratedCompanion {
        avatar_emoji: emoji,
        name,
        role_label: v.get("role_label").and_then(|x| x.as_str()).unwrap_or("").trim().to_string(),
        harshness: dial("harshness"),
        formality: dial("formality"),
        verbosity: dial("verbosity"),
    })
}

/// 从可能裹着代码块/解释的文本里抽第一个完整 `{...}`。
fn extract_json_object(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| text[start..=end].to_string())
}

// ── Helpers ──────────────────────────────────────────────────────────

fn persona_path_for(working_dir: &std::path::Path, id: i64) -> std::path::PathBuf {
    working_dir
        .join("companions")
        .join(id.to_string())
        .join("persona.md")
}

/// Reconcile a persona body with the on-disk persona.md file for one
/// companion. Returns the new value to store in `companions.persona_md_path`:
///   * `None`           — body is `None` *or* empty/whitespace → file deleted, DB cleared
///   * `Some(path)`     — body written to disk, path returned for DB update
///
/// Always invalidates the [`persona_loader`] cache so the next sub-agent
/// spawn sees the fresh body (mtime within the same second otherwise hits
/// stale cache).
fn persist_persona(
    working_dir: &std::path::Path,
    id: i64,
    body: Option<&str>,
) -> Result<Option<String>, String> {
    let path = persona_path_for(working_dir, id);
    let trimmed = body.map(str::trim).filter(|s| !s.is_empty());
    match trimmed {
        None => {
            if path.exists() {
                let _ = std::fs::remove_file(&path);
            }
            crate::engine::agents::persona_loader::invalidate(&path);
            Ok(None)
        }
        Some(text) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("create persona dir: {}", e))?;
            }
            std::fs::write(&path, text).map_err(|e| format!("write persona.md: {}", e))?;
            crate::engine::agents::persona_loader::invalidate(&path);
            Ok(Some(path.to_string_lossy().to_string()))
        }
    }
}

fn validate_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name cannot be empty".into());
    }
    if trimmed.chars().count() > 24 {
        return Err("name too long (max 24 chars)".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("name must not contain path separators".into());
    }
    Ok(())
}

fn validate_emoji(emoji: &str) -> Result<(), String> {
    if emoji.trim().is_empty() {
        return Err("avatar_emoji cannot be empty".into());
    }
    if emoji.chars().count() > 4 {
        return Err("avatar_emoji should be a single emoji".into());
    }
    Ok(())
}

fn validate_color(hex: &str) -> Result<(), String> {
    let bytes = hex.as_bytes();
    if bytes.len() != 7 || bytes[0] != b'#' {
        return Err("color_hex must be in #RRGGBB form".into());
    }
    for c in &bytes[1..] {
        if !c.is_ascii_hexdigit() {
            return Err("color_hex must be in #RRGGBB form".into());
        }
    }
    Ok(())
}

/// Lower-case alphanumerics + underscores, max 20 chars. Used for the
/// MemMe user_id suffix. Non-ASCII names produce a short hash fallback.
fn slugify(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() {
                Some(c.to_ascii_lowercase())
            } else if c.is_whitespace() || c == '_' || c == '-' {
                Some('_')
            } else {
                None
            }
        })
        .collect();
    if cleaned.trim_matches('_').is_empty() {
        // CJK / emoji name → derive a short stable suffix from byte hash.
        let mut h: u64 = 0xcbf29ce484222325;
        for b in name.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        return format!("c{:08x}", h as u32);
    }
    cleaned.chars().take(20).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_name_rejects_empty_and_path_traversal() {
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err());
        assert!(validate_name("../escape").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("阿狸").is_ok());
        assert!(validate_name("a very long companion name that exceeds twenty four characters by far").is_err());
    }

    #[test]
    fn validate_color_requires_hex_format() {
        assert!(validate_color("#F97316").is_ok());
        assert!(validate_color("#abcdef").is_ok());
        assert!(validate_color("F97316").is_err());
        assert!(validate_color("#XYZ123").is_err());
        assert!(validate_color("#fff").is_err());
    }

    #[test]
    fn slugify_handles_ascii_and_cjk() {
        assert_eq!(slugify("Ali_Ace"), "ali_ace");
        let cjk = slugify("阿狸");
        assert!(cjk.starts_with('c') && cjk.len() == 9, "got: {}", cjk);
        // Stable: same input → same slug.
        assert_eq!(slugify("阿狸"), cjk);
    }

    #[test]
    fn build_preview_prompt_includes_all_dials() {
        let p = build_preview_prompt(&PreviewPersonaToneInput {
            role: "代码评审员".into(),
            harshness: 0,
            formality: 5,
            verbosity: 10,
        });
        assert!(p.contains("代码评审员"));
        assert!(p.contains("毒舌"));
        assert!(p.contains("适度正式"));
        assert!(p.contains("惜字如金"));
    }
}
