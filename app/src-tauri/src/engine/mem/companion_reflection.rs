//! Per-companion 轻量反思(B + C 期)。
//!
//! 和全局 `meditation.rs` **并存、不复用**:全局冥想深绑"全局会话 review +
//! MemMe meditate(主桶)",而伙伴的反思输入本就不同——它是该伙伴
//! `messages WHERE companion_id=?` 的发言 + 它的 `companion_{id}` 记忆桶。
//!
//! - B 期:读该伙伴最近发言 → 一次 LLM 反思 → 产出它自己的性格 delta 信号
//!   (带 companion_id 落库)+ 一段短 journal。
//! - C 期:再对它的 `companion_{id}` 记忆桶跑 MemMe `meditate()`(记忆巩固),
//!   并把整次反思落成一条带 companion_id 的 `meditation_sessions` 历史。
//!
//! YiYi 的 `run_meditation_session` 保持不动(全局),两条路径共享下层信号表 / MemMe。

use log::{info, warn};
use serde::Serialize;

use crate::engine::db::{Database, PersonalitySignal};
use crate::engine::llm_client::{chat_completion_tracked, LLMConfig, LLMMessage, MessageContent};
use crate::engine::usage::UsageSource;

/// 反思最多回看的发言条数。
const REFLECTION_MESSAGE_LIMIT: usize = 24;
/// 单条发言截断字节数(避免长消息撑爆 prompt)。
const MESSAGE_TRUNCATE_BYTES: usize = 220;

#[derive(Debug, Clone, Serialize)]
pub struct CompanionReflectionResult {
    pub companion_id: i64,
    pub messages_reviewed: usize,
    pub signals_added: usize,
    /// 这次对它的记忆桶巩固出的记忆条数(MemMe meditate)。
    pub memories_consolidated: usize,
    /// 一段第一人称的简短反思(给用户看「它在想什么」)。可能为空。
    pub journal: String,
}

/// 对某个记忆桶(companion_{id})跑 MemMe `meditate()`,返回巩固的记忆条数。
/// MemMe 未初始化或出错时返回 0(不致命,反思主体仍算成功)。
fn consolidate_companion_memories(memory_user_id: &str) -> usize {
    let store = match crate::engine::tools::get_memme_store() {
        Some(s) => s,
        None => {
            warn!("Companion reflection: MemMe store not initialized — skipping consolidation");
            return 0;
        }
    };
    let opts = memme_core::types::MeditateOptions::new(
        memory_user_id.to_string(),
        "companion_reflection".to_string(),
    );
    match store.meditate(opts) {
        Ok(record) => (record.memories_created + record.memories_updated) as usize,
        Err(e) => {
            warn!("Companion reflection: MemMe meditate failed for {}: {}", memory_user_id, e);
            0
        }
    }
}

fn truncate_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn extract_json_from_response(text: &str) -> String {
    let trimmed = text.trim();
    // 去掉 ```json ... ``` 围栏
    if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        if let Some(end) = after.find("```") {
            return after[..end].trim().to_string();
        }
    }
    // 退而求其次:截取第一个 { 到最后一个 }
    if let (Some(s), Some(e)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if e > s {
            return trimmed[s..=e].to_string();
        }
    }
    trimmed.to_string()
}

