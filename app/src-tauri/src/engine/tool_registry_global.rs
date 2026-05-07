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

/// Reported when a registration would shadow an existing tool from a
/// different source. Same-source re-registration is silent (idempotent).
#[derive(Debug, Clone)]
pub struct Collision {
    pub name: String,
    pub existing: ToolSource,
    pub incoming: ToolSource,
}

/// Global registry holding all tools from all sources.
pub struct GlobalToolRegistry {
    tools: RwLock<HashMap<String, ToolEntry>>,
    /// Per-server description overrides applied during MCP sync (e.g. skill aliases).
    mcp_skill_overrides: RwLock<HashMap<String, String>>,
}

impl GlobalToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: RwLock::new(HashMap::new()),
            mcp_skill_overrides: RwLock::new(HashMap::new()),
        }
    }

    /// Strict registration. Same-source re-register upserts; cross-source
    /// collision returns `Err` so the caller can decide policy (panic for
    /// programmer error, alias for MCP/plugin runtime collisions).
    pub fn try_register(&self, entry: ToolEntry) -> Result<(), Collision> {
        let mut tools = self.tools.write().unwrap();
        if let Some(existing) = tools.get(&entry.name) {
            if existing.source != entry.source {
                return Err(Collision {
                    name: entry.name.clone(),
                    existing: existing.source.clone(),
                    incoming: entry.source.clone(),
                });
            }
        }
        tools.insert(entry.name.clone(), entry);
        Ok(())
    }

    pub fn try_register_batch(&self, entries: Vec<ToolEntry>) -> Vec<Collision> {
        entries.into_iter()
            .filter_map(|e| self.try_register(e).err())
            .collect()
    }

    /// Set MCP skill description overrides. Read by `sync_mcp_tools`.
    pub fn set_mcp_skill_overrides(&self, overrides: HashMap<String, String>) {
        *self.mcp_skill_overrides.write().unwrap() = overrides;
    }

    pub fn mcp_skill_overrides(&self) -> HashMap<String, String> {
        self.mcp_skill_overrides.read().unwrap().clone()
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

    let collisions = registry.try_register_batch(core_entries);
    if !collisions.is_empty() {
        // Built-in names colliding with each other is a code-level bug
        // (two `tool_def("foo", ...)` calls under different modules).
        panic!("Built-in tool name collisions: {:?}", collisions);
    }
    let collisions = registry.try_register_batch(deferred_entries);
    if !collisions.is_empty() {
        panic!("Built-in deferred tool name collisions: {:?}", collisions);
    }
}

/// Apply collisions for plugin/MCP runtime registrations: aliases the
/// incoming tool with `<source-prefix>__<name>`, retries, and warns.
fn alias_on_collision(registry: &GlobalToolRegistry, mut entry: ToolEntry) {
    match registry.try_register(entry.clone()) {
        Ok(()) => {}
        Err(c) => {
            let prefix = match &c.incoming {
                ToolSource::Mcp { server_name } => format!("mcp_{}", sanitize_segment(server_name)),
                ToolSource::Plugin { plugin_id } => format!("plugin_{}", sanitize_segment(plugin_id)),
                ToolSource::BuiltIn => "builtin".into(),
            };
            let aliased = format!("{}__{}", prefix, entry.name);
            log::warn!(
                "Tool name collision: '{}' ({:?} ⇄ {:?}) — incoming aliased to '{}'",
                c.name, c.existing, c.incoming, aliased
            );
            entry.name = aliased.clone();
            // Keep the LLM-visible function name in sync with display name.
            entry.definition.function.name = aliased;
            // Aliased name shouldn't collide; if it somehow does (same source
            // already registered with the alias), accept the upsert.
            let _ = registry.try_register(entry);
        }
    }
}

fn sanitize_segment(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect()
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
    for entry in entries { alias_on_collision(registry, entry); }
}

/// Sync MCP tools into the global registry. Applies stored skill-description
/// overrides. Cross-source name collisions are auto-aliased (and warned).
/// Called before each agent run to pick up newly connected servers.
pub async fn sync_mcp_tools(registry: &GlobalToolRegistry) {
    if let Some(runtime) = super::tools::MCP_RUNTIME.get() {
        // Clear existing MCP tools first (servers may have disconnected)
        {
            let mut tools = registry.tools.write().unwrap();
            tools.retain(|_, e| !matches!(e.source, ToolSource::Mcp { .. }));
        }
        let (mcp_tools, _unavailable) = runtime.get_all_tools_with_status().await;
        if mcp_tools.is_empty() { return; }

        let overrides = registry.mcp_skill_overrides();
        let entries: Vec<ToolEntry> = mcp_tools.iter().map(|tool| {
            let description = overrides.get(&tool.server_key)
                .cloned()
                .unwrap_or_else(|| tool.description.clone());
            ToolEntry {
                name: tool.name.clone(),
                source: ToolSource::Mcp { server_name: tool.server_key.clone() },
                definition: super::tools::ToolDefinition {
                    r#type: "function".into(),
                    function: super::tools::FunctionDef {
                        name: tool.name.clone(),
                        description,
                        parameters: tool.input_schema.clone(),
                    },
                },
                dispatch_name: tool.name.clone(),
                concurrency_safe: false,
            }
        }).collect();
        log::debug!("Synced {} MCP tools into global registry", entries.len());
        for entry in entries { alias_on_collision(registry, entry); }
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
    for entry in entries { alias_on_collision(registry, entry); }
}
