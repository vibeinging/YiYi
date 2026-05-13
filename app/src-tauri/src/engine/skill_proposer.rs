//! Skill proposer — scans recent conversation history, identifies recurring
//! tool-call patterns, and asks the LLM whether each pattern is worth
//! distilling into a reusable skill. Proposals land in the inbox for user
//! review (white-box co-construction; see Growth V3 design doc).
//!
//! Pipeline (cheap first):
//!   1. Gather tool sequences from sessions in the last N days (DB scan, no LLM).
//!   2. Find recurring N-grams across sessions (pure rules, no LLM).
//!   3. Drop n-grams already covered by a longer one, or already proposed.
//!   4. For the top K survivors, fork an LLM call (UsageSource::Growth) that
//!      either accepts and produces a SKILL.md draft, or rejects.
//!   5. Persist accepted drafts as inbox_items with kind='skill_create'.
//!
//! This module is intentionally side-effect-light: it only writes to the
//! `inbox_items` table. SKILL.md files are NOT written here — that happens
//! during approve.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::db::{Database, NewInboxItem};
use super::llm_client::{chat_completion_tracked, LLMConfig, LLMMessage, MessageContent};
use super::usage::UsageSource;

const DEFAULT_DAYS_BACK: i64 = 30;
const DEFAULT_MIN_REPEAT: usize = 3;
const MIN_NGRAM_LEN: usize = 2;
const MAX_NGRAM_LEN: usize = 5;
const TOP_K_CANDIDATES: usize = 5;
const MAX_MESSAGES_PER_SESSION: usize = 500;

/// JSON shape stored in `inbox_items.draft_json` for kind='skill_create'.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDraft {
    pub name: String,
    pub description: String,
    /// Full SKILL.md text including YAML frontmatter.
    pub content: String,
    pub confidence: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct NgramEvidence {
    pub tools: Vec<String>,
    pub occurrence_count: usize,
    pub session_ids: Vec<String>,
}

/// Public entry. Returns the list of inserted `inbox_items.id` values.
pub async fn propose_skills_from_history(
    config: &LLMConfig,
    db: &Database,
    source: &str,
) -> Result<Vec<String>, String> {
    let sequences = collect_tool_sequences(db, DEFAULT_DAYS_BACK);
    if sequences.is_empty() {
        log::info!("skill_proposer: no recent sessions with tool calls");
        return Ok(vec![]);
    }

    let candidates = find_recurring_ngrams(&sequences, DEFAULT_MIN_REPEAT);
    if candidates.is_empty() {
        log::info!("skill_proposer: no recurring tool patterns found");
        return Ok(vec![]);
    }
    log::info!(
        "skill_proposer: {} candidate patterns from {} sessions",
        candidates.len(),
        sequences.len()
    );

    let top: Vec<&NgramCandidate> = candidates.iter().take(TOP_K_CANDIDATES).collect();

    let mut item_ids = Vec::new();
    for cand in top {
        match evaluate_candidate(config, cand).await {
            Ok(Some(draft)) => {
                if db.has_similar_skill_proposal(&draft.name, &draft.description, 7) {
                    log::info!("skill_proposer: skipping similar skill '{}'", draft.name);
                    continue;
                }
                let draft_json = match serde_json::to_string(&draft) {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("skill_proposer: serialize draft failed: {}", e);
                        continue;
                    }
                };
                let evidence_json = serde_json::to_string(&cand.evidence).ok();
                let id = Uuid::new_v4().to_string();
                let item = NewInboxItem {
                    id: id.clone(),
                    kind: "skill_create".into(),
                    draft_json,
                    source: source.into(),
                    reason: draft.reason.clone(),
                    confidence: draft.confidence,
                    evidence_json,
                };
                if let Err(e) = db.insert_inbox_item(&item) {
                    log::warn!("skill_proposer: insert failed: {}", e);
                    continue;
                }
                log::info!(
                    "skill_proposer: proposed skill '{}' (confidence={:.2})",
                    draft.name,
                    draft.confidence
                );
                item_ids.push(id);
            }
            Ok(None) => {
                log::debug!("skill_proposer: LLM rejected candidate {:?}", cand.tools);
            }
            Err(e) => {
                log::warn!("skill_proposer: evaluate failed: {}", e);
            }
        }
    }

    Ok(item_ids)
}

#[derive(Debug, Clone)]
struct ToolSequence {
    session_id: String,
    tools: Vec<String>,
}

