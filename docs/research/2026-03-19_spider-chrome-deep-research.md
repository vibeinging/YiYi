# spider_chrome / chromey Deep Research

**Date**: 2026-03-19
**Purpose**: Evaluate spider_chrome as a replacement for chromiumoxide in YiYi browser automation

---

## 1. What It Is

**spider_chrome** (now renamed to **chromey** on crates.io) is a fork of [chromiumoxide](https://github.com/mattsse/chromiumoxide) maintained by [Jeff Mendez](https://github.com/j-mendez) and the [spider-rs](https://github.com/spider-rs) organization.

It is a concurrent, high-level async Rust API for controlling Chrome or Firefox over the Chrome DevTools Protocol (CDP). The fork focuses on:

- Keeping CDP protocol definitions up to date
- Applying bug fixes (especially around hangs and timeouts)
- Adding emulation, adblocking, firewall features
- Improving performance for high-concurrency scenarios
- Integrating browser fingerprint spoofing (via `spider_fingerprint` crate)

The crate was extracted from the main `spider` web crawler project into its own repository at https://github.com/spider-rs/spider_chrome (the repo is titled "chromey" on GitHub).

### Naming Confusion

- **GitHub repo**: `spider-rs/spider_chrome` (displayed as "chromey")
- **crates.io**: Published as both `spider_chrome` (older, v2.37.x) and `chromey` (newer, v2.42.x as of March 2026)
- `chromey` appears to be the canonical going-forward name
- The repo was "moved over from spider causing the commits to reset"

---

## 2. GitHub Repository Stats

| Metric | Value |
|--------|-------|
| **Stars** | 41 |
| **Forks** | 10 |
| **Open Issues** | 1 (bug in `page.set_content`) |
| **License** | MIT OR Apache-2.0 |
| **Created** | June 7, 2025 |
| **Latest Commit** | March 18, 2026 (very active) |
| **Contributors** | 3+ (Jeff Mendez + external contributors) |
| **PRs Merged** | 3 external PRs, all merged quickly |

For comparison, the original chromiumoxide has 35 open issues, many about hanging, iframes, and timeouts.

---

## 3. Crates.io / Lib.rs Stats

### chromey (current name)
- **Version**: 2.42.2 (March 18, 2026)
- **Downloads**: ~230,480/month, ~97,174/week
- **Total stable releases**: 140+
- **Used by**: 5 crates directly

### spider_chrome (older name)
- **Version**: 2.37.129 (October 20, 2025)
- **Downloads**: ~121,455/month
- **Total releases**: 738 stable releases
- **Ranked**: #84 in Testing category on lib.rs

The download numbers are significant -- this is not a toy project. The spider ecosystem depends on it for production web crawling.

---

## 4. Fixed Issues from chromiumoxide

### Timeout System -- FIXED
chromiumoxide Issue #52: `request_timeout` from `BrowserConfigBuilder` was never honored. The default 30s timeout was used for target init commands instead of the configured value, and timed-out requests weren't handled, causing infinite hangs.

**In chromey**: PR #9 (March 2026) explicitly "propagates custom timeout to CDP commands and navigation." This was a known pain point that chromey has actively addressed.

### Browser::new_page() Hang -- FIXED
chromiumoxide Issue #49 and related: `new_page()` could hang indefinitely.

**In chromey**: PR #8 (March 2026) fixed a critical hang where `Browser::new_page("about:blank")` would hang during fresh browser startup. Root cause: timing issue in CDP event correlation -- Chrome created the tab but chromey never finished wiring up the session state. Fix: seed session state immediately from `Target.attachToTarget` response rather than waiting for the `attachedToTarget` event.

### Process Management
chromiumoxide had issues with Chrome processes not exiting, zombie processes, and SIGINT killing browser instances.

**In chromey**: The spider-rs team operates a production web crawling service (spider.cloud) that manages thousands of browser instances. Process lifecycle management has been hardened for this use case.

### iframe Support -- UNCLEAR / LIKELY INHERITED
chromiumoxide has multiple open issues (#296, #280, #228) about iframe interaction, especially cross-origin iframes. No specific evidence that chromey has fixed these -- the issues likely persist since they're CDP-level limitations.

### Non-English Locale -- NO SPECIFIC FIX FOUND
No evidence of specific CJK/locale fixes in chromey. However, the `spider_fingerprint` crate does support locale emulation as part of its fingerprint spoofing.

---

## 5. API Differences

**chromey is largely a drop-in replacement for chromiumoxide.** The README states it "kept the API the same" since it was forked. Key API patterns are identical:

```rust
// Launch browser (same pattern as chromiumoxide)
let (mut browser, mut handler) =
    Browser::launch(BrowserConfig::builder().with_head().build()?).await?;

// Same element interaction API
let search_bar = page.find_element("input#searchInput").await?;
search_bar.click().await?.type_str("some query").await?;

// Same PDF generation
page.pdf(PrintToPdfParams::default()).await?;

// Same extensibility via Page::execute()
page.execute(SomeCustomCdpCommand::new()).await?;
```

### Additional Features in chromey (not in chromiumoxide)
- `spider_fingerprint` integration for stealth/emulation
- `spider_network_blocker` for ad blocking
- `spider_firewall` for request filtering
- Remote caching via `hybrid_cache_server`
- Configurable WebSocket channel capacity (v2.42.0)
- Batched WebSocket sends for performance (v2.42.2)
- Brave browser auto-detection (PR #6)

### Module Naming
Internal modules still reference `chromiumoxide_cdp` namespacing (e.g., `chromiumoxide_cdp::cdp::browser_protocol::page`), which may require some import path adjustments depending on how it's re-exported.

---

## 6. Production Usage

### spider.cloud (Primary Production User)
Spider is a commercial web crawling/scraping API that uses chromey as its browser engine. Claims:
- Processes 100k+ pages in minutes
- ~7x throughput of Firecrawl, ~9.5x of Crawl4AI for static pages
- 99.9% success rate, 99.9% uptime
- ~4ms command latency with zero cold start
- Up to 100 concurrent sessions
- Anti-bot stealth, CAPTCHA solving, proxy rotation

The fact that spider.cloud runs this at scale and charges money for it provides strong evidence of production reliability.

### headless-browser Crate
The spider-rs org also maintains `headless-browser` for managing Chrome instances in cloud environments (Fargate, CloudRun, K8s), which wraps chromey.

---

## 7. Known Issues and Limitations

### Open Issue
- **#4**: Bug in `page.set_content` -- results in error "-32602: Either objectId or executionContextId or uniqueContextId must be specified" (open since Nov 2025, not yet fixed)

### Inherited from chromiumoxide
- iframe interaction (especially cross-origin) is likely still limited
- The generated CDP code is ~60K lines, making the crate heavy to compile
- No specific evidence of improved error types (chromiumoxide uses string errors)

### Low Star Count
41 stars is very low compared to chromiumoxide's ~800+. This means:
- Smaller community for help
- Fewer eyes finding bugs
- Less ecosystem visibility

### Naming Confusion
The spider_chrome -> chromey rename, plus the repo being at `spider-rs/spider_chrome` but displaying as "chromey", creates confusion about which crate to depend on.

---

## 8. Community and Support

- **Maintainer responsiveness**: Good. Jeff Mendez merges external PRs quickly (same-day for PRs #8 and #9).
- **External contributions**: 3 merged PRs from 3 different external contributors, all accepted.
- **Issue response**: Only 1 open issue (has been open since Nov 2025 without resolution though).
- **Communication**: No Discord/Matrix channel found specific to chromey. Community activity happens through GitHub issues/PRs and the broader spider-rs ecosystem.

---

## 9. Documentation Quality

### docs.rs
The docs.rs page for `spider_chrome` returns 404. The `chromey` docs may be available but weren't verified.

### README
The README provides:
- Basic usage example (Wikipedia search automation)
- Feature flags documentation
- Browser fetcher instructions
- CDP code generation architecture explanation
- References to `vanilla.aslushnikov.com` for browsing CDP types

### What's Missing
- No migration guide from chromiumoxide
- No comprehensive API guide beyond the README example
- No cookbook/recipes for common tasks
- `spider_fingerprint` documentation is good (95% coverage) but chromey's own docs are sparse

---

## 10. Anti-Detection / Stealth

This is a **significant differentiator** over chromiumoxide. chromey integrates with `spider_fingerprint` (v2.38.1), which provides:

### Fingerprint Spoofing
- **User Agent** spoofing
- **HTTP Headers** emulation via `emulate_headers()`
- **WebGL/GPU** spoofing (WIP)
- **navigator.userAgentData** high entropy value support
- **Plugin and mimeType** spoofing
- **Mouse and viewport** spoofing (optional)
- **Hardware concurrency** (CPU core count) spoofing
- **Platform-specific variants** (macOS, Windows, Linux)

### Tiered Spoofing
Supports levels from basic to full spoofing, with `build_stealth_script()` generating injectable JavaScript.

### Stealth Script Injection
`spider_fingerprint` generates JavaScript that gets injected into pages to spoof `navigator.webdriver`, canvas fingerprint, WebGL metadata, and other detection vectors.

chromiumoxide has **zero** stealth features by comparison.

---

## 11. Chrome Management

### Discovery
- By default, tries to find an installed Chrome/Chromium on the system
- PR #6 added **Brave browser** auto-detection
- Standard approach: checks common installation paths per-platform

### Auto-Download (Fetcher)
Optional feature flags enable automatic Chromium download:
- `_fetcher-rusttls-tokio` -- fetcher using rustls
- `_fetcher-native-tokio` -- fetcher using native TLS

### headless-browser Companion
The `headless-browser` crate provides production Chrome management for cloud environments with proxy and server support built in.

---

## 12. Cross-Platform Support

| Platform | Status |
|----------|--------|
| **macOS (x86_64)** | Supported |
| **macOS (aarch64/M1+)** | Supported |
| **Linux (x86_64)** | Supported |
| **Linux (aarch64)** | Supported (chromiumoxide had issue #238 about this) |
| **Windows** | Supported |

The `spider_fingerprint` crate explicitly supports platform-specific variants for macOS, Windows, and Linux on both ARM and x86 architectures.

---

## 13. Interactive Automation Capabilities

chromey supports the same interactive automation as chromiumoxide:

| Capability | Supported | Notes |
|-----------|-----------|-------|
| **Navigate to URL** | Yes | `page.goto("url")` |
| **Find elements** | Yes | `page.find_element("selector")` |
| **Click elements** | Yes | `element.click()` |
| **Type text** | Yes | `element.type_str("text")` |
| **Keyboard input** | Yes | Key press simulation |
| **Take screenshots** | Yes | `page.screenshot()` |
| **Generate PDFs** | Yes | `page.pdf()` |
| **Execute JavaScript** | Yes | Via `Page::execute()` with CDP commands |
| **Get page content** | Yes | `page.content()` |
| **DOM manipulation** | Yes | Via CDP commands |
| **Network interception** | Yes | Via CDP Network domain |
| **Custom CDP commands** | Yes | `Page::execute()` accepts any Command type |
| **iframe interaction** | Limited | Inherited limitation from chromiumoxide |

The API is oriented toward automation, not just crawling. The Wikipedia search example in the README demonstrates interactive form filling and navigation.

---

## Assessment Summary

### Pros
1. **Actively maintained** -- commits as recent as March 18, 2026, with performance optimizations
2. **Production-proven** -- powers spider.cloud commercial crawling service at scale
3. **Drop-in replacement** -- API-compatible with chromiumoxide
4. **Stealth features** -- `spider_fingerprint` integration is a major advantage
5. **Fixes critical bugs** -- timeout propagation and new_page() hang both fixed
6. **Ad blocking / firewall** -- built-in via companion crates
7. **External PRs accepted** -- responsive maintainer
8. **Cross-platform** -- macOS, Windows, Linux, ARM and x86

### Cons
1. **Small community** -- 41 stars, limited visibility
2. **Naming confusion** -- spider_chrome vs chromey, unclear migration path
3. **Documentation sparse** -- README-only, no comprehensive guides
4. **iframe support still limited** -- inherited from chromiumoxide
5. **set_content bug** -- open since Nov 2025
6. **Heavy compilation** -- ~60K generated lines of CDP code
7. **Single key maintainer** -- bus factor risk (Jeff Mendez)
8. **docs.rs 404** -- documentation not readily accessible online

### Recommendation for YiYi

chromey/spider_chrome is a **strong candidate** to replace chromiumoxide for browser automation. The key advantages are:
- Critical hang/timeout fixes that we've been hitting
- Stealth features important for real-world browsing
- Same API means minimal migration effort
- Production-proven at scale

The main risks are the small community size and single-maintainer dependency, but these are mitigated by the fact that spider.cloud depends on it commercially.

**Suggested crate**: `chromey` (the newer name, v2.42.x) rather than `spider_chrome` (older, v2.37.x).

---

## Sources

- [GitHub: spider-rs/spider_chrome (chromey)](https://github.com/spider-rs/spider_chrome)
- [crates.io: spider_chrome](https://crates.io/crates/spider_chrome)
- [crates.io: chromey](https://crates.io/crates/chromey/2.37.135)
- [lib.rs: spider_chrome](https://lib.rs/crates/spider_chrome)
- [lib.rs: chromey](https://lib.rs/crates/chromey)
- [GitHub: mattsse/chromiumoxide](https://github.com/mattsse/chromiumoxide)
- [chromiumoxide Issue #52: Timeout not working](https://github.com/mattsse/chromiumoxide/issues/52)
- [chromiumoxide Issue #49: Chrome stays idle](https://github.com/mattsse/chromiumoxide/issues/49)
- [chromey PR #8: Fix new_page() hang](https://github.com/spider-rs/spider_chrome/pull/8)
- [chromey PR #9: Timeout propagation](https://github.com/spider-rs/spider_chrome/pull/9)
- [spider_fingerprint docs](https://docs.rs/spider_fingerprint/latest/spider_fingerprint/)
- [spider_fingerprint GitHub](https://github.com/spider-rs/spider_fingerprint)
- [Spider Cloud Browser](https://spider.cloud/browser)
- [Spider Cloud](https://spider.cloud/)
- [spider-rs organization](https://github.com/spider-rs)
