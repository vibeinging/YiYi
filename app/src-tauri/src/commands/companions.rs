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

// ── G1:动态角色(运行时生成,非编译期固化)──────────────────────────────

/// 注册一个动态角色并收养成 companion。G2「agent 自生成团队」落地单个角色的底座:
/// ① 落 `~/.yiyi/agents/<slug>/AGENT.md`(重启后 `AgentRegistry::load` 自动读回)
/// ② 运行时 `upsert` 进 registry(不重启即可被执行器按权限档位解析,F2 真生效)
/// ③ 收养成 companion(persona 落 `companions/<id>/persona.md`)
///
/// 返回新 companion 的 id。权限只能走 `RoleSpec.profile` 的预设安全档位 —— 生成器
/// 无法给动态角色乱开全权工具(见 `engine/agents/dynamic.rs`)。
#[tauri::command]
pub async fn register_dynamic_role(
    state: State<'_, AppState>,
    spec: crate::engine::agents::dynamic::RoleSpec,
) -> Result<i64, String> {
    register_dynamic_role_impl(&state, spec).await
}

pub async fn register_dynamic_role_impl(
    state: &AppState,
    spec: crate::engine::agents::dynamic::RoleSpec,
) -> Result<i64, String> {
    use crate::engine::agents::dynamic::persist_role_agent_md;

    validate_emoji(&spec.emoji)?;
    validate_color(&spec.color)?;
    validate_role_slug(&spec.slug)?;
    // slug 不能撞已有 agent(内置 pm/ui_designer/… 或别的动态角色)—— 否则 upsert 会悄悄
    // 顶替内置角色定义(如把只读的 PM 换成带 execute_shell 的档位),破坏权限隔离。
    if state.agent_registry.read().await.get(&spec.slug).is_some() {
        return Err(format!("角色标识 '{}' 已被占用,换一个 slug", spec.slug));
    }

    // 顺序关键(安全):**先**落 AGENT.md + upsert registry,**再** adopt companion。
    // 反过来(先 adopt)若 AGENT.md 落盘失败,companion 会带着未注册的 agent_definition_name →
    // F2 解析不到 → 回落 ToolFilter::All(**全权!**)= 提权,违背档位隔离。先注册定义则:
    // 落盘失败 → 干净报错无 companion;adopt 失败 → 只留一个「受限(带档位白名单)、无 companion
    // 引用」的孤儿定义(benign,不会被跑到,顶多占用该 slug 待重试时换名)。
    persist_role_agent_md(state.working_dir.as_path(), &spec)
        .map_err(|e| format!("角色落盘失败: {e}"))?;
    {
        // write 锁尽快释放,别跨后续 await 持有。
        state.agent_registry.write().await.upsert(spec.to_agent_def());
    }

    let name = unique_companion_name(&state.db, &spec.name);
    validate_name(&name)?;
    let now = chrono::Utc::now().timestamp_millis();
    let memory_user_id = format!("companion_{}_{}", now, uuid::Uuid::new_v4().simple());
    let id = state.db.adopt_companion(&NewCompanion {
        name,
        agent_definition_name: spec.slug.clone(),
        avatar_emoji: spec.emoji.clone(),
        color_hex: spec.color.clone(),
        persona_md_path: None,
        memory_user_id,
        metadata_json: None,
        role_label: Some(spec.description.clone()),
    })?;
    if let Some(path) = persist_persona(state.working_dir.as_path(), id, Some(&spec.persona))? {
        state.db.update_companion(
            id,
            &CompanionUpdate { persona_md_path: Some(Some(path)), ..Default::default() },
        )?;
    }

    Ok(id)
}

/// slug 格式校验:非空 + 纯 ascii 小写/数字/下划线(register / commit_dynamic_team 共用)。
fn validate_role_slug(slug: &str) -> Result<(), String> {
    if slug.trim().is_empty()
        || !slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Err("slug 必须为非空的小写字母/数字/下划线".into());
    }
    Ok(())
}

