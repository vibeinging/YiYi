//! Tauri commands for the Growth V3 Inbox.
//!
//! User flow: agent proposes drafts (via meditation or manual button) →
//! drafts live in `inbox_items` table → user reviews in Buddy UI →
//! approve writes SKILL.md to customized_skills/, reject just marks status.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::agent::resolve_llm_config;
use crate::commands::skills::create_skill_impl;
use crate::engine::db::InboxItem;
use crate::engine::skill_proposer::{propose_skills_from_history, SkillDraft};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposeResult {
    pub created_count: usize,
    pub item_ids: Vec<String>,
}

/// User-initiated trigger: scan history → propose skills now.
/// Runs synchronously; UI shows a spinner. Returns the new pending items.
#[tauri::command]
pub async fn propose_skills_now(state: State<'_, AppState>) -> Result<ProposeResult, String> {
    let config = resolve_llm_config(&state).await?;
    let db = state.db.clone();

    // Run on a background thread so the proposer's DB scans + LLM call don't block the Tauri thread.
    let result = tokio::task::spawn(async move {
        propose_skills_from_history(&config, &db, "user_request").await
    })
    .await
    .map_err(|e| format!("propose task join: {}", e))??;

    Ok(ProposeResult {
        created_count: result.len(),
        item_ids: result,
    })
}

#[tauri::command]
pub async fn list_inbox_items(
    state: State<'_, AppState>,
    status: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<InboxItem>, String> {
    let limit = limit.unwrap_or(50).min(200);
    Ok(state
        .db
        .list_inbox_items(status.as_deref(), limit))
}

#[tauri::command]
pub async fn count_pending_inbox(state: State<'_, AppState>) -> Result<i64, String> {
    Ok(state.db.count_pending_inbox())
}

#[tauri::command]
pub async fn get_inbox_item(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<InboxItem>, String> {
    Ok(state.db.get_inbox_item(&id))
}

/// Approve a `skill_create` item: writes SKILL.md to customized_skills/.
/// `edited_content`, if provided, replaces the draft's content body before write.
#[tauri::command]
pub async fn approve_inbox_item(
    state: State<'_, AppState>,
    id: String,
    edited_content: Option<String>,
    note: Option<String>,
) -> Result<(), String> {
    let item = state
        .db
        .get_inbox_item(&id)
        .ok_or_else(|| format!("inbox item {} not found", id))?;
    if item.status != "pending" {
        return Err(format!("item already {}", item.status));
    }

    match item.kind.as_str() {
        "skill_create" => apply_skill_create(&state, &item, edited_content.as_deref(), note.as_deref()).await,
        other => Err(format!("approve not implemented for kind '{}'", other)),
    }
}

async fn apply_skill_create(
    state: &AppState,
    item: &InboxItem,
    edited_content: Option<&str>,
    note: Option<&str>,
) -> Result<(), String> {
    let draft: SkillDraft = serde_json::from_str(&item.draft_json)
        .map_err(|e| format!("malformed draft_json: {}", e))?;

    let content = edited_content.unwrap_or(&draft.content).to_string();

    // Mark approved (or edit_approved) BEFORE writing file — so re-tries don't double-write.
    state
        .db
        .mark_inbox_approved(&item.id, edited_content, note)?;

    // Stamp metadata.yiyi.source = inbox_approved and approved_at into the file (best-effort).
    let stamped = stamp_provenance(&content, &item.id);

    create_skill_impl(state, draft.name.clone(), stamped, None, None)
        .await
        .map_err(|e| format!("write SKILL.md: {}", e))?;

    state.db.mark_inbox_applied(&item.id)?;
    Ok(())
}

/// Rewrite `source: inbox_pending` → `source: inbox_approved` and append `approved_at`/`inbox_item_id`.
/// Best-effort: if the frontmatter shape is unexpected, leave content as-is.
fn stamp_provenance(content: &str, inbox_id: &str) -> String {
    let now_iso = chrono::Utc::now().to_rfc3339();
    let replaced_source = content.replacen(
        "source: inbox_pending",
        "source: inbox_approved",
        1,
    );
    // Insert approved_at and inbox_item_id right after the source line if we updated it.
    if replaced_source != content {
        let extra = format!(
            "\n    approved_at: {}\n    inbox_item_id: {}",
            now_iso, inbox_id
        );
        if let Some(idx) = replaced_source.find("source: inbox_approved") {
            let line_end = replaced_source[idx..]
                .find('\n')
                .map(|i| idx + i)
                .unwrap_or(replaced_source.len());
            let mut out = String::with_capacity(replaced_source.len() + extra.len());
            out.push_str(&replaced_source[..line_end]);
            out.push_str(&extra);
            out.push_str(&replaced_source[line_end..]);
            return out;
        }
    }
    replaced_source
}

#[tauri::command]
pub async fn reject_inbox_item(
    state: State<'_, AppState>,
    id: String,
    note: Option<String>,
) -> Result<(), String> {
    state.db.reject_inbox_item(&id, note.as_deref())
}

#[tauri::command]
pub async fn withdraw_inbox_item(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.db.withdraw_inbox_item(&id)
}
