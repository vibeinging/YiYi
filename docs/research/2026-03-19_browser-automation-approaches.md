# Browser Automation Approaches for Desktop AI Assistant (Rust/Tauri)

> Research date: 2026-03-19

## Executive Summary

For a Tauri desktop AI assistant that needs browser automation, the most practical approaches in 2026 are:

1. **Direct CDP via `chromiumoxide`** — best Rust-native option, mature, async, no external runtime needed
2. **Playwright MCP Server** — best for AI agent integration, uses accessibility tree, but requires Node.js
3. **Subprocess to `browser-use`** — most capable AI-browser integration, but requires Python runtime

The ecosystem is rapidly shifting toward **direct CDP** over Playwright abstractions, and toward **MCP protocol** for AI-agent-to-browser communication.

---

## 1. Chromium DevTools Protocol (CDP) — Rust Crates

### 1.1 chromiumoxide

- **Repo**: https://github.com/mattsse/chromiumoxide
- **Stars**: 1.2k | **Latest**: v0.9.1 (Feb 2026) | **Used by**: 846 projects
- **Status**: Actively maintained, 44 contributors

**How it works**:
- Connects to Chrome/Chromium via WebSocket using the DevTools Protocol
- Can launch a new browser instance or connect to an existing one via `--remote-debugging-port`
- Full async API on Tokio runtime
- Code-generated from Chrome's PDL files — supports ALL CDP types (~60K lines generated)
- Built-in browser fetcher can auto-download Chromium binaries

**Dependencies**: Only Rust. No Node.js, no Python. Needs Chrome/Chromium installed (or auto-downloads).

**Key capabilities**: Navigate, click, type, screenshot, PDF, execute JS, intercept network, cookie management, `Page::execute` for any raw CDP command.

**Forks worth noting**:
- `spider_chrome` — optimized for high-concurrency scraping
- `chaser-oxide` — stealth/anti-detection modifications
- `chromey` — kept up-to-date with latest CDP

**Suitability**: Excellent for Tauri. Pure Rust, async, no external runtimes. Can launch Chrome headless or connect to user's existing browser. Main limitation: high-level API doesn't cover every scenario, but raw CDP access fills gaps.

### 1.2 headless_chrome (rust-headless-chrome)

- **Repo**: https://github.com/rust-headless-chrome/rust-headless-chrome
- **Stars**: 2.9k | **Latest**: v1.0.21 (Feb 2026) | **Releases**: 27
- **Status**: Actively maintained

**How it works**:
- Synchronous API (plain threads, no async runtime)
- Equivalent of Puppeteer for Rust
- Auto-downloads Chromium binaries
- Uses CDP under the hood

**Dependencies**: Only Rust + Chrome/Chromium.

**Key capabilities**: Navigate, screenshot, PDF, network interception, JS coverage, incognito windows, extension preloading.

**Missing features**: Frame handling, file picker, touchscreen, WebSocket inspection, HTTP Basic Auth.

**Suitability**: Good but synchronous API is a drawback for Tauri (which uses async Tokio). Less flexible than chromiumoxide. Higher star count but fewer CDP types supported.

### 1.3 fantoccini

- **Repo**: https://github.com/jonhoo/fantoccini
- **Stars**: ~moderate | **Latest**: v0.14.x
- **Status**: Maintained

**How it works**:
- Uses **WebDriver protocol** (not CDP directly)
- Requires a WebDriver server (chromedriver, geckodriver, etc.) running separately
- Async API on Tokio
- CSS selector-driven interactions

**Dependencies**: Rust + a WebDriver binary + browser installed.

**Suitability**: Less ideal. Extra dependency on WebDriver server process. WebDriver is slower and less capable than direct CDP. However, supports Firefox/Safari in addition to Chrome.

### 1.4 thirtyfour

- **Repo**: https://github.com/vrtgs/thirtyfour
- **Status**: Actively maintained, weekly updates

