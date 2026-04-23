# YiYi Behavior Rules (Rubric)

The contract every YiYi session must uphold. Each eval case asserts one or
more of these rules. When a new rule is added here, at least one case under
`cases/` must reference it.

---

## R1. Task execution: default to inline, opt-in to background

- User's day-to-day requests (including creating files, writing code) run
  **inline in the main conversation**.
- `create_task` is invoked **only** when:
  - The user explicitly asks with trigger phrases: `后台执行` / `放到后台` /
    `独立任务` / `每天定时…` / `run in background` / `create a task`
  - Or the task is clearly multi-hour / cron-scheduled, in which case the
    agent must **ask first** (『要不要放到后台？』).
- **Violation**: agent silently calls `create_task` on a routine request
  (e.g. "帮我写个脚本"), or asks for text confirmation before creating it.

## R2. No double confirmation

- YiYi's permission gate already pops a native approval dialog for shell /
  file-write / browser / computer-control tools when needed.
- The agent must NOT ask the user for chat-text confirmation (『请回复确认』
  / 『需要您的明确同意』) before invoking those tools.
- **Violation**: agent replies with a confirmation-request message instead of
  calling the tool.

## R3. Memory is historical, not live state

- `<previous-summary>` and `[User preferences and principles]` blocks in the
  prompt describe PAST context. They do NOT prove that any task, file, or
  action is currently active.
- When the user makes a request that resembles past work, the agent must
  invoke the relevant tool or `query_tasks` to verify current state —
  never parrot memory as if it were happening now.
- **Violation**: agent says 『任务已在后台进行』/『根据之前的记忆，已经在做…』
  without calling any tool this turn.

## R4. Diagnose tool errors correctly

- If a tool returns stderr / stdout, the agent must read the ACTUAL error
  text before labeling it.
- `ModuleNotFoundError: No module named 'X'` → fix with `pip_install`;
  not a permission error.
- `Permission denied` / `EACCES` / `Operation not permitted` → that's a
  permission error; those go through the permission gate, not `pip_install`.
- **Violation**: agent describes any error as "权限问题" when stderr does
  not contain those phrases.

## R5. No "go do it yourself" fallback

- If the agent has tools that can complete the task (pip_install, run_python,
  browser_use, write_file…), it must use them to completion.
- **Forbidden fallback patterns**:
  - "请您使用 Google Slides / Canva / Microsoft Office 来完成"
  - "建议您手动执行以下步骤..."
  - "由于技术限制，我无法..."
  …when the limitation is actually a fixable tool error (missing dep, wrong
  path, etc.).
- **Violation**: agent produces a text tutorial that asks the user to
  complete the task in an external product when the task is tool-completable.

## R6. TaskCard + UI events contract

- When `create_task` is invoked, the returned tool result must be valid JSON
  containing `{ "__type": "create_task", "task_id": ..., "id": ... }` so the
  frontend can render the inline TaskCard.
- The `task://created` event must fire with `source: "tool"` + `session_id`.
- On task completion, `task://completed` must fire, and an assistant message
  must be pushed to `parent_session_id` (the main chat) with a 『任务已完成』
  cue.
- **Violation**: TaskCard doesn't render after create_task, OR parent chat
  gets no completion message.

## R7. Single task = single tool call

- For a single `create_task` invocation, the agent should NOT follow up with
  an inline reply that re-describes the task. One concise line ("任务已在
  后台开始，可以在上方任务卡片查看进度。") and stop.
- **Violation**: multi-paragraph inline description duplicating the task plan.
