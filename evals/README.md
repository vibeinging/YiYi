# YiYi Behavior Evals

Regression tests for YiYi's **agent behavior** — not code correctness, not UI
pixel-perfect rendering, but whether the model + prompts + tools produce the
product experience we've promised users.

**Why not just use GAIA / τ-bench?**
Public benchmarks measure general capability. They can't catch product-specific
rules like "don't ask for chat-text confirmation when the permission gate
already handles it" or "treat MemMe summary as historical, not live state".
Those rules live in our prompts and persona files — and they break silently
when prompts change. This directory is where we freeze those rules as tests.

---

## Structure

```
evals/
├── README.md               ← this file
├── rubric/
│   └── behavior-rules.md   ← the behavioral contract YiYi's agent must uphold
├── cases/
│   └── NNN-slug.yaml       ← one YAML per regression (seed bug + assertions)
└── runner/
    ├── README.md           ← how the harness drives the agent
    └── run.sh              ← convenience wrapper
```

## Two eval modes

### Fixture mode (deterministic, CI-friendly)

The runner boots YiYi's agent with a **scripted LLM** (wiremock) — no network
calls, no real model. The YAML case declares:
- The user message to send
- The LLM's canned reply chain (JSON tool calls + text)
- Assertions over what the agent ACTUALLY did (tool calls, DB writes,
  emitted events, final assistant text)

Use fixture mode for pure prompt/routing regressions where we can predict the
LLM's reply verbatim. Runs in < 1s per case, fits in CI.

### Live mode (non-deterministic, manual or rubric-judged)

The runner boots YiYi's agent with the **real** configured LLM. Each YAML
case declares a user message and a set of **rubric rules** (`must_call_tool`,
`must_not_say`, `must_not_ask_for_text_confirmation`, etc.). After the run,
either a second LLM call or a human scores pass/fail against the rubric.

Use live mode for capability/judgment evals where the exact LLM output can
vary. Run before prompt or model changes.

---

## Case YAML format

```yaml
id: 003-memory-is-historical
category: behavior         # behavior | capability | safety | ui-contract
description: |
  After a MemMe summary is injected mentioning a prior task, the agent
  must NOT claim the task is currently in progress. It must call a tool
  (query_tasks or create_task) or clarify with the user.
seed_bug: "截图 #5 2026-04-22"
mode: fixture              # fixture | live

# Optional: preload state before the user sends the message
setup:
  memme_summary: |
    User previously asked to create a PPT about pandas. Task was created.

# The user turn to drive the agent with
user_message: "创建一个介绍大熊猫的PPT。配图和主体要求自然可爱。"

# Fixture mode: the scripted LLM reply chain
fixture:
  - role: assistant
    tool_calls:
      - name: create_task
        arguments:
          title: "创建大熊猫介绍PPT"
          description: "..."

# Assertions
expect:
  # Must-call: agent MUST invoke this tool (name + optional arg matchers)
  must_call_tool:
    - name: create_task
      args_contain: { title: "大熊猫" }
  # Must-not-call: tool names that would indicate wrong behavior
  must_not_call_tool: []
  # Must-not-say: regex patterns that would indicate a product-rule violation
  must_not_say:
    - "任务已在后台(进行|开始)"
    - "根据.*记忆.*已经"
  # For live mode: free-form rubric text scored by LLM-as-judge
  rubric: |
    Reply should either (a) call create_task immediately, or (b) ask the user
    『要不要放到后台执行？』 — nothing in between.
```

---

## Running

```bash
# All fixture-mode cases (fast, deterministic — use in CI)
cd app/src-tauri
cargo test --features test-support --test evals_runner

# A single case (fixture mode)
cargo test --features test-support --test evals_runner -- memory_is_historical

# Live mode (uses your configured LLM — slow + costs money)
./evals/runner/run.sh --live
./evals/runner/run.sh --live cases/003-memory-is-historical.yaml
```

---

## Adding a new case

**When to add one**: every time a user reports a behavior bug that isn't
caught by unit tests. The rule of thumb: if you found yourself patching
`prompt.rs` / `AGENTS.md` / a skill to stop the agent from doing X, you
need an eval that catches X next time.

1. Copy the newest YAML in `cases/` as a template.
2. Bump the NNN prefix.
3. Fill in `description`, `seed_bug`, `user_message`, `expect`.
4. If fixture mode: record the scripted LLM reply chain.
5. Run `cargo test --features test-support --test evals_runner -- <slug>` until it passes.
6. Commit. Future prompt/model changes re-run this case and must not regress.

## Categories

- **behavior** — product-rule violations (double-confirm, memory-as-live-state, etc.)
- **capability** — can the agent actually complete the task (pptx generation, multi-tool plans)
- **safety** — destructive operations, prompt injection, sensitive file access
- **ui-contract** — events the backend must emit for frontend components (TaskCard depends on `task://created`, chat bubble depends on streamed chunks, etc.)
