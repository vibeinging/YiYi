use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

fn load_env_file(state: &AppState) -> BTreeMap<String, String> {
    let path = state.working_dir.join(".env");
    let mut map = BTreeMap::new();
    if let Ok(content) = std::fs::read_to_string(&path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim().to_string();
                let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
                map.insert(key, value);
            }
        }
    }
    map
}

fn save_env_file(state: &AppState, map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = state.working_dir.join(".env");
    let content: String = map
        .iter()
        .map(|(k, v)| {
            if v.contains(' ') || v.contains('"') || v.contains('\'') {
                format!("{}=\"{}\"", k, v.replace('"', "\\\""))
            } else {
                format!("{}={}", k, v)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write .env: {}", e))?;

    // Reload into process env
    for (k, v) in map {
        std::env::set_var(k, v);
    }

    Ok(())
}

#[tauri::command]
pub async fn list_envs(state: State<'_, AppState>) -> Result<Vec<EnvVar>, String> {
    let map = load_env_file(&state);
    Ok(map
        .into_iter()
        .map(|(key, value)| EnvVar { key, value })
        .collect())
}

#[tauri::command]
pub async fn save_envs(
    state: State<'_, AppState>,
    envs: Vec<EnvVar>,
) -> Result<(), String> {
    let map: BTreeMap<String, String> = envs
        .into_iter()
        .filter(|e| !e.key.is_empty())
        .map(|e| (e.key, e.value))
        .collect();
    save_env_file(&state, &map)
}

#[tauri::command]
pub async fn delete_env(
    state: State<'_, AppState>,
    key: String,
) -> Result<(), String> {
    let mut map = load_env_file(&state);
    map.remove(&key);
    std::env::remove_var(&key);
    save_env_file(&state, &map)
}
