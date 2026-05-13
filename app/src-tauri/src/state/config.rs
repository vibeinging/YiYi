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
    /// Agent trace recording (opt-in fine-tune data path).
    #[serde(default)]
    pub tracing: TracingConfig,
}

/// Turn-level agent trace persistence.
///
/// Stores raw ShareGPT-format turns (role, content, reasoning, tool_calls)
/// to SQLite for future offline fine-tuning of DeepSeek V4 once the API
/// supports it. **Default: disabled** — must be explicitly enabled by the
/// user since traces contain full conversation including tool inputs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TracingConfig {
    /// Master switch. When false, agent loop does not write to `agent_traces`.
    #[serde(default)]
    pub enabled: bool,
    /// Rows older than this are dropped by the daily GC.
    #[serde(default = "default_trace_max_age_days")]
    pub max_age_days: u32,
}

fn default_trace_max_age_days() -> u32 { 30 }

impl Default for TracingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_age_days: default_trace_max_age_days(),
        }
    }
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

/// Lazy-install dependency declaration. Lets MCP servers (and, in the
/// future, individual tools) declare what binaries they need so YiYi can
/// detect a missing prerequisite *before* spawning, surface a consent
/// dialog to the user, and run the install for them.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DepSpec {
    /// Bin name to look up via `which` (e.g. `"npx"`, `"node"`).
    pub bin: String,
    /// User-facing name shown in the install dialog (e.g. `"Node.js"`).
    pub display_name: String,
    /// One-line reason the user is being asked to install this — appears
    /// in the consent dialog so they can judge "do I want this?".
    #[serde(default)]
    pub why: String,
    /// Ordered list of install options shown to the user. The dialog
    /// prefers the first option whose `kind` is locally available
    /// (e.g. brew if Homebrew is installed); falls back to the URL kind.
    #[serde(default)]
    pub install: Vec<InstallStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InstallStep {
    /// "brew" | "winget" | "apt" | "url" | "manual"
    pub kind: String,
    /// User-facing label, e.g. "Install via Homebrew".
    pub label: String,
    /// Shell command to run (for brew / winget / apt / manual). Mutually
    /// exclusive with `url`.
    #[serde(default)]
    pub command: Option<String>,
    /// Open this URL in the browser (for "url" kind).
    #[serde(default)]
    pub url: Option<String>,
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
    /// Lazy-install prerequisites — see `DepSpec`. Empty means no checks.
    #[serde(default)]
    pub requires: Vec<DepSpec>,
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
    /// DeepSeek V4 thinking-mode effort. One of "off" / "high" / "max".
    /// Maps to the OpenAI-compatible `enable_thinking` request param:
    ///   "off"        → enable_thinking = false
    ///   "high"/"max" → enable_thinking = true
    /// DeepSeek currently exposes only a boolean toggle for thinking; the
    /// "high" vs "max" distinction is reserved for future API granularity.
    /// Defaults to "high" (DeepSeek's recommended on-state).
    #[serde(default)]
    pub thinking_effort: Option<String>,
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
///
/// The embedder is hard-coded to bge-small-zh-v1.5 (local ONNX, 512 dims) in
/// `app_state.rs`. The five `embedding_*` fields below are kept for
/// config-file back-compat and inspection only — they are not read by the
/// runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemmeConfig {
    /// (Unused) Embedding provider identifier, always "local-bge-zh".
    #[serde(default = "memme_default_provider")]
    pub embedding_provider: String,
    /// (Unused) Embedding model name, always "bge-small-zh-v1.5".
    #[serde(default = "memme_default_model")]
    pub embedding_model: String,
    /// (Unused) Legacy API key field.
    #[serde(default)]
    pub embedding_api_key: String,
    /// (Unused) Legacy base URL field.
    #[serde(default)]
    pub embedding_base_url: String,
    /// (Unused) Embedding vector dimensions, always 512.
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

    /// Optional LLM override for memory operations (compact/meditate/extract).
    /// If empty, falls back to the active main LLM provider.
    /// Use case: main model is expensive, use a cheap one for background memory ops.
    #[serde(default)]
    pub memory_llm_base_url: String,
    #[serde(default)]
    pub memory_llm_api_key: String,
    #[serde(default)]
    pub memory_llm_model: String,
}

fn memme_default_provider() -> String { "local-bge-zh".to_string() }
fn memme_default_model() -> String { "bge-small-zh-v1.5".to_string() }
fn memme_default_dims() -> usize { 512 }
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
            memory_llm_base_url: String::new(),
            memory_llm_api_key: String::new(),
            memory_llm_model: String::new(),
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
    /// Hosted mode: buddy auto-handles decisions, permissions, and task direction.
    #[serde(default)]
    pub hosted_mode: bool,
    /// How many times the user has petted the buddy.
    #[serde(default)]
    pub pet_count: u32,
    /// How many times the buddy has made a delegation decision.
    #[serde(default)]
    pub delegation_count: u32,
    /// Per-domain trust scores (0.0-1.0). Keys: task_decision, skill_review, permission, etc.
    #[serde(default)]
    pub trust_scores: HashMap<String, f64>,
    /// Overall trust score (weighted average of domain scores).
    #[serde(default = "default_trust")]
    pub trust_overall: f64,
}

fn default_trust() -> f64 {
    0.5
}