#[derive(Debug, Clone)]
struct NgramCandidate {
    tools: Vec<String>,
    #[allow(dead_code)]
    count: usize,
    evidence: NgramEvidence,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn collect_tool_sequences(db: &Database, days_back: i64) -> Vec<ToolSequence> {
    let cutoff = now_ms() - days_back * 86_400_000;
    let sessions = match db.list_sessions() {
        Ok(s) => s,
        Err(e) => {
            log::warn!("skill_proposer: list_sessions failed: {}", e);
            return vec![];
        }
    };

    let mut sequences = Vec::new();
    for s in sessions {
        if s.updated_at < cutoff {
            continue;
        }
        let msgs = match db.get_messages(&s.id, Some(MAX_MESSAGES_PER_SESSION)) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let tools = extract_tool_names(&msgs);
        if tools.len() >= MIN_NGRAM_LEN {
            sequences.push(ToolSequence {
                session_id: s.id,
                tools,
            });
        }
    }
    sequences
}

fn extract_tool_names(msgs: &[super::db::ChatMessage]) -> Vec<String> {
    let mut tools = Vec::new();
    for m in msgs {
        if m.role != "assistant" {
            continue;
        }
        let meta_str = match m.metadata.as_ref() {
            Some(s) => s,
            None => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(meta_str) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(arr) = v.get("tool_calls").and_then(|x| x.as_array()) {
            for tc in arr {
                if let Some(name) = tc.get("name").and_then(|x| x.as_str()) {
                    tools.push(name.to_string());
                }
            }
        }
    }
    tools
}

fn find_recurring_ngrams(
    sequences: &[ToolSequence],
    min_repeat: usize,
) -> Vec<NgramCandidate> {
    let mut counter: HashMap<Vec<String>, (usize, Vec<String>)> = HashMap::new();

    for seq in sequences {
        let mut seen: HashSet<Vec<String>> = HashSet::new();
        let max_n = MAX_NGRAM_LEN.min(seq.tools.len());
        for n in MIN_NGRAM_LEN..=max_n {
            for window in seq.tools.windows(n) {
                let ngram: Vec<String> = window.to_vec();
                if seen.insert(ngram.clone()) {
                    let entry = counter.entry(ngram).or_insert((0, Vec::new()));
                    entry.0 += 1;
                    entry.1.push(seq.session_id.clone());
                }
            }
        }
    }

    let mut candidates: Vec<NgramCandidate> = counter
        .into_iter()
        .filter(|(_, (count, _))| *count >= min_repeat)
        .map(|(tools, (count, session_ids))| {
            let evidence = NgramEvidence {
                tools: tools.clone(),
                occurrence_count: count,
                session_ids,
            };
            NgramCandidate {
                tools,
                count,
                evidence,
            }
        })
        .collect();

    // Prefer longer + more frequent patterns.
    candidates.sort_by(|a, b| {
        b.tools.len().cmp(&a.tools.len()).then(b.count.cmp(&a.count))
    });

    // Drop n-grams that are sub-windows of an already-kept longer pattern.
    let mut filtered: Vec<NgramCandidate> = Vec::new();
    for cand in candidates {
        let is_sub = filtered.iter().any(|kept| {
            kept.tools.len() > cand.tools.len() && contains_window(&kept.tools, &cand.tools)
        });
        if !is_sub {
            filtered.push(cand);
        }
    }
    filtered
}

fn contains_window(haystack: &[String], needle: &[String]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

async fn evaluate_candidate(
    config: &LLMConfig,
    cand: &NgramCandidate,
) -> Result<Option<SkillDraft>, String> {
    let tools_str = cand.tools.join(" → ");
    let prompt = format!(
        "你在观察 YiYi（一个 ReAct agent）的历史行为。过去 30 天里，下面这套工具调用序列\n\
         在 {sess} 个不同的会话中重复出现了 {cnt} 次：\n\n\
         工具序列：{tools}\n\n\
         请判断这套流程是否值得固化为一个可复用的 skill（agent skill）。\n\
         好的 skill 标准：\n\
         - 工具序列稳定、有清晰的起止点\n\
         - 流程有明确的触发条件（「何时使用」）\n\
         - 提供的价值超过裸工具组合（有思维步骤、参数模式或经验）\n\n\
         严格输出 JSON 对象，不要包裹在代码块里，不要有任何其他文字：\n\
         {{\n  \
            \"should_create\": true|false,\n  \
            \"name\": \"kebab-case-name（仅 should_create=true 时填）\",\n  \
            \"description\": \"一句话描述，≤30 字\",\n  \
            \"content\": \"完整的 SKILL.md 内容主体，markdown 格式，包含「何时使用」「步骤」「示例」三节。不要写 YAML frontmatter（系统会自动加）\",\n  \
            \"confidence\": 0.0-1.0,\n  \
            \"reason\": \"为什么值得（或不值得）固化的一句话理由\"\n\
         }}",
        sess = cand.evidence.session_ids.len(),
        cnt = cand.evidence.occurrence_count,
        tools = tools_str,
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
        reasoning_content: None,
    }];

    let response = chat_completion_tracked(UsageSource::Growth, config, &messages, &[])
        .await
        .map_err(|e| format!("evaluate_candidate llm: {}", e))?;

    let raw = response
        .message
        .content
        .map(|c| c.into_text())
        .unwrap_or_default();

    let json_str = extract_json_block(&raw);
    if json_str.is_empty() {
        return Ok(None);
    }

    let parsed: serde_json::Value = match serde_json::from_str(&json_str) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("skill_proposer: failed to parse LLM JSON: {}", e);
            return Ok(None);
        }
    };