/// 找一个不撞 registry 既有 agent(内置或动态)的 slug —— 撞了加 `_2`/`_3`…
/// commit_dynamic_team 在注册每个角色前调,避免整团因撞名失败。
async fn unique_role_slug(state: &AppState, base: &str) -> String {
    let reg = state.agent_registry.read().await;
    if reg.get(base).is_none() {
        return base.to_string();
    }
    for i in 2..1000 {
        let cand = format!("{base}_{i}");
        if reg.get(&cand).is_none() {
            return cand;
        }
    }
    format!("{base}_{}", chrono::Utc::now().timestamp_millis())
}

/// 把团队名清成安全的目录名。**白名单**:字母/数字(`is_alphanumeric` 含 CJK)+ 空格/`-`/`_`,
/// 其余(`/` `\` `:` `.` 及 Unicode 形似分隔符如 U+FF0F/U+2044 等)一律 → `_`;再去收尾的
/// `.`/`_`/空白,杜绝 `..` 等。空则回落"团队"。配合 `-{gid}` 后缀,保证是单层安全叶子名。
fn sanitize_team_folder(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let cleaned = cleaned
        .trim_matches(|c: char| c == '.' || c == '_' || c.is_whitespace())
        .to_string();
    if cleaned.is_empty() { "团队".to_string() } else { cleaned }
}

/// 落地一支动态团队(G2 白盒 Apply):审阅通过的 RoleSpec[] → 逐个收养成 companion →
/// 建群 + 拉成员 + 隔离工作区。返回 group_id(前端复用"建群即开聊"进群)。
///
/// 每个角色走 `register_dynamic_role_impl` 的安全路径(撞名拒绝 + adopt-first 防幽灵);
/// slug 先经 `unique_role_slug` 兜底,避免与既有 agent / 批内成员撞名导致整团失败。
#[tauri::command]
pub async fn commit_dynamic_team(
    state: State<'_, AppState>,
    group_name: String,
    emoji: Option<String>,
    roles: Vec<crate::engine::agents::dynamic::RoleSpec>,
) -> Result<i64, String> {
    let group_name = group_name.trim();
    if group_name.is_empty() {
        return Err("先给团队起个名".into());
    }
    if roles.is_empty() {
        return Err("团队至少要一个角色".into());
    }
    if roles.len() > 8 {
        return Err("一个团队最多 8 个角色".into());
    }

    // 落地前把每个角色的格式校验一遍(emoji/color/slug),format 错就 fail-fast,
    // 不留半队已收养的 companion。
    for role in &roles {
        validate_emoji(&role.emoji)?;
        validate_color(&role.color)?;
        validate_role_slug(&role.slug)?;
    }

    // 逐个落地。slug 先唯一化(读 registry,含已注册的批内成员),再 register。
    // 任一角色失败 → 整团回滚:退休已收养的成员,不留半队孤儿 companion 在伙伴面板。
    // (已注册的 AGENT.md/registry 定义是受限孤儿定义,benign,不会被跑到,留待后续 GC。)
    let mut member_ids = Vec::with_capacity(roles.len());
    for mut role in roles {
        role.slug = unique_role_slug(&state, &role.slug).await;
        match register_dynamic_role_impl(&state, role).await {
            Ok(id) => member_ids.push(id),
            Err(e) => {
                for cid in &member_ids {
                    let _ = state.db.retire_companion(*cid);
                }
                return Err(e);
            }
        }
    }

    // 建群 + 拉成员入群。
    let emoji = emoji
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .unwrap_or("🛠️");
    let group_id = state.db.create_companion_group(group_name, Some(emoji), Some("#6366F1"))?;
    for cid in &member_ids {
        state.db.add_group_member(group_id, *cid)?;
    }

    // 隔离项目工作区(同软件公司团队:落 ~/Documents/YiYi/projects/<团队名>-<gid>/)。
    let user_ws = {
        let g = state.user_workspace.read().unwrap_or_else(|e| e.into_inner());
        g.clone()
    };
    let folder = format!("{}-{group_id}", sanitize_team_folder(group_name));
    let workspace = user_ws.join("projects").join(folder);
    std::fs::create_dir_all(&workspace).map_err(|e| format!("建项目工作区失败: {e}"))?;
    state.db.set_group_workspace(group_id, &workspace.to_string_lossy())?;

    Ok(group_id)
}