/// 对单个伙伴跑一次轻量反思。
///
/// - `companion_id`: 目标伙伴。
/// - 无发言 / LLM 无明显信号时,返回 0 信号 + 空 journal,**不报错**。
pub async fn run_companion_reflection(
    config: &LLMConfig,
    db: &Database,
    companion_id: i64,
) -> Result<CompanionReflectionResult, String> {
    let companion = db
        .get_companion(companion_id)
        .ok_or_else(|| format!("Companion {} not found", companion_id))?;

    let messages = db.get_companion_recent_messages(companion_id, REFLECTION_MESSAGE_LIMIT)?;
    if messages.is_empty() {
        info!(
            "Companion reflection ({}): no messages — skipped",
            companion.name
        );
        return Ok(CompanionReflectionResult {
            companion_id,
            messages_reviewed: 0,
            signals_added: 0,
            memories_consolidated: 0,
            journal: String::new(),
        });
    }

    // 有发言才开一条反思历史(避免空跑留下空行)。出任何错都 mark failed。
    let session_id = uuid::Uuid::new_v4().to_string();
    db.create_companion_meditation_session(&session_id, companion_id);
    let messages_reviewed = messages.len();

    // 1) LLM 反思 → 性格信号 + journal。出错则 mark failed。
    let (signals_added, journal) =
        match reflect_signals(config, db, &companion, &messages, companion_id).await {
            Ok(v) => v,
            Err(e) => {
                db.update_meditation_session(&session_id, "failed", messages_reviewed as i32, 0, 0, 0, None, Some(&e));
                return Err(e);
            }
        };

    // 2) 对它的记忆桶跑 MemMe 巩固(失败不致命)。
    let memories_consolidated = consolidate_companion_memories(&companion.memory_user_id);

    // 3) 落历史。sessions_reviewed=回看发言数, memories_updated=巩固记忆数,
    //    principles_changed=性格信号数(复用列语义)。
    let journal_opt = if journal.is_empty() { None } else { Some(journal.as_str()) };
    db.update_meditation_session(
        &session_id,
        "completed",
        messages_reviewed as i32,
        memories_consolidated as i32,
        signals_added as i32,
        0,
        journal_opt,
        None,
    );

    info!(
        "Companion reflection ({}): reviewed {} msgs, +{} signals, {} memories consolidated",
        companion.name, messages_reviewed, signals_added, memories_consolidated
    );

    Ok(CompanionReflectionResult {
        companion_id,
        messages_reviewed,
        signals_added,
        memories_consolidated,
        journal,
    })
}

/// LLM 反思核心:产性格信号(带 companion_id 落库)+ journal。返回 (信号数, journal)。
async fn reflect_signals(
    config: &LLMConfig,
    db: &Database,
    companion: &crate::engine::db::Companion,
    messages: &[crate::engine::db::ChatMessage],
    companion_id: i64,
) -> Result<(usize, String), String> {
    // 该伙伴自己的发言,按时间正序拼成片段(查询是 DESC,这里翻回正序)。
    let transcript: Vec<String> = messages
        .iter()
        .rev()
        .map(|m| format!("- {}", truncate_bytes(&m.content, MESSAGE_TRUNCATE_BYTES)))
        .collect();
    let transcript = transcript.join("\n");

    let prompt = format!(
        "你是「{name}」——一个有自己性格的 AI 伙伴。下面是你最近在对话里说过的话。\n\
         请你做一次自我反思:这些发言体现/塑造了你怎样的性格倾向?\n\n\
         五个性格属性:\n\
         - energy(活力):你交流的活跃度、热情\n\
         - warmth(温柔):你流露的温暖、关心、情感深度\n\
         - mischief(调皮):你的幽默、玩闹、轻松\n\
         - wit(聪慧):你的深度思考、技术性、洞察\n\
         - sass(犀利):你的直接、犀利、有态度\n\n\
         你最近说过的话:\n{transcript}\n\n\
         输出 JSON:\n\
         {{\n\
           \"journal\": \"一两句第一人称的反思(如:我发现自己最近更爱开玩笑了)\",\n\
           \"signals\": [{{\"trait\": \"属性名\", \"delta\": 浮点数, \"evidence\": \"一句话原因\"}}]\n\
         }}\n\n\
         规则:\n\
         - 每个属性最多出现一次\n\
         - delta 的**绝对值必须 ≥ 0.3**,否则不要输出该信号\n\
         - delta 范围 -1.0 到 1.0,正数增强、负数减弱\n\
         - 需有**多处具体证据**支持,单条发言不足以产生信号\n\
         - 发言很少/很中性时,signals 输出空数组 []\n\
         - 最多 3 个 signals\n\
         - 只输出 JSON,不要其他文字",
        name = companion.name,
        transcript = transcript,
    );

    let llm_messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
        reasoning_content: None,
    }];

    let response = chat_completion_tracked(UsageSource::Meditation, config, &llm_messages, &[])
        .await
        .map_err(|e| format!("Companion reflection LLM call failed: {}", e))?;

    let text = response
        .message
        .content
        .map(|c| c.into_text())
        .unwrap_or_default();

    let json_str = extract_json_from_response(&text);
    let parsed: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| {
        format!(
            "Failed to parse companion reflection JSON: {} (raw: {})",
            e,
            truncate_bytes(&text, 200)
        )
    })?;

    let journal = parsed
        .get("journal")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();

    let signals: Vec<PersonalitySignal> = parsed
        .get("signals")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let trait_name = s.get("trait")?.as_str()?.to_string();
                    let delta = s.get("delta")?.as_f64()?;
                    let evidence = s.get("evidence")?.as_str()?.to_string();
                    if !["energy", "warmth", "mischief", "wit", "sass"]
                        .contains(&trait_name.as_str())
                    {
                        return None;
                    }
                    Some(PersonalitySignal {
                        trait_name,
                        delta: delta.clamp(-1.0, 1.0),
                        evidence,
                        memory_id: None,
                    })
                })
                .take(3)
                .collect()
        })
        .unwrap_or_default();

    let signals_added = signals.len();
    if signals_added > 0 {
        db.add_personality_signals(&signals, None, Some(companion_id))?;
    }

    Ok((signals_added, journal))
}

