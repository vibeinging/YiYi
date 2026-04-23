//! YiYi behavior-eval runner.
//!
//! Two phases:
//! 1. **Schema lint** — every YAML under `../../evals/cases/` is well-formed,
//!    references an actual rule in `rubric/behavior-rules.md`, etc.
//! 2. **Fixture harness** — every case with `mode: fixture` is executed
//!    end-to-end: the YAML's `fixture:` block is replayed on a `MockLlmServer`,
//!    `run_react_with_options_stream` drives the real agent loop, and the
//!    `expect:` assertions (must_call_tool / must_not_call_tool / must_not_say)
//!    are checked against captured events + streamed text.
//!
//! Intentionally LIGHT: we don't boot AppHandle / DB. Tool dispatch will fail
//! with "Error: DB not available" for DB-backed tools — that's fine, since
//! this harness only asserts *the agent attempted the tool call* and *the
//! final text doesn't violate product rules*. For UI-contract cases that need
//! to assert `task://created` events or `__type` JSON fields, a richer v2
//! harness would layer on TempDb + MockEmitter; not implemented yet.
//!
//! See `../../evals/README.md` for the two-mode design.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use regex::Regex;
use serde::Deserialize;

use app_lib::engine::llm_client::LLMConfig;
use app_lib::engine::react_agent::{run_react_with_options_stream, AgentStreamEvent};
use app_lib::engine::tools::{builtin_tools, FunctionDef, ToolDefinition};

// ── Path helpers ───────────────────────────────────────────────────────────

fn cases_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../evals/cases")
}

fn rubric_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../evals/rubric/behavior-rules.md")
}

// ── YAML schema ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct EvalCase {
    id: String,
    category: String,
    #[serde(default)]
    rule: Option<String>,
    #[serde(default)]
    seed_bug: Option<String>,
    #[serde(default)]
    description: Option<String>,
    mode: String,
    user_message: String,
    #[serde(default)]
    setup: Option<serde_yaml::Value>,
    #[serde(default)]
    fixture: Option<Vec<FixtureTurn>>,
    expect: ExpectBlock,
}

#[derive(Debug, Deserialize, Clone)]
struct FixtureTurn {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<FixtureToolCall>>,
}

#[derive(Debug, Deserialize, Clone)]
struct FixtureToolCall {
    name: String,
    #[serde(default)]
    arguments: serde_yaml::Value,
}

#[derive(Debug, Deserialize, Default)]
struct ExpectBlock {
    // ── Hard assertions (deterministic, checked in every mode) ──
    // Use these only for mechanical facts: "tool X was called", "tool Y was
    // NOT called". Don't use regex assertions for wording — that's what the
    // rubric is for.
    #[serde(default)]
    must_call_tool: Vec<ToolExpect>,
    #[serde(default)]
    must_not_call_tool: Vec<ToolExpect>,
    #[serde(default)]
    must_call_any_tool: Option<bool>,

    // ── Soft assertions (regex-based) ──
    // Kept for cheap fixture-mode smoke tests. Prefer `rubric` for live mode.
    #[serde(default)]
    must_not_say: Vec<String>,

    // ── LLM-as-judge rubric ──
    // Natural-language criteria. In live mode, after the agent runs, a
    // separate LLM call scores the transcript against each criterion.
    // Criteria with weight=critical cause the case to fail if violated;
    // major/minor are surfaced as warnings.
    #[serde(default)]
    rubric: Vec<RubricItem>,

    // ── Future v2 harness fields ──
    #[serde(default)]
    #[allow(dead_code)]
    tool_result_shape: Option<serde_yaml::Value>,
    #[serde(default)]
    #[allow(dead_code)]
    event_emitted: Option<serde_yaml::Value>,
    #[serde(default)]
    #[allow(dead_code)]
    tool_end_preview: Option<serde_yaml::Value>,
}

