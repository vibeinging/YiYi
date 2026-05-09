<div align="center">

<img src="app/src-tauri/icons/icon.png" width="120" height="120" alt="YiYi" />

# YiYi · DeepSeek V4 Edition

A desktop AI assistant. Wired to DeepSeek V4 only — but wired deep. Keeps notes, reflects nightly, gets sharper the longer you use it.

[![GitHub release](https://img.shields.io/github/v/release/vibeinging/YiYi?style=flat-square&color=orange&include_prereleases)](https://github.com/vibeinging/YiYi/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square)](https://github.com/vibeinging/YiYi/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-green.svg?style=flat-square)](LICENSE)

[中文](./README.md) · English

[Download](https://github.com/vibeinging/YiYi/releases) · [Issues](https://github.com/vibeinging/YiYi/issues)

</div>

---

## Why this exists

Most desktop agents today are Claude Code wrappers. Swap an API key, ship it. The problems:

- Model adaptation is generic — nobody bothers tuning a single model deeply
- Every chat starts from zero — corrections from last week are forgotten
- Claude / GPT pricing makes "leave it running 24/7" economically painful

YiYi takes the opposite bet. It commits to DeepSeek V4 (well-funded; Pro cache hits cost 120× less than misses) and pushes the adaptation into the engine. Cheap inference is what makes long-term memory and reflection actually pay off.

## See it

<p align="center">
  <img src="docs/screenshots/01-main.png" alt="YiYi main view" width="860" />
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/02-buddy.png" alt="Buddy" /></td>
    <td width="50%"><img src="docs/screenshots/03-skills.png" alt="Skills library" /></td>
  </tr>
  <tr>
    <td align="center">Buddy<br/>Desktop sprite, persona, evolves</td>
    <td align="center">Skills<br/>25+ built-in + custom + MCP</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/04-tasks.png" alt="Long tasks" /></td>
    <td width="50%"><img src="docs/screenshots/05-authorize.png" alt="Authorization prompt" /></td>
  </tr>
  <tr>
    <td align="center">Long tasks<br/>Auto-decomposed · pausable · resumable</td>
    <td align="center">Authorization<br/>Sensitive ops need explicit approval</td>
  </tr>
</table>

---

## What "deep DeepSeek V4 adaptation" actually means

**Performance & cost**

| Item | What we did |
|---|---|
| Pro / Flash routing | Main loop runs V4 Pro. Compaction, meditation, heartbeat, connection tests run V4 Flash. Pipeline-level routing — saves ~10× |
| Prefix cache hits | Tools array sorted by name for byte-stable prefix; system prompt split into static + dynamic blocks. Hit rate displayed live |
| Long-context compaction | Triggers at 80% window (800K). Disabled below 500K so we don't trash the prefix cache |
| Error-code specialization | `503 Server busy` → 5s base backoff; `402` → "balance exhausted, top up at platform.deepseek.com"; `429` + balance keywords → no retry |
| Flash-driven helper tools | `compact_context` (squash long text) and `parallel_analyze` (N concurrent Flash calls) offload work from Pro |

**Experience**

| Item | What we did |
|---|---|
| Reasoning chain | `reasoning_content` streamed live, collapsible, persisted in history. Effort toggles OFF / HIGH / MAX in the input box |
| Chinese reasoning | System prompt explicitly tells the model to think in the same language as the reply |
| Parallel tool calls | OpenAI-compatible request sets `parallel_tool_calls: true` explicitly + prompt nudges the model to batch independent reads. Engine `join_all`s read-only tools |
| Cache-hit badge | One line under each reply: `↑12,453  ↓1,028  cache 73%`. You can see what the cache is saving |

**Robustness**

| Item | What we did |
|---|---|
| Anti-loop guard | Same `(tool, args)` 3 times → blocked with corrective feedback. Same tool failing 8 times → halt with a friendly summary, never a raw `Error:` paste |
| Browser fetch | Real Chrome 131 UA, `disable-blink-features=AutomationControlled`. Detects Cloudflare / Akamai challenge pages and returns a structured Error pointing the agent at `web_search` |
| Workspace time machine | Shadow-git snapshots before and after every turn. Roll back any step; your real `.git` is untouched |

---

## Long-term growth

Wrapper agents solve "one task." Every new chat starts from scratch. YiYi's other axis is keeping the model in your workflow long enough to actually get better at working with you.

- **Nightly meditation** — a Flash-tier background pass reviews the day's interactions and distills scattered experience into behavior principles
- **Tiered memory** — HOT (active context) / COLD (SQLite) / MEMME (vector recall). Important facts age into long-term storage instead of getting lost
- **Corrections become rules** — say "don't do that again" once; it goes into feedback memory and applies next time
- **Capability profile** — visible deltas of where she's getting stronger or weaker
- **Failure reflection** — repeated tool failures and loop_guard halts get written into reflections; next similar task starts by checking those notes

The 120× cache discount isn't just a cost number. It's what makes "run long-running growth loops in the background" affordable in the first place.

---

## What's in the box

**ReAct agent**

`think → act → observe` loop. 60+ built-in tools — shell, file I/O, browser automation, screenshot analysis, calendar, memory recall. Spawns sub-agents in parallel for harder workflows.

**25+ built-in skills**

| | |
|:---|:---|
| Office — Word / Excel / PDF / PPT | Browser — automation / testing / SEO |
| Comms — email, news aggregation | Creative — Canvas, algorithmic art, frontend |
| Automation — cron, auto-continue | Dev — coding assistant, MCP, Claude Code |

Install more from the skill market, or have YiYi generate one.

**Bot deployment**

Run YiYi as a bot on Discord · QQ · Telegram · DingTalk · Lark · WeCom · Webhook. Same agent, same memory, anywhere you live.

**MCP**

Speaks Model Context Protocol natively. Connect any MCP server for new capabilities; expose YiYi's skills back out so other AI apps can call them.

**Safe by default**

- Folder allowlist; sensitive paths (`.env`, `.ssh`, credentials) always blocked
- Shell commands go through static safety analysis; destructive ops require explicit confirmation
- Model-supplied URLs go through SSRF filtering
- External content is wrapped in `<external-content>` to defend against prompt injection

---

## Install

Grab a build from [Releases](https://github.com/vibeinging/YiYi/releases):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `YiYi_x.x.x_aarch64.dmg` |
| macOS (Intel) | `YiYi_x.x.x_x64.dmg` |
| Windows | `YiYi_x.x.x_x64-setup.exe` |
| Linux (Debian / Ubuntu) | `YiYi_x.x.x_amd64.deb` |
| Linux (generic) | `YiYi_x.x.x_amd64.AppImage` |

Open it, pick a language in the wizard, paste in a key from the [DeepSeek platform](https://platform.deepseek.com/api_keys), and start chatting. Pro / Flash routing is automatic — there's no model picker.

> This release supports DeepSeek V4 only. If you're still on OpenAI / Claude / Gemini, stay on the prior release or export sessions before upgrading.

---

## Architecture

- Frontend: React 18, TypeScript, Tailwind, Vite, xterm.js
- Backend: Rust, Tauri 2.x
- Agent: ReAct + `spawn_agents` parallel sub-agents + `loop_guard` anti-loop
- LLM: DeepSeek V4 Pro / Flash dual-model, `UsageSource`-driven routing, prefix-cache hit tracking, streaming reasoning
- Cost: `engine/pricing.rs` V4 pricing table (V4 Pro 75% promo through 2026-05-31). Process-wide cost side-channel covers background calls
- Context: 800K auto-compaction trigger; disabled below 500K to preserve the prefix cache
- Workspace: shadow-git snapshots before/after every turn; your `.git` is never touched
- DB: SQLite (WAL)
- Vector memory: [MemMe](https://github.com/vibeinging/MemMe) tiered memory + nightly meditation consolidation
- Python: PyO3 embedded, bundled pypdf / python-docx / openpyxl / python-pptx
- Browser: Playwright bridge for interactive flows; system Chrome headless for cheap screenshot / HTML fetch (with anti-bot hardening)

## Development

```bash
git clone https://github.com/vibeinging/YiYi.git
cd YiYi/app
npm install
npm run tauri dev          # dev mode
npm run tauri build        # production build
```

Requirements: Node.js 20+, Rust 1.77+, Python 3.13. See [CLAUDE.md](./CLAUDE.md) for engineering details.

---

## License

[Apache 2.0](./LICENSE)

---

<div align="center">

Tauri 2 · Rust · React · TypeScript · SQLite · MCP · DeepSeek V4

[Download](https://github.com/vibeinging/YiYi/releases) · [File an issue](https://github.com/vibeinging/YiYi/issues)

</div>
