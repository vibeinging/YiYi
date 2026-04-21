mod common;

use common::*;

#[tokio::test(flavor = "multi_thread")]
async fn integration_test_can_build_test_app_state() {
    let t = build_test_app_state().await;
    assert!(t.state().working_dir.exists());
}
