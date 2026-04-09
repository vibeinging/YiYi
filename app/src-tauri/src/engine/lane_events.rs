//! Structured event system for Agent observability.
//!
//! Provides a typed event log that tracks agent lifecycle, CI signals,
//! git milestones, and failure diagnostics. Inspired by Claw Code's
//! lane event design, adapted for YiYi's single-agent desktop context.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// High-level event types covering the full agent lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaneEventType {
    Started,
    Ready,
    Running,
    Blocked,
    Red,
    Green,
    CommitCreated,
    PrOpened,
    MergeReady,
    Finished,
    Failed,
    Reconciled,
    Merged,
    Closed,
}

/// Taxonomy of failure causes for structured diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    PromptDelivery,
    TrustGate,
    BranchDivergence,
    Compile,
    Test,
    PluginStartup,
    McpStartup,
    McpHandshake,
    ToolRuntime,
    Infra,
}

impl std::fmt::Display for FailureClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PromptDelivery => write!(f, "prompt_delivery"),
            Self::TrustGate => write!(f, "trust_gate"),
            Self::BranchDivergence => write!(f, "branch_divergence"),
            Self::Compile => write!(f, "compile"),
            Self::Test => write!(f, "test"),
            Self::PluginStartup => write!(f, "plugin_startup"),
            Self::McpStartup => write!(f, "mcp_startup"),
            Self::McpHandshake => write!(f, "mcp_handshake"),
            Self::ToolRuntime => write!(f, "tool_runtime"),
            Self::Infra => write!(f, "infra"),
        }
    }
}

/// A single structured event emitted during agent execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaneEvent {
    pub event_type: LaneEventType,
    pub timestamp: i64,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_class: Option<FailureClass>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, String>,
}

impl LaneEvent {
    /// Create a new event with the minimum required fields.
    #[must_use]
    pub fn new(event_type: LaneEventType, timestamp: i64, session_id: impl Into<String>) -> Self {
        Self {
            event_type,
            timestamp,
            session_id: session_id.into(),
            agent_name: None,
            failure_class: None,
            message: None,
            metadata: HashMap::new(),
        }
    }

    /// Builder: attach an agent name.
    #[must_use]
    pub fn with_agent(mut self, name: impl Into<String>) -> Self {
        self.agent_name = Some(name.into());
        self
    }

    /// Builder: attach a failure class.
    #[must_use]
    pub fn with_failure(mut self, class: FailureClass) -> Self {
        self.failure_class = Some(class);
        self
    }

    /// Builder: attach a human-readable message.
    #[must_use]
    pub fn with_message(mut self, msg: impl Into<String>) -> Self {
        self.message = Some(msg.into());
        self
    }

    /// Builder: insert a metadata key-value pair.
    #[must_use]
    pub fn with_meta(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.metadata.insert(key.into(), value.into());
        self
    }

    /// Convenience: create a `Failed` event from a failure class.
    #[must_use]
    pub fn failed(
        timestamp: i64,
        session_id: impl Into<String>,
        class: FailureClass,
        detail: impl Into<String>,
    ) -> Self {
        Self::new(LaneEventType::Failed, timestamp, session_id)
            .with_failure(class)
            .with_message(detail)
    }
}

/// Append-only log of lane events with query helpers.
#[derive(Debug, Clone, Default)]
pub struct LaneEventLog {
    events: Vec<LaneEvent>,
}

impl LaneEventLog {
    #[must_use]
    pub fn new() -> Self {
        Self { events: Vec::new() }
    }

    /// Append an event to the log.
    pub fn emit(&mut self, event: LaneEvent) {
        self.events.push(event);
    }

    /// Return all events with timestamp >= the given value.
    #[must_use]
    pub fn events_since(&self, timestamp: i64) -> &[LaneEvent] {
        match self.events.iter().position(|e| e.timestamp >= timestamp) {
            Some(pos) => &self.events[pos..],
            None => &[],
        }
    }

