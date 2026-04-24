<div align="center">

<img src="app/src-tauri/icons/icon.png" width="120" height="120" alt="YiYi" />

# YiYi

**The AI desktop companion that grows with you**

She's not just a tool — she's a companion.<br/>
She can operate your computer, remember your habits, connect to your world,
and get to know you better with every interaction.

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

1. Open YiYi, walk through the setup wizard (language, active model)
2. Paste your API key (OpenAI / Claude / DeepSeek / Zhipu / Qwen / Moonshot / custom)
3. Start chatting. She'll learn you as you go.

---

## 🛠 Architecture

- **Frontend**: React 18 · TypeScript · Tailwind · Vite · xterm.js
- **Backend**: Rust · Tauri 2.x
- **Agent**: ReAct (think → act → observe) + `spawn_agents` parallel sub-agents
- **LLM client**: Unified abstraction, native support for OpenAI / Anthropic / Gemini / DashScope, including Anthropic prompt-cache split optimization
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
