# Eval Runner

The runner lives at `app/src-tauri/tests/evals_runner.rs`.

## What runs today

1. **Schema lint** (7 tests)
   - Every `cases/*.yaml` deserializes, has required fields, uses known
     `mode` / `category`, filename matches `id`, `rule:` refs exist in the
     rubric. Also prints a rule-coverage report.

2. **Fixture harness** (`fixture_cases_all_pass`)
   - For each `mode: fixture` case: boots a local `wiremock` server
     programmed with the YAML's `fixture:` reply chain (content + tool_calls
     emitted as OpenAI-format SSE), drives
     `run_react_with_options_stream` with dummy tool definitions derived
     from the case, captures every `AgentStreamEvent::ToolStart` + `Token`,
     and asserts against the `expect:` block:
     - `must_call_tool` — name matched, optional `args_contain` subset-check
     - `must_not_call_tool` — name never seen
     - `must_not_say` — regex **not** matched in accumulated text
     - `must_call_any_tool: true` — at least one tool call observed
   - Cases with `tool_result_shape` / `event_emitted` / `tool_end_preview`
     are SKIPPED with a log line — those need a v2 harness with TempDb +
     MockEmitter + real tool dispatch.

## What's NOT implemented yet

- **Live mode** (`run.sh --live`) — prints a not-implemented message.
  Plan: invoke the real configured LLM, capture full transcript, pipe to an
  LLM-as-judge with the rubric prompt for pass/fail + reasoning.
- **UI-contract v2 harness** — seeding TempDb + MockEmitter so that tool
  dispatch actually runs and we can assert `task://created` payload shape +
  final `result_preview` JSON-parseability. Case 005 is ready and waiting.

## Usage

```bash
# Run everything (schema lint + fixture harness)
cd app/src-tauri
cargo test --features test-support --test evals_runner

# Verbose — see which cases ran + what tool calls they produced
cargo test --features test-support --test evals_runner -- --nocapture

# Just the fixture harness
cargo test --features test-support --test evals_runner fixture_cases_all_pass

# Live mode (stub)
./evals/runner/run.sh --live
```

## Harness limitations (by design)

- No `AppHandle` / DB setup. DB-backed tool calls like `create_task` will
  dispatch to real handlers that return `Error: DB not available`. We still
  see the `ToolStart` event, which is what the behavior-class assertions
  care about.
- `max_iterations` auto-set to the number of fixture turns. If your case
  needs more rounds, add more turns.
- Dummy tool definitions stub out schemas — we're telling the LLM the tool
  *exists* so it's willing to emit a tool_call, but the real tool's full
  parameters aren't validated.