#[derive(Debug, Deserialize, Clone)]
struct RubricItem {
    criterion: String,
    #[serde(default = "default_weight")]
    weight: String, // "critical" | "major" | "minor"
}

fn default_weight() -> String {
    "critical".into()
}

#[derive(Debug, Deserialize, Clone)]
struct ToolExpect {
    name: String,
    #[serde(default)]
    args_contain: Option<serde_yaml::Value>,
}

// ── Load ───────────────────────────────────────────────────────────────────

fn load_all_cases() -> Vec<(PathBuf, EvalCase)> {
    let dir = cases_dir();
    assert!(dir.exists(), "cases directory missing: {:?}", dir);

    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).expect("read cases/") {
        let path = entry.expect("entry").path();
        if path.extension().and_then(|s| s.to_str()) != Some("yaml") {
            continue;
        }
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {:?}: {}", path, e));
        let case: EvalCase = serde_yaml::from_str(&text)
            .unwrap_or_else(|e| panic!("YAML deserialize failed for {:?}: {}", path, e));
        out.push((path, case));
    }
    out.sort_by(|a, b| a.1.id.cmp(&b.1.id));
    out
}

fn load_rubric_rules() -> Vec<String> {
    let path = rubric_path();
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read rubric {:?}: {}", path, e));
    let mut rules = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## R") {
            if let Some(dot) = rest.find('.') {
                let num = &rest[..dot];
                if num.chars().all(|c| c.is_ascii_digit()) {
                    rules.push(format!("R{}", num));
                }
            }
        }
    }
    rules
}

// ── Schema lint tests ──────────────────────────────────────────────────────

#[test]
fn every_case_has_all_required_fields() {
    let cases = load_all_cases();
    assert!(!cases.is_empty(), "no cases under evals/cases/");
    for (path, case) in &cases {
        assert!(!case.id.is_empty(), "{:?}: id empty", path);
        assert!(!case.category.is_empty(), "{:?}: category empty", path);
        assert!(!case.mode.is_empty(), "{:?}: mode empty", path);
        assert!(!case.user_message.is_empty(), "{:?}: user_message empty", path);
    }
}

#[test]
fn every_case_uses_a_known_mode() {
    for (path, case) in load_all_cases() {
        assert!(
            matches!(case.mode.as_str(), "fixture" | "live"),
            "{:?}: mode must be 'fixture' or 'live' (got '{}')",
            path,
            case.mode
        );
    }
}

#[test]
fn every_case_uses_a_known_category() {
    const CATEGORIES: &[&str] = &["behavior", "capability", "safety", "ui-contract"];
    for (path, case) in load_all_cases() {
        assert!(
            CATEGORIES.contains(&case.category.as_str()),
            "{:?}: category must be one of {:?} (got '{}')",
            path,
            CATEGORIES,
            case.category
        );
    }
}

#[test]
fn every_case_id_matches_filename_prefix() {
    for (path, case) in load_all_cases() {
        let stem = path.file_stem().unwrap().to_string_lossy();
        assert_eq!(
            case.id, stem,
            "{:?}: id must equal filename stem (got '{}')",
            path, case.id
        );
    }
}

#[test]
fn fixture_mode_cases_include_fixture_block() {
    for (path, case) in load_all_cases() {
        if case.mode == "fixture" {
            assert!(
                case.fixture.is_some(),
                "{:?}: fixture mode requires a `fixture:` block",
                path
            );
        }
    }
}

#[test]
fn every_rule_reference_exists_in_rubric() {
    let rules = load_rubric_rules();
    assert!(!rules.is_empty(), "no R# headings parsed from rubric");
    for (path, case) in load_all_cases() {
        if let Some(ref r) = case.rule {
            for piece in r.split(',') {
                let piece = piece.trim();
                if !piece.is_empty() {
                    assert!(
                        rules.iter().any(|have| have == piece),
                        "{:?}: rule '{}' not found in rubric (have: {:?})",
                        path,
                        piece,
                        rules
                    );
                }
            }
        }
    }
}

