# Eval Runner

## Current status: **skeleton**

The runner currently does two things:

1. **Static lint** (`cargo test --features test-support --test evals_runner`)
   - Loads every `cases/*.yaml`
   - Asserts the schema: `id`, `category`, `rule`, `mode`, `user_message`, `expect` all present
   - Asserts `mode` ∈ {`fixture`, `live`}
   - Asserts `category` ∈ {`behavior`, `capability`, `safety`, `ui-contract`}
   - Asserts `rule` references an actual R# in `rubric/behavior-rules.md`

2. **Fixture dry-run** — not implemented yet. Future plan:
   - For each fixture case, boot `react_agent::run_react_with_options_stream`
     with `MockLlmServer` (from `test_support`) pre-seeded with the case's
     `fixture:` reply chain.
   - Capture all `AgentStreamEvent::ToolStart / ToolEnd` + final text.
   - Assert against `expect.must_call_tool` / `must_not_call_tool` /
     `must_not_say` regexes.
   - Assert `tool_result_shape` / `event_emitted` / `tool_end_preview` for
     ui-contract cases.

3. **Live mode** — not implemented. Future plan:
   - `./run.sh --live <case.yaml>` invokes the real configured LLM.
   - Captures full transcript + emitted events.
   - Pipes transcript to an LLM-as-judge with the rubric prompt.
   - Returns pass / fail + reasoning per assertion.

## Usage

```bash
# Right now — only the lint step runs. Catches typos/drift in YAML schema.
cd app/src-tauri
cargo test --features test-support --test evals_runner

# Run a specific case (once fixture mode lands)
cargo test --features test-support --test evals_runner -- memory_is_historical

# Live mode (once implemented)
./evals/runner/run.sh --live
```

## Growing the runner

Each seed case in `cases/` currently describes the target behavior
declaratively. The fixture harness needs these pieces wired up, in order:

- [ ] YAML → Rust struct deserialization (`serde_yaml`)
- [ ] Per-case `test_support::MockLlmServer` programming from `fixture:` chain
- [ ] Capture ToolStart/ToolEnd events into an assertion buffer
- [ ] Regex matcher for `must_not_say` against accumulated assistant text
- [ ] JSON-shape matcher for `tool_result_shape`
- [ ] Event capture via `test_support::MockEmitter` for `event_emitted`

None of these require new dependencies — all pieces exist in `test_support`
already. Tracking work in `docs/plans/2026-04-23-eval-harness.md` (not yet
written).