**How it works**:
- Selenium/WebDriver client for Rust (W3C WebDriver v1 spec)
- From v0.29+, switched to fantoccini as backend
- Also has some CDP support

**Dependencies**: Rust + WebDriver server + browser.

**Suitability**: Similar to fantoccini. Better if you need Selenium ecosystem compatibility. The CDP support is partial.

---

## 2. Playwright

### 2.1 playwright-rust (Rust bindings)

- **Repo**: https://github.com/padamson/playwright-rust
- **Stars**: 51 | **Latest**: v0.8.1 (Jan 2026) | **Status**: ALPHA, not production-ready
- **Crate**: `playwright-rs`

**Architecture**:
- Rust API layer communicates via **JSON-RPC over stdio** to a Playwright Server (Node.js)
- Same architecture as playwright-python, playwright-java
- Requires **Node.js 18+** and **Rust 1.85+**
- Must install browsers separately: `npx playwright@1.56.1 install chromium firefox webkit`

**Dependencies**: Rust + Node.js 18+ + browser binaries installed via npx.

**Suitability**: Not recommended yet. Alpha quality, requires Node.js runtime, small community. The Node.js dependency is heavy for a Tauri app.

### 2.2 Playwright MCP Server

- **Repo**: https://github.com/microsoft/playwright-mcp
- **Status**: Production-ready, officially maintained by Microsoft
- **Released**: Early 2025, widely adopted by mid-2025

**How it works**:
- MCP (Model Context Protocol) server that exposes Playwright as tools
- Uses **accessibility tree snapshots** instead of screenshots (2-5KB structured data vs images)
- AI agents interact via roles, labels, attributes — no fragile CSS selectors
- 10-100x faster than vision-based approaches

**Dependencies**: Node.js + browser binaries.

**Suitability**: Excellent for AI agent use case. The MCP protocol means your Tauri app could spawn this as a subprocess and communicate via MCP. The accessibility-tree approach is ideal for LLM-driven automation. Drawback: Node.js dependency.

---

## 3. Browser Use (Python)

- **Repo**: https://github.com/browser-use/browser-use
- **Stars**: 81.3k | **Latest**: v0.12.2 (Mar 2026) | **Contributors**: 301
- **Status**: Very active, $17M+ seed funding

**Architecture (current, 2026)**:
- **Migrated from Playwright to direct CDP** in 2026 for performance
  - Eliminated Node.js relay server that Playwright required
  - Direct WebSocket connection to Chrome's CDP
  - Lower latency, better crash handling, cross-origin iframe support
- LLM agent loop: capture page state → send to LLM → LLM decides action → execute via CDP → repeat
- Supports visual understanding + HTML structure extraction
- Compatible with all major LLMs via LangChain (GPT-4, Claude, Gemini, etc.)

**Why they left Playwright**:
- Playwright added a Node.js WebSocket relay — extra network hop, latency on thousands of CDP calls
- State drift across 3 layers (browser, Node.js, Python client)
- Edge cases: full-page screenshots >16K px, dialog handling, tab crash detection

**Dependencies**: Python 3.11+ + Chromium (installable via `uvx browser-use install`).

**Key Chrome v136+ issue**: Default `--user-data-dir` profile no longer supports CDP remote debugging. Must use a non-default profile path.

**Suitability**: Most capable AI browser automation, but requires Python runtime. For Tauri integration, would need to spawn Python subprocess or embed Python. Could communicate via CDP URL sharing — browser-use returns a CDP WebSocket URL that Rust code could also connect to.

---

## 4. Tauri-Specific Approaches

### 4.1 Tauri MCP Plugins

Several MCP server implementations exist for Tauri:
- `tauri-plugin-mcp` — exposes Tauri app capabilities via MCP
- MCP servers for testing/debugging Tauri apps (DOM inspection, screenshot, JS execution)

