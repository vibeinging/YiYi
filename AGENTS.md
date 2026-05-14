# AGENTS.md

Onboarding for coding AIs (Claude Code, Cursor, Codex, …) contributing to **YiYi**.

If you're a human reader, this also works as a fast tour — just skim §1 then jump to whatever section matches the task.

---

## 1. 30-second tour

YiYi is a **desktop AI personal assistant** — Tauri (Rust backend) + React 18 / TypeScript frontend. Single binary, runs locally on the user's machine. Data lives in SQLite (WAL mode) under `~/.yiyi/`.

Differentiation vs. other open-source agents:
- **Deeply tuned for DeepSeek V4** (Pro / Flash) — implicit prefix cache, 1M context, 120× hit/miss price gap drives most architectural choices.
- **White-box co-construction** — the agent never silently rewrites its own skills or rules. Anything it proposes (new skill, new principle) goes through an *Inbox* the user approves. See §6.
- **Multi-platform bots** out of the box — Discord, QQ, Telegram, DingTalk, Feishu, WeCom, Webhook.

**Default behaviour expectations:**
- Read code before editing. Keep changes scoped. No speculative abstractions.
- Don't break the prefix cache (see §7).
- Don't add features the user didn't ask for.
- Finish things; "能跑 ≠ 能用，能用 ≠ 好用".

---

## 2. Repo layout

```
/
├── AGENTS.md           ← this file (you're here)
├── README.md           ← public-facing intro / screenshots
├── app/
│   ├── src/            ← React frontend (Vite + TS + Tailwind)
│   │   ├── pages/      Chat, CronJobs, Bots, Skills, Settings, …
│   │   ├── components/
│   │   ├── api/        Tauri invoke wrappers
│   │   ├── stores/     Zustand stores
│   │   └── i18n.ts     zh/en strings
│   └── src-tauri/      ← Rust backend (the heart of YiYi)
│       ├── src/
│       │   ├── lib.rs          App init + plugin setup
│       │   ├── main.rs         CLI dispatch (`yiyi doctor`, …) → lib.rs::run()
│       │   ├── doctor.rs       Environment self-check
│       │   ├── tray.rs         System tray menu
│       │   ├── commands/       Tauri command handlers
│       │   │   ├── agent/      chat / streaming / history
│       │   │   ├── bots.rs / cronjobs.rs / skills.rs / workspace.rs / …
│       │   ├── engine/         ← Core domain logic
│       │   │   ├── react_agent/
│       │   │   │   ├── core.rs         Think → Act → Observe loop
│       │   │   │   ├── prompt.rs       System prompt + persona prefix
│       │   │   │   ├── compaction.rs   Long-context handling
│       │   │   │   ├── growth.rs       Skill / principle proposals → Inbox
│       │   │   │   └── loop_guard.rs   Anti-loop guard per turn
│       │   │   ├── tools/      ← Tool dispatch (heavy file, expect 3k+ LOC)
│       │   │   │   ├── file_tools.rs   read/write/edit/append/delete + undo_edit
│       │   │   │   ├── shell_security.rs  Two-layer regex (Hardline ▸ Block ▸ Warn)
│       │   │   │   ├── output_envelope.rs  Trust + MultimodalEnvelope
│       │   │   │   ├── permission_gate.rs  Native OS approval dialog
│       │   │   │   └── …
│       │   │   ├── llm_client/         OpenAI / Anthropic / Google formats
│       │   │   ├── bots/               Per-platform adapters + BotManager
│       │   │   ├── infra/              mcp_runtime, dep_check, python_bridge
│       │   │   ├── db/                 SQLite schema + queries
│       │   │   ├── checkpoint.rs       Shadow-git per-turn snapshots
│       │   │   ├── scheduler.rs        Cron / delay / once jobs
│       │   │   ├── prompt_cache.rs     FNV fingerprint + cache-break detect
│       │   │   └── tool_registry_global.rs  Single source of truth for tools
│       │   ├── state/                  AppState, Config
│       │   └── test_support/           Test helpers (feature-gated)
│       ├── tests/      ← Integration tests (flat layout, one file per area)
│       └── Cargo.toml
└── evals/              ← Behaviour eval YAML cases + rubric
```