// ── S1:一键组建软件公司团队 ─────────────────────────────────────────────

/// 软件公司角色清单。顺序 = 群成员展示顺序。
/// (agent_definition slug, 中文名, emoji, 颜色, 「擅长」label)。slug 对应
/// `BUILTIN_AGENTS` 里的角色定义;persona 取该定义的 instructions(AGENT.md body)。
/// 工具权限/步数由 F2 经 `agent_definition_name` 在群聊执行器里真生效。
const SW_COMPANY_ROLES: &[(&str, &str, &str, &str, &str)] = &[
    ("pm", "产品经理", "🧭", "#3B82F6", "需求澄清与项目协调"),
    ("ui_designer", "UI 设计师", "🎨", "#EC4899", "界面与交互设计"),
    ("frontend_dev", "前端工程师", "💻", "#10B981", "前端开发"),
    ("backend_dev", "后端工程师", "⚙️", "#F59E0B", "后端开发"),
    ("qa_engineer", "测试工程师", "🔍", "#8B5CF6", "测试与质量把关"),
];

/// 找一个不与现有伙伴冲突的名字(companions.name 全局唯一)。重复成团时
/// 自动加序号("产品经理 2"),避免硬失败。
fn unique_companion_name(db: &crate::engine::db::Database, base: &str) -> String {
    if db.get_companion_by_name(base).is_none() {
        return base.to_string();
    }
    for i in 2..1000 {
        let candidate = format!("{base} {i}");
        if db.get_companion_by_name(&candidate).is_none() {
            return candidate;
        }
    }
    format!("{base} {}", chrono::Utc::now().timestamp_millis())
}

/// 一键收养"软件公司"团队:批量收养 5 个角色(PM / UI / 前端 / 后端 / 测试),
/// 建一个"软件公司"群并把他们拉进去。返回新群的 group_id(前端据此进群聊)。
///
/// 每个角色的 persona 取其 AGENT.md instructions 写进 companions/<id>/persona.md
/// (run_one_react 据此注入人设);工具权限/步数随 agent_definition,经 F2 真生效。
#[tauri::command]
pub async fn adopt_software_company_team(state: State<'_, AppState>) -> Result<i64, String> {
    adopt_software_company_team_impl(&state).await
}

