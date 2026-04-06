<div align="center">

<img src="app/src-tauri/icons/icon.png" width="120" height="120" alt="YiYi Logo" />

# YiYi

**Your AI Desktop Companion — The More You Use It, The Better It Knows You**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/vibeinging/YiYi?include_prereleases)](https://github.com/vibeinging/YiYi/releases)

[中文](./README.md) | English

</div>

---

## What is YiYi

YiYi is a **desktop AI personal assistant**. She's more than a chatbot — she can operate your computer, execute long-running tasks, manage files, process documents, and learns from every interaction to grow alongside you.

- **Multi-Model Support**: OpenAI, Claude, DeepSeek, Zhipu, Qwen, Moonshot and more — switch freely; extensible via custom Provider plugins
- **Computer Control**: File read/write, terminal commands, browser automation, screenshot analysis
- **Long Task Execution**: Multi-step task auto-decomposition and execution with interrupt recovery, pause/resume support
- **25 Built-in Skills**: PDF/DOCX/XLSX/PPTX document processing, Canvas design, frontend design, WeChat article writing and more — supports custom extensions
- **Multi-Platform Bots**: Discord, QQ, Telegram, DingTalk, Feishu, WeCom with unified cross-platform user identity
- **Scheduled Tasks**: Cron expressions or natural language for automated recurring work
- **Growth System**: Reflection, memory, meditation — MemMe vector memory + meditation engine, grows smarter with use
- **Buddy Companion**: A hatchable desktop companion character that observes your habits and grows with you
- **Security & Permissions**: Folder authorization, sensitive path protection, shell command safety analysis — transparent and controllable
- **MCP Protocol**: Connect to external tool servers for unlimited capability expansion

## Getting Started

### Download & Install

Visit [Releases](https://github.com/vibeinging/YiYi/releases) to download the installer for your platform:

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `YiYi_x.x.x_aarch64.dmg` |
| macOS (Intel) | `YiYi_x.x.x_x64.dmg` |
| Windows | `YiYi_x.x.x_x64-setup.exe` |
| Linux (Debian/Ubuntu) | `YiYi_x.x.x_amd64.deb` |
| Linux (Universal) | `YiYi_x.x.x_amd64.AppImage` |

### First Launch

1. Open YiYi and follow the setup wizard to configure language and AI model
2. Enter your model provider's API Key
3. Start chatting!

## Tech Stack

- **Frontend**: React 18 + TypeScript + Tailwind CSS + Vite + xterm.js terminal
- **Backend**: Rust + Tauri v2
- **AI Engine**: ReAct Agent (Think → Act → Observe loop) + multi-agent collaboration
- **Database**: SQLite (WAL mode)
- **Python Integration**: PyO3 embedded runtime with built-in document processing packages (pypdf, python-docx, openpyxl, python-pptx)
- **Vector Memory**: MemMe vector store with semantic search
- **Browser Automation**: Playwright bridge for page interaction and screenshot analysis
- **Built-in Server**: axum HTTP/WebSocket server (Bot Webhooks, MCP Skill Server)

## Development

```bash
# Clone the repository
git clone https://github.com/vibeinging/YiYi.git
cd YiYi

# Install frontend dependencies
cd app && npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

### Prerequisites

- Node.js 20+
- Rust 1.77+
- Python 3.13 (required by PyO3)

## License

[Apache License 2.0](LICENSE)
