use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub channels: HashMap<String, ChannelConfig>,
    #[serde(default)]
    pub heartbeat: HeartbeatConfig,
    #[serde(default)]
    pub mcp: HashMap<String, MCPClientConfig>,
    #[serde(default)]
    pub agents: AgentsConfig,
    /// Configuration for exposing local skills as an MCP server.
    #[serde(default)]
    pub skill_server: SkillServerConfig,
    #[serde(default)]
    pub meditation: MeditationConfig,
    /// MemMe memory engine configuration (embedding, graph, forgetting curve).
    #[serde(default)]
    pub memme: MemmeConfig,
    /// External CLI tool providers (e.g. Feishu CLI, DingTalk CLI).
    #[serde(default)]
    pub cli_providers: HashMap<String, CliProviderConfig>,
    /// Buddy companion configuration.
    #[serde(default)]
    pub buddy: BuddyConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChannelConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bot_prefix: String,
    #[serde(default)]
    pub access: AccessPolicy,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccessPolicy {
    #[serde(default = "default_open")]
    pub dm_policy: String,
    #[serde(default = "default_open")]
    pub group_policy: String,
    #[serde(default)]
    pub allow_from: Vec<String>,
    #[serde(default)]
    pub deny_message: Option<String>,
}

fn default_open() -> String {
    "open".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_heartbeat_every")]
    pub every: String,
    #[serde(default = "default_heartbeat_target")]
    pub target: String,
    #[serde(default)]
    pub active_hours: Option<ActiveHours>,
}

impl Default for HeartbeatConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            every: default_heartbeat_every(),
            target: default_heartbeat_target(),
            active_hours: None,
        }
    }
}

fn default_heartbeat_every() -> String {
    "6h".to_string()
}

fn default_heartbeat_target() -> String {
    "main".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveHours {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MCPClientConfig {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub transport: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// If set, use this SKILL.md name to override MCP tool descriptions in the prompt.
    #[serde(default)]
    pub skill_override: Option<String>,
    /// Priority for tool ordering. Higher priority tools appear first. Default 0.
    #[serde(default)]
    pub priority: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SkillServerConfig {
    /// Whether to expose local skills as an MCP server.
    #[serde(default)]
    pub expose_as_mcp: bool,
    /// Host to bind the MCP server to. Default "127.0.0.1".
    #[serde(default = "default_mcp_host")]
    pub host: String,
    /// Port for the MCP server. Default 9315.
    #[serde(default = "default_mcp_port")]
    pub port: u16,
    /// Which skills to expose. Empty means all enabled skills.
    #[serde(default)]
    pub skills: Vec<String>,
}

fn default_mcp_host() -> String {
    "127.0.0.1".to_string()
}

fn default_mcp_port() -> u16 {
    9315
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentsConfig {
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub max_iterations: Option<usize>,
    #[serde(default)]
    pub max_input_length: Option<usize>,
    /// User-facing workspace directory. Agent-generated files, uploads, etc.
    /// If None, defaults to ~/Documents/YiYi.
    #[serde(default)]
    pub workspace_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeditationConfig {
    pub enabled: bool,
    pub start_time: String, // "HH:MM" format, e.g. "23:00"
    pub notify_on_complete: bool,
}

impl Default for MeditationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            start_time: "23:00".to_string(),
            notify_on_complete: true,
        }
    }
}

/// MemMe memory engine configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemmeConfig {
    /// Embedding provider: "mock" (default) | "openai"
    #[serde(default = "memme_default_provider")]
    pub embedding_provider: String,
    /// Embedding model name (e.g. "text-embedding-3-small")
    #[serde(default = "memme_default_model")]
    pub embedding_model: String,
    /// API key for embedding provider. Empty = use active LLM provider's key.
    #[serde(default)]
    pub embedding_api_key: String,
    /// Base URL override for embedding API. Empty = use provider default.
    #[serde(default)]
    pub embedding_base_url: String,
    /// Embedding vector dimensions. Must match model output.
    #[serde(default = "memme_default_dims")]
    pub embedding_dims: usize,
    /// Enable MemMe knowledge graph (entity extraction + relations).
    #[serde(default = "default_true")]
    pub enable_graph: bool,
    /// Enable Ebbinghaus forgetting curve decay.
    #[serde(default = "default_true")]
    pub enable_forgetting_curve: bool,
    /// Fact extraction depth: "standard" | "thorough".
    #[serde(default = "memme_default_depth")]
    pub extraction_depth: String,
}

fn memme_default_provider() -> String { "mock".to_string() }
fn memme_default_model() -> String { "text-embedding-3-small".to_string() }
fn memme_default_dims() -> usize { 384 }
fn memme_default_depth() -> String { "standard".to_string() }

impl Default for MemmeConfig {
    fn default() -> Self {
        Self {
            embedding_provider: memme_default_provider(),
            embedding_model: memme_default_model(),
            embedding_api_key: String::new(),
            embedding_base_url: String::new(),
            embedding_dims: memme_default_dims(),
            enable_graph: true,
            enable_forgetting_curve: true,
            extraction_depth: memme_default_depth(),
        }
    }
}

/// Configuration for an external CLI tool provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliProviderConfig {
    /// Whether this CLI provider is enabled.
    #[serde(default)]
    pub enabled: bool,
    /// Binary name (e.g. "lark-cli").
    #[serde(default)]
    pub binary: String,
    /// Install command (e.g. "npm install -g @larksuite/cli").
    #[serde(default)]
    pub install_command: String,
    /// Authentication command suffix (e.g. "auth login --recommend").
    #[serde(default)]
    pub auth_command: String,
    /// Command to check installation (e.g. "--version").
    #[serde(default)]
    pub check_command: String,
    /// Credential key-value pairs (app_id, app_secret, etc.).
    #[serde(default)]
    pub credentials: HashMap<String, String>,
    /// Authentication status: "unknown" | "authenticated" | "not_authenticated".
    #[serde(default)]
    pub auth_status: String,
}