// ── Fixture harness ────────────────────────────────────────────────────────

/// Convert a fixture turn (possibly with tool_calls) into a streaming SSE
/// body acceptable to the OpenAI-format adapter.
fn fixture_turn_to_sse(turn: &FixtureTurn) -> String {
    let mut body = String::new();

    // Emit content chunk first if present — streamed as Token events.
    if let Some(ref text) = turn.content {
        if !text.is_empty() {
            let evt = serde_json::json!({
                "id": "mock-id",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "mock-model",
                "choices": [{
                    "index": 0,
                    "delta": { "content": text },
                    "finish_reason": null,
                }]
            });
            body.push_str(&format!("data: {}\n\n", evt));
        }
    }

    // Emit each tool_call as its own delta chunk.
    if let Some(ref calls) = turn.tool_calls {
        for (i, call) in calls.iter().enumerate() {
            let args_json = if call.arguments.is_null() {
                "{}".to_string()
            } else {
                serde_json::to_string(&yaml_to_json(&call.arguments))
                    .unwrap_or_else(|_| "{}".into())
            };
            let evt = serde_json::json!({
                "id": "mock-id",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "mock-model",
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{
                            "index": i,
                            "id": format!("call_mock_{}", i),
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": args_json,
                            }
                        }]
                    },
                    "finish_reason": null,
                }]
            });
            body.push_str(&format!("data: {}\n\n", evt));
        }
    }

    // Final finish-reason chunk: tool_calls wins if any, otherwise stop.
    let finish_reason = if turn.tool_calls.as_ref().map_or(false, |c| !c.is_empty()) {
        "tool_calls"
    } else {
        "stop"
    };
    let finish = serde_json::json!({
        "id": "mock-id",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "mock-model",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": finish_reason }]
    });
    body.push_str(&format!("data: {}\n\n", finish));
    body.push_str("data: [DONE]\n\n");
    body
}

fn yaml_to_json(v: &serde_yaml::Value) -> serde_json::Value {
    // Round-trip: serde_yaml → string → serde_json. Handles basic scalars
    // and mappings faithfully enough for fixture args.
    match serde_yaml::to_string(v) {
        Ok(s) => serde_json::from_str::<serde_json::Value>(&s)
            .or_else(|_| serde_yaml::from_str::<serde_json::Value>(&s))
            .unwrap_or(serde_json::Value::Null),
        Err(_) => serde_json::Value::Null,
    }
}

/// Collect every tool name referenced in the case (fixture + expectations)
/// so we can register dummy ToolDefinitions — the LLM needs to see them in
/// the `tools:` array to feel licensed to emit a tool_call.
fn referenced_tool_names(case: &EvalCase) -> HashSet<String> {
    let mut names = HashSet::new();
    if let Some(ref turns) = case.fixture {
        for t in turns {
            if let Some(ref calls) = t.tool_calls {
                for c in calls {
                    names.insert(c.name.clone());
                }
            }
        }
    }
    for t in &case.expect.must_call_tool {
        names.insert(t.name.clone());
    }
    for t in &case.expect.must_not_call_tool {
        names.insert(t.name.clone());
    }
    names
}

fn dummy_tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        r#type: "function".into(),
        function: FunctionDef {
            name: name.into(),
            description: format!("Eval stub for {}", name),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "additionalProperties": true,
            }),
        },
    }
}

fn make_llm_config(uri: &str) -> LLMConfig {
    LLMConfig {
        base_url: uri.to_string(),
        api_key: "test-fake-key".to_string(),
        model: "mock-model".to_string(),
        provider_id: "openai".to_string(),
        native_tools: vec![],
    }
}

struct RunOutcome {
    tool_calls: Vec<(String, String)>, // (name, args_preview)
    text: String,
    final_result: Result<String, String>,
}