    if !parsed
        .get("should_create")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Ok(None);
    }

    let name = parsed
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return Ok(None);
    }
    let description = parsed
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let body = parsed
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let confidence = parsed
        .get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.5)
        .clamp(0.0, 1.0);
    let reason = parsed
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("agent 识别到重复使用的工具流程")
        .to_string();

    let now_iso = chrono::Utc::now().to_rfc3339();
    let sessions_yaml = cand
        .evidence
        .session_ids
        .iter()
        .map(|s| format!("      - {}", s))
        .collect::<Vec<_>>()
        .join("\n");

    let skill_md = format!(
        "---\n\
         name: {name}\n\
         description: {desc}\n\
         metadata:\n  \
           yiyi:\n    \
             source: inbox_pending\n    \
             proposed_at: {ts}\n    \
             agent_confidence: {conf}\n    \
             evidence_sessions:\n{sessions}\n\
         ---\n\n\
         {body}\n",
        name = name,
        desc = description,
        ts = now_iso,
        conf = confidence,
        sessions = sessions_yaml,
        body = body,
    );

    Ok(Some(SkillDraft {
        name,
        description,
        content: skill_md,
        confidence,
        reason,
    }))
}

fn extract_json_block(text: &str) -> String {
    let trimmed = text.trim();
    // Strip ```json ... ``` fences if present.
    let stripped = if let Some(rest) = trimmed.strip_prefix("```json") {
        rest.trim_start_matches('\n').trim_end_matches("```").trim()
    } else if let Some(rest) = trimmed.strip_prefix("```") {
        rest.trim_start_matches('\n').trim_end_matches("```").trim()
    } else {
        trimmed
    };
    if stripped.starts_with('{') && stripped.ends_with('}') {
        return stripped.to_string();
    }
    if let (Some(start), Some(end)) = (stripped.find('{'), stripped.rfind('}')) {
        if end > start {
            return stripped[start..=end].to_string();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ngram_filter_drops_sub_windows() {
        let sequences = vec![
            ToolSequence {
                session_id: "s1".into(),
                tools: vec!["a".into(), "b".into(), "c".into()],
            },
            ToolSequence {
                session_id: "s2".into(),
                tools: vec!["a".into(), "b".into(), "c".into()],
            },
            ToolSequence {
                session_id: "s3".into(),
                tools: vec!["a".into(), "b".into(), "c".into()],
            },
        ];
        let cands = find_recurring_ngrams(&sequences, 3);
        // longest pattern [a,b,c] should be kept; [a,b] and [b,c] should be dropped.
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].tools, vec!["a", "b", "c"]);
    }

    #[test]
    fn ngram_needs_min_repeat_across_sessions() {
        let sequences = vec![
            ToolSequence {
                session_id: "s1".into(),
                tools: vec!["a".into(), "b".into(), "a".into(), "b".into()],
            },
        ];
        let cands = find_recurring_ngrams(&sequences, 3);
        // Even though [a,b] appears twice in one session, dedup-per-session caps at 1.
        assert!(cands.is_empty());
    }

    #[test]
    fn extract_tool_names_from_metadata() {
        let msgs = vec![super::super::db::ChatMessage {
            id: 1,
            session_id: "s".into(),
            role: "assistant".into(),
            content: "".into(),
            timestamp: 0,
            metadata: Some(
                r#"{"tool_calls":[{"id":"a","name":"shell","arguments":"ls"},{"id":"b","name":"read_file","arguments":""}]}"#.into(),
            ),
        }];
        let tools = extract_tool_names(&msgs);
        assert_eq!(tools, vec!["shell", "read_file"]);
    }

    #[test]
    fn json_block_extraction_handles_fences() {
        let with_fence = "```json\n{\"a\":1}\n```";
        assert_eq!(extract_json_block(with_fence), "{\"a\":1}");
        let raw = "noise {\"a\":1} more";
        assert_eq!(extract_json_block(raw), "{\"a\":1}");
    }
}
