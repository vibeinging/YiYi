//! Hardline blocklist — patterns that destroy data / hardware / the
//! whole machine irrecoverably. Detected at the raw-string level (before
//! tokenisation) so quoted-flag tricks and whitespace variants can't slip
//! through.
//!
//! **This layer is never bypassable.** Not by session blanket "approve all",
//! not by yolo mode, not by the user accidentally clicking through a
//! dialog. If they really need to run one of these, they open their own
//! terminal — YiYi refuses on principle.
//!
//! Everything here is a *string* matcher; the structural classifier in
//! `classify.rs` runs on top of this and produces `Block` / `Warn`
//! verdicts that ARE user-overridable.

use regex::Regex;
use std::sync::LazyLock;

/// Common command prefix: separator + optional sudo / env / wrappers,
/// followed by the command name. Used to anchor hardline patterns at
/// command-start positions so `echo "reboot"` (reboot as arg) doesn't
/// false-positive but `ls; reboot` (reboot as new command) does.
///
/// Boundary chars: start-of-string, `;`, `&`, `|`, newline, backtick,
/// `$(`. NOT `(` alone (would match `()` in regex groups; rare in shell
/// outside `$(...)`). NOT `<` `>` `=` (rare command boundaries) — there
/// because they're rarely meaningful as text content, and `\b` is cheaper.
const CMD_PREFIX: &str = concat!(
    r"(?:^|[;&|\n`]|\$\()",                  // start or separator
    r"\s*",
    r"(?:sudo\s+(?:-\S+\s+)*)?",             // optional sudo + flags
    r"(?:env\s+(?:\w+=\S*\s+)*)?",           // optional env VAR=VAL...
    r"(?:(?:exec|nohup|setsid|time)\s+)*",   // optional wrappers
    r"\s*",
);

static HARDLINE_PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    let pat = |s: &str| Regex::new(s).expect("hardline regex");
    vec![
        // rm -rf / / /* / ~  (recursive delete of root or home).
        // Flag token allows: bare `-rf` / long `--recursive` / quoted
        // `"-rf"` / quoted `'--no-preserve-root'`. Quoted variants are
        // a known bypass — the shell strips quotes before `rm` sees
        // them, but our string-level regex doesn't, so without the
        // explicit quoted alternative the pattern misses.
        (
            pat(r#"(?i)\brm\s+(?:(?:-\S*|"-[^"]*"|'-[^']*')\s+)*(?:--no-preserve-root\s+)?(/|/\*|~)(\s|$)"#),
            "recursive delete of root/home filesystem",
        ),
        // rm -rf into protected system directories. Same quoted-flag
        // bypass coverage.
        (
            pat(r#"(?i)\brm\s+(?:(?:-\S*|"-[^"]*"|'-[^']*')\s+)*(/home|/root|/etc|/usr|/var|/bin|/sbin|/boot|/lib)(/?\*?)(\s|$)"#),
            "recursive delete of system directory",
        ),
        // mkfs.<type> (any filesystem format)
        (pat(r"(?i)\bmkfs(\.[a-z0-9]+)?\b"), "format filesystem (mkfs)"),
        // dd of=/dev/sd* /dev/nvme* — raw block-device overwrite
        (
            pat(r"(?i)\bdd\b[^\n]*\bof=/dev/(sd|nvme|hd|mmcblk|vd|xvd|disk|rdisk)[a-z0-9]*"),
            "dd to raw block device",
        ),
        // > /dev/sd* — shell redirection to raw block device
        (
            pat(r"(?i)>\s*/dev/(sd|nvme|hd|mmcblk|vd|xvd|disk|rdisk)[a-z0-9]*\b"),
            "redirect to raw block device",
        ),
        // Fork bomb (classic and tolerant of whitespace variants)
        (
            pat(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"),
            "fork bomb",
        ),
        // `kill -1` / `kill -9 -1` — kills every process incl PID 1
        (
            pat(r"(?i)\bkill\s+(?:-\S+\s+)*-1\b"),
            "kill all processes (kill -1)",
        ),
        // System shutdown / reboot — must anchor at command-start position
        (
            pat(&format!(r"(?i){}(shutdown|reboot|halt|poweroff)\b", CMD_PREFIX)),
            "system shutdown/reboot",
        ),
        (
            pat(&format!(r"(?i){}init\s+[06]\b", CMD_PREFIX)),
            "init 0/6 (shutdown/reboot)",
        ),
        (
            pat(&format!(r"(?i){}systemctl\s+(poweroff|reboot|halt|kexec)\b", CMD_PREFIX)),
            "systemctl poweroff/reboot",
        ),
        (
            pat(&format!(r"(?i){}telinit\s+[06]\b", CMD_PREFIX)),
            "telinit 0/6 (shutdown/reboot)",
        ),
    ]
});

/// Detect if a command matches the unconditional hardline blocklist.
///
/// Returns `Some(label)` describing the match, or `None` if safe. The label
/// is used in error messages and logs.
///
/// **Important**: this is NEVER allowed to be bypassed — see
/// [`super::SecurityVerdict::Hardline`] and
/// `permission_gate::request_permission`.
pub fn detect_hardline(command: &str) -> Option<&'static str> {
    for (re, label) in HARDLINE_PATTERNS.iter() {
        if re.is_match(command) {
            return Some(label);
        }
    }
    None
}
