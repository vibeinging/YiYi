//! Integration tests for the check_fn liveness probe + 30 s TTL cache on
//! GlobalToolRegistry.
//!
//! The contract — what the cache must guarantee:
//! 1. Tools without a probe stay listed (back-compat for everything that
//!    existed before P1.2).
//! 2. A probe returning `false` hides the tool from the LLM-facing list.
//! 3. Within a TTL window the probe runs at most once per tool, so a single
//!    agent turn doesn't probe N tools N times.
//! 4. After the TTL the next query reruns the probe.
//! 5. `invalidate_check` forces a fresh evaluation immediately.

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::tool_registry_global::{
    invalidate_check, _clear_check_cache_for_test, _expire_check_for_test,
    GlobalToolRegistry, ToolEntry, ToolSource, CheckFn,
};
use app_lib::engine::tools::{FunctionDef, ToolDefinition};
use serial_test::serial;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

fn def(name: &str) -> ToolDefinition {
    ToolDefinition {
        r#type: "function".into(),
        function: FunctionDef {
            name: name.into(),
            description: format!("test tool {}", name),
            parameters: serde_json::json!({"type": "object", "properties": {}}),
        },
    }
}

fn entry(name: &str) -> ToolEntry {
    ToolEntry {
        name: name.into(),
        source: ToolSource::BuiltIn,
        definition: def(name),
        dispatch_name: name.into(),
        concurrency_safe: false,
    }
}

/// Probe that counts how many times it was actually invoked, and returns
/// a configurable verdict. Use to assert cache hits without sleeping.
fn counting_probe(verdict: bool) -> (CheckFn, Arc<AtomicUsize>) {
    let counter = Arc::new(AtomicUsize::new(0));
    let c = counter.clone();
    let probe: CheckFn = Arc::new(move || {
        c.fetch_add(1, Ordering::SeqCst);
        verdict
    });
    (probe, counter)
}

#[test]
#[serial]
fn check_fn_absent_tool_stays_visible() {
    _clear_check_cache_for_test();
    let reg = GlobalToolRegistry::new();
    reg.try_register(entry("plain_tool")).expect("register");

    let visible = reg.all_definitions_available();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].function.name, "plain_tool");
}

#[test]
#[serial]
fn check_fn_returning_false_hides_tool_from_list() {
    _clear_check_cache_for_test();
    let reg = GlobalToolRegistry::new();
    reg.try_register(entry("always_on")).expect("register");
    reg.try_register(entry("offline_tool")).expect("register");
    let (probe, _) = counting_probe(false);
    reg.set_check_fn("offline_tool", probe);

    let visible = reg.all_definitions_available();
    let names: Vec<&str> = visible.iter().map(|t| t.function.name.as_str()).collect();
    assert_eq!(names, vec!["always_on"], "offline tool must be filtered");
    // Full (unfiltered) list still includes both — `_available` is the
    // gate, registry remains authoritative.
    assert_eq!(reg.all_definitions().len(), 2);
}

#[test]
#[serial]
fn check_fn_result_is_cached_within_ttl_window() {
    _clear_check_cache_for_test();
    let reg = GlobalToolRegistry::new();
    reg.try_register(entry("flaky_tool")).expect("register");
    let (probe, counter) = counting_probe(true);
    reg.set_check_fn("flaky_tool", probe);

    // Hammer the registry many times — the probe must only run once.
    for _ in 0..20 {
        let _ = reg.all_definitions_available();
    }
    assert_eq!(counter.load(Ordering::SeqCst), 1,
        "probe should be cached for the full TTL window");
}

#[test]
#[serial]
fn check_fn_re_runs_after_ttl_expires() {
    _clear_check_cache_for_test();
    let reg = GlobalToolRegistry::new();
    reg.try_register(entry("expiring_tool")).expect("register");
    let (probe, counter) = counting_probe(true);
    reg.set_check_fn("expiring_tool", probe);

    let _ = reg.all_definitions_available();
    assert_eq!(counter.load(Ordering::SeqCst), 1);

    // Simulate the cache entry aging past CHECK_TTL.
    _expire_check_for_test("expiring_tool");

    let _ = reg.all_definitions_available();
    assert_eq!(counter.load(Ordering::SeqCst), 2,
        "after the TTL expires the next query must rerun the probe");
}

#[test]
#[serial]
fn invalidate_check_forces_immediate_recompute() {
    _clear_check_cache_for_test();
    let reg = GlobalToolRegistry::new();
    reg.try_register(entry("permission_gated")).expect("register");
    let (probe, counter) = counting_probe(true);
    reg.set_check_fn("permission_gated", probe);

    let _ = reg.all_definitions_available();
    let _ = reg.all_definitions_available();
    assert_eq!(counter.load(Ordering::SeqCst), 1, "second call should hit cache");

    // External event (permission granted, MCP server reconnected, …) — bump
    // the entry so the next list refreshes immediately, no need to wait.
    invalidate_check("permission_gated");

    let _ = reg.all_definitions_available();
    assert_eq!(counter.load(Ordering::SeqCst), 2,
        "invalidate must force a fresh probe on the next query");
}

#[test]
#[serial]
fn check_fn_set_replaces_existing_and_clears_cache() {
    _clear_check_cache_for_test();
    let reg = GlobalToolRegistry::new();
    reg.try_register(entry("swap_tool")).expect("register");

    let (probe_off, _) = counting_probe(false);
    reg.set_check_fn("swap_tool", probe_off);
    assert!(reg.has_check_fn("swap_tool"));
    assert!(reg.all_definitions_available().is_empty(),
        "tool should be hidden under the first probe");

    // Replace with a probe that says the tool is up. Replacement must drop
    // the stale `false` cache; otherwise the tool would stay hidden until
    // CHECK_TTL elapses.
    let (probe_on, _) = counting_probe(true);
    reg.set_check_fn("swap_tool", probe_on);
    let visible = reg.all_definitions_available();
    assert_eq!(visible.len(), 1,
        "after replacing the probe the new verdict must take effect immediately");
}

#[test]
#[serial]
fn remove_check_fn_restores_unconditional_visibility() {
    _clear_check_cache_for_test();
    let reg = GlobalToolRegistry::new();
    reg.try_register(entry("recoverable")).expect("register");

    let (probe, _) = counting_probe(false);
    reg.set_check_fn("recoverable", probe);
    assert!(reg.all_definitions_available().is_empty());

    reg.remove_check_fn("recoverable");
    assert!(!reg.has_check_fn("recoverable"));
    assert_eq!(reg.all_definitions_available().len(), 1,
        "removing the probe must return the tool to the always-visible default");
}
