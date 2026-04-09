use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Condition that determines whether a rule fires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PolicyCondition {
    /// Always matches.
    Always,
    /// Matches when the current git branch equals the given name.
    GitBranchIs { branch: String },
    /// Matches when a file exists at the given path.
    FileExists { path: String },
    /// Matches when the context timestamp is after the given ISO-8601 time string.
    TimeAfter { time: String },
    /// Matches a custom key-value pair in the context's `custom` map.
    Custom { key: String, value: String },
}

impl PolicyCondition {
    /// Evaluate this condition against the given context.
    #[must_use]
    pub fn matches(&self, ctx: &PolicyContext) -> bool {
        match self {
            Self::Always => true,
            Self::GitBranchIs { branch } => {
                ctx.branch.as_deref() == Some(branch.as_str())
            }
            Self::FileExists { path } => ctx.files.iter().any(|f| f == path),
            Self::TimeAfter { time } => {
                // Simple lexicographic comparison on ISO-8601 strings.
                if let Some(ctx_time) = ctx.custom.get("time") {
                    ctx_time.as_str() >= time.as_str()
                } else {
                    // Fall back to comparing the raw timestamp.
                    ctx.timestamp > 0
                }
            }
            Self::Custom { key, value } => {
                ctx.custom.get(key).map_or(false, |v| v == value)
            }
        }
    }
}

/// Action to execute when a rule matches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PolicyAction {
    /// Send a notification with a message.
    Notify { message: String },
    /// Run a named tool with the given input.
    RunTool { tool_name: String, input: String },
    /// Block the operation with a reason.
    Block { reason: String },
    /// Log a message.
    Log { message: String },
}

/// A single policy rule: condition + action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRule {
    pub name: String,
    pub condition: PolicyCondition,
    pub action: PolicyAction,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

/// Context provided to the policy engine for rule evaluation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PolicyContext {
    pub branch: Option<String>,
    pub files: Vec<String>,
    pub timestamp: i64,
    #[serde(default)]
    pub custom: HashMap<String, String>,
}

/// Rule-based policy engine.
#[derive(Debug, Clone, Default)]
pub struct PolicyEngine {
    rules: Vec<PolicyRule>,
}

impl PolicyEngine {
    #[must_use]
    pub fn new() -> Self {
        Self { rules: Vec::new() }
    }

    /// Create an engine with the given rules.
    #[must_use]
    pub fn with_rules(rules: Vec<PolicyRule>) -> Self {
        Self { rules }
    }

    /// Add a rule to the engine.
    pub fn add_rule(&mut self, rule: PolicyRule) {
        self.rules.push(rule);
    }

    /// Return the current rules.
    #[must_use]
    pub fn rules(&self) -> &[PolicyRule] {
        &self.rules
    }

    /// Evaluate all enabled rules against the context and collect matching actions.
    #[must_use]
    pub fn evaluate(&self, context: &PolicyContext) -> Vec<PolicyAction> {
        self.rules
            .iter()
            .filter(|rule| rule.enabled && rule.condition.matches(context))
            .map(|rule| rule.action.clone())
            .collect()
    }

    /// Load rules from a JSON file. Returns an error string on failure.
    pub fn load_from_config(path: &Path) -> Result<Self, String> {
        let content =
            fs::read_to_string(path).map_err(|e| format!("failed to read policy config: {e}"))?;
        let rules: Vec<PolicyRule> = serde_json::from_str(&content)
            .map_err(|e| format!("failed to parse policy config: {e}"))?;
        Ok(Self { rules })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_context() -> PolicyContext {
        PolicyContext {
            branch: Some("main".to_string()),
            files: vec!["src/lib.rs".to_string(), "README.md".to_string()],
            timestamp: 1000,
            custom: {
                let mut m = HashMap::new();
                m.insert("env".to_string(), "production".to_string());
                m
            },
        }
    }

    #[test]
    fn always_condition_matches() {
        let ctx = sample_context();
        assert!(PolicyCondition::Always.matches(&ctx));
    }

    #[test]
    fn git_branch_condition() {
        let ctx = sample_context();
        assert!(PolicyCondition::GitBranchIs {
            branch: "main".to_string()
        }
        .matches(&ctx));
        assert!(!PolicyCondition::GitBranchIs {
            branch: "dev".to_string()
        }
        .matches(&ctx));
    }

    #[test]
    fn file_exists_condition() {
        let ctx = sample_context();
        assert!(PolicyCondition::FileExists {
            path: "src/lib.rs".to_string()
        }
        .matches(&ctx));
        assert!(!PolicyCondition::FileExists {
            path: "missing.rs".to_string()
        }
        .matches(&ctx));
    }

    #[test]
    fn custom_condition() {
        let ctx = sample_context();
        assert!(PolicyCondition::Custom {
            key: "env".to_string(),
            value: "production".to_string()
        }
        .matches(&ctx));
        assert!(!PolicyCondition::Custom {
            key: "env".to_string(),
            value: "staging".to_string()
        }
        .matches(&ctx));
    }

    #[test]
    fn evaluate_collects_matching_actions() {
        let engine = PolicyEngine::with_rules(vec![
            PolicyRule {
                name: "always-log".to_string(),
                condition: PolicyCondition::Always,
                action: PolicyAction::Log {
                    message: "hello".to_string(),
                },
                enabled: true,
            },
            PolicyRule {
                name: "branch-notify".to_string(),
                condition: PolicyCondition::GitBranchIs {
                    branch: "main".to_string(),
                },
                action: PolicyAction::Notify {
                    message: "on main".to_string(),
                },
                enabled: true,
            },
            PolicyRule {
                name: "disabled".to_string(),
                condition: PolicyCondition::Always,
                action: PolicyAction::Block {
                    reason: "should not appear".to_string(),
                },
                enabled: false,
            },
        ]);

        let actions = engine.evaluate(&sample_context());
        assert_eq!(actions.len(), 2);
        assert_eq!(
            actions[0],
            PolicyAction::Log {
                message: "hello".to_string()
            }
        );
        assert_eq!(
            actions[1],
            PolicyAction::Notify {
                message: "on main".to_string()
            }
        );
    }

    #[test]
    fn load_from_config_parses_json() {
        let tmp = std::env::temp_dir().join("yiyi-policy-test.json");
        let json = serde_json::to_string(&vec![PolicyRule {
            name: "test".to_string(),
            condition: PolicyCondition::Always,
            action: PolicyAction::Log {
                message: "loaded".to_string(),
            },
            enabled: true,
        }])
        .unwrap();
        fs::write(&tmp, &json).unwrap();

        let engine = PolicyEngine::load_from_config(&tmp).unwrap();
        assert_eq!(engine.rules().len(), 1);
        assert_eq!(engine.rules()[0].name, "test");

        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn load_from_missing_file_returns_error() {
        let result = PolicyEngine::load_from_config(Path::new("/nonexistent/policy.json"));
        assert!(result.is_err());
    }
}
