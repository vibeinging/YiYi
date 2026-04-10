#![allow(dead_code)]
/// The level of "greenness" a branch has achieved.
///
/// Levels are ordered from least to most rigorous. A higher level
/// implies all lower levels have also passed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum GreenLevel {
    /// A specific targeted test passed.
    TargetedTests,
    /// All tests in the relevant package pass.
    Package,
    /// All tests across the entire workspace pass.
    Workspace,
    /// CI is green and review has been approved.
    MergeReady,
}

impl GreenLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TargetedTests => "targeted_tests",
            Self::Package => "package",
            Self::Workspace => "workspace",
            Self::MergeReady => "merge_ready",
        }
    }
}

impl std::fmt::Display for GreenLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// The result of evaluating a green contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractOutcome {
    /// The required green level has been met or exceeded.
    Satisfied,
    /// The required green level has not been met.
    Unsatisfied { reason: String },
}

impl ContractOutcome {
    pub fn is_satisfied(&self) -> bool {
        matches!(self, Self::Satisfied)
    }
}

/// Tracks the required and current build/test status for a branch.
///
/// A contract is "satisfied" when `current_level` meets or exceeds
/// `required_level`.
#[derive(Debug, Clone)]
pub struct GreenContract {
    pub required_level: GreenLevel,
    pub current_level: Option<GreenLevel>,
    pub last_check: Option<i64>,
}

impl GreenContract {
    /// Create a new contract with the given required level.
    pub fn new(required: GreenLevel) -> Self {
        Self {
            required_level: required,
            current_level: None,
            last_check: None,
        }
    }

    /// Evaluate whether the contract is currently satisfied.
    pub fn evaluate(&self) -> ContractOutcome {
        match self.current_level {
            Some(level) if level >= self.required_level => ContractOutcome::Satisfied,
            Some(level) => ContractOutcome::Unsatisfied {
                reason: format!(
                    "Current level '{}' does not meet required level '{}'",
                    level, self.required_level,
                ),
            },
            None => ContractOutcome::Unsatisfied {
                reason: format!(
                    "No green level recorded yet; required level is '{}'",
                    self.required_level,
                ),
            },
        }
    }

    /// Update the current green level and record the check timestamp.
    pub fn update_level(&mut self, level: GreenLevel) {
        self.current_level = Some(level);
        self.last_check = Some(now_epoch_secs());
    }

    /// Convenience: check if the contract is satisfied.
    pub fn is_satisfied(&self) -> bool {
        self.evaluate().is_satisfied()
    }
}

fn now_epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_contract_is_unsatisfied() {
        let c = GreenContract::new(GreenLevel::Package);
        assert!(!c.is_satisfied());
        match c.evaluate() {
            ContractOutcome::Unsatisfied { reason } => {
                assert!(reason.contains("No green level recorded"));
            }
            other => panic!("expected Unsatisfied, got {:?}", other),
        }
    }

    #[test]
    fn matching_level_satisfies_contract() {
        let mut c = GreenContract::new(GreenLevel::Package);
        c.update_level(GreenLevel::Package);
        assert!(c.is_satisfied());
        assert_eq!(c.evaluate(), ContractOutcome::Satisfied);
    }

    #[test]
    fn higher_level_satisfies_contract() {
        let mut c = GreenContract::new(GreenLevel::TargetedTests);
        c.update_level(GreenLevel::Workspace);
        assert!(c.is_satisfied());
    }

    #[test]
    fn lower_level_does_not_satisfy_contract() {
        let mut c = GreenContract::new(GreenLevel::Workspace);
        c.update_level(GreenLevel::Package);
        assert!(!c.is_satisfied());
        match c.evaluate() {
            ContractOutcome::Unsatisfied { reason } => {
                assert!(reason.contains("does not meet required"));
            }
            other => panic!("expected Unsatisfied, got {:?}", other),
        }
    }

    #[test]
    fn update_level_records_timestamp() {
        let mut c = GreenContract::new(GreenLevel::TargetedTests);
        assert!(c.last_check.is_none());
        c.update_level(GreenLevel::TargetedTests);
        assert!(c.last_check.is_some());
        assert!(c.last_check.unwrap() > 0);
    }
}
