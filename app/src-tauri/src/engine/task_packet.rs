//! Structured task definition for agent work items.
//!
//! A `TaskPacket` captures objective, scope, acceptance criteria, and
//! policies for a unit of agent work. Supports JSON serialization for
//! cross-boundary transport. Inspired by Claw Code's task_packet module.

use serde::{Deserialize, Serialize};

/// A structured task definition that an agent can execute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskPacket {
    pub objective: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default)]
    pub acceptance_tests: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub escalation_policy: Option<String>,
}

impl TaskPacket {
    /// Validate that the packet has the minimum required fields.
    /// Returns `Ok(())` if valid, or an error string describing issues.
    pub fn validate(&self) -> Result<(), String> {
        let mut errors = Vec::new();

        if self.objective.trim().is_empty() {
            errors.push("objective must not be empty".to_string());
        }

        for (i, test) in self.acceptance_tests.iter().enumerate() {
            if test.trim().is_empty() {
                errors.push(format!(
                    "acceptance_tests contains an empty value at index {}",
                    i
                ));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    /// Deserialize a `TaskPacket` from a JSON string.
    pub fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("invalid task packet JSON: {}", e))
    }

    /// Serialize this packet to a JSON string.
    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("TaskPacket should always serialize")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_packet() -> TaskPacket {
        TaskPacket {
            objective: "Implement lane events module".to_string(),
            scope: Some("engine/lane_events".to_string()),
            acceptance_tests: vec![
                "cargo check passes".to_string(),
                "cargo test passes".to_string(),
            ],
            commit_policy: Some("single commit".to_string()),
            branch_policy: Some("feat/claw-code-p0".to_string()),
            escalation_policy: Some("alert human on ambiguity".to_string()),
        }
    }

    #[test]
    fn valid_packet_passes_validation() {
        assert!(sample_packet().validate().is_ok());
    }

    #[test]
    fn empty_objective_fails_validation() {
        let mut p = sample_packet();
        p.objective = "  ".to_string();
        let err = p.validate().unwrap_err();
        assert!(err.contains("objective must not be empty"));
    }

    #[test]
    fn empty_acceptance_test_fails_validation() {
        let mut p = sample_packet();
        p.acceptance_tests.push(" ".to_string());
        let err = p.validate().unwrap_err();
        assert!(err.contains("acceptance_tests contains an empty value"));
    }

    #[test]
    fn json_roundtrip() {
        let packet = sample_packet();
        let json = packet.to_json();
        let restored = TaskPacket::from_json(&json).expect("should parse");
        assert_eq!(restored, packet);
    }

    #[test]
    fn from_json_rejects_invalid_input() {
        let result = TaskPacket::from_json("not json");
        assert!(result.is_err());
    }

    #[test]
    fn minimal_packet_is_valid() {
        let p = TaskPacket {
            objective: "do something".to_string(),
            scope: None,
            acceptance_tests: vec![],
            commit_policy: None,
            branch_policy: None,
            escalation_policy: None,
        };
        assert!(p.validate().is_ok());
    }
}
