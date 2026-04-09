//! Auto-recovery engine for known failure scenarios.
//!
//! Encodes recovery recipes for common failures (MCP handshake, plugin
//! startup, branch divergence, etc.) and enforces max-attempt limits
//! before escalation. Inspired by Claw Code's recovery_recipes module,
//! adapted for YiYi's desktop agent context.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::lane_events::FailureClass;

/// Individual action that can be executed as part of recovery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    RetryMcpHandshake { timeout_ms: u64 },
    RestartPlugin { plugin_id: String },
    RestartWorker { worker_id: String },
    RebaseBranch,
    CleanBuild,
    AcceptTrustPrompt,
    RedirectPrompt { target: String },
    AlertHuman { message: String },
}

/// Policy governing what happens when automatic recovery is exhausted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EscalationPolicy {
    AlertHuman,
    LogAndContinue,
    Abort,
}

/// A recovery recipe ties a failure class to a sequence of actions,
/// a retry budget, and an escalation policy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryRecipe {
    pub failure_class: FailureClass,
    pub actions: Vec<RecoveryAction>,
    pub max_attempts: u32,
    pub escalation: EscalationPolicy,
}

/// Outcome of a recovery attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryOutcome {
    /// Recovery actions to execute.
    ActionsToExecute(Vec<RecoveryAction>),
    /// Max attempts reached or recipe missing — escalate.
    Escalate(EscalationPolicy),
    /// Absolute limit reached; no more retries allowed.
    MaxAttemptsReached,
}

/// Engine that holds recovery recipes and tracks per-failure attempt counts.
#[derive(Debug, Clone)]
pub struct RecoveryEngine {
    recipes: Vec<RecoveryRecipe>,
    attempt_counts: HashMap<String, u32>,
}

impl Default for RecoveryEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl RecoveryEngine {
    /// Create a new engine pre-loaded with default recipes for known scenarios.
    #[must_use]
    pub fn new() -> Self {
        Self {
            recipes: default_recipes(),
            attempt_counts: HashMap::new(),
        }
    }

    /// Look up a recipe and attempt recovery. Returns actions to execute,
    /// an escalation directive, or `MaxAttemptsReached`.
    pub fn try_recover(&mut self, failure: &FailureClass) -> RecoveryOutcome {
        let key = failure.to_string();

        let recipe = match self.recipes.iter().find(|r| r.failure_class == *failure) {
            Some(r) => r.clone(),
            None => {
                return RecoveryOutcome::Escalate(EscalationPolicy::AlertHuman);
            }
        };

        let count = self.attempt_counts.entry(key).or_insert(0);

        if *count >= recipe.max_attempts {
            return RecoveryOutcome::MaxAttemptsReached;
        }

        *count += 1;
        RecoveryOutcome::ActionsToExecute(recipe.actions.clone())
    }

    /// Reset the attempt counter for a specific failure class (e.g. after
    /// a successful recovery or manual intervention).
    pub fn reset_attempts(&mut self, failure: &FailureClass) {
        self.attempt_counts.remove(&failure.to_string());
    }

    /// Return the current attempt count for a failure class.
    #[must_use]
    pub fn attempt_count(&self, failure: &FailureClass) -> u32 {
        self.attempt_counts
            .get(&failure.to_string())
            .copied()
            .unwrap_or(0)
    }

    /// Return all registered recipes (for inspection / UI display).
    #[must_use]
    pub fn recipes(&self) -> &[RecoveryRecipe] {
        &self.recipes
    }
}

