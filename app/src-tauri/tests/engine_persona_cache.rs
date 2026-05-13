//! Integration tests for session-scoped persona prefix caching.
//!
//! The contract: within a single session, `build_persona_prefix_cached`
//! returns the byte-identical string even if AGENTS.md / SOUL.md /
//! PROFILE.md are edited on disk after the first call. This is what keeps
//! the DeepSeek prefix cache hot across sub-agents, auto-continue rounds,
//! and task workers that all share the same parent session.

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::react_agent::{
    build_persona_prefix, build_persona_prefix_cached, clear_persona_cache,
    invalidate_persona_snapshot, PERSONA_FILE_MAX_BYTES,
};
use serial_test::serial;
use tempfile::TempDir;

fn write_persona_files(dir: &std::path::Path, agents: &str, soul: &str) {
    std::fs::write(dir.join("AGENTS.md"), agents).unwrap();
    std::fs::write(dir.join("SOUL.md"), soul).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn persona_cached_returns_byte_identical_within_session() {
    clear_persona_cache();
    let dir = TempDir::new().unwrap();
    write_persona_files(dir.path(), "# AGENTS\n\nBE_HELPFUL", "# SOUL\n\nCARING");

    let first = build_persona_prefix_cached("session-A", dir.path(), None).await;
    let second = build_persona_prefix_cached("session-A", dir.path(), None).await;

    assert_eq!(first, second, "same-session calls must return byte-identical strings");
    assert!(first.contains("BE_HELPFUL"));
    assert!(first.contains("CARING"));
    assert!(first.starts_with("<persona-prefix>"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn persona_cached_is_frozen_against_disk_edits() {
    clear_persona_cache();
    let dir = TempDir::new().unwrap();
    write_persona_files(dir.path(), "# AGENTS\n\nORIGINAL_VALUE", "# SOUL\n\nKIND");

    let snapshot = build_persona_prefix_cached("session-B", dir.path(), None).await;
    assert!(snapshot.contains("ORIGINAL_VALUE"));

    // Edit the file on disk after the snapshot was frozen.
    std::fs::write(dir.path().join("AGENTS.md"), "# AGENTS\n\nMUTATED_VALUE").unwrap();

    let after_edit = build_persona_prefix_cached("session-B", dir.path(), None).await;
    assert_eq!(
        snapshot, after_edit,
        "edits to AGENTS.md must NOT bleed into a session that already captured persona"
    );
    assert!(after_edit.contains("ORIGINAL_VALUE"));
    assert!(!after_edit.contains("MUTATED_VALUE"));

    // But a fresh session DOES see the new contents.
    let fresh = build_persona_prefix_cached("session-C", dir.path(), None).await;
    assert!(fresh.contains("MUTATED_VALUE"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn persona_cached_sessions_are_independent() {
    clear_persona_cache();
    let dir = TempDir::new().unwrap();

    write_persona_files(dir.path(), "# AGENTS\n\nFIRST_VERSION", "# SOUL\n\nKIND");
    let a = build_persona_prefix_cached("sess-1", dir.path(), None).await;

    // Replace files between sessions; sess-2 captures the new state.
    write_persona_files(dir.path(), "# AGENTS\n\nSECOND_VERSION", "# SOUL\n\nWITTY");
    let b = build_persona_prefix_cached("sess-2", dir.path(), None).await;

    assert!(a.contains("FIRST_VERSION"));
    assert!(b.contains("SECOND_VERSION"));
    assert_ne!(a, b, "different sessions must capture distinct snapshots");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn persona_invalidate_drops_snapshot_and_reloads_from_disk() {
    clear_persona_cache();
    let dir = TempDir::new().unwrap();
    write_persona_files(dir.path(), "# AGENTS\n\nV1", "# SOUL\n\nA");

    let before = build_persona_prefix_cached("sess-X", dir.path(), None).await;
    assert!(before.contains("V1"));

    // Simulate /clear: discard the snapshot.
    invalidate_persona_snapshot("sess-X");

    // Disk has changed in the meantime.
    std::fs::write(dir.path().join("AGENTS.md"), "# AGENTS\n\nV2").unwrap();

    let after = build_persona_prefix_cached("sess-X", dir.path(), None).await;
    assert!(after.contains("V2"));
    assert!(!after.contains("V1"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn persona_empty_session_id_falls_through_and_is_not_cached() {
    clear_persona_cache();
    let dir = TempDir::new().unwrap();
    write_persona_files(dir.path(), "# AGENTS\n\nLIVE_READ", "# SOUL\n\nNICE");

    // Empty session_id should match build_persona_prefix output exactly.
    let cached_empty = build_persona_prefix_cached("", dir.path(), None).await;
    let uncached = build_persona_prefix(dir.path(), None).await;
    assert_eq!(cached_empty, uncached);

    // And the fall-through path must observe live disk edits (no freezing).
    std::fs::write(dir.path().join("AGENTS.md"), "# AGENTS\n\nLIVE_READ_2").unwrap();
    let cached_empty_again = build_persona_prefix_cached("", dir.path(), None).await;
    assert!(cached_empty_again.contains("LIVE_READ_2"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn persona_truncates_oversize_file_at_byte_cap() {
    clear_persona_cache();
    let dir = TempDir::new().unwrap();
    let huge: String = "X".repeat(PERSONA_FILE_MAX_BYTES * 4);
    std::fs::write(dir.path().join("AGENTS.md"), &huge).unwrap();

    let prefix = build_persona_prefix_cached("sess-trunc", dir.path(), None).await;

    // Expect the truncation sentinel to be present.
    assert!(prefix.contains("…[truncated]"),
        "oversize files must be tail-truncated, but no sentinel found");
    // The full huge body cannot fit byte-for-byte inside the rendered prefix.
    assert!(prefix.len() < huge.len(),
        "rendered prefix ({}) should be smaller than the raw file ({})", prefix.len(), huge.len());
    // The cap is per-file (~8KB); plus header/wrapper boilerplate this should
    // comfortably stay under 16KB.
    assert!(prefix.len() < PERSONA_FILE_MAX_BYTES + 4 * 1024,
        "rendered prefix is unexpectedly large: {} bytes", prefix.len());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn persona_truncation_is_utf8_safe_at_boundary() {
    clear_persona_cache();
    let dir = TempDir::new().unwrap();
    // Build a string whose byte-cap boundary lands in the middle of a 3-byte
    // codepoint. `中` is 3 bytes; padding to (cap - 1) puts the next char's
    // boundary exactly at byte cap.
    let mut payload = String::from("# AGENTS\n\n");
    payload.push_str(&"a".repeat(PERSONA_FILE_MAX_BYTES - payload.len() - 1));
    payload.push_str("中文测试");
    std::fs::write(dir.path().join("AGENTS.md"), &payload).unwrap();

    // If truncate slices mid-codepoint, this call would panic before returning.
    let prefix = build_persona_prefix_cached("sess-utf8", dir.path(), None).await;
    assert!(prefix.contains("…[truncated]"));
}
