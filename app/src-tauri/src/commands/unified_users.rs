use serde::{Deserialize, Serialize};
use tauri::State;

use crate::engine::db::{UnifiedUserRow, UserIdentityRow};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedUserInfo {
    pub id: String,
    pub display_name: Option<String>,
    pub identities: Vec<UserIdentityRow>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<UnifiedUserRow> for UnifiedUserInfo {
    fn from(row: UnifiedUserRow) -> Self {
        Self {
            id: row.id,
            display_name: row.display_name,
            identities: vec![],
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[tauri::command]
pub async fn unified_users_list(
    state: State<'_, AppState>,
) -> Result<Vec<UnifiedUserInfo>, String> {
    let users = state.db.list_unified_users()?;
    let mut result = Vec::with_capacity(users.len());
    for user in users {
        let identities = state.db.list_user_identities(&user.id)?;
        let mut info = UnifiedUserInfo::from(user);
        info.identities = identities;
        result.push(info);
    }
    Ok(result)
}

#[tauri::command]
pub async fn unified_users_create(
    state: State<'_, AppState>,
    display_name: Option<String>,
) -> Result<UnifiedUserInfo, String> {
    let user = state.db.create_unified_user(display_name.as_deref())?;
    Ok(UnifiedUserInfo::from(user))
}

#[tauri::command]
pub async fn unified_users_link(
    state: State<'_, AppState>,
    unified_user_id: String,
    platform: String,
    platform_user_id: String,
    bot_id: String,
    display_name: Option<String>,
) -> Result<(), String> {
    // Verify unified user exists
    state.db.get_unified_user(&unified_user_id)?
        .ok_or_else(|| format!("Unified user '{}' not found", unified_user_id))?;

    state.db.link_identity(
        &platform,
        &platform_user_id,
        &bot_id,
        &unified_user_id,
        display_name.as_deref(),
    )
}

#[tauri::command]
pub async fn unified_users_unlink(
    state: State<'_, AppState>,
    platform: String,
    platform_user_id: String,
    bot_id: String,
) -> Result<(), String> {
    state.db.unlink_identity(&platform, &platform_user_id, &bot_id)
}