async fn run_fixture_case(case: &EvalCase) -> RunOutcome {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let mock = MockServer::start().await;

    // Register each fixture turn as an up_to_1 response. Wiremock matches
    // mounted mocks in order of registration when priorities are equal.
    let turns = case.fixture.as_ref().expect("fixture turns present");
    for turn in turns {
        let sse = fixture_turn_to_sse(turn);
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(sse.into_bytes(), "text/event-stream")
                    .insert_header("content-type", "text/event-stream"),
            )
            .up_to_n_times(1)
            .mount(&mock)
            .await;
    }

    // Build the tools override: dummy stubs for every tool the case cares
    // about. This makes the LLM willing to emit them in the reply and
    // avoids leaking real tool implementations during the eval.
    let tool_names = referenced_tool_names(case);
    let tools_override: Vec<ToolDefinition> = tool_names.iter().map(|n| dummy_tool(n)).collect();

    let config = make_llm_config(&mock.uri());
    let events = Arc::new(Mutex::new(Vec::<AgentStreamEvent>::new()));
    let events_cb = events.clone();

    let result = run_react_with_options_stream(
        &config,
        "You are YiYi, a helpful assistant (eval harness).",
        &case.user_message,
        &[],
        &[],
        Some(turns.len()), // max iterations = number of scripted turns
        None,
        move |e| events_cb.lock().unwrap().push(e),
        None,
        None,
        Some(tools_override),
    )
    .await;

    let events = events.lock().unwrap().clone();
    let mut tool_calls = Vec::new();
    let mut text = String::new();
    for evt in &events {
        match evt {
            AgentStreamEvent::ToolStart { name, args_preview } => {
                tool_calls.push((name.clone(), args_preview.clone()));
            }
            AgentStreamEvent::Token(t) => text.push_str(t),
            _ => {}
        }
    }

    RunOutcome { tool_calls, text, final_result: result }
}

// ── Assertion helpers ──────────────────────────────────────────────────────

fn assert_must_call_tool(case: &EvalCase, outcome: &RunOutcome) {
    for want in &case.expect.must_call_tool {
        let found = outcome.tool_calls.iter().any(|(name, args)| {
            if name != &want.name {
                return false;
            }
            match want.args_contain {
                None => true,
                Some(ref expect_yaml) => {
                    // Parse args_preview as JSON; check that each key/value
                    // in args_contain appears in the actual call.
                    let actual: serde_json::Value =
                        serde_json::from_str(args).unwrap_or(serde_json::Value::Null);
                    let expected = yaml_to_json(expect_yaml);
                    json_contains(&actual, &expected)
                }
            }
        });
        assert!(
            found,
            "case {}: expected tool `{}` to be called (args_contain={:?}) but observed: {:?}",
            case.id, want.name, want.args_contain, outcome.tool_calls,
        );
    }
}

fn assert_must_not_call_tool(case: &EvalCase, outcome: &RunOutcome) {
    for forbidden in &case.expect.must_not_call_tool {
        let called = outcome.tool_calls.iter().any(|(n, _)| n == &forbidden.name);
        assert!(
            !called,
            "case {}: tool `{}` MUST NOT have been called, but was. Calls: {:?}",
            case.id, forbidden.name, outcome.tool_calls,
        );
    }
}

fn assert_must_call_any_tool(case: &EvalCase, outcome: &RunOutcome) {
    if case.expect.must_call_any_tool == Some(true) {
        assert!(
            !outcome.tool_calls.is_empty(),
            "case {}: expected at least one tool call, observed none. \
             Final text: {:?}",
            case.id,
            outcome.text,
        );
    }
}