**Heuristic for "where do I put this?"**:
- *New tool* → `engine/tools/<area>_tools.rs` + register via `tool_registry_global`.
- *New Tauri command* (frontend can call) → `commands/<area>.rs`.
- *New DB table* → `engine/db/<table>.rs` + add to `engine/db/mod.rs`.
- *New frontend page* → `app/src/pages/X.tsx` + register in routes.
- *Skill content* → `app/src-tauri/skills/<name>/SKILL.md` (built-in) or document the path for `~/.yiyi/active_skills/`.

---

## 3. Commands

### Day-to-day
```bash
# from app/
npm run tauri dev           # full app, hot-reload frontend, rebuild Rust on change
npm run dev                 # frontend only (Vite)
npx tsc --noEmit            # frontend type-check (no emit)

# from app/src-tauri/
cargo check --features test-support       # fast type check
cargo test  --features test-support       # default (hermetic) test tier
cargo test  --features test-support,test-integration  # +live API tier
cargo build                                # debug build for `target/debug/yiyi`
```

### After a build, sanity-check the environment
```bash
./app/src-tauri/target/debug/yiyi doctor   # 10 checks in <1s; exit code = fail count
```

### Test conventions
- New integration tests live at `tests/<area>.rs` (flat — no sub-dirs).
- Async default: `#[tokio::test(flavor = "multi_thread")]`.
- Anything touching SQLite uses `TempDb` + `#[serial]` (WAL can't be shared across parallel threads).
- Tests using `app_lib::test_support::*` must run with `--features test-support`.
- Tests hitting **real external dependencies** (live LLM API, real Chrome, real cua-driver) go behind `#[cfg(feature = "test-integration")]`. Inside the body, still env-var-guard so missing creds skip cleanly. See `tests/evals_runner.rs::live_cases` for the canonical example.

---

## 4. Working philosophy — 做就做好

This is the meta-rule above all design principles below:

- **不追求快**：宁可慢一步，不留半成品。能跑 ≠ 能用，能用 ≠ 好用。
- **闭环再下一个**：单个 feature 的代码、测试、UI、错误处理、可见的用户路径没收尾，不开下一个。拒绝同时半完成 N 个东西。
- **不写"以后再改"**：要么现在做对，要么明确标 TODO 加"为什么暂时这样"的理由。
- **质量 > 覆盖面**：宁可只做一个 feature 但做到位，也不要十个半成品。

When you (the coding AI) finish a chunk, ask yourself: *can a user actually use this end-to-end right now, or did I stop at "code compiles"?*

---

## 5. Code style

- **Rust**: standard `rustfmt`. No nightly features. Avoid `unsafe` unless wrapping a C dep.
- **TypeScript**: Vite + React 18, Tailwind, `lucide-react` icons. CSS variables (`--color-*`), Plus Jakarta Sans, glass cards, rounded corners.
- **Comments**: write the *why*, not the *what*. Don't echo the code. If a future reader would not be surprised, don't comment.
- **No backwards-compat shims for unshipped code**: if a function isn't used yet outside your patch, delete it instead of leaving a wrapper.
- **No emojis in code or docs** unless the user explicitly asks. (The doctor output `✓ / ! / ✗` glyphs are an exception — they're functional, not decoration.)

### Commit style — Conventional Commits

`<type>(<scope>): <subject>`
Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`.

**Hard rules** (the user enforces these):
- Commit messages must NOT mention Claude / Anthropic / Codex / any AI model name. Keep them clean as if a human wrote them.
- Never commit or push without an explicit instruction (`commit`, `push`, `ship`, etc.). Asking once per session is fine; don't pre-empt.
- Never use `--no-verify`, `--amend` on pushed commits, or destructive history rewrites without being told to.

---

## 6. White-box co-construction (元原则)

YiYi's positioning is "an agent that grows *with* the user, not behind the user's back". When the agent observes something worth turning into a long-lived behaviour (a new skill, a new principle, a recurring fix), it does NOT silently apply it. Three-step protocol:

| Phase | Where it lives | Effect on production |
|---|---|---|
| Draft | `engine/react_agent/growth.rs` proposes | none |
| Review | Inbox (`engine/db/inbox.rs`) — user sees "X 项待审" | none |
| Apply | After user approves → written to skill / principle store | takes effect next turn |

**Rules of thumb when touching this area:**
- *Proactive behaviour* (agent will autonomously do X later) → MUST go through Inbox.
- *Passive information* (a memory, a fact, a stats tweak) → agent handles itself; user can see + delete but doesn't pre-approve each one.
- If a feature would require the user to approve hundreds of items to be useful, the feature is failing — fix the internal classifier, don't push the cost onto the user.
- GC / cleanup / state migration: rule-based + idle-triggered, never cron. See `db/inbox.rs::archive_stale_inbox_items`.

---

## 7. The prefix cache is sacred

DeepSeek V4's implicit prefix cache makes the first ~all-tokens of a request **120× cheaper** if they match a recent request. Anything that changes the byte prefix of system prompt / tools / persona between turns destroys this and balloons the bill.

**Things that have historically broken the cache and must NOT regress:**
- Re-reading `AGENTS.md` / `SOUL.md` on every turn (fixed in `prompt.rs::build_persona_prefix_cached` — session-frozen snapshot).
- Listing skills inline in the system prompt (deleted — agent discovers via `tool_search`).
- Including unsorted tool definitions in the API request (sorted by name in `tool_registry_global::all_definitions`).
- Per-iteration `[System Reminder]` re-injection (moved into the static block once).

When adding anything that goes into the system prompt or the tools array, ask:
1. Is its byte representation stable across turns within a session?
2. If yes, is it BEFORE the `<!-- yiyi:cache_boundary -->` marker in `prompt.rs`?
3. If it has to vary, does it live AFTER the boundary?

See `engine/prompt_cache.rs` for the fingerprint + cache-break detector that flags accidental regressions in logs.

---

## 8. Routing — "where do I change X?"

| User-visible task | Touch this |
|---|---|
| Chat reply quality / tool selection logic | `engine/react_agent/core.rs` (ReAct loop) + `engine/react_agent/prompt.rs` |
| Add a new tool | New `engine/tools/<area>_tools.rs` + register builder in `engine/tool_registry_global.rs` |
| Wrap untrusted tool output | `engine/tools/output_envelope.rs::wrap_external` |
| Tool that returns image/audio etc. | Return `MultimodalEnvelope`; runtime handles vision-vs-text dispatch |
| Permission gate / dangerous command | `engine/tools/shell_security.rs` (Hardline / Block / Warn) + `engine/tools/permission_gate.rs` |
| Bot platform adapter | `engine/bots/<platform>.rs` + `engine/bots/manager.rs` registration |
| Skill catalog / marketplace | `engine/skills_hub.rs` + `commands/skills.rs` |
| Scheduled task / cron | `engine/scheduler.rs` (cron / delay / once) |
| New SQLite table | `engine/db/<table>.rs` + add `pub mod` to `engine/db/mod.rs` + `CREATE TABLE` in `mod.rs::init_db` |
| Frontend chat panel | `app/src/pages/Chat.tsx` + `stores/chatStreamStore.ts` |
| New Tauri command for frontend | `commands/<area>.rs` (#[tauri::command]) + register in `lib.rs::run()` |
| LLM provider format | `engine/llm_client/{openai,anthropic,google}.rs` |
| Environment self-check item | `doctor.rs::run_checks` |

---

## 9. Common pitfalls (don't repeat these)

- **Editing `~/.yiyi/AGENTS.md` from code.** That file is the **user's runtime persona**, owned by them. The default seed lives in `engine/templates/{zh,en}/AGENTS.md` (compiled in via `include_str!`); never overwrite the user's copy after first launch.
- **`tokio::spawn` with `AppState`.** `AppState` is not `Clone`. Pass `tauri::AppHandle` (which IS `Clone`) into the task and recover state with `handle.state::<AppState>()` inside.
- **Adding `#[tauri::command]` without registering.** Tauri silently won't expose it. Update the `.invoke_handler(tauri::generate_handler![…])` list in `lib.rs::run()`.
- **Hitting SQLite in parallel tests.** WAL doesn't share across threads — add `#[serial]`.
- **Backwards-compat for code you just wrote.** If you renamed an unused function in this same diff, just delete the old name. Don't leave `pub use foo as old_foo;`.
- **Touching `prompt.rs` without thinking about cache.** See §7. The fingerprint detector will warn in logs but the cost still happens.
- **Re-inventing existing helpers.** Check before writing: `engine/tools/file_tools.rs::backup_to_central`, `engine/infra/dep_check::check_bin`, `engine/tools/output_envelope::*`, `engine/checkpoint::report_dirty / snapshot_pre_turn / restore`.
- **`/Users/<name>/...` absolute paths in code or tests.** Use `tempfile::TempDir` and `dirs::*` so other contributors' machines aren't dependencies.

---

## 10. Storage paths

| What | Default | Override |
|---|---|---|
| Internal data (DB, secrets, skills, persona) | `~/.yiyi/` | `YIYI_WORKING_DIR` env |
| User workspace (LLM's default output dir) | `~/Documents/YiYi/` | `YIYI_WORKSPACE` env |
| SQLite | `~/.yiyi/yiyi.db` (WAL) | derived from working dir |
| Single-file backups (P2.1) | `~/.yiyi/backups/<encoded-path>.backup` | derived |
| Turn-level shadow git | `~/.yiyi/checkpoints/<workspace-hash>/` | derived |
| Secret store | `~/.yiyi.secret/` (mode 0o700 on Unix) | sibling of working dir |
| Inbox (white-box queue) | `~/.yiyi/inbox/` + `inbox` SQLite table | derived |

`yiyi doctor` prints all of these and verifies write access.

---

## 11. Glossary

- **Persona** — `AGENTS.md` + `SOUL.md` + `PROFILE.md` injected as a prefix on the first user message of a session. Frozen per session (see `build_persona_prefix_cached`).
- **Inbox** — table of pending growth proposals (skill / principle / lesson) awaiting user approval.
- **Hardline** — top tier of shell command rejection. Cannot be bypassed by `grant_session_blanket` or YOLO mode. See `shell_security.rs::HARDLINE_PATTERNS`.
- **Skill** — `SKILL.md` + optional `references/` + `scripts/`. Built-in under `app/src-tauri/skills/`, user-installed under `~/.yiyi/active_skills/`.
- **MCP** — Model Context Protocol. Two surfaces: client (`mcp_runtime.rs`, talks to external servers) and server (`mcp_server.rs`, future, exposes YiYi's skills to other agents).
- **Trace** — opt-in turn-level record of (role / content / reasoning / tool_calls) for future fine-tuning. Default off. Toggle via `tracing.enabled` in config; auto-GC every 24h.
- **Checkpoint** — shadow-git commits over the user's workspace, one ref per turn (`refs/yiyi/<sid>/<turn>__pre|post`). Used for multi-file rollback; single-file rollback lives in `backups/` (see `undo_edit` tool).

---

## 12. When in doubt

- Re-read the relevant file BEFORE editing — don't edit blind on a stale mental model.
- If a tool's behaviour seems wrong, check `engine/tools/<area>.rs` ← `tool_registry_global` ← `react_agent/core.rs` (dispatch path).
- If output to the user looks off, the chain is `react_agent::core` → `commands/agent/chat.rs::chat_stream_start` → `stores/chatStreamStore.ts`.
- Logs go to stdout in dev (`npm run tauri dev`) — search them; failures often print structured hints.
- `yiyi doctor` answers most "is my env fine?" questions before you guess.

Welcome to YiYi. 做就做好。
