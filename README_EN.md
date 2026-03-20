<div align="center">

**English** | **[中文](README.md)**

<img src="app/src-tauri/icons/icon.png" width="120" height="120" alt="YiYi Logo" />

# YiYi

**Your AI Companion That Grows With You**

A desktop AI companion that can operate your computer, execute complex tasks, connect to multiple platforms, and learn from every interaction.

[![GitHub release](https://img.shields.io/github/v/release/HungryFour/YiYi?style=flat-square&color=orange)](https://github.com/HungryFour/YiYi/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square)](https://github.com/HungryFour/YiYi/releases)
[![License](https://img.shields.io/github/license/HungryFour/YiYi?style=flat-square)](LICENSE)

[Download](#-installation) · [Features](#-features) · [Quick Start](#-quick-start)

</div>

---

## ✨ Features

### 🧠 ReAct Agent Engine

At its core, YiYi runs a **ReAct (Reasoning + Acting) loop engine** for autonomous task execution:

- **Think → Act → Observe** iterative reasoning, just like a human
- 40+ built-in tools: shell, file I/O, browser automation, screenshot, calendar, package management...
- Sub-Agent spawning to decompose complex tasks into parallel workflows
- Token-aware context compaction — never lose critical info in long conversations

### 🎯 Skills System

**24 built-in skills** covering every aspect of daily work:

| Category | Skills |
|:---|:---|
| 📄 **Office Suite** | Word, Excel, PDF, PPT document processing |
| 🌐 **Browser** | Visual browser automation, web testing, SEO analysis |
| ✉️ **Communication** | Email (IMAP), news aggregation |
| 🎨 **Content Creation** | Canvas design, algorithmic art (p5.js), frontend design |
| ⏰ **Automation** | Cron job scheduling, auto-continue workflows |
| 🔧 **Development** | Coding assistant, MCP Builder, Claude Code integration |

> Create custom skills or browse the skill marketplace to extend YiYi's capabilities.

### 🤖 Multi-Platform Bot System

One YiYi, seven platforms:

<table>
<tr>
<td align="center"><b>Discord</b><br/>WebSocket</td>
<td align="center"><b>QQ</b><br/>WebSocket</td>
<td align="center"><b>Telegram</b><br/>Polling</td>
<td align="center"><b>DingTalk</b><br/>Stream</td>
<td align="center"><b>Feishu</b><br/>WebSocket</td>
<td align="center"><b>WeCom</b><br/>Webhook</td>
<td align="center"><b>Webhook</b><br/>Generic</td>
</tr>
</table>

- MPSC channel → dedup → debounce (500ms) → 4 concurrent workers
- Image and file attachment support
- Multiple bots bound to a single session

### 🌱 Growth System

YiYi isn't just a tool — she **grows**:

- **Reflective Learning** — captures your corrections and approvals, forming behavioral principles
- **Meditation Engine** — daily scheduled deep reflection, consolidating memory and principles
- **Tiered Memory** — Hot / Warm / Cold three-tier memory system, important memories never fade
- **Capability Profile** — visual growth trajectory across domains

### 🔌 MCP Protocol Support

- As **MCP Client**: connect to external tool servers, seamlessly integrate third-party capabilities
- As **MCP Server**: expose local skills to other applications

### ⏰ Scheduled Tasks

- Cron expressions, delayed execution, one-time tasks
- Visual task management panel
- Push notifications on completion

### 💻 Terminal Integration

- Built-in interactive terminal (xterm.js)
- Dedicated Claude Code terminal interface
- PTY session management

---

## 🖥️ Screenshots

> 🚧 Coming soon

---

## 📦 Installation

### Download

Head to [Releases](https://github.com/HungryFour/YiYi/releases) to download for your platform:

| Platform | Format |
|:---|:---|
| **macOS** | `.dmg` |
| **Windows** | `.exe` (NSIS installer) |
| **Linux** | `.AppImage` |

### Build from Source

```bash
git clone https://github.com/HungryFour/YiYi.git
cd YiYi/app

npm ci

# Development
npm run tauri dev

# Production build
npm run tauri build
```

---

## 🚀 Quick Start

1. **Launch YiYi** — a setup wizard will guide you on first run
2. **Choose language** — Chinese / English
3. **Configure model** — enter your LLM API Key
4. **Set workspace** — defaults to `~/Documents/YiYi`
5. **Start chatting** — tell YiYi what you need, she'll handle the rest

---

## 🏗️ Tech Stack

Tauri 2 · Rust · React 18 · TypeScript · SQLite · MCP Protocol

---

## 🤝 Contributing

Contributions are welcome! Please submit feedback or suggestions via [Issues](https://github.com/HungryFour/YiYi/issues).

---

<div align="center">

**YiYi** — Named after a daughter, built to be the best AI companion 🧡

</div>
