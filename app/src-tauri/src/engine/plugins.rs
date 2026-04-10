//! Plugin system — extend YiYi with custom tools, hooks, and lifecycle commands.
//!
//! Plugins are directories containing a `plugin.json` manifest that defines:
//! - Custom tools (executed as subprocesses, JSON stdin → stdout)
//! - Hooks (pre/post tool use shell commands)
//! - Lifecycle commands (init/shutdown)
//!
//! Plugin directory: `~/.yiyi/plugins/<name>/plugin.json`
//!
//! Borrowed from Claw Code's plugin architecture, adapted for YiYi.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::engine::hooks::HookConfig;

const MANIFEST_FILE: &str = "plugin.json";

// ── Manifest types ──────────────────────────────────────────────────────

/// Plugin manifest (`plugin.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(rename = "defaultEnabled", default = "default_true")]
    pub default_enabled: bool,
    #[serde(default)]
    pub hooks: PluginHooks,
    #[serde(default)]
    pub lifecycle: PluginLifecycle,
    #[serde(default)]
    pub tools: Vec<PluginToolManifest>,
}

fn default_true() -> bool { true }

/// Hook commands defined by a plugin.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginHooks {
    #[serde(rename = "PreToolUse", default)]
    pub pre_tool_use: Vec<String>,
    #[serde(rename = "PostToolUse", default)]
    pub post_tool_use: Vec<String>,
    #[serde(rename = "PostToolUseFailure", default)]
    pub post_tool_use_failure: Vec<String>,
}

impl PluginHooks {
    pub fn is_empty(&self) -> bool {
        self.pre_tool_use.is_empty()
            && self.post_tool_use.is_empty()
            && self.post_tool_use_failure.is_empty()
    }

    /// Merge another set of hooks into this one.
    pub fn merge(&mut self, other: &Self) {
        self.pre_tool_use.extend(other.pre_tool_use.iter().cloned());
        self.post_tool_use.extend(other.post_tool_use.iter().cloned());
        self.post_tool_use_failure.extend(other.post_tool_use_failure.iter().cloned());
    }

    /// Convert to the engine's HookConfig format.
    pub fn to_hook_config(&self) -> HookConfig {
        HookConfig {
            pre_tool_use: self.pre_tool_use.clone(),
            post_tool_use: self.post_tool_use.clone(),
            post_tool_use_failure: self.post_tool_use_failure.clone(),
        }
    }
}

/// Lifecycle commands (run at startup/shutdown).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginLifecycle {
    #[serde(rename = "Init", default)]
    pub init: Vec<String>,
    #[serde(rename = "Shutdown", default)]
    pub shutdown: Vec<String>,
}

/// A custom tool defined by a plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginToolManifest {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: serde_json::Value,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(rename = "requiredPermission", default = "default_permission")]
    pub required_permission: String,
}

fn default_permission() -> String { "standard".into() }

// ── Plugin instance ─────────────────────────────────────────────────────

/// A loaded and validated plugin.
#[derive(Debug, Clone)]
pub struct Plugin {
    pub id: String,
    pub manifest: PluginManifest,
    pub root: PathBuf,
    pub enabled: bool,
}

impl Plugin {
    /// Execute a custom tool defined by this plugin.
    pub fn execute_tool(&self, tool_name: &str, input: &serde_json::Value) -> Result<String, String> {
        let tool = self.manifest.tools.iter()
            .find(|t| t.name == tool_name)
            .ok_or_else(|| format!("Plugin '{}' has no tool '{}'", self.id, tool_name))?;

        let input_json = input.to_string();
        let mut process = Command::new(&tool.command);
        process
            .args(&tool.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(&self.root)
            .env("YIYI_PLUGIN_ID", &self.id)
            .env("YIYI_PLUGIN_NAME", &self.manifest.name)
            .env("YIYI_TOOL_NAME", tool_name)
            .env("YIYI_TOOL_INPUT", &input_json)
            .env("YIYI_PLUGIN_ROOT", self.root.display().to_string());

        let mut child = process.spawn()
            .map_err(|e| format!("Failed to spawn plugin tool '{}': {e}", tool_name))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(input_json.as_bytes()).ok();
        }

        let output = child.wait_with_output()
            .map_err(|e| format!("Plugin tool '{}' wait error: {e}", tool_name))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!(
                "Plugin tool '{}' failed (exit {}): {}",
                tool_name,
                output.status.code().unwrap_or(-1),
                if stderr.is_empty() { "no output" } else { &stderr }
            ))
        }
    }

    /// Run lifecycle init commands.
    pub fn initialize(&self) -> Result<(), String> {
        for cmd in &self.manifest.lifecycle.init {
            run_lifecycle_command(&self.root, &self.id, "init", cmd)?;
        }
        Ok(())
    }

    /// Run lifecycle shutdown commands.
    pub fn shutdown(&self) -> Result<(), String> {
        for cmd in &self.manifest.lifecycle.shutdown {
            run_lifecycle_command(&self.root, &self.id, "shutdown", cmd)?;
        }
        Ok(())
    }

    /// Convert this plugin's tools to YiYi ToolDefinitions.
    pub fn tool_definitions(&self) -> Vec<super::tools::ToolDefinition> {
        self.manifest.tools.iter().map(|t| {
            super::tools::ToolDefinition {
                r#type: "function".into(),
                function: super::tools::FunctionDef {
                    name: format!("plugin__{}__{}", self.id, t.name),
                    description: format!("[Plugin: {}] {}", self.manifest.name, t.description),
                    parameters: t.input_schema.clone(),
                },
            }
        }).collect()
    }
}