    /// Return references to all events matching a given type.
    #[must_use]
    pub fn filter_by_type(&self, t: LaneEventType) -> Vec<&LaneEvent> {
        self.events.iter().filter(|e| e.event_type == t).collect()
    }

    /// Return the most recent failure event, if any.
    #[must_use]
    pub fn last_failure(&self) -> Option<&LaneEvent> {
        self.events
            .iter()
            .rev()
            .find(|e| e.event_type == LaneEventType::Failed)
    }

    /// All events in the log.
    #[must_use]
    pub fn all(&self) -> &[LaneEvent] {
        &self.events
    }

    /// Human-readable summary of the event log.
    #[must_use]
    pub fn summary(&self) -> String {
        if self.events.is_empty() {
            return "No events recorded.".to_string();
        }

        let total = self.events.len();
        let failures = self
            .events
            .iter()
            .filter(|e| e.event_type == LaneEventType::Failed)
            .count();
        let has_finished = self
            .events
            .iter()
            .any(|e| e.event_type == LaneEventType::Finished);

        let status = if has_finished {
            "Finished"
        } else if failures > 0 {
            "Has failures"
        } else {
            "In progress"
        };

        let mut summary = format!(
            "{} event(s), {} failure(s), status: {}",
            total, failures, status
        );

        if let Some(last_fail) = self.last_failure() {
            if let Some(ref msg) = last_fail.message {
                summary.push_str(&format!(". Last failure: {}", msg));
            }
        }

        summary
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emit_and_query_events() {
        let mut log = LaneEventLog::new();
        log.emit(LaneEvent::new(LaneEventType::Started, 100, "s1"));
        log.emit(LaneEvent::new(LaneEventType::Running, 200, "s1"));
        log.emit(LaneEvent::failed(300, "s1", FailureClass::Compile, "build error"));
        log.emit(LaneEvent::new(LaneEventType::Finished, 400, "s1"));

        assert_eq!(log.all().len(), 4);
        assert_eq!(log.events_since(200).len(), 3);
        assert_eq!(log.filter_by_type(LaneEventType::Failed).len(), 1);
        assert!(log.last_failure().is_some());
        assert_eq!(
            log.last_failure().unwrap().failure_class,
            Some(FailureClass::Compile)
        );
    }

    #[test]
    fn summary_reports_status() {
        let mut log = LaneEventLog::new();
        assert_eq!(log.summary(), "No events recorded.");

        log.emit(LaneEvent::new(LaneEventType::Started, 1, "s1"));
        assert!(log.summary().contains("In progress"));

        log.emit(LaneEvent::failed(2, "s1", FailureClass::Test, "test failed"));
        assert!(log.summary().contains("Has failures"));
        assert!(log.summary().contains("test failed"));

        log.emit(LaneEvent::new(LaneEventType::Finished, 3, "s1"));
        assert!(log.summary().contains("Finished"));
    }

    #[test]
    fn builder_pattern_works() {
        let event = LaneEvent::new(LaneEventType::Running, 42, "s1")
            .with_agent("react-agent")
            .with_message("processing")
            .with_meta("tool", "shell");

        assert_eq!(event.agent_name.as_deref(), Some("react-agent"));
        assert_eq!(event.message.as_deref(), Some("processing"));
        assert_eq!(event.metadata.get("tool").map(|s| s.as_str()), Some("shell"));
    }

    #[test]
    fn events_since_returns_empty_for_future_timestamp() {
        let mut log = LaneEventLog::new();
        log.emit(LaneEvent::new(LaneEventType::Started, 100, "s1"));
        assert!(log.events_since(999).is_empty());
    }

    #[test]
    fn serialization_roundtrip() {
        let event = LaneEvent::failed(123, "s1", FailureClass::McpHandshake, "timeout");
        let json = serde_json::to_string(&event).expect("serialize");
        let deserialized: LaneEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deserialized.event_type, LaneEventType::Failed);
        assert_eq!(deserialized.failure_class, Some(FailureClass::McpHandshake));
    }
}
