use crate::engine::tool_registry_global;

/// List all registered tools from all sources (built-in, plugin, MCP).
#[tauri::command]
pub async fn list_all_tools() -> Result<Vec<serde_json::Value>, String> {
    let registry = tool_registry_global::global_registry()
        .ok_or("Tool registry not initialized")?;

    let entries = registry.list_all();
    Ok(entries.iter().map(|e| {
        serde_json::json!({
            "name": e.name,
            "description": e.definition.function.description,
            "source": e.source,
            "dispatch_name": e.dispatch_name,
            "concurrency_safe": e.concurrency_safe,
        })
    }).collect())
}

/// Get tool count by source.
#[tauri::command]
pub async fn get_tool_stats() -> Result<serde_json::Value, String> {
    let registry = tool_registry_global::global_registry()
        .ok_or("Tool registry not initialized")?;

    let entries = registry.list_all();
    let builtin = entries.iter().filter(|e| matches!(e.source, tool_registry_global::ToolSource::BuiltIn)).count();
    let plugin = entries.iter().filter(|e| matches!(e.source, tool_registry_global::ToolSource::Plugin { .. })).count();
    let mcp = entries.iter().filter(|e| matches!(e.source, tool_registry_global::ToolSource::Mcp { .. })).count();

    Ok(serde_json::json!({
        "total": entries.len(),
        "builtin": builtin,
        "plugin": plugin,
        "mcp": mcp,
    }))
}
