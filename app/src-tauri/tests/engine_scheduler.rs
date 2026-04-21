mod common;

use common::*;
use serial_test::serial;
use app_lib::engine::scheduler::CronScheduler;

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cron_scheduler_new_returns_ready_instance() {
    let sched = CronScheduler::new().await;
    assert!(sched.is_ok(), "CronScheduler::new should succeed");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cron_scheduler_start_does_not_panic_on_empty_job_list() {
    let sched = CronScheduler::new().await.unwrap();
    let res = sched.start().await;
    assert!(res.is_ok(), "start() should succeed with no jobs");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cron_scheduler_remove_nonexistent_job_returns_ok_or_reports() {
    let sched = CronScheduler::new().await.unwrap();
    // Removing a job that was never added: accept either Ok or a controlled error
    // (implementation-defined; this test asserts it does not panic).
    let _ = sched.remove_job("nonexistent-id").await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
#[serial]
async fn cron_scheduler_tick_advances_with_paused_clock() {
    // Sanity: paused-clock testing works under CronScheduler.
    // Real fire-time assertions require a CronJobSpec fixture — deferred.
    // NOTE: tokio's `start_paused` requires `current_thread` flavor, so this
    // test deviates from the other multi_thread tests by design.
    let sched = CronScheduler::new().await.unwrap();
    sched.start().await.unwrap();
    tokio::time::advance(std::time::Duration::from_secs(120)).await;
    // No assertion besides "does not deadlock".
}
