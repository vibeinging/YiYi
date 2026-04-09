use serde::Serialize;
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub enabled: bool,
    pub tool_count: usize,
    pub has_hooks: bool,
}

#[tauri::command]
pub async fn list_plugins(state: State<'_, AppState>) -> Result<Vec<PluginInfo>, String> {
    let registry = state.plugin_registry.read().await;
    Ok(registry.list().iter().map(|p| PluginInfo {
        id: p.id.clone(),
        name: p.manifest.name.clone(),
        version: p.manifest.version.clone(),
        description: p.manifest.description.clone(),
        enabled: p.enabled,
        tool_count: p.manifest.tools.len(),
        has_hooks: !p.manifest.hooks.is_empty(),
    }).collect())
}

#[tauri::command]
pub async fn enable_plugin(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let plugins_dir = state.working_dir.join("plugins");
    let mut registry = state.plugin_registry.write().await;
    registry.set_enabled(&plugins_dir, &id, true);
    // Run init for newly enabled plugin
    if let Some(plugin) = registry.get(&id) {
        if let Err(e) = plugin.initialize() {
            log::warn!("Plugin '{}' init after enable failed: {e}", id);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn disable_plugin(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let plugins_dir = state.working_dir.join("plugins");
    let mut registry = state.plugin_registry.write().await;
    // Run shutdown before disabling
    if let Some(plugin) = registry.get(&id) {
        if let Err(e) = plugin.shutdown() {
            log::warn!("Plugin '{}' shutdown before disable failed: {e}", id);
        }
    }
    registry.set_enabled(&plugins_dir, &id, false);
    Ok(())
}

#[tauri::command]
pub async fn reload_plugins(state: State<'_, AppState>) -> Result<usize, String> {
    let plugins_dir = state.working_dir.join("plugins");
    let mut registry = state.plugin_registry.write().await;
    *registry = crate::engine::plugins::PluginRegistry::load(&plugins_dir);
    registry.initialize_all();
    Ok(registry.list().len())
}