impl Default for CliProviderConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            binary: String::new(),
            install_command: String::new(),
            auth_command: String::new(),
            check_command: String::new(),
            credentials: HashMap::new(),
            auth_status: "unknown".to_string(),
        }
    }
}

/// Buddy companion soul & preferences.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BuddyConfig {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub personality: String,
    /// Unix timestamp (ms) when the buddy was hatched. 0 = not hatched yet.
    #[serde(default)]
    pub hatched_at: i64,
    #[serde(default)]
    pub muted: bool,
    /// Stable user identifier for deterministic generation. Auto-generated on first access.
    #[serde(default)]
    pub buddy_user_id: String,
    /// Growth deltas for each stat, accumulated from usage patterns.
    /// Keys: ENERGY, WARMTH, MISCHIEF, WIT, SASS
    #[serde(default)]
    pub stats_delta: HashMap<String, i32>,
    /// Total interaction count (used for growth rate scaling).
    #[serde(default)]
    pub interaction_count: u32,
}

impl CliProviderConfig {
    /// Default configuration for Feishu CLI.
    pub fn feishu_default() -> Self {
        Self {
            enabled: false,
            binary: "lark-cli".to_string(),
            install_command: "npm install -g @larksuite/cli".to_string(),
            auth_command: "auth login --recommend".to_string(),
            check_command: "--version".to_string(),
            credentials: HashMap::new(),
            auth_status: "unknown".to_string(),
        }
    }
}

impl Config {
    pub fn load(working_dir: &Path) -> Self {
        let path = working_dir.join("config.json");
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        }
    }

    pub fn save(&self, working_dir: &Path) -> Result<(), String> {
        let path = working_dir.join("config.json");
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        std::fs::write(&path, content)
            .map_err(|e| format!("Failed to write config: {}", e))?;
        Ok(())
    }
}
