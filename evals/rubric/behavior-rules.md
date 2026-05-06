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

## R8. Web tool selection: search vs fetch vs enable

YiYi exposes three web-related entry points; picking the right one
matters for cost (token spend) and capability (read-only vs interactive).

- `web_search` — keyword discovery. Use when the user gives **no URL**
  and needs to find candidate pages by topic.
- `browser_fetch` — read a single page's rendered text via headless
  Chrome. Use when the user **already has a URL** and just wants the
  content. Cheap, no install, no interaction.
- `browser_enable` — proxy stub that triggers the user-consent install
  of Playwright. Use ONLY when the task requires **interaction** with
  a page: click, type, fill forms, log in, multi-step flows. Calling
  this prompts an install dialog; do not call for purely read-only
  requests.

Decision flow:

```
URL given?
├─ no  → web_search
└─ yes → needs interaction (click / type / login)?
         ├─ no  → browser_fetch
         └─ yes → browser_enable
```

- **Violation A**: agent calls `browser_enable` for a "read this URL"
  or "search the web" request.
- **Violation B**: agent calls `web_search` when the user already
  pasted a URL.
- **Violation C**: agent tries to handle a login / click / form task
  with `browser_fetch` alone and gives up — should call
  `browser_enable`.

## R9. Typed tools earn their keep — shell is fine when it works

YiYi exposes both typed tools (`read_file`, `edit_file`, `git_status`,
…) and `execute_shell`. The product principle is **practical, not
puritanical**: shell is universal, well-trained-on, and gets the job
done; we only insist on a typed tool when it offers a concrete
advantage shell cannot replicate.

Use a typed tool **only** when the answer to "what does this give me
that shell doesn't?" is clearly:
- **Undoable mutation** — `edit_file` keeps a backup so `undo_edit`
  works; raw `sed -i` doesn't.
- **Permission gate** — typed write/delete tools route through YiYi's
  permission gate; shell `rm` doesn't.
- **Cancellable / observable task** — long-running typed flows
  integrate with the task framework; a forked shell process is harder
  to cancel and audit.
- **Structured output** the agent will parse downstream — `grep_search`
  returns parseable matches; `grep | wc` returns text.

Agent picking `execute_shell git status`, `cat file.md`, `ls dir/` etc.
is **not a violation** — these are read-only inspections; shell works
fine and the typed equivalent offers nothing material.

- **Violation A**: agent uses raw shell to mutate a file (`sed -i`,
  `> file`, `rm`) when the typed tool would have given undo /
  permission gating / safer semantics.
- **Violation B**: shell gives unstructured output and the agent then
  tries to re-parse it with another shell pipe rather than calling the
  typed tool that returns structure.

## R10. Spawn parallel agents only for independent sub-tasks

`spawn_agents` is for **truly parallelisable** work — 3 different files
to analyse, 5 independent web sources to summarise, etc. For a single
linear task or a 2-step pipeline (search → read), do it inline; spawning
adds context-isolation overhead and an extra round-trip.

- **Use spawn_agents**: "把这 5 篇 markdown 各自总结一下"
- **Don't spawn**: "搜下 React 19 然后读官方博客" (just chain the tools)
- **Violation**: agent spawns one or two sub-agents for what is
  obviously sequential.

## R11. Memory is historical; current state needs a tool call

(Companion to R3.) When asked "现在 / 当前 / 还在跑吗" → call the
authoritative tool (`query_tasks`, `list_cronjobs`, `list_bot_-
conversations`, etc.), not `memory_search`. Memory tells you what was
discussed; only the live tool tells you what's true now.

- "之前我们聊过什么" → `memory_search`
- "刚才那个 PPT 任务还在跑吗" → `query_tasks`
- "我有哪些定时任务" → `list_cronjobs`
- **Violation**: agent answers a "现在 X 是什么状态" question by
  paraphrasing memory.

## R12. Skills first for domain-shaped tasks

When the task fits a known skill (PDF, PPT, Word, Feishu, browser,
canvas, MCP), call `activate_skills` first to load the skill's SOP
into the prompt, *then* execute. Skipping this often results in the
agent inventing wrong tool sequences.

- "做个 PPT 介绍大熊猫" → activate_skills(["pptx"]) → run skill steps
- "把这个发到飞书群" → activate_skills(["feishu"]) → send_bot_message
- **Violation**: agent reaches for raw `execute_shell` when the skill
  would have provided a tested pipeline.
