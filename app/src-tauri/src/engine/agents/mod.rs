//! Agent definition system — load, parse, and manage AGENT.md definitions.
//!
//! Agents define persona + tool access + model selection. They reference Skills
//! for domain knowledge but are distinct from Skills.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::react_agent::ToolFilter;

/// Parsed agent definition from AGENT.md.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    /// Model preference: "fast", "default", "powerful", or a specific model ID.
    #[serde(default)]
    pub model: Option<String>,
    /// Max ReAct iterations for this agent.
    #[serde(default)]
    pub max_iterations: Option<usize>,
    /// Tool whitelist. If set, only these tools are available.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// Tool blacklist. If set, these tools are denied.
    #[serde(default)]
    pub disallowed_tools: Option<Vec<String>>,
    /// Skill names to auto-load into this agent's prompt.
    #[serde(default)]
    pub skills: Vec<String>,
    /// Frontmatter metadata (emoji, color, category, etc.)
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    /// Markdown body (system prompt instructions) — parsed separately from YAML.
    #[serde(skip)]
    pub instructions: String,
    /// Source file path for debugging/editing.
    #[serde(skip)]
    pub source_path: PathBuf,
}

impl AgentDefinition {
    /// Convert this agent's tool config into a ToolFilter.
    pub fn tool_filter(&self) -> ToolFilter {
        if let Some(ref allowed) = self.tools {
            ToolFilter::Allow(allowed.clone())
        } else if let Some(ref denied) = self.disallowed_tools {
            ToolFilter::Deny(denied.clone())
        } else {
            ToolFilter::All
        }
    }

    /// Get emoji from metadata, fallback to default.
    pub fn emoji(&self) -> &str {
        self.metadata
            .as_ref()
            .and_then(|m| m["yiyi"]["emoji"].as_str())
            .unwrap_or("🤖")
    }

    /// Get color from metadata.
    pub fn color(&self) -> Option<&str> {
        self.metadata
            .as_ref()
            .and_then(|m| m["yiyi"]["color"].as_str())
    }

    /// Is this a built-in agent?
    pub fn is_builtin(&self) -> bool {
        self.metadata
            .as_ref()
            .and_then(|m| m["yiyi"]["category"].as_str())
            .map(|c| c == "builtin")
            .unwrap_or(false)
    }
}

/// Serializable summary for frontend listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSummary {
    pub name: String,
    pub description: String,
    pub emoji: String,
    pub color: Option<String>,
    pub is_builtin: bool,
    pub model: Option<String>,
    pub tool_count: Option<usize>,
}

impl From<&AgentDefinition> for AgentSummary {
    fn from(def: &AgentDefinition) -> Self {
        Self {
            name: def.name.clone(),
            description: def.description.clone(),
            emoji: def.emoji().to_string(),
            color: def.color().map(String::from),
            is_builtin: def.is_builtin(),
            model: def.model.clone(),
            tool_count: def.tools.as_ref().map(|t| t.len()),
        }
    }
}

/// Registry of all loaded agent definitions.
pub struct AgentRegistry {
    agents: Vec<AgentDefinition>,
}

impl AgentRegistry {
    /// Load agent definitions from built-in resources and custom directory.
    pub fn load(working_dir: &Path, resource_dir: Option<&Path>) -> Self {
        let mut agents = Vec::new();

        // 1. Load built-in agents from embedded resources
        for (name, content) in BUILTIN_AGENTS {
            if let Some(def) = parse_agent_md(content, &PathBuf::from(format!("builtin:{name}"))) {
                agents.push(def);
            }
        }

        // 2. Load built-in agents from resource directory (production)
        if let Some(res) = resource_dir {
            let agents_dir = res.join("agents");
            load_from_dir_sync(&agents_dir, &mut agents);
        }

        // 3. Load custom agents from ~/.yiyi/agents/ (can override built-ins)
        let custom_dir = working_dir.join("agents");
        load_from_dir_sync(&custom_dir, &mut agents);

        log::info!("AgentRegistry: loaded {} agent definitions", agents.len());
        Self { agents }
    }

    /// Get agent by name.
    pub fn get(&self, name: &str) -> Option<&AgentDefinition> {
        self.agents.iter().find(|a| a.name == name)
    }

    /// List all agents.
    pub fn list(&self) -> &[AgentDefinition] {
        &self.agents
    }

    /// Reload agents from disk.
    pub fn reload(&mut self, working_dir: &Path, resource_dir: Option<&Path>) {
        *self = Self::load(working_dir, resource_dir);
    }
}

/// Load AGENT.md files from a directory (synchronous, for startup).
fn load_from_dir_sync(dir: &Path, agents: &mut Vec<AgentDefinition>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let agent_md = if path.is_dir() {
            path.join("AGENT.md")
        } else if path.extension().map_or(false, |e| e == "md") {
            path.clone()
        } else {
            continue;
        };

        if let Ok(content) = std::fs::read_to_string(&agent_md) {
            if let Some(def) = parse_agent_md(&content, &agent_md) {
                // Custom agents override built-ins with the same name
                agents.retain(|a| a.name != def.name);
                agents.push(def);
            }
        }
    }
}

/// Parse AGENT.md content (YAML frontmatter + Markdown body).
/// Uses `\n---` as delimiter to avoid false splits on `---` within YAML values.
pub fn parse_agent_md(content: &str, source: &Path) -> Option<AgentDefinition> {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return None;
    }
    // Find closing `---` on its own line (after the opening one)
    let rest = &trimmed[3..];
    let end = rest.find("\n---").map(|i| i + 1)?; // +1 to skip the \n
    let frontmatter = &rest[..end - 1]; // exclude the \n before ---
    let body = rest[end + 3..].trim(); // skip past the closing ---

    let mut def: AgentDefinition = match serde_yaml::from_str(frontmatter) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("Failed to parse AGENT.md at {}: {e}", source.display());
            return None;
        }
    };
    def.instructions = body.to_string();
    def.source_path = source.to_path_buf();
    Some(def)
}

// ═══════════════════════════════════════════════════════════════════════
// Built-in agent definitions (embedded in binary)
// ═══════════════════════════════════════════════════════════════════════

const BUILTIN_AGENTS: &[(&str, &str)] = &[
    ("explore", include_str!("../../../agents/explore/AGENT.md")),
    ("planner", include_str!("../../../agents/planner/AGENT.md")),
    ("desktop_operator", include_str!("../../../agents/desktop_operator/AGENT.md")),
    ("memory_curator", include_str!("../../../agents/memory_curator/AGENT.md")),
    ("bot_coordinator", include_str!("../../../agents/bot_coordinator/AGENT.md")),
];
