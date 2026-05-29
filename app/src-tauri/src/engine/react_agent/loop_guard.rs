//! Anti-loop guard for the ReAct loop.
//!
//! Tracks per-turn `(tool_name, canonical_args_hash) -> call_count` and
//! per-tool `failure_count`. When the model retries the same tool with the
//! same arguments past a threshold we synthesize a corrective tool result
//! instead of executing the tool again. After many cumulative failures we
//! halt the loop.
//!
//! Ported from DeepSeek-TUI's `loop_guard.rs`.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// How many times the *exact same* (tool, args) call may run before we block it.
pub const IDENTICAL_CALL_BLOCK_THRESHOLD: u32 = 3;
/// After this many failures of one tool, append a corrective warning.
pub const FAILURE_WARN_THRESHOLD: u32 = 3;
/// After this many failures of one tool, halt the ReAct loop.
pub const FAILURE_HALT_THRESHOLD: u32 = 8;

/// Decision returned for a tool *attempt* (before execution).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptDecision {
    /// Execute the tool normally.
    Proceed,
    /// Skip execution; feed `String` back to the model as a fake tool result.
    Block(String),
}

/// Decision returned after recording a tool *outcome* (success / failure).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutcomeDecision {
    /// Continue the loop normally.
    Continue,
    /// Continue but append the warning as a corrective user message
    /// (LLM-facing — the string is injected into the conversation as guidance).
    Warn(String),
    /// Halt the ReAct loop. Carries structured data so the caller can render
    /// a user-facing message in the right language; loop_guard does not own
    /// terminal copy.
    Halt { tool: String, count: u32 },
}

/// Per-turn loop guard. Counters reset between turns by re-instantiating.
#[derive(Debug, Default)]
pub struct LoopGuard {
    /// (tool_name, canonical_args_hash) -> attempt count.
    call_counts: HashMap<(String, u64), u32>,
    /// tool_name -> cumulative failure count this turn.
    failure_counts: HashMap<String, u32>,
}

impl LoopGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a tool attempt. Returns `Block` if this exact call has already
    /// been executed `IDENTICAL_CALL_BLOCK_THRESHOLD` times.
    pub fn record_attempt(&mut self, tool: &str, args: &serde_json::Value) -> AttemptDecision {
        let h = canonical_hash(args);
        let key = (tool.to_string(), h);
        let entry = self.call_counts.entry(key).or_insert(0);
        *entry += 1;
        let count = *entry;
        if count > IDENTICAL_CALL_BLOCK_THRESHOLD {
            let msg = format!(
                "Error: identical_call_blocked (tool={} count={}). \
                 This exact tool call (same arguments) has already been issued \
                 {} times this turn. Stop retrying it unchanged. Either change \
                 the arguments, pick a different tool, or summarize what you \
                 have so far and stop.",
                tool, count, count
            );
            AttemptDecision::Block(msg)
        } else {
            AttemptDecision::Proceed
        }
    }

    /// Record the outcome of a tool execution. `ok=false` increments the
    /// per-tool failure counter and may produce a Warn or Halt decision.
    pub fn record_outcome(&mut self, tool: &str, ok: bool) -> OutcomeDecision {
        if ok {
            return OutcomeDecision::Continue;
        }
        let entry = self.failure_counts.entry(tool.to_string()).or_insert(0);
        *entry += 1;
        let count = *entry;
        if count >= FAILURE_HALT_THRESHOLD {
            OutcomeDecision::Halt { tool: tool.to_string(), count }
        } else if count >= FAILURE_WARN_THRESHOLD {
            OutcomeDecision::Warn(format!(
                "Warning: tool '{}' has failed {} times in this turn. \
                 Reconsider your approach — try a different tool, change \
                 arguments substantially, or stop and report the blocker \
                 to the user.",
                tool, count
            ))
        } else {
            OutcomeDecision::Continue
        }
    }
}

/// Heuristic: tool result content represents a failure if it begins with
/// `Error:` (case-insensitive on the prefix). Keeps the rule simple,
/// defensible, and aligned with how built-in tools format error strings.
pub fn is_failure_content(content: &str) -> bool {
    let trimmed = content.trim_start();
    // .get(..6) 在 6 不是 char 边界时返回 None(首字符是多字节/emoji)→ 直接非
    // "error:",不会 panic。避免对中文/emoji 开头的工具结果字节切片崩溃。
    trimmed
        .get(..6)
        .is_some_and(|p| p.eq_ignore_ascii_case("error:"))
}