fn run_lifecycle_command(root: &Path, plugin_id: &str, phase: &str, cmd: &str) -> Result<(), String> {
    log::info!("Plugin '{}' {}: {}", plugin_id, phase, cmd);
    let output = Command::new("sh")
        .args(["-lc", cmd])
        .current_dir(root)
        .env("YIYI_PLUGIN_ID", plugin_id)
        .env("YIYI_LIFECYCLE_PHASE", phase)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Plugin '{}' {} failed: {e}", plugin_id, phase))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::warn!("Plugin '{}' {} failed: {}", plugin_id, phase, stderr);
    }
    Ok(())
}

// ── Plugin Registry ─────────────────────────────────────────────────────

/// Registry of all loaded plugins.
pub struct PluginRegistry {
    plugins: Vec<Plugin>,
}

impl PluginRegistry {
    /// Load plugins from the plugins directory.
    pub fn load(plugins_dir: &Path) -> Self {
        let mut plugins = Vec::new();

        let entries = match std::fs::read_dir(plugins_dir) {
            Ok(e) => e,
            Err(_) => {
                // Create the directory for future use
                std::fs::create_dir_all(plugins_dir).ok();
                return Self { plugins };
            }
        };

        // Load enabled state from settings
        let settings = load_plugin_settings(plugins_dir);

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() { continue; }

            let manifest_path = path.join(MANIFEST_FILE);
            if !manifest_path.exists() { continue; }

            match load_manifest(&manifest_path) {
                Ok(manifest) => {
                    let id = path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let enabled = settings.get(&id)
                        .copied()
                        .unwrap_or(manifest.default_enabled);
                    log::info!("Plugin loaded: {} v{} (enabled: {})", manifest.name, manifest.version, enabled);
                    plugins.push(Plugin { id, manifest, root: path, enabled });
                }
                Err(e) => {
                    log::warn!("Failed to load plugin at {}: {e}", path.display());
                }
            }
        }

        Self { plugins }
    }

    /// Get all enabled plugins.
    pub fn enabled(&self) -> impl Iterator<Item = &Plugin> {
        self.plugins.iter().filter(|p| p.enabled)
    }

    /// List all plugins (for frontend).
    pub fn list(&self) -> &[Plugin] {
        &self.plugins
    }

    /// Get a plugin by ID.
    pub fn get(&self, id: &str) -> Option<&Plugin> {
        self.plugins.iter().find(|p| p.id == id)
    }

    /// Aggregate all hook configs from enabled plugins.
    pub fn aggregated_hooks(&self) -> PluginHooks {
        let mut hooks = PluginHooks::default();
        for plugin in self.enabled() {
            hooks.merge(&plugin.manifest.hooks);
        }
        hooks
    }

    /// Collect all tool definitions from enabled plugins.
    pub fn all_tool_definitions(&self) -> Vec<super::tools::ToolDefinition> {
        let mut defs = Vec::new();
        for plugin in self.enabled() {
            defs.extend(plugin.tool_definitions());
        }
        defs
    }

    /// Find which plugin owns a tool name (format: `plugin__<id>__<tool_name>`).
    pub fn find_tool_plugin<'a>(&'a self, full_tool_name: &'a str) -> Option<(&'a Plugin, &'a str)> {
        if let Some(rest) = full_tool_name.strip_prefix("plugin__") {
            if let Some(sep) = rest.find("__") {
                let plugin_id = &rest[..sep];
                let tool_name = &rest[sep + 2..];
                if let Some(plugin) = self.get(plugin_id) {
                    return Some((plugin, tool_name));
                }
            }
        }
        None
    }

    /// Execute a plugin tool by its full name.
    pub fn execute_tool(&self, full_tool_name: &str, input: &serde_json::Value) -> Result<String, String> {
        let (plugin, tool_name) = self.find_tool_plugin(full_tool_name)
            .ok_or_else(|| format!("Plugin tool not found: {full_tool_name}"))?;
        plugin.execute_tool(tool_name, input)
    }

    /// Initialize all enabled plugins (run lifecycle init commands).
    pub fn initialize_all(&self) {
        for plugin in self.enabled() {
            if let Err(e) = plugin.initialize() {
                log::warn!("Plugin '{}' init failed: {e}", plugin.id);
            }
        }
    }

    /// Shutdown all enabled plugins (run lifecycle shutdown commands).
    #[allow(dead_code)]
    pub fn shutdown_all(&self) {
        for plugin in self.plugins.iter().rev().filter(|p| p.enabled) {
            if let Err(e) = plugin.shutdown() {
                log::warn!("Plugin '{}' shutdown failed: {e}", plugin.id);
            }
        }
    }

    /// Enable/disable a plugin and save settings.
    pub fn set_enabled(&mut self, plugins_dir: &Path, id: &str, enabled: bool) {
        if let Some(plugin) = self.plugins.iter_mut().find(|p| p.id == id) {
            plugin.enabled = enabled;
        }
        save_plugin_settings(plugins_dir, &self.plugins);
    }
}

// ── Settings persistence ────────────────────────────────────────────────

fn load_plugin_settings(plugins_dir: &Path) -> HashMap<String, bool> {
    let path = plugins_dir.join("settings.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_plugin_settings(plugins_dir: &Path, plugins: &[Plugin]) {
    let settings: HashMap<String, bool> = plugins.iter()
        .map(|p| (p.id.clone(), p.enabled))
        .collect();
    let path = plugins_dir.join("settings.json");
    if let Ok(json) = serde_json::to_string_pretty(&settings) {
        std::fs::write(path, json).ok();
    }
}

fn load_manifest(path: &Path) -> Result<PluginManifest, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Invalid plugin.json at {}: {e}", path.display()))
}
