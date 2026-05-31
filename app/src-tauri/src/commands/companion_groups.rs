//! Tauri 命令面:companion groups(群)CRUD + 成员管理 + session 绑组。
//!
//! 多对多关系 —— 一个 companion 可同时在多个组(类比微信群)。每组对应一个
//! `group_shared_<id>` 记忆桶,通过 `MemoryScope::Group(id)` 路由。
//! Phase A 的"全 active 隐式群 + 单一 family_shared 桶"作为回落保留
//! (session.group_id IS NULL 时生效)。

use tauri::State;

use crate::engine::db::{Companion, CompanionGroup};
use crate::state::AppState;

// ── group CRUD ────────────────────────────────────────────────────────

pub async fn create_companion_group_impl(
    state: &AppState,
    name: String,
    emoji: Option<String>,
    color_hex: Option<String>,
) -> Result<i64, String> {
    state
        .db
        .create_companion_group(&name, emoji.as_deref(), color_hex.as_deref())
}

#[tauri::command]
pub async fn create_companion_group(
    state: State<'_, AppState>,
    name: String,
    emoji: Option<String>,
    color_hex: Option<String>,
) -> Result<i64, String> {
    create_companion_group_impl(&state, name, emoji, color_hex).await
}

pub async fn list_companion_groups_impl(state: &AppState) -> Result<Vec<CompanionGroup>, String> {
    Ok(state.db.list_companion_groups())
}

#[tauri::command]
pub async fn list_companion_groups(
    state: State<'_, AppState>,
) -> Result<Vec<CompanionGroup>, String> {
    list_companion_groups_impl(&state).await
}

pub async fn get_companion_group_impl(
    state: &AppState,
    id: i64,
) -> Result<Option<CompanionGroup>, String> {
    Ok(state.db.get_companion_group(id))
}

#[tauri::command]
pub async fn get_companion_group(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<CompanionGroup>, String> {
    get_companion_group_impl(&state, id).await
}

pub async fn update_companion_group_impl(
    state: &AppState,
    id: i64,
    name: String,
    emoji: Option<String>,
    color_hex: Option<String>,
) -> Result<(), String> {
    state
        .db
        .update_companion_group(id, &name, emoji.as_deref(), color_hex.as_deref())
}

#[tauri::command]
pub async fn update_companion_group(
    state: State<'_, AppState>,
    id: i64,
    name: String,
    emoji: Option<String>,
    color_hex: Option<String>,
) -> Result<(), String> {
    update_companion_group_impl(&state, id, name, emoji, color_hex).await
}

pub async fn delete_companion_group_impl(state: &AppState, id: i64) -> Result<(), String> {
    state.db.delete_companion_group(id)
}

#[tauri::command]
pub async fn delete_companion_group(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    delete_companion_group_impl(&state, id).await
}

// ── membership ────────────────────────────────────────────────────────

pub async fn add_companion_to_group_impl(
    state: &AppState,
    group_id: i64,
    companion_id: i64,
) -> Result<(), String> {
    state.db.add_group_member(group_id, companion_id)
}

#[tauri::command]
pub async fn add_companion_to_group(
    state: State<'_, AppState>,
    group_id: i64,
    companion_id: i64,
) -> Result<(), String> {
    add_companion_to_group_impl(&state, group_id, companion_id).await
}

pub async fn remove_companion_from_group_impl(
    state: &AppState,
    group_id: i64,
    companion_id: i64,
) -> Result<(), String> {
    state.db.remove_group_member(group_id, companion_id)
}

#[tauri::command]
pub async fn remove_companion_from_group(
    state: State<'_, AppState>,
    group_id: i64,
    companion_id: i64,
) -> Result<(), String> {
    remove_companion_from_group_impl(&state, group_id, companion_id).await
}

pub async fn list_group_members_impl(
    state: &AppState,
    group_id: i64,
) -> Result<Vec<Companion>, String> {
    Ok(state.db.list_group_members(group_id))
}

#[tauri::command]
pub async fn list_group_members(
    state: State<'_, AppState>,
    group_id: i64,
) -> Result<Vec<Companion>, String> {
    list_group_members_impl(&state, group_id).await
}

pub async fn list_groups_for_companion_impl(
    state: &AppState,
    companion_id: i64,
) -> Result<Vec<CompanionGroup>, String> {
    Ok(state.db.list_groups_for_companion(companion_id))
}

#[tauri::command]
pub async fn list_groups_for_companion(
    state: State<'_, AppState>,
    companion_id: i64,
) -> Result<Vec<CompanionGroup>, String> {
    list_groups_for_companion_impl(&state, companion_id).await
}

// ── session ↔ group binding ───────────────────────────────────────────

pub async fn set_session_group_impl(
    state: &AppState,
    session_id: String,
    group_id: Option<i64>,
) -> Result<(), String> {
    state.db.set_session_group(&session_id, group_id)
}

/// 绑定会话到指定群(None = 解绑,回落 Phase A 全员)。
#[tauri::command]
pub async fn set_session_group(
    state: State<'_, AppState>,
    session_id: String,
    group_id: Option<i64>,
) -> Result<(), String> {
    set_session_group_impl(&state, session_id, group_id).await
}

pub async fn get_session_group_impl(
    state: &AppState,
    session_id: String,
) -> Result<Option<i64>, String> {
    Ok(state.db.get_session_group(&session_id))
}

#[tauri::command]
pub async fn get_session_group(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<i64>, String> {
    get_session_group_impl(&state, session_id).await
}
