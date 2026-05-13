//! `yiyi doctor` — environment self-check.
//!
//! Invoked from `main.rs` when argv[1] == "doctor". Runs a battery of
//! cheap probes (PATH lookups, filesystem stat, SQLite open) and prints
//! a categorized report to stdout. Exit code = number of *failed* checks
//! (warnings don't count) so wrapper scripts can branch on `$?`.
//!
//! Why a stand-alone subcommand: when YiYi misbehaves the first question
//! is "is the user's environment sane?". Asking them to launch the GUI,
//! open dev tools, and copy a console blob is a bad debug loop. `yiyi
//! doctor` is meant to print everything we'd otherwise ask for, in a
//! shareable form, in under a second.
//!
//! This module deliberately does **not** boot Tauri / `AppState`. It
//! re-derives working-dir / workspace paths from env + `dirs` so the
//! check is fast and stays useful even when AppState would itself fail
//! to initialise (the kind of state where a doctor matters most).

use std::path::{Path, PathBuf};

use crate::engine::infra::dep_check::check_bin;

/// One health-check result.
#[derive(Debug, Clone)]
pub struct CheckResult {
    pub label: String,
    pub status: CheckStatus,
}

#[derive(Debug, Clone)]
pub enum CheckStatus {
    /// All good. `detail` is short extra info (version string, path).
    Ok { detail: String },
    /// Optional dep is missing or a non-critical condition isn't met.
    /// `hint` should be one short actionable line.
    Warn { hint: String },
    /// A required dep / dir is missing — YiYi will break without this.
    Fail { hint: String },
}

impl CheckStatus {
    pub fn glyph(&self) -> &'static str {
        match self {
            CheckStatus::Ok { .. } => "✓",
            CheckStatus::Warn { .. } => "!",
            CheckStatus::Fail { .. } => "✗",
        }
    }
}

/// Full sweep result.
#[derive(Debug, Clone)]
pub struct DoctorReport {
    pub results: Vec<CheckResult>,
}

impl DoctorReport {
    pub fn num_fails(&self) -> usize {
        self.results.iter().filter(|r| matches!(r.status, CheckStatus::Fail { .. })).count()
    }
    pub fn num_warns(&self) -> usize {
        self.results.iter().filter(|r| matches!(r.status, CheckStatus::Warn { .. })).count()
    }
    pub fn num_oks(&self) -> usize {
        self.results.iter().filter(|r| matches!(r.status, CheckStatus::Ok { .. })).count()
    }
}

/// Same resolution logic AppState uses, factored to dodge the AppState
/// constructor side-effects (which create directories — undesirable for
/// a doctor probe).
fn resolve_working_dir() -> PathBuf {
    std::env::var("YIYI_WORKING_DIR")
        .or_else(|_| std::env::var("YIYICLAW_WORKING_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".yiyi")
        })
}

fn resolve_user_workspace() -> PathBuf {
    std::env::var("YIYI_WORKSPACE")
        .or_else(|_| std::env::var("YIYICLAW_WORKSPACE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::document_dir()
                .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
                .join("YiYi")
        })
}

// ── individual probes ─────────────────────────────────────────────────

fn check_bin_required(bin: &str, purpose: &str) -> CheckResult {
    if check_bin(bin) {
        CheckResult {
            label: format!("{} (required) — {}", bin, purpose),
            status: CheckStatus::Ok { detail: "on PATH".into() },
        }
    } else {
        CheckResult {
            label: format!("{} (required) — {}", bin, purpose),
            status: CheckStatus::Fail {
                hint: format!(
                    "install '{}' and ensure it's on PATH. macOS: brew install {}",
                    bin, bin
                ),
            },
        }
    }
}

fn check_bin_optional(bin: &str, purpose: &str) -> CheckResult {
    if check_bin(bin) {
        CheckResult {
            label: format!("{} (optional) — {}", bin, purpose),
            status: CheckStatus::Ok { detail: "on PATH".into() },
        }
    } else {
        CheckResult {
            label: format!("{} (optional) — {}", bin, purpose),
            status: CheckStatus::Warn {
                hint: format!("skip if you don't need it; otherwise: brew install {}", bin),
            },
        }
    }
}

