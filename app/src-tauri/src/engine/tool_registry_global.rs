//! GlobalToolRegistry — unified tool registration for all sources.
//!
//! All tools (built-in, plugin, MCP) register here. The ReAct agent queries
//! this single registry instead of assembling tools from multiple sources.
//! Dispatch is also unified: `execute_tool` looks up the source and routes
//! to the correct executor.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use serde::Serialize;

use super::tools::{ToolDefinition, FunctionDef};

/// Where a tool comes from.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub enum ToolSource {
    /// Built-in Rust tool (core or deferred).
    BuiltIn,
    /// Plugin-provided tool.
    Plugin { plugin_id: String },
    /// MCP server tool.
    Mcp { server_name: String },
}

/// A tool entry in the global registry.
#[derive(Debug, Clone, Serialize)]
pub struct ToolEntry {
    /// Display name the agent sees (no prefix).
    pub name: String,
    /// Where this tool comes from.
    pub source: ToolSource,
    /// Full tool definition for the LLM API.
    pub definition: ToolDefinition,
    /// Original name used internally for dispatch (may have prefix for plugin/mcp).
    pub dispatch_name: String,
    /// Whether this tool is concurrency-safe (read-only).
    pub concurrency_safe: bool,
}

/// Global registry holding all tools from all sources.
pub struct GlobalToolRegistry {
    tools: RwLock<HashMap<String, ToolEntry>>,
}

impl GlobalToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: RwLock::new(HashMap::new()),
        }
    }

    /// Register a tool. If a tool with the same name exists, it's replaced.
    pub fn register(&self, entry: ToolEntry) {
        let mut tools = self.tools.write().unwrap();
        tools.insert(entry.name.clone(), entry);
    }

    /// Register multiple tools at once.
    pub fn register_batch(&self, entries: Vec<ToolEntry>) {
        let mut tools = self.tools.write().unwrap();
        for entry in entries {
            tools.insert(entry.name.clone(), entry);
        }
    }

    /// Remove all tools from a given source.
    pub fn unregister_source(&self, source_match: &ToolSource) {
        let mut tools = self.tools.write().unwrap();
        tools.retain(|_, entry| &entry.source != source_match);
    }

    /// Remove all tools from a specific plugin.
    pub fn unregister_plugin(&self, plugin_id: &str) {
        let mut tools = self.tools.write().unwrap();
        tools.retain(|_, e| {
            !matches!(&e.source, ToolSource::Plugin { plugin_id: pid } if pid == plugin_id)
        });
    }

    /// Remove all tools from a specific MCP server.
    pub fn unregister_mcp(&self, server_name: &str) {
        let mut tools = self.tools.write().unwrap();
        tools.retain(|_, e| {
            !matches!(&e.source, ToolSource::Mcp { server_name: sn } if sn == server_name)
        });
    }

    /// Look up a tool by name.
    pub fn get(&self, name: &str) -> Option<ToolEntry> {
        self.tools.read().unwrap().get(name).cloned()
    }

    /// Get dispatch name for a tool (may differ from display name).
    pub fn dispatch_name(&self, name: &str) -> Option<String> {
        self.tools.read().unwrap().get(name).map(|e| e.dispatch_name.clone())
    }

    /// Get all tool definitions for the LLM API.
    pub fn all_definitions(&self) -> Vec<ToolDefinition> {
        self.tools.read().unwrap().values()
            .map(|e| e.definition.clone())
            .collect()
    }

    /// Get tool definitions filtered by source type.
    pub fn definitions_by_source(&self, source_type: &str) -> Vec<ToolDefinition> {
        self.tools.read().unwrap().values()
            .filter(|e| match (&e.source, source_type) {
                (ToolSource::BuiltIn, "builtin") => true,
                (ToolSource::Plugin { .. }, "plugin") => true,
                (ToolSource::Mcp { .. }, "mcp") => true,
                _ => false,
            })
            .map(|e| e.definition.clone())
            .collect()
    }

    /// List all tool entries (for frontend display).
    pub fn list_all(&self) -> Vec<ToolEntry> {
        self.tools.read().unwrap().values().cloned().collect()
    }

    /// Total tool count.
    pub fn count(&self) -> usize {
        self.tools.read().unwrap().len()
    }

    /// Check if a tool is concurrency-safe.
    pub fn is_concurrency_safe(&self, name: &str) -> bool {
        self.tools.read().unwrap()
            .get(name)
            .map_or(false, |e| e.concurrency_safe)
    }
}

// ── Global singleton ────────────────────────────────────────────────

static GLOBAL_REGISTRY: std::sync::OnceLock<Arc<GlobalToolRegistry>> = std::sync::OnceLock::new();

