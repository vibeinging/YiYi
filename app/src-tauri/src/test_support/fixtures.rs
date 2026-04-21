//! Fixture builders for engine integration tests.
//!
//! Wraps the production `CronJobSpec` and `IncomingMessage` types with
//! ergonomic defaults so tests can construct minimum-valid instances in
//! one line. Only the minimum set of fields is populated; everything
//! else uses production defaults.

use crate::commands::cronjobs::{CronJobSpec, ScheduleSpec};
use crate::engine::bots::IncomingMessage;
use crate::engine::db::ExecutionMode;

/// Build a `CronJobSpec` of type `cron` with the given id and cron expression.
pub fn cron_job_spec(id: &str, cron_expr: &str) -> CronJobSpec {
    CronJobSpec {
        id: id.to_string(),
        name: id.to_string(),
        enabled: true,
        schedule: ScheduleSpec {
            r#type: "cron".to_string(),
            cron: cron_expr.to_string(),
            timezone: None,
            delay_minutes: None,
            schedule_at: None,
            created_at: None,
        },
        task_type: "notify".to_string(),
        text: Some("test job".to_string()),
        request: None,
        dispatch: None,
        runtime: None,
        execution_mode: ExecutionMode::default(),
    }
}

/// Build a `CronJobSpec` of type `delay` that fires after `delay_minutes`.
pub fn cron_job_spec_delay(id: &str, delay_minutes: u64) -> CronJobSpec {
    CronJobSpec {
        id: id.to_string(),
        name: id.to_string(),
        enabled: true,
        schedule: ScheduleSpec {
            r#type: "delay".to_string(),
            cron: String::new(),
            timezone: None,
            delay_minutes: Some(delay_minutes),
            schedule_at: None,
            // Leave created_at None so add_job treats delay_minutes as full remaining time.
            created_at: None,
        },
        task_type: "notify".to_string(),
        text: Some("test delay job".to_string()),
        request: None,
        dispatch: None,
        runtime: None,
        execution_mode: ExecutionMode::default(),
    }
}

/// Build a `CronJobSpec` of type `once` scheduled at the given RFC3339 time.
pub fn cron_job_spec_once(id: &str, schedule_at_rfc3339: &str) -> CronJobSpec {
    CronJobSpec {
        id: id.to_string(),
        name: id.to_string(),
        enabled: true,
        schedule: ScheduleSpec {
            r#type: "once".to_string(),
            cron: String::new(),
            timezone: None,
            delay_minutes: None,
            schedule_at: Some(schedule_at_rfc3339.to_string()),
            created_at: None,
        },
        task_type: "notify".to_string(),
        text: Some("test once job".to_string()),
        request: None,
        dispatch: None,
        runtime: None,
        execution_mode: ExecutionMode::default(),
    }
}

/// Build an `IncomingMessage` with minimal fields populated.
///
/// Note: `IncomingMessage` has no `msg_id` field — uniqueness for dedup is
/// derived from `(bot_id, conversation_id, timestamp, content-hash)`. The
/// `msg_id` parameter here is threaded into `meta["msg_id"]` for platforms
/// that use it (e.g. QQ passive reply) and to tweak the content hash so
/// fixture helpers behave intuitively when tests use distinct ids.
pub fn incoming_message(
    bot_id: &str,
    platform: &str,
    msg_id: &str,
    text: &str,
) -> IncomingMessage {
    IncomingMessage {
        bot_id: bot_id.to_string(),
        platform: platform.to_string(),
        conversation_id: format!("conv-{}", bot_id),
        sender_id: format!("sender-{}", bot_id),
        sender_name: Some("tester".to_string()),
        content: text.to_string(),
        content_parts: Vec::new(),
        timestamp: 1_700_000_000,
        meta: serde_json::json!({ "msg_id": msg_id }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cron_job_spec_populates_cron_type_with_expression() {
        let s = cron_job_spec("job-a", "* * * * *");
        assert_eq!(s.id, "job-a");
        assert_eq!(s.name, "job-a");
        assert!(s.enabled);
        assert_eq!(s.schedule.r#type, "cron");
        assert_eq!(s.schedule.cron, "* * * * *");
        assert!(s.schedule.delay_minutes.is_none());
        assert!(s.schedule.schedule_at.is_none());
    }

    #[test]
    fn cron_job_spec_delay_sets_delay_minutes() {
        let s = cron_job_spec_delay("delay-job", 5);
        assert_eq!(s.schedule.r#type, "delay");
        assert_eq!(s.schedule.delay_minutes, Some(5));
        assert!(s.schedule.cron.is_empty());
    }

    #[test]
    fn cron_job_spec_once_sets_schedule_at() {
        let s = cron_job_spec_once("once-job", "2099-01-01T00:00:00Z");
        assert_eq!(s.schedule.r#type, "once");
        assert_eq!(
            s.schedule.schedule_at.as_deref(),
            Some("2099-01-01T00:00:00Z")
        );
    }

    #[test]
    fn incoming_message_populates_required_fields() {
        let m = incoming_message("bot-x", "webhook", "msg-1", "hello");
        assert_eq!(m.bot_id, "bot-x");
        assert_eq!(m.platform, "webhook");
        assert_eq!(m.content, "hello");
        assert_eq!(m.meta["msg_id"], "msg-1");
        assert!(m.sender_name.is_some());
        // session_id() exercises the conversation_id path.
        assert_eq!(m.session_id(), "bot:bot-x:conv-bot-x");
    }
}