/// 一晚最多自动反思的伙伴数(错峰,避免 N 伙伴 = N 次 LLM 一次性烧光)。
const MAX_AUTO_REFLECTIONS_PER_RUN: usize = 5;

/// 在全局冥想尾部顺带反思「活跃」伙伴(C 期·自动调度)。
///
/// **不另起 cron**(Design Principle 4):复用既有冥想触发。**规则先筛**——
/// 只对「距上次反思后又有新发言」的伙伴跑 LLM,其余零成本跳过。封顶
/// `MAX_AUTO_REFLECTIONS_PER_RUN`,被截断时 log(Principle 5:不静默截断)。
pub async fn reflect_active_companions(config: &LLMConfig, db: &Database) {
    let companions = db.list_active_companions();
    if companions.is_empty() {
        return;
    }

    // 规则先筛:最近一条发言比上次反思更新 → 才值得花 token。
    let mut due: Vec<i64> = Vec::new();
    for c in &companions {
        let latest_msg_ts = db
            .get_companion_recent_messages(c.id, 1)
            .ok()
            .and_then(|m| m.first().map(|x| x.timestamp))
            .unwrap_or(0);
        if latest_msg_ts == 0 {
            continue; // 从没发过言
        }
        let last_reflect_ts = db
            .list_companion_meditation_sessions(c.id, 1)
            .first()
            .map(|s| s.started_at)
            .unwrap_or(0);
        if latest_msg_ts > last_reflect_ts {
            due.push(c.id);
        }
    }

    if due.is_empty() {
        info!("Auto companion reflection: no companions with new activity — skipped");
        return;
    }

    let total_due = due.len();
    let capped = total_due > MAX_AUTO_REFLECTIONS_PER_RUN;
    if capped {
        // 优先反思 due 列表里靠前的(list_active_companions 默认按近期使用排序)。
        due.truncate(MAX_AUTO_REFLECTIONS_PER_RUN);
        info!(
            "Auto companion reflection: {} due, capping at {} this run (rest next run)",
            total_due, MAX_AUTO_REFLECTIONS_PER_RUN
        );
    } else {
        info!("Auto companion reflection: {} companions due", total_due);
    }

    for id in due {
        if let Err(e) = run_companion_reflection(config, db, id).await {
            warn!("Auto companion reflection failed for companion {}: {}", id, e);
        }
    }
}