fn assert_must_not_say(case: &EvalCase, outcome: &RunOutcome) {
    for pattern in &case.expect.must_not_say {
        let re = Regex::new(pattern).unwrap_or_else(|e| {
            panic!("case {}: invalid regex `{}`: {}", case.id, pattern, e)
        });
        assert!(
            !re.is_match(&outcome.text),
            "case {}: forbidden phrase matched — pattern `{}` found in text: {:?}",
            case.id,
            pattern,
            outcome.text,
        );
    }
}

// ── LLM-as-judge ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
struct JudgeVerdict {
    criterion: String,
    verdict: String, // "pass" | "fail"
    reasoning: String,
}

/// Ask an LLM to evaluate a transcript against rubric criteria. Returns one
/// verdict per criterion; critical-weight failures cause the case to fail,
/// major/minor surface as warnings.
async fn judge_with_llm(
    case: &EvalCase,
    outcome: &RunOutcome,
    config: &LLMConfig,
) -> Result<Vec<JudgeVerdict>, String> {
    if case.expect.rubric.is_empty() {
        return Ok(vec![]);
    }

    // Build a compact transcript for the judge
    let tools_section = if outcome.tool_calls.is_empty() {
        "(none)".to_string()
    } else {
        outcome
            .tool_calls
            .iter()
            .map(|(n, a)| format!("  • {}({})", n, a.chars().take(200).collect::<String>()))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let rubric_json: serde_json::Value = serde_json::Value::Array(
        case.expect
            .rubric
            .iter()
            .map(|r| {
                serde_json::json!({
                    "criterion": r.criterion,
                    "weight": r.weight,
                })
            })
            .collect(),
    );

    let judge_prompt = format!(
        r#"You are evaluating the behavior of an AI assistant called YiYi against a rubric.

USER MESSAGE:
{user_msg}

AGENT BEHAVIOR:
Tool calls made:
{tools}

Final reply to user:
{text}

RUBRIC — evaluate each criterion independently:
{rubric_json}

Return a JSON array (no prose, no markdown fences). One object per criterion:
[
  {{"criterion": "...", "verdict": "pass" | "fail", "reasoning": "one short sentence"}}
]

Rules:
- Be strict. If the agent violates the spirit of a criterion, mark fail.
- A criterion about "not asking for text confirmation" FAILS if the agent says things like 『请回复确认/允许/同意/继续/ok/yes』, 『请您确认是否允许』, 『需要您的明确同意』, or similar ack-gating phrasing — even if it also calls the right tool.
- A criterion about "not falling back to external tutorials" FAILS if the agent tells the user to use Google Slides / Canva / do it manually.
- Tool dispatch may return "Unknown tool" in this eval harness — that's a test artifact, judge the agent's intent from its tool calls and reply text, not the tool result.
- Output MUST be parseable JSON array. No code fences.
"#,
        user_msg = case.user_message,
        tools = tools_section,
        text = outcome.text.chars().take(2000).collect::<String>(),
        rubric_json = serde_json::to_string_pretty(&rubric_json).unwrap_or_default(),
    );

    // Use the same LLM adapter as the main ReAct loop, non-streaming for a
    // single structured reply.
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": config.model,
        "messages": [
            { "role": "system", "content": "You are a precise evaluation judge. Output only valid JSON." },
            { "role": "user",   "content": judge_prompt },
        ],
        "temperature": 0.0,
    });
    let resp = client
        .post(format!("{}/chat/completions", config.base_url.trim_end_matches('/')))
        .bearer_auth(&config.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("judge http: {e}"))?;
    let status = resp.status();
    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("judge parse: {e}"))?;
    if !status.is_success() {
        return Err(format!("judge http {}: {}", status, resp_body));
    }
    let raw = resp_body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    // Strip accidental code fences
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let verdicts: Vec<JudgeVerdict> = serde_json::from_str(cleaned)
        .map_err(|e| format!("judge json parse: {e}\nraw: {}", raw))?;
    Ok(verdicts)
}