/// Stable canonical-JSON hash. Object keys are sorted before hashing so that
/// `{"a":1,"b":2}` and `{"b":2,"a":1}` produce the same hash.
fn canonical_hash(value: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    hash_canonical(value, &mut hasher);
    hasher.finish()
}

fn hash_canonical(value: &serde_json::Value, hasher: &mut DefaultHasher) {
    use serde_json::Value;
    match value {
        Value::Null => 0u8.hash(hasher),
        Value::Bool(b) => {
            1u8.hash(hasher);
            b.hash(hasher);
        }
        Value::Number(n) => {
            2u8.hash(hasher);
            // Use the canonical string form to fold int/float reps.
            n.to_string().hash(hasher);
        }
        Value::String(s) => {
            3u8.hash(hasher);
            s.hash(hasher);
        }
        Value::Array(arr) => {
            4u8.hash(hasher);
            (arr.len() as u64).hash(hasher);
            for v in arr {
                hash_canonical(v, hasher);
            }
        }
        Value::Object(map) => {
            5u8.hash(hasher);
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            (keys.len() as u64).hash(hasher);
            for k in keys {
                k.hash(hasher);
                hash_canonical(&map[k], hasher);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn loop_guard_proceeds_below_threshold() {
        let mut g = LoopGuard::new();
        let args = json!({"path": "/tmp/x"});
        for _ in 0..IDENTICAL_CALL_BLOCK_THRESHOLD {
            assert_eq!(g.record_attempt("read_file", &args), AttemptDecision::Proceed);
        }
    }

    #[test]
    fn loop_guard_blocks_after_threshold() {
        let mut g = LoopGuard::new();
        let args = json!({"path": "/tmp/x"});
        for _ in 0..IDENTICAL_CALL_BLOCK_THRESHOLD {
            let _ = g.record_attempt("read_file", &args);
        }
        match g.record_attempt("read_file", &args) {
            AttemptDecision::Block(msg) => {
                assert!(msg.contains("identical_call_blocked"));
                assert!(msg.contains("read_file"));
            }
            other => panic!("expected Block, got {:?}", other),
        }
    }

    #[test]
    fn loop_guard_canonical_hash_independent_of_key_order() {
        let mut g = LoopGuard::new();
        let a = json!({"a": 1, "b": 2});
        let b = json!({"b": 2, "a": 1});
        for _ in 0..IDENTICAL_CALL_BLOCK_THRESHOLD {
            let _ = g.record_attempt("t", &a);
        }
        // The 4th call with a key-reordered-but-equivalent object should block.
        assert!(matches!(g.record_attempt("t", &b), AttemptDecision::Block(_)));
    }

    #[test]
    fn loop_guard_different_args_do_not_collide() {
        let mut g = LoopGuard::new();
        for i in 0..10 {
            let args = json!({"i": i});
            assert_eq!(g.record_attempt("t", &args), AttemptDecision::Proceed);
        }
    }

    #[test]
    fn loop_guard_outcome_continue_on_success() {
        let mut g = LoopGuard::new();
        assert_eq!(g.record_outcome("t", true), OutcomeDecision::Continue);
    }

    #[test]
    fn loop_guard_outcome_warns_at_warn_threshold() {
        let mut g = LoopGuard::new();
        for _ in 0..(FAILURE_WARN_THRESHOLD - 1) {
            assert_eq!(g.record_outcome("t", false), OutcomeDecision::Continue);
        }
        match g.record_outcome("t", false) {
            OutcomeDecision::Warn(msg) => assert!(msg.contains("'t'")),
            other => panic!("expected Warn, got {:?}", other),
        }
    }

    #[test]
    fn loop_guard_outcome_halts_at_halt_threshold() {
        let mut g = LoopGuard::new();
        let mut last = OutcomeDecision::Continue;
        for _ in 0..FAILURE_HALT_THRESHOLD {
            last = g.record_outcome("t", false);
        }
        match last {
            OutcomeDecision::Halt { tool, count } => {
                assert_eq!(tool, "t");
                assert_eq!(count, FAILURE_HALT_THRESHOLD);
            }
            other => panic!("expected Halt, got {:?}", other),
        }
    }

    #[test]
    fn is_failure_content_detects_error_prefix() {
        assert!(is_failure_content("Error: something"));
        assert!(is_failure_content("  ERROR: x"));
        assert!(!is_failure_content("ok"));
        assert!(!is_failure_content(""));
        assert!(!is_failure_content("the error: was minor"));
    }
}