fn check_dir_writable(label: &str, dir: &Path, required: bool) -> CheckResult {
    let label = format!("{} ({})", label, dir.display());
    if !dir.exists() {
        let hint = format!(
            "doesn't exist yet — YiYi will create it on first launch, or `mkdir -p {}`",
            dir.display()
        );
        return CheckResult {
            label,
            status: if required {
                CheckStatus::Fail { hint }
            } else {
                CheckStatus::Warn { hint }
            },
        };
    }

    // Write a small probe file to verify it's actually writable.
    let probe = dir.join(".yiyi_doctor_probe");
    let writable = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe); // best-effort cleanup

    if writable {
        CheckResult {
            label,
            status: CheckStatus::Ok { detail: "writable".into() },
        }
    } else {
        CheckResult {
            label,
            status: CheckStatus::Fail {
                hint: format!(
                    "not writable — check permissions: ls -ld {}",
                    dir.display()
                ),
            },
        }
    }
}

fn check_database(working_dir: &Path) -> CheckResult {
    let db_path = working_dir.join("yiyi.db");
    let label = format!("SQLite DB ({})", db_path.display());
    if !db_path.exists() {
        return CheckResult {
            label,
            status: CheckStatus::Warn {
                hint: "DB not yet created — YiYi seeds it on first launch.".into(),
            },
        };
    }
    // Try to open read-only to confirm it's not corrupted.
    match rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(conn) => {
            // Trivial query to make sure the file isn't a bad shape.
            let ok = conn
                .query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
                .map(|v| v == 1)
                .unwrap_or(false);
            if ok {
                CheckResult {
                    label,
                    status: CheckStatus::Ok { detail: "opens cleanly".into() },
                }
            } else {
                CheckResult {
                    label,
                    status: CheckStatus::Fail {
                        hint: "DB opened but SELECT 1 failed — likely corrupted".into(),
                    },
                }
            }
        }
        Err(e) => CheckResult {
            label,
            status: CheckStatus::Fail {
                hint: format!("can't open: {} — back it up then delete to let YiYi rebuild", e),
            },
        },
    }
}

fn check_persona_templates(working_dir: &Path) -> CheckResult {
    let agents = working_dir.join("AGENTS.md");
    let soul = working_dir.join("SOUL.md");
    let label = "persona templates (AGENTS.md / SOUL.md)".to_string();
    match (agents.exists(), soul.exists()) {
        (true, true) => CheckResult {
            label,
            status: CheckStatus::Ok { detail: "both present".into() },
        },
        (false, false) => CheckResult {
            label,
            status: CheckStatus::Warn {
                hint: "neither present — YiYi seeds defaults on first launch".into(),
            },
        },
        (a, b) => CheckResult {
            label,
            status: CheckStatus::Warn {
                hint: format!(
                    "partial: AGENTS.md {}, SOUL.md {}",
                    if a { "✓" } else { "missing" },
                    if b { "✓" } else { "missing" },
                ),
            },
        },
    }
}

// ── public entry ──────────────────────────────────────────────────────

/// Run the full sweep. Pure-ish (filesystem + `which` probes only — no
/// network), suitable for both the CLI entry and unit tests.
pub fn run_checks() -> DoctorReport {
    let working_dir = resolve_working_dir();
    let user_workspace = resolve_user_workspace();

    let mut results = Vec::new();

    // Required binaries — YiYi will fail to do core work without these.
    results.push(check_bin_required("python3", "run_python / script tools"));
    results.push(check_bin_required("node", "frontend build (dev mode)"));
    results.push(check_bin_required("git", "shadow-git checkpoints"));

    // Optional binaries — degrade gracefully without these.
    results.push(check_bin_optional("rg", "faster grep_search (falls back to grep)"));
    results.push(check_bin_optional("uv", "faster Python deps for skills"));
    results.push(check_bin_optional("ffmpeg", "voice / video skills"));

    // Storage paths.
    results.push(check_dir_writable("YiYi data dir", &working_dir, true));
    results.push(check_dir_writable("user workspace", &user_workspace, true));

    // Database — can be missing on a fresh install (warn, not fail).
    results.push(check_database(&working_dir));

    // Persona templates.
    results.push(check_persona_templates(&working_dir));

    DoctorReport { results }
}

/// Format a report to stdout. Returns the exit code (number of fails).
pub fn print_report(report: &DoctorReport) -> i32 {
    println!("yiyi doctor — environment self-check\n");
    for r in &report.results {
        let glyph = r.status.glyph();
        match &r.status {
            CheckStatus::Ok { detail } => {
                println!("  {} {}  ({})", glyph, r.label, detail);
            }
            CheckStatus::Warn { hint } => {
                println!("  {} {}", glyph, r.label);
                println!("      hint: {}", hint);
            }
            CheckStatus::Fail { hint } => {
                println!("  {} {}", glyph, r.label);
                println!("      fix : {}", hint);
            }
        }
    }
    let fails = report.num_fails();
    let warns = report.num_warns();
    let oks = report.num_oks();
    println!(
        "\nsummary: {} ok, {} warn, {} fail (exit code = fail count)",
        oks, warns, fails
    );
    fails as i32
}

