<div align="center">

<img src="app/src-tauri/icons/icon.png" width="120" height="120" alt="YiYi" />

# YiYi · DeepSeek V4 Edition

**The AI desktop companion that grows with you — powered by DeepSeek V4 dual-model**

She's not just a tool — she's a companion.<br/>
She can operate your computer, remember your habits, connect to your world,
and get to know you better with every interaction.

> **🔵 DeepSeek V4 only**: starting with this release, YiYi is deeply adapted to
> DeepSeek V4 and no longer supports other providers. `v4-pro` handles heavy
> reasoning, `v4-flash` handles fast sub-tasks, and **the engine routes
> between them automatically — the user never picks a model**. Existing OpenAI /
> Claude / Gemini users should keep an older release or export sessions before
> upgrading.

[![GitHub release](https://img.shields.io/github/v/release/vibeinging/YiYi?style=flat-square&color=orange&include_prereleases)](https://github.com/vibeinging/YiYi/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square)](https://github.com/vibeinging/YiYi/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-green.svg?style=flat-square)](LICENSE)

[中文](./README.md) · **English**

**[Download](https://github.com/vibeinging/YiYi/releases)** · [Issues](https://github.com/vibeinging/YiYi/issues)

</div>

---

## 🖥️ See YiYi in action

<p align="center">
  <img src="docs/screenshots/01-main.png" alt="YiYi main view" width="860" />
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/02-buddy.png" alt="Buddy" /></td>
    <td width="50%"><img src="docs/screenshots/03-skills.png" alt="Skills library" /></td>
  </tr>
  <tr>
    <td align="center"><b>Buddy companion</b><br/>Desktop sprite with personality that evolves</td>
    <td align="center"><b>Skills extension</b><br/>25+ built-in + custom + MCP</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/04-tasks.png" alt="Long tasks" /></td>
    <td width="50%"><img src="docs/screenshots/05-authorize.png" alt="Authorization prompt" /></td>
  </tr>
  <tr>
    <td align="center"><b>Long-running tasks</b><br/>Auto-decomposed · pausable · resumable</td>
    <td align="center"><b>Safe by default</b><br/>Sensitive ops require explicit approval</td>
  </tr>
</table>

---

## ⚡ DeepSeek V4 deep adaptation

YiYi doesn't just *talk* to DeepSeek V4 — the entire engine is tuned around it:

| Feature | What it does |
|---|---|
| **🎚️ Pro / Flash auto routing** | Main ReAct loop runs on V4 Pro for heavy reasoning. Compaction, meditation, heartbeat, test-pings, growth reflections all run on V4 Flash — ~10× cheaper. The user never sees a model picker. |
| **🌪️ Flash-driven tools** | Built-in `compact_context` (squash long text) and `parallel_analyze` (N concurrent Flash calls) let the orchestrator offload sub-tasks instead of burning Pro tokens. |
| **🧱 1M context + V4-aware compaction** | Auto-compaction triggers at 800K tokens (80% of the 1M window) and is **disabled below 500K** to protect the prefix cache. |
| **💸 Prefix-cache aware billing** | Parses DeepSeek's `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`. Pro cache hits cost **120× less** than misses; the UI shows live hit-rate and the dollars saved. |
| **🛑 Anti-loop guard** | Same `(tool, args)` 3 times in a turn → blocked with corrective feedback. Same tool failing 8 times → halt. No more rabbit holes burning tokens. |
| **💭 Thinking-mode UI** | Native streaming render of V4 reasoning content. OFF / HIGH / MAX effort toggle directly in the chat input. |
| **🕰️ Workspace time-machine** | Side-git tar.zst snapshots before/after every turn. Roll back any step with one tool call — your real `.git` is never touched. |
| **📊 Real-time cost panel** | Foreground + background LLM calls all aggregate into the session cost (1 Hz refresh), broken down by source over the month. |

## What can she do?

### 🧠 Autonomous task execution

YiYi ships with a **ReAct Agent engine** — not just answering questions, but
iterating through **think → act → observe** until a task is genuinely done.

> "Take the data from this PDF, put it in Excel, email my boss, then run this every Friday."
>
> — YiYi: got it.

60+ built-in tools on tap: shell, file I/O, browser automation, screenshot
analysis, calendar, memory retrieval. She also spawns sub-agents in parallel
for harder workflows.

### 🎯 25+ built-in skills

| | |
|:---|:---|
| 📄 **Office** — Word / Excel / PDF / PPT | 🌐 **Browser** — automation / testing / SEO |
| ✉️ **Comms** — email, news aggregation | 🎨 **Creation** — Canvas, algorithmic art, frontend |
| ⏰ **Automation** — cron / reminders / auto-continue | 🔧 **Dev** — coding assistant, MCP, Claude Code |

Not enough? Install from the skills market, or have YiYi generate a new one.

### 🤖 One YiYi, seven platforms

Deploy YiYi as your bot on any platform you live in:

**Discord** · **QQ** · **Telegram** · **DingTalk** · **Feishu (Lark)** · **WeCom** · **Webhook**

Ask her to look things up in a WeChat group, manage servers in Discord, track
news in Telegram — same YiYi, same memory, everywhere.

### 🌱 She grows

This is what makes YiYi special.

- **Every correction is remembered** — the same mistake won't happen twice
- **Nightly meditation** distills scattered experiences into behavior principles
- **Tiered memory** (HOT / COLD / MEMME vector) — important facts never slip
- **Capability profile** — you can see her getting stronger over time

The more you use her, the more she gets you.

### 🔌 MCP-native, infinitely extensible

YiYi speaks **MCP (Model Context Protocol)** natively:

- Connect any MCP tool server for instant new capabilities
- Expose her own skills so other AI apps can call YiYi

### 💻 Built-in terminal + long tasks

- xterm.js terminal inside the app for direct shell work
- Long tasks are **pausable / resumable / cancellable**
- One-click Claude Code integration for a seamless dev loop

### 🔒 Safe by default

- Folder allowlist; sensitive paths (.env / .ssh / credentials) always blocked
- Shell commands go through safety analysis; destructive ops need explicit confirm
- LLM-supplied URLs go through SSRF filtering (cloud metadata / private / loopback blocked)
- External content wrapped in `<external-content>` to defend against prompt injection
- `claude-code-*` subwindows run with minimum-scope capabilities

---

## 🚀 Getting started

### Install

Grab the installer for your platform from [Releases](https://github.com/vibeinging/YiYi/releases):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `YiYi_x.x.x_aarch64.dmg` |
| macOS (Intel) | `YiYi_x.x.x_x64.dmg` |
| Windows | `YiYi_x.x.x_x64-setup.exe` |
| Linux (Debian / Ubuntu) | `YiYi_x.x.x_amd64.deb` |
| Linux (generic) | `YiYi_x.x.x_amd64.AppImage` |

### First run

1. Open YiYi and walk through the setup wizard (just pick a language).
2. Get an API key from the [DeepSeek platform](https://platform.deepseek.com/api_keys) and paste it in.
3. Start chatting. She'll learn you as you go. Pro / Flash routing is automatic — you don't pick models.

---

## 🛠 Architecture

- **Frontend**: React 18 · TypeScript · Tailwind · Vite · xterm.js
- **Backend**: Rust · Tauri 2.x
- **Agent**: ReAct (think → act → observe) + `spawn_agents` parallel sub-agents + anti-loop guard (`loop_guard`)
- **LLM**: DeepSeek V4 Pro/Flash dual-model · `UsageSource`-driven auto routing · prefix-cache hit-rate tracking · streaming reasoning render
- **Cost**: `engine/pricing.rs` V4 pricing table (incl. V4 Pro 75% promo through 2026-05-31) · process-wide cost side-channel that catches background LLM calls
- **Context**: 800K auto-compaction trigger · disabled below 500K to protect prefix cache
- **Workspace**: side-git tar.zst snapshots before/after every turn — never touches your `.git`
- **DB**: SQLite (WAL)
- **Vector memory**: [MemMe](https://github.com/vibeinging/MemMe) tiered memory + nightly meditation consolidation
- **Python integration**: PyO3 embedded, bundled pypdf / python-docx / openpyxl / python-pptx
- **Browser**: Playwright bridge (interactive) + system Chrome headless (cheap tier for screenshot / HTML fetch)

## Development

```bash
git clone https://github.com/vibeinging/YiYi.git
cd YiYi/app
npm install
npm run tauri dev          # dev mode
npm run tauri build        # production build
```

**Requirements**: Node.js 20+ · Rust 1.77+ · Python 3.13

See [CLAUDE.md](./CLAUDE.md) for engineering details.

---

## 📜 License

[Apache 2.0](./LICENSE)

---

<div align="center">

**Tauri 2 · Rust · React · TypeScript · SQLite · MCP**

**[Download YiYi](https://github.com/vibeinging/YiYi/releases)** · [File an issue](https://github.com/vibeinging/YiYi/issues)

Named after the founder's daughter, built to be the best AI companion possible 🧡

</div>