fn weight_of(case: &EvalCase, criterion: &str) -> &'static str {
    for r in &case.expect.rubric {
        if r.criterion == criterion {
            return match r.weight.as_str() {
                "critical" => "critical",
                "major" => "major",
                _ => "minor",
            };
        }
    }
    "critical"
}

/// Recursive subset check: does `actual` contain every key/value in `expected`?
/// - Objects: every expected key must exist in actual and recursively match
/// - Arrays: every expected element must appear somewhere in actual
/// - Strings: actual must contain expected as a substring
/// - Scalars: exact equality
fn json_contains(actual: &serde_json::Value, expected: &serde_json::Value) -> bool {
    match (actual, expected) {
        (serde_json::Value::Object(a), serde_json::Value::Object(e)) => e.iter().all(|(k, ev)| {
            match a.get(k) {
                Some(av) => json_contains(av, ev),
                None => false,
            }
        }),
        (serde_json::Value::Array(a), serde_json::Value::Array(e)) => {
            e.iter().all(|ev| a.iter().any(|av| json_contains(av, ev)))
        }
        (serde_json::Value::String(a), serde_json::Value::String(e)) => a.contains(e.as_str()),
        _ => actual == expected,
    }
}

// ── Driver: every fixture case ─────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn fixture_cases_all_pass() {
    // Serial-ish: the ReAct loop mutates some globals (task session id,
    // tool-filter scope). Running cases sequentially inside one test sidesteps
    // having to wire serial_test here.
    let cases = load_all_cases();
    let mut ran = 0;
    for (path, case) in &cases {
        if case.mode != "fixture" {
            continue;
        }
        // Cases that lean on contract-shape assertions (tool_result_shape /
        // event_emitted / tool_end_preview) need the v2 harness. Skip them
        // with a clear log rather than a false pass.
        if case.expect.tool_result_shape.is_some()
            || case.expect.event_emitted.is_some()
            || case.expect.tool_end_preview.is_some()
        {
            eprintln!(
                "  [skip] {} — contract assertions require v2 harness (TempDb + MockEmitter)",
                case.id
            );
            continue;
        }

        eprintln!("  [run ] {}", case.id);
        let outcome = run_fixture_case(case).await;
        eprintln!("         → tool_calls: {:?}", outcome.tool_calls);
        eprintln!("         → final: {:?}", outcome.final_result.as_ref().err());

        assert_must_call_tool(case, &outcome);
        assert_must_not_call_tool(case, &outcome);
        assert_must_call_any_tool(case, &outcome);
        assert_must_not_say(case, &outcome);

        // Guard against harness misuse: if no assertion targets were set,
        // the case is effectively a no-op and should flag for author attention.
        let has_assertions = !case.expect.must_call_tool.is_empty()
            || !case.expect.must_not_call_tool.is_empty()
            || !case.expect.must_not_say.is_empty()
            || case.expect.must_call_any_tool == Some(true)
            || !case.expect.rubric.is_empty();
        assert!(
            has_assertions,
            "case {}: no effective assertions; add must_call_tool / must_not_call_tool / must_not_say / must_call_any_tool / rubric",
            case.id
        );

        ran += 1;
        let _ = path;
    }
    assert!(ran > 0, "no fixture cases ran — check mode fields");
    eprintln!("✓ {} fixture case(s) passed", ran);
}

// ── Live mode ──────────────────────────────────────────────────────────────
//
// Runs each case against the real configured LLM. Gated by the env var
// `YIYI_EVAL_LIVE=1` so CI stays deterministic / free.
//
// Required env:
//   DASHSCOPE_API_KEY (or provider-matching env var; see providers.rs)
// Optional:
//   YIYI_EVAL_BASE_URL     (default: https://dashscope.aliyuncs.com/compatible-mode/v1)
//   YIYI_EVAL_MODEL        (default: qwen-max)
//   YIYI_EVAL_PROVIDER_ID  (default: openai — OpenAI-compatible adapter)
//   YIYI_EVAL_ONLY         (substring filter for case id)
//
// Loads the REAL system prompt (persona + build_system_prompt) from ~/.yiyi/
// so this actually exercises the prompt rules + persona files we edit to
// fix behavior bugs. Dummy tool definitions stub dispatch — we only care
// whether the LLM *chooses* the right tool, not what happens after.