/// CLI entry. Called from `main.rs` when argv[1] == "doctor".
pub fn run() -> i32 {
    let report = run_checks();
    print_report(&report)
}

// ── tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn check_bin_required_finds_sh_on_unix() {
        #[cfg(unix)]
        {
            let r = check_bin_required("sh", "POSIX shell");
            assert!(matches!(r.status, CheckStatus::Ok { .. }));
        }
        #[cfg(windows)]
        {
            let r = check_bin_required("cmd", "Windows shell");
            assert!(matches!(r.status, CheckStatus::Ok { .. }));
        }
    }

    #[test]
    fn check_bin_required_fails_for_unknown_binary() {
        let r = check_bin_required("definitely-not-a-real-binary-xyz123", "fake");
        assert!(matches!(r.status, CheckStatus::Fail { .. }));
    }

    #[test]
    fn check_bin_optional_warns_for_unknown_binary() {
        let r = check_bin_optional("definitely-not-a-real-binary-xyz123", "fake");
        // Optional missing → Warn, NOT Fail (so it doesn't bump exit code).
        assert!(matches!(r.status, CheckStatus::Warn { .. }));
    }

    #[test]
    fn check_dir_writable_passes_for_existing_writable_tempdir() {
        let dir = TempDir::new().unwrap();
        let r = check_dir_writable("test", dir.path(), true);
        assert!(matches!(r.status, CheckStatus::Ok { .. }));
    }

    #[test]
    fn check_dir_writable_fails_for_missing_required_dir() {
        let missing = std::env::temp_dir().join(format!("yiyi_doctor_missing_{}", uuid::Uuid::new_v4()));
        let r = check_dir_writable("test", &missing, true);
        assert!(matches!(r.status, CheckStatus::Fail { .. }));
    }

    #[test]
    fn check_dir_writable_warns_for_missing_optional_dir() {
        let missing = std::env::temp_dir().join(format!("yiyi_doctor_missing_{}", uuid::Uuid::new_v4()));
        let r = check_dir_writable("test", &missing, false);
        // Missing + optional → Warn so the exit code stays clean.
        assert!(matches!(r.status, CheckStatus::Warn { .. }));
    }

    #[test]
    fn check_database_warns_when_db_missing() {
        let dir = TempDir::new().unwrap();
        let r = check_database(dir.path());
        // Fresh dir, no DB yet — that's a normal first-run state, not a failure.
        assert!(matches!(r.status, CheckStatus::Warn { .. }));
    }

    #[test]
    fn check_database_passes_when_db_is_valid_sqlite() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("yiyi.db");
        // Open + close a SQLite file at the expected path.
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute("CREATE TABLE probe (id INTEGER)", []).unwrap();
        drop(conn);

        let r = check_database(dir.path());
        assert!(matches!(r.status, CheckStatus::Ok { .. }),
            "expected Ok, got {:?}", r.status);
    }

    #[test]
    fn check_persona_templates_warns_when_neither_present() {
        let dir = TempDir::new().unwrap();
        let r = check_persona_templates(dir.path());
        assert!(matches!(r.status, CheckStatus::Warn { .. }));
    }

    #[test]
    fn check_persona_templates_ok_when_both_present() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "x").unwrap();
        std::fs::write(dir.path().join("SOUL.md"), "y").unwrap();
        let r = check_persona_templates(dir.path());
        assert!(matches!(r.status, CheckStatus::Ok { .. }));
    }

    #[test]
    fn run_checks_returns_results_with_known_categories() {
        let report = run_checks();
        assert!(!report.results.is_empty(), "doctor must produce results");
        // Sanity: sums match the population.
        assert_eq!(
            report.num_oks() + report.num_warns() + report.num_fails(),
            report.results.len(),
        );
    }

    #[test]
    fn doctor_report_glyph_per_status() {
        let ok = CheckStatus::Ok { detail: "".into() };
        let warn = CheckStatus::Warn { hint: "".into() };
        let fail = CheckStatus::Fail { hint: "".into() };
        assert_eq!(ok.glyph(), "✓");
        assert_eq!(warn.glyph(), "!");
        assert_eq!(fail.glyph(), "✗");
    }
}