/// Initialize the global tool registry.
pub fn init_global_registry() -> Arc<GlobalToolRegistry> {
    let registry = Arc::new(GlobalToolRegistry::new());
    GLOBAL_REGISTRY.set(registry.clone()).ok();
    registry
}

/// Get the global registry.
pub fn global_registry() -> Option<&'static Arc<GlobalToolRegistry>> {
    GLOBAL_REGISTRY.get()
}

// ── Registration helpers ────────────────────────────────────────────

/// Register all built-in tools into the global registry.
pub fn register_builtin_tools(registry: &GlobalToolRegistry) {
    let core_defs = super::tools::core_tools();
    let deferred_defs = super::tools::deferred_tools();

    let core_entries: Vec<ToolEntry> = core_defs.into_iter().map(|def| {
        let name = def.function.name.clone();
        let safe = super::tools::is_tool_concurrency_safe(&name);
        ToolEntry {
            name: name.clone(),
            source: ToolSource::BuiltIn,
            definition: def,
            dispatch_name: name,
            concurrency_safe: safe,
        }
    }).collect();

    let deferred_entries: Vec<ToolEntry> = deferred_defs.into_iter().map(|def| {
        let name = def.function.name.clone();
        let safe = super::tools::is_tool_concurrency_safe(&name);
        ToolEntry {
            name: name.clone(),
            source: ToolSource::BuiltIn,
            definition: def,
            dispatch_name: name,
            concurrency_safe: safe,
        }
    }).collect();

    registry.register_batch(core_entries);
    registry.register_batch(deferred_entries);
}

/// Register plugin tools into the global registry.
/// Called after plugin loading.
pub fn register_plugin_tools(
    registry: &GlobalToolRegistry,
    plugin_id: &str,
    tools: Vec<ToolDefinition>,
) {
    let entries: Vec<ToolEntry> = tools.into_iter().map(|def| {
        let original_name = def.function.name.clone();
        // Strip plugin__ prefix for display name if present
        let display_name = if original_name.starts_with("plugin__") {
            original_name.split("__").last().unwrap_or(&original_name).to_string()
        } else {
            original_name.clone()
        };
        ToolEntry {
            name: display_name,
            source: ToolSource::Plugin { plugin_id: plugin_id.to_string() },
            definition: def,
            dispatch_name: original_name,
            concurrency_safe: false,
        }
    }).collect();
    registry.register_batch(entries);
}

/// Sync MCP tools into the global registry.
/// Called before each agent run to pick up newly connected servers.
pub async fn sync_mcp_tools(registry: &GlobalToolRegistry) {
    if let Some(runtime) = super::tools::MCP_RUNTIME.get() {
        // Clear existing MCP tools first (servers may have disconnected)
        {
            let mut tools = registry.tools.write().unwrap();
            tools.retain(|_, e| !matches!(e.source, ToolSource::Mcp { .. }));
        }
        let (mcp_tools, _unavailable) = runtime.get_all_tools_with_status().await;
        if !mcp_tools.is_empty() {
            let entries: Vec<ToolEntry> = mcp_tools.iter().map(|tool| ToolEntry {
                name: tool.name.clone(),
                source: ToolSource::Mcp { server_name: tool.server_key.clone() },
                definition: super::tools::ToolDefinition {
                    r#type: "function".into(),
                    function: super::tools::FunctionDef {
                        name: tool.name.clone(),
                        description: tool.description.clone(),
                        parameters: tool.input_schema.clone(),
                    },
                },
                dispatch_name: tool.name.clone(),
                concurrency_safe: false,
            }).collect();
            log::debug!("Synced {} MCP tools into global registry", entries.len());
            registry.register_batch(entries);
        }
    }
}

/// Register MCP server tools into the global registry (batch).
pub fn register_mcp_tools(
    registry: &GlobalToolRegistry,
    server_name: &str,
    tools: Vec<ToolDefinition>,
) {
    let entries: Vec<ToolEntry> = tools.into_iter().map(|def| {
        let original_name = def.function.name.clone();
        // Strip mcp__ prefix for display name if present
        let display_name = if original_name.starts_with("mcp__") {
            let parts: Vec<&str> = original_name.splitn(3, "__").collect();
            if parts.len() == 3 { parts[2].to_string() } else { original_name.clone() }
        } else {
            original_name.clone()
        };
        ToolEntry {
            name: display_name,
            source: ToolSource::Mcp { server_name: server_name.to_string() },
            definition: def,
            dispatch_name: original_name,
            concurrency_safe: false,
        }
    }).collect();
    registry.register_batch(entries);
}