pub async fn adopt_software_company_team_impl(state: &AppState) -> Result<i64, String> {
    let registry = state.agent_registry.read().await;
    let mut member_ids: Vec<i64> = Vec::with_capacity(SW_COMPANY_ROLES.len());

    for (slug, base_name, emoji, color, label) in SW_COMPANY_ROLES {
        // 角色定义必须在 registry(否则 F2 解析不到权限,等于裸 agent)。
        let def = registry
            .get(slug)
            .ok_or_else(|| format!("角色定义 '{slug}' 未注册"))?;
        let persona = def.instructions.clone();

        let name = unique_companion_name(&state.db, base_name);
        let now = chrono::Utc::now().timestamp_millis();
        // memory_user_id 必须全局唯一。批量收养在同一毫秒内、且纯 CJK 名 slugify 会折叠
        // (如"产品经理 2"→"_2"),不能靠 now+slug 兜底 —— 用 UUID 保证唯一。
        let memory_user_id = format!("companion_{}_{}", now, uuid::Uuid::new_v4().simple());

        let id = state.db.adopt_companion(&NewCompanion {
            name,
            agent_definition_name: slug.to_string(),
            avatar_emoji: emoji.to_string(),
            color_hex: color.to_string(),
            persona_md_path: None,
            memory_user_id,
            metadata_json: None,
            role_label: Some(label.to_string()),
        })?;

        // 把角色 persona 落到 companions/<id>/persona.md,群聊执行器据此注入人设。
        if let Some(path) =
            persist_persona(state.working_dir.as_path(), id, Some(persona.as_str()))?
        {
            state.db.update_companion(
                id,
                &CompanionUpdate {
                    persona_md_path: Some(Some(path)),
                    ..Default::default()
                },
            )?;
        }
        member_ids.push(id);
    }
    drop(registry);

    // 建"软件公司"群 + 拉成员入群。
    let group_id = state
        .db
        .create_companion_group("软件公司", Some("🏢"), Some("#6366F1"))?;
    for cid in member_ids {
        state.db.add_group_member(group_id, cid)?;
    }

    // S2 步骤①:给团队分配一个隔离的、用户可见的项目工作区。成员的文件/shell 工具
    // 落在这里(run_one_react 据 group_workspace_for_collaboration 解析并 scope),
    // 不污染用户默认工作区,产出可直接打开/拿走。
    let user_ws = {
        let g = state.user_workspace.read().unwrap_or_else(|e| e.into_inner());
        g.clone()
    };
    let workspace = user_ws.join("projects").join(format!("软件公司-{group_id}"));
    std::fs::create_dir_all(&workspace).map_err(|e| format!("建项目工作区失败: {e}"))?;
    state
        .db
        .set_group_workspace(group_id, &workspace.to_string_lossy())?;

    Ok(group_id)
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
// ── G2:agent 自生成团队 ──────────────────────────────────────────────────

/// 据用户目标,让 LLM 生成一支角色团队(`RoleSpec` 草稿)。**不落地** —— 走白盒
/// Draft → Review → Apply:返回草稿给前端审阅/编辑,用户确认后再 `commit_dynamic_team`。
///
/// 安全:profile 只能是四档之一,LLM 乱填会被 `parse_team_from_json` 落到最安全的 Coordinator。
#[tauri::command]
pub async fn generate_team(
    state: State<'_, AppState>,
    goal: String,
) -> Result<Vec<crate::engine::agents::dynamic::RoleSpec>, String> {
    let goal = goal.trim();
    if goal.is_empty() {
        return Err("先描述要做什么".into());
    }
    let mut config = resolve_llm_config(&state).await?;
    config.enable_thinking = Some(false);
    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(build_team_gen_prompt(goal))),
        tool_calls: None,
        tool_call_id: None,
        reasoning_content: None,
    }];
    let resp = chat_completion_tracked(UsageSource::Growth, &config, &messages, &[]).await?;
    let text = resp.message.content.map(|c| c.into_text()).unwrap_or_default();
    let json = extract_json_object(&text).ok_or_else(|| "组队这次没说清,再试一次".to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("组队结果格式不对({e}),再试一次"))?;
    let team = crate::engine::agents::dynamic::parse_team_from_json(&v);
    if team.is_empty() {
        return Err("没生成出有效角色,换个说法再试".into());
    }
    Ok(team)
}

fn build_team_gen_prompt(goal: &str) -> String {
    format!(
        "用户要做这件事:「{goal}」\n\n\
         为这个目标组建一支 3-5 人的 AI 角色团队,模拟真实协作。每个角色职责清晰、不重叠。\n\
         **只输出一个 JSON 对象**,不要代码块、不要解释:\n\
         {{\"roles\": [{{\
         \"slug\": \"english_snake_case 标识(纯小写字母/数字/下划线)\", \
         \"name\": \"2-8 字中文角色名\", \
         \"description\": \"一句话职责(12 字内)\", \
         \"emoji\": \"一个贴切 emoji\", \
         \"color\": \"#RRGGBB 十六进制色\", \
         \"profile\": \"四选一权限档位\", \
         \"persona\": \"50-120 字角色人设/工作方式,第二人称'你是…'\"\
         }}]}}\n\n\
         profile 必须从这四档里选(决定能用什么工具,按职责选**最小够用**的):\n\
         - coordinator:协调/规划型 —— 能问用户、读资料,**不写文件不跑命令**。适合产品、策划、协调。\n\
         - designer:设计/文档型 —— 能问用户、读写文件,**不跑命令**。适合设计、文案、方案。\n\
         - builder:开发型 —— 能读写文件 + **跑命令/脚本**。只给真正要写代码/做实现的角色。\n\
         - reviewer:测试/评审型 —— 能读 + **跑命令(测试)** + 写测试。适合测试、质检。\n\
         至少有一个 coordinator 牵头。不要轻易给 builder/reviewer(那是能跑命令的高权限档)。"
    )
}

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