fn live_env() -> Option<(String, String, String, String)> {
    if std::env::var("YIYI_EVAL_LIVE").ok().as_deref() != Some("1") {
        return None;
    }
    let api_key = std::env::var("DASHSCOPE_API_KEY")
        .or_else(|_| std::env::var("YIYI_EVAL_API_KEY"))
        .ok()?;
    let base_url = std::env::var("YIYI_EVAL_BASE_URL")
        .unwrap_or_else(|_| "https://dashscope.aliyuncs.com/compatible-mode/v1".into());
    let model = std::env::var("YIYI_EVAL_MODEL").unwrap_or_else(|_| "qwen-max".into());
    let provider_id = std::env::var("YIYI_EVAL_PROVIDER_ID").unwrap_or_else(|_| "openai".into());
    Some((api_key, base_url, model, provider_id))
}

async fn build_real_system_prompt() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let working_dir = PathBuf::from(&home).join(".yiyi");
    let user_workspace = PathBuf::from(&home).join("Documents/YiYi");
    app_lib::engine::react_agent::build_system_prompt(
        &working_dir,
        Some(&user_workspace),
        &[],
        &[],
        Some("zh-CN"),
        None,
        None,
    )
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn live_cases() {
    let Some((api_key, base_url, model, provider_id)) = live_env() else {
        eprintln!("YIYI_EVAL_LIVE not set — skipping live harness.");
        eprintln!("To run: YIYI_EVAL_LIVE=1 DASHSCOPE_API_KEY=sk-xxx cargo test --features test-support --test evals_runner live_cases -- --nocapture");
        return;
    };

    let only_filter = std::env::var("YIYI_EVAL_ONLY").ok();
    let system_prompt = build_real_system_prompt().await;
    eprintln!("── Live eval (model={}, base={}) ──", model, base_url);

    let cases = load_all_cases();
    let mut ran = 0;
    let mut failures: Vec<(String, String)> = Vec::new();

    for (_, case) in &cases {
        if case.mode != "fixture" && case.mode != "live" {
            continue;
        }
        if let Some(ref f) = only_filter {
            if !case.id.contains(f.as_str()) {
                continue;
            }
        }
        // Contract-shape cases need the v2 harness; skip here too.
        if case.expect.tool_result_shape.is_some()
            || case.expect.event_emitted.is_some()
            || case.expect.tool_end_preview.is_some()
        {
            eprintln!("  [skip] {} — contract case", case.id);
            continue;
        }

        // Live mode MUST use real tool schemas — otherwise the LLM invents
        // parameter names (we saw `pip_install({"name": ...})` instead of
        // `{"package": ...}`) and args_contain assertions fail for the wrong
        // reason. Filter builtin_tools() down to the tool names referenced
        // by the case; fall back to a dummy stub for unknown names (tools
        // from plugins / MCP that aren't in the builtin set yet).
        let tool_names = referenced_tool_names(case);
        let all_builtin = builtin_tools();
        let tools_override: Vec<ToolDefinition> = tool_names
            .iter()
            .map(|name| {
                all_builtin
                    .iter()
                    .find(|t| &t.function.name == name)
                    .cloned()
                    .unwrap_or_else(|| dummy_tool(name))
            })
            .collect();

        let config = LLMConfig {
            base_url: base_url.clone(),
            api_key: api_key.clone(),
            model: model.clone(),
            provider_id: provider_id.clone(),
            native_tools: vec![],
        };

        let events = Arc::new(Mutex::new(Vec::<AgentStreamEvent>::new()));
        let events_cb = events.clone();

        eprintln!("  [live] {} — sending real LLM request…", case.id);
        let result = run_react_with_options_stream(
            &config,
            &system_prompt,
            &case.user_message,
            &[],
            &[],
            Some(3), // allow up to 3 rounds for real agent
            None,
            move |e| events_cb.lock().unwrap().push(e),
            None,
            None,
            Some(tools_override),
        )
        .await;

        let events = events.lock().unwrap().clone();
        let mut tool_calls = Vec::new();
        let mut text = String::new();
        for e in &events {
            match e {
                AgentStreamEvent::ToolStart { name, args_preview } => {
                    tool_calls.push((name.clone(), args_preview.clone()));
                }
                AgentStreamEvent::Token(t) => text.push_str(t),
                _ => {}
            }
        }

        let outcome = RunOutcome {
            tool_calls,
            text,
            final_result: result,
        };
        eprintln!(
            "         → tool_calls: {:?}",
            outcome.tool_calls
        );
        eprintln!(
            "         → text: {}…",
            outcome
                .text
                .chars()
                .take(120)
                .collect::<String>()
                .replace('\n', " ")
        );

        // Collect hard-assertion failures.
        let mut local = Vec::new();
        if let Err(e) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert_must_call_tool(case, &outcome);
            assert_must_not_call_tool(case, &outcome);
            assert_must_call_any_tool(case, &outcome);
            assert_must_not_say(case, &outcome);
        })) {
            let msg = match e.downcast_ref::<String>() {
                Some(s) => s.clone(),
                None => e
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "unknown panic".into()),
            };
            local.push(msg);
        }

        // LLM-as-judge: score the rubric with a separate LLM call. Critical
        // fails block the case; major/minor print as warnings.
        if !case.expect.rubric.is_empty() {
            match judge_with_llm(case, &outcome, &config).await {
                Ok(verdicts) => {
                    for v in &verdicts {
                        let pass = v.verdict.eq_ignore_ascii_case("pass");
                        let weight = weight_of(case, &v.criterion);
                        let icon = if pass { "✓" } else { "✗" };
                        eprintln!(
                            "         {} [judge/{}] {} — {}",
                            icon, weight, v.criterion, v.reasoning
                        );
                        if !pass && weight == "critical" {
                            local.push(format!(
                                "rubric critical fail: {} — {}",
                                v.criterion, v.reasoning
                            ));
                        }
                    }
                }
                Err(e) => {
                    eprintln!("         ⚠ judge error: {}", e);
                    local.push(format!("judge error: {}", e));
                }
            }
        }

        if local.is_empty() {
            eprintln!("         ✓ pass");
        } else {
            for m in &local {
                eprintln!("         ✗ {}", m);
            }
            failures.push((case.id.clone(), local.join("\n")));
        }
        ran += 1;
    }

    eprintln!("── Live eval complete: {} case(s) ran, {} failed ──", ran, failures.len());
    if !failures.is_empty() {
        for (id, msg) in &failures {
            eprintln!("✗ {} — {}", id, msg);
        }
        panic!("{} live case(s) failed", failures.len());
    }
}

// ── Coverage report ────────────────────────────────────────────────────────

#[test]
fn rules_coverage_report() {
    let rules = load_rubric_rules();
    let cases = load_all_cases();

    let mut report = String::from("\n── Rule coverage ──\n");
    for r in &rules {
        let covering: Vec<&str> = cases
            .iter()
            .filter_map(|(_, c)| {
                c.rule
                    .as_deref()
                    .filter(|v| v.split(',').any(|p| p.trim() == r))
                    .map(|_| c.id.as_str())
            })
            .collect();
        if covering.is_empty() {
            report.push_str(&format!("  {} — ⚠ no case\n", r));
        } else {
            report.push_str(&format!("  {} — {}\n", r, covering.join(", ")));
        }
    }
    println!("{}", report);
}
