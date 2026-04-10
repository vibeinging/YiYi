use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// Phases in the MCP server lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpPhase {
    ConfigLoad,
    ServerRegistration,
    SpawnConnect,
    InitializeHandshake,
    ToolDiscovery,
    Ready,
    Invocation,
    Error,
    Shutdown,
}

impl std::fmt::Display for McpPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ConfigLoad => write!(f, "config_load"),
            Self::ServerRegistration => write!(f, "server_registration"),
            Self::SpawnConnect => write!(f, "spawn_connect"),
            Self::InitializeHandshake => write!(f, "initialize_handshake"),
            Self::ToolDiscovery => write!(f, "tool_discovery"),
            Self::Ready => write!(f, "ready"),
            Self::Invocation => write!(f, "invocation"),
            Self::Error => write!(f, "error"),
            Self::Shutdown => write!(f, "shutdown"),
        }
    }
}

/// A structured error recorded during a lifecycle phase.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpError {
    pub phase: McpPhase,
    pub message: String,
    pub recoverable: bool,
    pub timestamp: i64,
}

/// Per-server lifecycle state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerLifecycle {
    pub server_name: String,
    pub current_phase: McpPhase,
    pub errors: Vec<McpError>,
    pub started_at: i64,
}

/// Summary status for a single MCP server, suitable for frontend display.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ServerStatus {
    pub server_name: String,
    pub phase: McpPhase,
    pub error_count: usize,
    pub last_error: Option<String>,
    pub started_at: i64,
}

/// Tracks lifecycle state for all MCP servers.
#[derive(Debug, Default)]
pub struct McpLifecycleTracker {
    servers: HashMap<String, McpServerLifecycle>,
}

impl McpLifecycleTracker {
    #[must_use]
    pub fn new() -> Self {
        Self {
            servers: HashMap::new(),
        }
    }

    /// Record a phase transition for a server. Creates the server entry if it does not exist.
    pub fn transition(&mut self, server: &str, phase: McpPhase) {
        let lifecycle = self
            .servers
            .entry(server.to_string())
            .or_insert_with(|| McpServerLifecycle {
                server_name: server.to_string(),
                current_phase: phase,
                errors: Vec::new(),
                started_at: now_secs(),
            });
        lifecycle.current_phase = phase;
    }

    /// Record an error for a server at a specific phase.
    pub fn record_error(
        &mut self,
        server: &str,
        phase: McpPhase,
        message: impl Into<String>,
        recoverable: bool,
    ) {
        let error = McpError {
            phase,
            message: message.into(),
            recoverable,
            timestamp: now_secs(),
        };

        let lifecycle = self
            .servers
            .entry(server.to_string())
            .or_insert_with(|| McpServerLifecycle {
                server_name: server.to_string(),
                current_phase: McpPhase::Error,
                errors: Vec::new(),
                started_at: now_secs(),
            });
        lifecycle.current_phase = McpPhase::Error;
        lifecycle.errors.push(error);
        // Cap errors to prevent unbounded growth
        if lifecycle.errors.len() > 50 {
            lifecycle.errors.drain(..lifecycle.errors.len() - 50);
        }
    }

    /// Return a status summary for every tracked server.
    #[must_use]
    #[allow(dead_code)]
    pub fn status_summary(&self) -> Vec<ServerStatus> {
        self.servers
            .values()
            .map(|lc| ServerStatus {
                server_name: lc.server_name.clone(),
                phase: lc.current_phase,
                error_count: lc.errors.len(),
                last_error: lc.errors.last().map(|e| e.message.clone()),
                started_at: lc.started_at,
            })
            .collect()
    }

    /// Suggest a recovery hint based on the error's phase.
    #[must_use]
    #[allow(dead_code)]
    pub fn get_recovery_hint(error: &McpError) -> Option<String> {
        if !error.recoverable {
            return Some("This error is not recoverable. Check the server configuration and restart.".to_string());
        }
        let hint = match error.phase {
            McpPhase::ConfigLoad => {
                "Check that the MCP config file exists and contains valid JSON."
            }
            McpPhase::ServerRegistration => {
                "Verify the server name and command are correct in the config."
            }
            McpPhase::SpawnConnect => {
                "The server process failed to start. Check the command path and permissions."
            }
            McpPhase::InitializeHandshake => {
                "Handshake failed. Ensure the server supports the expected MCP protocol version."
            }
            McpPhase::ToolDiscovery => {
                "Tool listing failed. The server may have started but is not responding to tool/list."
            }
            McpPhase::Invocation => {
                "A tool call failed. Retry, or check the tool's input parameters."
            }
            McpPhase::Ready | McpPhase::Error | McpPhase::Shutdown => {
                return None;
            }
        };
        Some(hint.to_string())
    }

    /// Get the lifecycle for a specific server.
    #[must_use]
    #[allow(dead_code)]
    pub fn get_server(&self, server: &str) -> Option<&McpServerLifecycle> {
        self.servers.get(server)
    }

    /// Remove a server from tracking (e.g. after shutdown).
    #[allow(dead_code)]
    pub fn remove_server(&mut self, server: &str) {
        self.servers.remove(server);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_creates_and_updates_server() {
        let mut tracker = McpLifecycleTracker::new();
        tracker.transition("alpha", McpPhase::ConfigLoad);
        assert_eq!(
            tracker.get_server("alpha").unwrap().current_phase,
            McpPhase::ConfigLoad
        );
        tracker.transition("alpha", McpPhase::Ready);
        assert_eq!(
            tracker.get_server("alpha").unwrap().current_phase,
            McpPhase::Ready
        );
    }

    #[test]
    fn record_error_sets_error_phase() {
        let mut tracker = McpLifecycleTracker::new();
        tracker.transition("beta", McpPhase::SpawnConnect);
        tracker.record_error("beta", McpPhase::SpawnConnect, "process exited", true);
        let lc = tracker.get_server("beta").unwrap();
        assert_eq!(lc.current_phase, McpPhase::Error);
        assert_eq!(lc.errors.len(), 1);
        assert!(lc.errors[0].recoverable);
    }

    #[test]
    fn status_summary_covers_all_servers() {
        let mut tracker = McpLifecycleTracker::new();
        tracker.transition("a", McpPhase::Ready);
        tracker.transition("b", McpPhase::ToolDiscovery);
        let summary = tracker.status_summary();
        assert_eq!(summary.len(), 2);
    }

    #[test]
    fn recovery_hint_for_spawn_connect() {
        let error = McpError {
            phase: McpPhase::SpawnConnect,
            message: "not found".to_string(),
            recoverable: true,
            timestamp: 0,
        };
        let hint = McpLifecycleTracker::get_recovery_hint(&error);
        assert!(hint.unwrap().contains("process"));
    }

    #[test]
    fn recovery_hint_for_non_recoverable() {
        let error = McpError {
            phase: McpPhase::ConfigLoad,
            message: "bad json".to_string(),
            recoverable: false,
            timestamp: 0,
        };
        let hint = McpLifecycleTracker::get_recovery_hint(&error);
        assert!(hint.unwrap().contains("not recoverable"));
    }

    #[test]
    fn remove_server_cleans_up() {
        let mut tracker = McpLifecycleTracker::new();
        tracker.transition("gone", McpPhase::Shutdown);
        tracker.remove_server("gone");
        assert!(tracker.get_server("gone").is_none());
    }
}
