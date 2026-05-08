//! Integration tests for `engine::checkpoint`. Cross-module coverage
//! that the inline unit tests can't reach.

mod common;

#[allow(unused_imports)]
use common::*;

use serial_test::serial;

use app_lib::engine::checkpoint;

/// `report_dirty` from a tokio task that sets the session-id task-local
/// (the same scope the agent loop uses) populates the per-session bucket
/// readable from the agent loop after the task completes.
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn dirty_set_is_visible_across_task_local_scope() {
    use app_lib::engine::tools::with_session_id;

    let session = format!("intg-{}", uuid::Uuid::new_v4());
    let _ = checkpoint::take_dirty(&session);

    let s = session.clone();
    with_session_id(s.clone(), async move {
        // simulate a tool reporting after a successful write
        checkpoint::report_dirty(&s, "subdir/touched.rs");
    })
    .await;

    let dirty = checkpoint::take_dirty(&session);
    assert_eq!(dirty.len(), 1, "expected 1 dirty path, got: {:?}", dirty);
    assert!(dirty.iter().any(|p| p.to_string_lossy().contains("touched.rs")));
}
