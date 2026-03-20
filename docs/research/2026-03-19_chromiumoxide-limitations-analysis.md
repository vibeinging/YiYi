# chromiumoxide Crate: Limitations & Known Issues Research

> Date: 2026-03-19
> Crate: https://crates.io/crates/chromiumoxide
> Repo: https://github.com/mattsse/chromiumoxide
> Version at time of research: 0.9.1 (released 2026-02-25)

---

## 1. Crate Stats (crates.io)

| Metric | Value |
|--------|-------|
| Total downloads | ~1.49M |
| Recent downloads (90 days) | ~888K |
| Current version | 0.9.1 |
| Versions released | 20 |
| First published | 2020-12-13 |
| Last update | 2026-02-25 |
| GitHub stars | ~1,208 |
| Open issues | 41 |
| Forks | 162 |
| **Still pre-1.0** | Yes - no stability guarantees |

### Version release cadence (recent):
- 0.9.1 — 2026-02-25
- 0.9.0 — 2026-02-20
- 0.8.0 — 2025-11-28
- 0.7.0 — 2024-08-12
- 0.6.0 — 2024-05-28

Gaps of 3-8 months between releases are common. Most downloads (~631K) are concentrated on v0.8.0.

---

## 2. Hanging / Deadlock Issues (Critical)

This is the **single biggest pain point** across multiple open issues:

- **#293** — `Hangs when clearing cookies` (2026-01, 0 comments, no fix)
- **#292** — `page.find_element hangs on invisible element` (2026-01, 0 comments)
- **#228** — `iframes sometimes stop page from loading (again)` — timeout config is **ignored** (hardcoded 30s); pages with iframes (e.g. MDN) hang indefinitely. This is a re-opened regression from a prior fix (#163/#174).
- **#191** — `Page.goto hangs on some websites while browser.new_page works` (2023-11, 0 comments, never resolved)
- **#125** — `Goto never returns if first request is aborted` — intercepting + aborting the first request causes goto to hang permanently, even with request timeout set. (2023-01, 0 comments)

**Pattern**: Navigation/element operations can hang indefinitely. The timeout system is unreliable — hardcoded 30s in places, and user-configured timeouts are sometimes ignored.

---

## 3. Timeout Configuration is Broken / Missing

- **#175** — `Unable to configure timeout on commands` (2023-09, 3 comments) — The library has a **hardcoded 30-second timeout** that cannot be overridden via the public API. Users must fork to change it.
- **#228** confirms that `launch_timeout` and `request_timeout` in BrowserConfig are ignored in some code paths — the 30s hardcoded value wins.

---

## 4. Non-English Locale Issues

- The library parses Chromium's stderr to find the debugging port. This parsing is **English-only**.
- If your OS locale causes Chromium to output non-English text, the library **times out** on launch.
- Chinese text input also causes errors (Rust forum report).

---

## 5. iframe Handling

- **#228** — iframes can prevent pages from loading entirely. Known regression.
- **#280** — `Interact with cross-origin iframe` — no support, marked "help wanted".
- **#296** — `Add method to Page to retrieve Element by some ID (for interacting with iframes)` — feature request, unresolved.

---

## 6. API Design Issues

- **#259** — `BrowserConfigBuilder.build()` returns `Result<BrowserConfig, String>` — the `String` error type does NOT implement `std::error::Error`, making it incompatible with `anyhow`, `eyre`, and `?` operator in standard error-handling patterns. A breaking change is needed to fix this.
- **#306** — Regression from 0.8 to 0.9 in argument parsing (single-string args broken).
- **#308** — `screenshot()` calls `activate()` which steals window focus on every capture — problematic for non-headless usage.

---

## 7. Missing Features

| Feature | Issue | Status |
|---------|-------|--------|
| Configurable command timeout | #175 | Open since 2023-09 |
| Cross-origin iframe interaction | #280 | Help wanted |
| `page.select` (dropdown selection) | #234 | Help wanted |
| Network request interception docs | #157 | Open since 2023-07 |
| Raw response bytes | #212 | No response |
| Redirect chain access | #202 | No response |
| Remote debugging pipe | #294 | Feature request |
| Linux aarch64 fetcher | #238 | Blocked — no official Chrome ARM64 Linux builds |
| CBOR serialization | #226 | Feature request |
| Human-like scrolling/mouse | #291 | Blocked |
| Clone for ScreenshotParams | #253/#304 | PR open |
| SIGINT handling (browser killed) | #251 | Help wanted |

---

## 8. Chrome/Chromium Dependency

