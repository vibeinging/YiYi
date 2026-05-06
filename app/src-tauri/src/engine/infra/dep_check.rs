//! Lazy-install dependency checking.
//!
//! Used by the MCP startup loop (and, in the future, by tool dispatch) to
//! detect missing binaries before spawning a subprocess. When a required
//! bin is absent we surface a structured `MissingDeps` payload to the
//! frontend instead of letting the spawn fail with an opaque OS error.

use crate::state::config::DepSpec;

/// Check whether a binary is reachable on PATH (and on macOS, in the
/// common GUI-launched-app extra paths).
pub fn check_bin(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }

    // Use `which` on Unix, `where` on Windows. Either tool prints the full
    // path on stdout when found and returns 0; non-zero on miss.
    #[cfg(unix)]
    let probe = "which";
    #[cfg(windows)]
    let probe = "where";

    let output = std::process::Command::new(probe).arg(name).output();
    if let Ok(o) = output {
        if o.status.success() && !o.stdout.is_empty() {
            return true;
        }
    }

    // GUI-launched apps on macOS sometimes inherit a stripped PATH that
    // omits Homebrew / Volta / nvm dirs. Probe a small set of known
    // locations so we don't false-negative when the user clearly has the
    // tool installed.
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let candidates: [String; 5] = [
            format!("/opt/homebrew/bin/{name}"),    // Apple Silicon brew
            format!("/usr/local/bin/{name}"),        // Intel brew
            format!("/usr/bin/{name}"),
            format!("{home}/.volta/bin/{name}"),
            format!("{home}/.nvm/current/bin/{name}"),
        ];
        for path in &candidates {
            if std::path::Path::new(path).exists() {
                return true;
            }
        }
    }

    false
}

/// Return the subset of `deps` whose `bin` is not on PATH.
/// Returns owned clones because the caller usually needs to ship them
/// across an event channel to the frontend.
pub fn missing_deps(deps: &[DepSpec]) -> Vec<DepSpec> {
    deps.iter()
        .filter(|d| !check_bin(&d.bin))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_bin_finds_a_real_system_tool() {
        // `sh` (Unix) / `cmd` (Windows) is essentially guaranteed to exist.
        #[cfg(unix)]
        assert!(check_bin("sh"));
        #[cfg(windows)]
        assert!(check_bin("cmd"));
    }

    #[test]
    fn check_bin_rejects_empty_and_missing() {
        assert!(!check_bin(""));
        assert!(!check_bin("definitely-not-a-real-binary-xyz123"));
    }

    #[test]
    fn missing_deps_filters_correctly() {
        let deps = vec![
            DepSpec {
                bin: "sh".to_string(),
                display_name: "POSIX shell".to_string(),
                ..Default::default()
            },
            DepSpec {
                bin: "definitely-not-a-real-binary-xyz123".to_string(),
                display_name: "Fake".to_string(),
                ..Default::default()
            },
        ];
        let missing = missing_deps(&deps);
        // Skip on platforms where `sh` isn't standard.
        #[cfg(unix)]
        {
            assert_eq!(missing.len(), 1);
            assert_eq!(missing[0].display_name, "Fake");
        }
        #[cfg(windows)]
        {
            // Both probably miss on Windows; just assert the fake one is in there.
            assert!(missing.iter().any(|d| d.display_name == "Fake"));
        }
    }
}
