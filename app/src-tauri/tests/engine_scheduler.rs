mod common;

use common::*;
use serial_test::serial;
use app_lib::engine::scheduler::CronScheduler;
use std::time::Duration;

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

// === Deeper fixture-driven tests (batch 1 backfill) ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cron_scheduler_add_cron_job_registers_and_remove_succeeds() {
    let t = build_test_app_state().await;
    let sched = CronScheduler::new().await.unwrap();
    sched.start().await.unwrap();

    let spec = cron_job_spec("cron-reg-1", "0 0 1 1 * *");
    sched
        .add_job(&spec, t.state())
        .await
        .expect("add_job should succeed for valid cron spec");

    // Remove the registered job — exercises the cron-branch of remove_job.
    sched
        .remove_job("cron-reg-1")
        .await
        .expect("remove_job should succeed for a registered cron job");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cron_scheduler_add_invalid_cron_expression_returns_error() {
    let t = build_test_app_state().await;
    let sched = CronScheduler::new().await.unwrap();
    sched.start().await.unwrap();

    let spec = cron_job_spec("cron-bad", "not-a-valid-cron");
    let res = sched.add_job(&spec, t.state()).await;
    assert!(res.is_err(), "invalid cron expression should error, got {:?}", res);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cron_scheduler_add_delay_without_minutes_returns_error() {
    let t = build_test_app_state().await;
    let sched = CronScheduler::new().await.unwrap();

    let mut spec = cron_job_spec_delay("delay-missing", 0);
    // Strip required delay_minutes to exercise the validation branch.
    spec.schedule.delay_minutes = None;

    let res = sched.add_job(&spec, t.state()).await;
    assert!(
        res.is_err(),
        "delay spec without delay_minutes should error, got {:?}",
        res
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cron_scheduler_overdue_once_job_returns_error() {
    let t = build_test_app_state().await;
    let sched = CronScheduler::new().await.unwrap();

    // Use a definitely-past RFC3339 timestamp.
    let spec = cron_job_spec_once("once-past", "2000-01-01T00:00:00Z");
    let res = sched.add_job(&spec, t.state()).await;
    assert!(
        res.is_err(),
        "once-type spec with past schedule_at should error, got {:?}",
        res
    );
    let msg = res.unwrap_err();
    assert!(
        msg.contains("future") || msg.contains("past"),
        "error should mention past/future, got: {}",
        msg
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
#[serial]
async fn cron_scheduler_delay_job_fires_after_delay() {
    // Paused-clock test: delay jobs rely on `tokio::time::sleep`, which honours
    // advance() under `start_paused = true`. We verify the fire by checking
    // that a `cronjob_executions` row lands with `task_type=notify` completing
    // successfully.
    let t = build_test_app_state().await;
    // Seed the cronjobs table so set_cronjob_enabled at completion doesn't fail.
    let spec = cron_job_spec_delay("delay-fires", 1); // 1 minute
    t.state()
        .db
        .upsert_cronjob(&spec.to_row())
        .expect("upsert test cron row");

    let sched = CronScheduler::new().await.unwrap();
    sched
        .add_job(&spec, t.state())
        .await
        .expect("add_job should succeed for delay spec");

    // Before advancing, no execution row yet.
    let before = t.state().db.list_executions("delay-fires", 10).unwrap();
    assert!(before.is_empty(), "expected no executions before advance");

    // Give the spawned delay task a chance to start and register its sleep
    // before we advance the virtual clock.
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    // Advance 70s (past the 60s delay). Yield a few times so the spawned task
    // observes the wake and runs through to the DB write.
    tokio::time::advance(Duration::from_secs(70)).await;
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }

    let after = t.state().db.list_executions("delay-fires", 10).unwrap();
    assert!(
        !after.is_empty(),
        "expected at least one execution row after advancing past delay"
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
#[serial]
async fn cron_scheduler_remove_delay_job_cancels_future_fire() {
    let t = build_test_app_state().await;
    let spec = cron_job_spec_delay("delay-cancel", 2); // 2 minutes
    t.state()
        .db
        .upsert_cronjob(&spec.to_row())
        .expect("upsert test cron row");

    let sched = CronScheduler::new().await.unwrap();
    sched.add_job(&spec, t.state()).await.unwrap();

    // Let the spawned delay task start and register its sleep.
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    // Advance halfway, cancel, then advance well past the original deadline.
    tokio::time::advance(Duration::from_secs(30)).await;
    sched.remove_job("delay-cancel").await.unwrap();
    tokio::time::advance(Duration::from_secs(180)).await;
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }

    let execs = t.state().db.list_executions("delay-cancel", 10).unwrap();
    assert!(
        execs.is_empty(),
        "remove_job should cancel a pending delay-type fire, got {} rows",
        execs.len()
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
#[serial]
async fn cron_scheduler_multiple_delay_jobs_fire_independently() {
    let t = build_test_app_state().await;
    let fast = cron_job_spec_delay("delay-fast", 1); // 60s
    let slow = cron_job_spec_delay("delay-slow", 10); // 600s
    t.state().db.upsert_cronjob(&fast.to_row()).unwrap();
    t.state().db.upsert_cronjob(&slow.to_row()).unwrap();

    let sched = CronScheduler::new().await.unwrap();
    sched.add_job(&fast, t.state()).await.unwrap();
    sched.add_job(&slow, t.state()).await.unwrap();

    // Let both spawned delay tasks start and register their sleeps.
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    // Advance just past the fast deadline but well before the slow one.
    tokio::time::advance(Duration::from_secs(70)).await;
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }

    let fast_execs = t.state().db.list_executions("delay-fast", 10).unwrap();
    let slow_execs = t.state().db.list_executions("delay-slow", 10).unwrap();
    assert!(
        !fast_execs.is_empty(),
        "fast delay job (60s) should have fired after 70s"
    );
    assert!(
        slow_execs.is_empty(),
        "slow delay job (600s) should NOT have fired after only 70s, got {} rows",
        slow_execs.len()
    );
}