These are primarily for **testing Tauri apps themselves**, not for controlling external browsers.

### 4.2 tauri-plugin-in-app-browser

- Opens URLs in an in-app browser view
- Not suitable for programmatic automation

### 4.3 WebDriver for Tauri (macOS)

- Custom WKWebView WebDriver bridge for testing Tauri apps
- macOS-specific, not for external browser control

**Bottom line**: There are no Tauri plugins specifically for automating external browsers. The Tauri ecosystem focuses on building apps, not controlling other apps' browsers.

---

## 5. Other Modern Approaches

### 5.1 Stagehand (Browserbase) — Rust SDK

- **Repo**: https://github.com/browserbase/stagehand-rust
- **Crate**: `stagehand_sdk` | **Status**: ALPHA
- **Main project**: https://github.com/browserbase/stagehand (10k+ stars)

**How it works**:
- AI-powered browser automation SDK
- v3 (2025) dropped Playwright, now CDP-native
- Natural language instructions for browser actions
- Returns CDP WebSocket URL for connecting external tools
- Primarily designed for **cloud browser sessions** (Browserbase infrastructure)

**Dependencies**: Requires Browserbase cloud account for full functionality.

**Suitability**: Interesting for cloud-hosted browser automation. Less suitable for local desktop use. The Rust SDK is alpha.

### 5.2 Agent Browser (Vercel)

- Rust-native CLI tool designed for AI coding agents
- Sub-millisecond startup
- Designed specifically for Claude Code and similar agents
- Uses CDP under the hood

### 5.3 Chrome DevTools MCP (Google)

- Official MCP server from Google's Chrome DevTools team (Sep 2025)
- Uses Puppeteer + CDP under the hood
- 29 tools: navigation, input, debugging, network inspection, Lighthouse audits
- Requires Node.js 22+

---

## Comparison Matrix

| Approach | Runtime Deps | Async | Maturity | AI-Optimized | Browser Required |
|---|---|---|---|---|---|
| **chromiumoxide** | None (Rust only) | Yes (Tokio) | Stable | No | Chrome/Chromium |
| **headless_chrome** | None (Rust only) | No (sync) | Stable | No | Chrome/Chromium |
| **fantoccini** | WebDriver binary | Yes (Tokio) | Stable | No | Any W3C browser |
| **playwright-rust** | Node.js 18+ | Yes (Tokio) | Alpha | No | Chromium/FF/WebKit |
| **Playwright MCP** | Node.js | N/A (MCP) | Production | Yes | Chromium/FF/WebKit |
| **browser-use** | Python 3.11+ | Yes (asyncio) | Production | Yes | Chromium |
| **Stagehand Rust** | Cloud API | Yes | Alpha | Yes | Cloud-hosted |

---

## Recommendation for YiYi

### Preferred Architecture: Hybrid CDP Approach

1. **Core browser control**: Use `chromiumoxide` in Rust backend
   - Zero external runtime dependencies
   - Full CDP access, async, well-maintained
   - Can launch headless Chrome or connect to user's existing browser
   - Integrates naturally with Tauri's Tokio async runtime

2. **AI agent layer**: Build a ReAct-style browser agent on top
   - Use chromiumoxide to capture page state (DOM, accessibility tree, screenshots)
   - Feed state to LLM for decision-making
   - Execute LLM-decided actions via chromiumoxide CDP calls
   - This mirrors what browser-use does, but in pure Rust

3. **Optional MCP integration**: Expose browser tools via MCP
   - Allow external AI agents to control the browser through your app
   - Playwright MCP's accessibility-tree approach is worth studying/replicating

### Why not browser-use directly?
- Requires Python runtime — heavy dependency for a Tauri app
- But its architecture (direct CDP + LLM agent loop) is the right pattern to replicate in Rust

### Why not Playwright Rust?
- Alpha quality, requires Node.js, small community
- The ecosystem is moving away from Playwright toward direct CDP anyway