impl CliProviderConfig {
    /// Default configuration for Feishu CLI.
    #[allow(dead_code)]
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
        let mut cfg: Self = if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        };
        cfg.seed_default_mcp_servers();
        cfg
    }

    pub fn save(&self, working_dir: &Path) -> Result<(), String> {
        let path = working_dir.join("config.json");
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        std::fs::write(&path, content)
            .map_err(|e| format!("Failed to write config: {}", e))?;
        Ok(())
    }

    /// Seed MCP entries the V4 build relies on. Idempotent: only inserts
    /// keys the user hasn't customised. Currently seeds:
    ///   * `playwright` — Microsoft's Playwright MCP server. Provides ARIA
    ///     accessibility-tree-based browser interaction (no screenshots),
    ///     replacing the in-process `browser_use` / `browser_screenshot`
    ///     tools while DeepSeek V4 lacks vision.
    fn seed_default_mcp_servers(&mut self) {
        // cua-driver (macOS-only): background computer-use via SkyLight pid-scoped
        // event posting — doesn't steal cursor, focus, or Space from the user.
        // Replaces the prior in-process `computer_control` tool (CGEvent-based)
        // which had to be disabled because (a) DeepSeek V4 lacks vision and
        // (b) HID injection conflicts with the user actively using the Mac.
        //
        // Seeded disabled by default — the user must install `cua-driver` and
        // grant Accessibility + Screen Recording perms before flipping it on.
        if !self.mcp.contains_key("cua-driver") {
            self.mcp.insert(
                "cua-driver".to_string(),
                MCPClientConfig {
                    name: "Computer Use (macOS)".to_string(),
                    description:
                        "Background macOS desktop control: screenshot, click, type, \
                         window/app control. Does NOT steal cursor/focus/Space from \
                         the user. macOS only — requires `cua-driver` binary + \
                         Accessibility & Screen Recording permissions."
                            .to_string(),
                    enabled: false,
                    transport: "stdio".to_string(),
                    command: Some("cua-driver".to_string()),
                    args: vec!["mcp".to_string()],
                    requires: vec![DepSpec {
                        bin: "cua-driver".to_string(),
                        display_name: "cua-driver".to_string(),
                        why: "macOS background computer-use driver from trycua/cua. \
                              Uses SkyLight private SPIs to dispatch events to a target \
                              pid without moving the cursor or switching Space."
                            .to_string(),
                        install: vec![
                            InstallStep {
                                kind: "shell".to_string(),
                                label: "通过官方脚本安装（macOS）".to_string(),
                                command: Some(
                                    "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)\""
                                        .to_string(),
                                ),
                                ..Default::default()
                            },
                            InstallStep {
                                kind: "url".to_string(),
                                label: "查看 trycua/cua 仓库".to_string(),
                                url: Some(
                                    "https://github.com/trycua/cua/tree/main/libs/cua-driver"
                                        .to_string(),
                                ),
                                ..Default::default()
                            },
                        ],
                    }],
                    ..Default::default()
                },
            );
        }

        if !self.mcp.contains_key("playwright") {
            self.mcp.insert(
                "playwright".to_string(),
                MCPClientConfig {
                    name: "Playwright".to_string(),
                    description:
                        "Browser automation via accessibility tree (no vision needed). \
                         Default install via npx; requires Node.js."
                            .to_string(),
                    enabled: true,
                    transport: "stdio".to_string(),
                    command: Some("npx".to_string()),
                    args: vec!["-y".to_string(), "@playwright/mcp@latest".to_string()],
                    requires: vec![DepSpec {
                        bin: "npx".to_string(),
                        display_name: "Node.js".to_string(),
                        why: "Playwright MCP runs as an `npx` package, so Node.js (with npm/npx) must be installed. Comes pre-bundled with Node.".to_string(),
                        install: vec![
                            InstallStep {
                                kind: "brew".to_string(),
                                label: "通过 Homebrew 安装（macOS 推荐）".to_string(),
                                command: Some("brew install node".to_string()),
                                ..Default::default()
                            },
                            InstallStep {
                                kind: "winget".to_string(),
                                label: "通过 winget 安装（Windows）".to_string(),
                                command: Some("winget install OpenJS.NodeJS.LTS".to_string()),
                                ..Default::default()
                            },
                            InstallStep {
                                kind: "apt".to_string(),
                                label: "通过 apt 安装（Debian/Ubuntu）".to_string(),
                                command: Some("sudo apt-get install -y nodejs npm".to_string()),
                                ..Default::default()
                            },
                            InstallStep {
                                kind: "url".to_string(),
                                label: "从 nodejs.org 下载".to_string(),
                                url: Some("https://nodejs.org/zh-cn/download".to_string()),
                                ..Default::default()
                            },
                        ],
                    }],
                    ..Default::default()
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn load_seeds_playwright_mcp_on_fresh_config() {
        let tmp = TempDir::new().unwrap();
        let cfg = Config::load(tmp.path());
        let pw = cfg.mcp.get("playwright").expect("playwright MCP must be seeded");
        assert!(pw.enabled);
        assert_eq!(pw.command.as_deref(), Some("npx"));
        assert!(pw.args.iter().any(|a| a.contains("@playwright/mcp")));
    }

    #[test]
    fn seed_does_not_overwrite_user_customisations() {
        let tmp = TempDir::new().unwrap();
        let mut cfg = Config::default();
        cfg.mcp.insert(
            "playwright".to_string(),
            MCPClientConfig {
                name: "Playwright (custom)".to_string(),
                command: Some("/usr/local/bin/playwright-mcp".to_string()),
                enabled: false,
                ..Default::default()
            },
        );
        cfg.save(tmp.path()).unwrap();

        let reloaded = Config::load(tmp.path());
        let pw = reloaded.mcp.get("playwright").unwrap();
        // User's custom command and disabled flag must be preserved.
        assert_eq!(pw.command.as_deref(), Some("/usr/local/bin/playwright-mcp"));
        assert!(!pw.enabled);
    }
}
