use std::fmt;

/// A lock held by an agent on a specific module within a branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchLock {
    /// The branch name, e.g. "feat/new-tools".
    pub branch: String,
    /// The module path being locked, e.g. "engine/tools".
    pub module: String,
    /// The agent that holds this lock.
    pub agent_id: String,
    /// Unix timestamp when the lock was acquired.
    pub acquired_at: i64,
}

/// Information about a lock collision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockCollision {
    /// The agent that currently holds the conflicting lock.
    pub held_by: String,
    /// The module that is locked.
    pub module: String,
    /// When the lock was acquired (unix timestamp).
    pub since: i64,
}

impl fmt::Display for LockCollision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Module '{}' is locked by agent '{}' since {}",
            self.module, self.held_by, self.since,
        )
    }
}

/// Registry that tracks module-level branch locks across agents.
///
/// Prevents two agents from modifying the same module on the same branch
/// concurrently. Modules are compared with path-prefix awareness, so locking
/// "engine" also conflicts with "engine/tools".
#[derive(Debug, Clone, Default)]
pub struct BranchLockRegistry {
    locks: Vec<BranchLock>,
}

impl BranchLockRegistry {
    pub fn new() -> Self {
        Self { locks: Vec::new() }
    }

    /// Attempt to acquire a lock on `module` within `branch` for `agent_id`.
    ///
    /// Returns `Err(LockCollision)` if another agent already holds a
    /// conflicting lock on the same branch and an overlapping module.
    pub fn acquire(
        &mut self,
        branch: &str,
        module: &str,
        agent_id: &str,
    ) -> Result<(), LockCollision> {
        if let Some(collision) = self.check_collision_excluding(branch, module, agent_id) {
            return Err(collision);
        }

        // Remove any existing lock by this agent on this branch+module
        // before inserting the new one.
        self.locks.retain(|l| {
            !(l.branch == branch && l.module == module && l.agent_id == agent_id)
        });

        self.locks.push(BranchLock {
            branch: branch.to_string(),
            module: module.to_string(),
            agent_id: agent_id.to_string(),
            acquired_at: now_epoch_secs(),
        });

        Ok(())
    }

    /// Release all locks held by `agent_id` on `branch`.
    pub fn release(&mut self, branch: &str, agent_id: &str) {
        self.locks
            .retain(|l| !(l.branch == branch && l.agent_id == agent_id));
    }

    /// Check whether any other agent holds a conflicting lock on `module`
    /// within `branch`. Returns the first collision found, if any.
    #[allow(dead_code)]
    pub fn check_collision(&self, branch: &str, module: &str) -> Option<&BranchLock> {
        self.locks.iter().find(|l| {
            l.branch == branch && modules_overlap(&l.module, module)
        })
    }

    /// Return all currently held locks.
    #[allow(dead_code)]
    pub fn list_locks(&self) -> &[BranchLock] {
        &self.locks
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

impl BranchLockRegistry {
    /// Like `check_collision`, but excludes locks held by `exclude_agent`.
    fn check_collision_excluding(
        &self,
        branch: &str,
        module: &str,
        exclude_agent: &str,
    ) -> Option<LockCollision> {
        self.locks
            .iter()
            .find(|l| {
                l.branch == branch
                    && l.agent_id != exclude_agent
                    && modules_overlap(&l.module, module)
            })
            .map(|l| LockCollision {
                held_by: l.agent_id.clone(),
                module: l.module.clone(),
                since: l.acquired_at,
            })
    }
}

/// Two modules overlap if one is a prefix of the other (respecting path boundaries).
fn modules_overlap(a: &str, b: &str) -> bool {
    a == b
        || a.starts_with(&format!("{}/", b))
        || b.starts_with(&format!("{}/", a))
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
    fn acquire_and_list_locks() {
        let mut reg = BranchLockRegistry::new();
        reg.acquire("feat/x", "engine/tools", "agent-1").unwrap();
        assert_eq!(reg.list_locks().len(), 1);
        assert_eq!(reg.list_locks()[0].module, "engine/tools");
    }

    #[test]
    fn collision_on_same_module() {
        let mut reg = BranchLockRegistry::new();
        reg.acquire("feat/x", "engine/tools", "agent-1").unwrap();
        let err = reg.acquire("feat/x", "engine/tools", "agent-2").unwrap_err();
        assert_eq!(err.held_by, "agent-1");
        assert_eq!(err.module, "engine/tools");
    }

    #[test]
    fn collision_on_nested_module() {
        let mut reg = BranchLockRegistry::new();
        reg.acquire("feat/x", "engine", "agent-1").unwrap();
        let err = reg
            .acquire("feat/x", "engine/tools", "agent-2")
            .unwrap_err();
        assert_eq!(err.held_by, "agent-1");
    }

    #[test]
    fn no_collision_on_different_branch() {
        let mut reg = BranchLockRegistry::new();
        reg.acquire("feat/a", "engine/tools", "agent-1").unwrap();
        assert!(reg.acquire("feat/b", "engine/tools", "agent-2").is_ok());
    }

    #[test]
    fn no_collision_on_disjoint_modules() {
        let mut reg = BranchLockRegistry::new();
        reg.acquire("feat/x", "engine/tools", "agent-1").unwrap();
        assert!(reg.acquire("feat/x", "engine/db", "agent-2").is_ok());
    }

    #[test]
    fn same_agent_can_reacquire() {
        let mut reg = BranchLockRegistry::new();
        reg.acquire("feat/x", "engine/tools", "agent-1").unwrap();
        assert!(reg.acquire("feat/x", "engine/tools", "agent-1").is_ok());
        // Should not duplicate
        assert_eq!(reg.list_locks().len(), 1);
    }

    #[test]
    fn release_removes_agent_locks() {
        let mut reg = BranchLockRegistry::new();
        reg.acquire("feat/x", "engine/tools", "agent-1").unwrap();
        reg.acquire("feat/x", "engine/db", "agent-1").unwrap();
        reg.release("feat/x", "agent-1");
        assert!(reg.list_locks().is_empty());
    }

    #[test]
    fn check_collision_returns_existing_lock() {
        let mut reg = BranchLockRegistry::new();
        reg.acquire("feat/x", "engine/tools", "agent-1").unwrap();
        let lock = reg.check_collision("feat/x", "engine/tools").unwrap();
        assert_eq!(lock.agent_id, "agent-1");
    }

    #[test]
    fn check_collision_returns_none_when_free() {
        let reg = BranchLockRegistry::new();
        assert!(reg.check_collision("feat/x", "engine/tools").is_none());
    }
}