/// Built-in recovery recipes covering 7 common failure scenarios.
fn default_recipes() -> Vec<RecoveryRecipe> {
    vec![
        // 1. MCP handshake failure → retry with timeout
        RecoveryRecipe {
            failure_class: FailureClass::McpHandshake,
            actions: vec![RecoveryAction::RetryMcpHandshake { timeout_ms: 5000 }],
            max_attempts: 2,
            escalation: EscalationPolicy::Abort,
        },
        // 2. MCP startup failure → restart plugin then retry handshake
        RecoveryRecipe {
            failure_class: FailureClass::McpStartup,
            actions: vec![
                RecoveryAction::RestartPlugin {
                    plugin_id: "stalled".to_string(),
                },
                RecoveryAction::RetryMcpHandshake { timeout_ms: 3000 },
            ],
            max_attempts: 1,
            escalation: EscalationPolicy::LogAndContinue,
        },
        // 3. Plugin startup failure → restart the plugin
        RecoveryRecipe {
            failure_class: FailureClass::PluginStartup,
            actions: vec![RecoveryAction::RestartPlugin {
                plugin_id: "failed".to_string(),
            }],
            max_attempts: 2,
            escalation: EscalationPolicy::AlertHuman,
        },
        // 4. Branch divergence → rebase then clean build
        RecoveryRecipe {
            failure_class: FailureClass::BranchDivergence,
            actions: vec![RecoveryAction::RebaseBranch, RecoveryAction::CleanBuild],
            max_attempts: 1,
            escalation: EscalationPolicy::AlertHuman,
        },
        // 5. Compile failure → clean build
        RecoveryRecipe {
            failure_class: FailureClass::Compile,
            actions: vec![RecoveryAction::CleanBuild],
            max_attempts: 1,
            escalation: EscalationPolicy::AlertHuman,
        },
        // 6. Trust gate → accept prompt
        RecoveryRecipe {
            failure_class: FailureClass::TrustGate,
            actions: vec![RecoveryAction::AcceptTrustPrompt],
            max_attempts: 1,
            escalation: EscalationPolicy::AlertHuman,
        },
        // 7. Prompt delivery failure → redirect prompt
        RecoveryRecipe {
            failure_class: FailureClass::PromptDelivery,
            actions: vec![RecoveryAction::RedirectPrompt {
                target: "default_agent".to_string(),
            }],
            max_attempts: 1,
            escalation: EscalationPolicy::AlertHuman,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_engine_has_seven_recipes() {
        let engine = RecoveryEngine::new();
        assert_eq!(engine.recipes().len(), 7);
    }

    #[test]
    fn successful_recovery_returns_actions() {
        let mut engine = RecoveryEngine::new();
        let outcome = engine.try_recover(&FailureClass::McpHandshake);
        match outcome {
            RecoveryOutcome::ActionsToExecute(actions) => {
                assert_eq!(actions.len(), 1);
                assert!(matches!(
                    actions[0],
                    RecoveryAction::RetryMcpHandshake { timeout_ms: 5000 }
                ));
            }
            other => panic!("expected ActionsToExecute, got {:?}", other),
        }
        assert_eq!(engine.attempt_count(&FailureClass::McpHandshake), 1);
    }

    #[test]
    fn max_attempts_reached_after_budget_exhausted() {
        let mut engine = RecoveryEngine::new();
        // TrustGate has max_attempts=1
        let first = engine.try_recover(&FailureClass::TrustGate);
        assert!(matches!(first, RecoveryOutcome::ActionsToExecute(_)));

        let second = engine.try_recover(&FailureClass::TrustGate);
        assert!(matches!(second, RecoveryOutcome::MaxAttemptsReached));
    }

    #[test]
    fn reset_attempts_allows_retry() {
        let mut engine = RecoveryEngine::new();
        engine.try_recover(&FailureClass::Compile);
        assert_eq!(engine.attempt_count(&FailureClass::Compile), 1);

        engine.reset_attempts(&FailureClass::Compile);
        assert_eq!(engine.attempt_count(&FailureClass::Compile), 0);

        let outcome = engine.try_recover(&FailureClass::Compile);
        assert!(matches!(outcome, RecoveryOutcome::ActionsToExecute(_)));
    }

    #[test]
    fn unknown_failure_class_escalates() {
        let mut engine = RecoveryEngine::new();
        // Test and Infra have no recipes in default set
        let outcome = engine.try_recover(&FailureClass::Test);
        assert!(matches!(outcome, RecoveryOutcome::Escalate(EscalationPolicy::AlertHuman)));
    }

    #[test]
    fn branch_divergence_recipe_has_rebase_then_clean_build() {
        let engine = RecoveryEngine::new();
        let recipe = engine
            .recipes()
            .iter()
            .find(|r| r.failure_class == FailureClass::BranchDivergence)
            .expect("should have branch divergence recipe");
        assert_eq!(recipe.actions.len(), 2);
        assert!(matches!(recipe.actions[0], RecoveryAction::RebaseBranch));
        assert!(matches!(recipe.actions[1], RecoveryAction::CleanBuild));
    }
}
