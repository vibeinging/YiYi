//! YiYi behavior-eval runner (static lint phase).
//!
//! This integration test only validates the **schema** of every YAML case
//! under `../../evals/cases/`. It does NOT yet run the agent — that's the
//! next step. See `../../evals/runner/README.md` for the roadmap.
//!
//! The intent: make the runner *exist* so new regression cases can be
//! committed under `evals/cases/` with CI confidence that they're
//! well-formed, even before the fixture harness lands.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

// Path to evals/cases/ relative to this test file's directory
// app/src-tauri/tests/evals_runner.rs → ../../../evals/cases
fn cases_dir() -> PathBuf {
    let manifest = env!("CARGO_MANIFEST_DIR");
    Path::new(manifest).join("../../evals/cases")
}

fn rubric_path() -> PathBuf {
    let manifest = env!("CARGO_MANIFEST_DIR");
    Path::new(manifest).join("../../evals/rubric/behavior-rules.md")
}

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
    fixture: Option<serde_yaml::Value>,
    expect: serde_yaml::Value,
}

fn load_all_cases() -> Vec<(PathBuf, EvalCase)> {
    let dir = cases_dir();
    assert!(
        dir.exists(),
        "cases directory missing: {:?}",
        dir
    );

    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).expect("read cases/") {
        let path = entry.expect("entry").path();
        if path.extension().and_then(|s| s.to_str()) != Some("yaml") {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("failed to read {:?}: {}", path, e)
        });
        let case: EvalCase = serde_yaml::from_str(&text).unwrap_or_else(|e| {
            panic!("YAML deserialize failed for {:?}: {}", path, e)
        });
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
        // Headings like "## R1. Task execution: default to inline"
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
            case.id,
            stem,
            "{:?}: id must equal filename stem (got '{}')",
            path,
            case.id,
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
                path,
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
            // rule may be single "R3" or multi "R4,R5"
            for piece in r.split(',') {
                let piece = piece.trim();
                if !piece.is_empty() {
                    assert!(
                        rules.iter().any(|have| have == piece),
                        "{:?}: rule '{}' not found in rubric (have: {:?})",
                        path,
                        piece,
                        rules,
                    );
                }
            }
        }
    }
}

#[test]
fn every_expect_block_is_a_mapping() {
    for (path, case) in load_all_cases() {
        assert!(
            case.expect.is_mapping(),
            "{:?}: `expect:` must be a mapping/object",
            path,
        );
    }
}

// ── Smoke: rule → case coverage report ─────────────────────────────────────
//
// Prints (on test success) which rules are covered by cases. Handy for
// spotting rubric rules with no regression guard.

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
    // print-only; don't fail. Invoke with `cargo test ... -- --nocapture` to see.
    println!("{}", report);
}
