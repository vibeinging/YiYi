---
name: cron
description: "Help users manage scheduled/cron tasks. Understand cron expressions and guide users to create, modify, or troubleshoot scheduled jobs."
metadata: { "yiyi": { "emoji": "⏰" } }
---

# Scheduled Task Management

Help users understand and manage scheduled (cron) tasks. When the user asks about scheduling, timing, or periodic execution, use this skill.

## Cron Expression Reference

```
*    *    *    *    *
|    |    |    |    |
min  hour day  mon  weekday
```

### Common Patterns

| Schedule | Expression | Description |
|----------|-----------|-------------|
| Every minute | `* * * * *` | Runs every minute |
| Every 15 min | `*/15 * * * *` | Every 15 minutes |
| Hourly | `0 * * * *` | At minute 0 of every hour |
| Daily 9 AM | `0 9 * * *` | Every day at 09:00 |
| Daily midnight | `0 0 * * *` | Every day at 00:00 |
| Weekdays 8:30 | `30 8 * * 1-5` | Mon-Fri at 08:30 |
| Weekly Mon 9 AM | `0 9 * * 1` | Every Monday at 09:00 |
| Monthly 1st | `0 0 1 * *` | 1st of each month at 00:00 |
| Every 2 hours | `0 */2 * * *` | At minute 0, every 2 hours |

### Field Ranges

- **Minute**: 0-59
- **Hour**: 0-23
- **Day**: 1-31
- **Month**: 1-12
- **Weekday**: 0-6 (0 = Sunday)

### Special Characters

- `*` — any value
- `,` — list separator (e.g., `1,15` = 1st and 15th)
- `-` — range (e.g., `1-5` = Monday to Friday)
- `/` — step (e.g., `*/10` = every 10 units)

## How to Help Users

1. When user describes a schedule in natural language, convert it to a cron expression
2. When user provides a cron expression, explain what it means
3. Guide users to the Cron Jobs page in the app UI to create/manage tasks
4. Help troubleshoot why a scheduled task might not be running as expected

## Task Types

- **Prompt tasks**: Send a prompt to the AI agent on schedule, and deliver the response
- **Message tasks**: Send a fixed message to a channel on schedule

## Tips

- Use longer intervals (6-12 hours) for monitoring tasks to avoid noise
- Set active hour restrictions for tasks that shouldn't run at night
- Test with a short interval first, then adjust to the desired schedule