- **Does NOT bundle Chrome** — requires an installed Chromium/Chrome instance.
- Optional `fetcher` feature can download Chromium, but:
  - Only supports some platforms (NOT linux-aarch64, issue #238)
  - Requires additional feature flags (`rustls`/`native-tls` + `zip0`/`zip8`)
  - Downloads are platform-specific and may break with Chrome version changes
- Browser discovery is via path search; non-standard install locations require manual config.
- **English locale required** for the launch process to work.

---

## 9. Compilation Impact

- The CDP code generator produces ~60K lines of Rust code (before proc macro expansion).
- This significantly increases compile times, especially on first build.
- Experimental types can't be disabled due to a codegen bug (PDL files reference experimental types that aren't marked as experimental).
- Feature flags described as "somewhat messy" in the README itself, pending a Cargo bug fix.

---

## 10. Cross-Platform Issues

| Platform | Issue |
|----------|-------|
| macOS | iframe hanging confirmed on macOS Sonoma (#228) |
| Linux aarch64 | Fetcher returns `UnsupportedOs` error (#238) |
| Non-English OS | Launch timeout due to English-only stderr parsing |
| All platforms | `screenshot()` steals focus (#308) |

---

## 11. Why People Forked It

### spider_chrome (by spider-rs)
- **899K downloads**, last updated 2025-10-20
- Reasons: keep CDP up-to-date, bug fixes, improved emulation, adblocking, firewalls, performance, high-concurrency CDP
- Aggressively versioned (v2.37.129) vs chromiumoxide's 0.9.1

### chaser-oxide
- Fork focused on **anti-detection/stealth** — protocol-level stealth patches, fingerprint consistency, human-like mouse/keyboard simulation
- chromiumoxide has zero built-in stealth capabilities; automation is trivially detectable

### chromiumoxide_fork (crates.io)
- 13K downloads, last updated 2023-09 — appears abandoned
- Was likely created during a period of slow upstream maintenance

### caido/dependency-chromiumoxide
- Private fork by Caido (security tool), tracking upstream closely (last push 2026-02-25)
- Likely needed custom patches for their use case

**Common fork motivation**: upstream moves too slowly, missing features, need bug fixes faster than upstream merges them.

---

## 12. Maintenance Assessment

**Positive signals:**
- Maintainer (mattsse, also known for Foundry/Alloy in the Ethereum ecosystem) is still active
- Recent releases (0.9.0 and 0.9.1 in Feb 2026)
- Issues are labeled and organized
- CDP protocol definitions are regularly bumped

**Negative signals:**
- Many bugs open for 1-3 years with zero comments (#191, #125, #72, #14)
- "Help wanted" on core features like dropdown selection, SIGINT handling
- Hanging bugs (#228, #293, #292) are show-stoppers with no fix timeline
- PRs from contributors sit open (6 open PRs currently)
- Regression introduced in 0.9.0 (#306) suggests limited test coverage for edge cases
- No documentation site; docs.rs is the only reference

---

## 13. Tokio Lock-in

- **Only supports tokio** runtime (stated in README)
- No async-std or smol support
- Uses `futures` crate channels internally

---

## 14. Production Readiness Summary

| Aspect | Rating | Notes |
|--------|--------|-------|
| API completeness | Medium | Core CDP works; many convenience methods missing |
| Stability | Low-Medium | Hanging bugs are real and unresolved |
| Error handling | Poor | String errors in config builder, hardcoded timeouts |
| Documentation | Poor | No guide, no examples beyond README |
| Maintenance | Medium | Active but slow; many stale issues |
| Cross-platform | Medium | Works on major platforms but aarch64 and non-English broken |
| Production battle-tested | Medium | Used by spider-rs (high traffic) but they had to fork it |

---

## 15. Alternatives Comparison

| Crate | Protocol | Async | Browsers | Maintenance | Notes |
|-------|----------|-------|----------|-------------|-------|
| **chromiumoxide** | CDP | Yes (tokio) | Chrome only | Active-ish | Most complete CDP in Rust |
| **headless_chrome** | CDP | No (sync) | Chrome only | Sporadic | Simpler API, sync only |
| **fantoccini** | WebDriver | Yes (tokio) | All browsers | Active | More mature, no CDP-specific features |
| **thirtyfour** | WebDriver | Yes (tokio) | All browsers | Active | Selenium-like, good docs |
| **playwright (via wrappers)** | CDP+more | Varies | All browsers | N/A | Not native Rust |

---

## Key Takeaways for Adoption Decision

1. **The hanging problem is real and unsolved** — if your use case involves arbitrary web pages (especially with iframes), expect intermittent hangs with no reliable timeout escape hatch.
2. **Not production-hardened** without modifications — spider-rs, the biggest user, forked it entirely.
3. **Good for controlled environments** where you know the target pages and can work around edge cases.
4. **The API is incomplete but extensible** — `Page::execute` lets you send raw CDP commands.
5. **Compile times are painful** — 60K+ lines of generated code.
6. **If you need stealth/anti-detection**, you need a fork like chaser-oxide.
7. **If you need cross-browser support**, use fantoccini or thirtyfour instead.
