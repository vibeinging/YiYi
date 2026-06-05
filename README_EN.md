<div align="center">

<img src="app/src-tauri/icons/icon.png" width="120" height="120" alt="YiYi" />

# YiYi

**A desktop AI companion that grows alongside you**
Adopt AI buddies with personalities, group them up for free-range chat · DeepSeek V4–only, engineered deep · learns from corrections, knows you better over time

[![GitHub release](https://img.shields.io/github/v/release/vibeinging/YiYi?style=flat-square&color=orange&include_prereleases)](https://github.com/vibeinging/YiYi/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square)](https://github.com/vibeinging/YiYi/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-green.svg?style=flat-square)](LICENSE)
[![Stars](https://img.shields.io/github/stars/vibeinging/YiYi?style=flat-square&color=yellow)](https://github.com/vibeinging/YiYi/stargazers)
[![Issues](https://img.shields.io/github/issues/vibeinging/YiYi?style=flat-square&color=red)](https://github.com/vibeinging/YiYi/issues)

[中文](./README.md) · English

[![macOS](https://img.shields.io/badge/macOS-Download-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/vibeinging/YiYi/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-Download-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/vibeinging/YiYi/releases/latest)
[![Linux](https://img.shields.io/badge/Linux-Download-FCC624?style=for-the-badge&logo=linux&logoColor=black)](https://github.com/vibeinging/YiYi/releases/latest)

<br/>

<img src="docs/screenshots/01-main.png" alt="YiYi main UI" width="860" />

</div>

---

## ✨ Why YiYi

<table>
  <tr>
    <td align="center" width="33%" valign="top">
      <h3>🎯 Engineered Deep</h3>
      <p>DeepSeek V4 only. Pro/Flash routing, prefix-cache hit tracking, streaming reasoning, parallel tool calls — the kind of detail that gets lost behind a multi-model abstraction.</p>
    </td>
    <td align="center" width="33%" valign="top">
      <h3>🌱 Long-term Growth</h3>
      <p>Lives on your desktop. Remembers your corrections, meditates nightly in the background. White-box "growth suggestions" — what the agent thinks should be saved waits for your review.</p>
    </td>
    <td align="center" width="33%" valign="top">
      <h3>💸 Low on both ends</h3>
      <p>Learning curve: no jargon required. Money: no subscription, no markup — your API key talks to DeepSeek directly, you see exactly what each turn cost.</p>
    </td>
  </tr>
</table>

---

## 👥 Not just one AI — a crew of buddies, chatting as a group

YiYi isn't a single-agent assistant. Adopt multiple **AI buddies with personalities** — each with its own avatar, character, role and private memory — then pull them into a **group** and let them chat free-range. Not "you ask, they answer in a queue," but like a real group chat:

- **Staggered replies**: nobody races to answer — each member chimes in over a few seconds (jittered delay), slower ones speak after seeing fuller context
- **Winds down on its own**: when no one picks up, YiYi (the group host) wraps it — no forced filler, no instant summary
- **@ to summon**: @ someone and they're up right away
- **1:1 too**: tap a buddy for a private chat, memories kept separate

The main sprite YiYi lives on your desktop and grows; each buddy has a job (writing, drawing, brainstorming…); the group brings them together.

---

## 📸 Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/02-buddy.png" alt="Desktop sprite" /></td>
    <td width="50%"><img src="docs/screenshots/03-skills.png" alt="Skills library" /></td>
  </tr>
  <tr>
    <td align="center"><b>Desktop Sprite</b><br/>Always there · with personality · talks to you</td>
    <td align="center"><b>Skills Library</b><br/>built-in · custom · MCP-connected</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/04-tasks.png" alt="Long tasks" /></td>
    <td width="50%"><img src="docs/screenshots/05-authorize.png" alt="Authorization" /></td>
  </tr>
  <tr>
    <td align="center"><b>Long Tasks</b><br/>Auto-decompose · pausable · resumable</td>
    <td align="center"><b>Authorization</b><br/>Destructive ops need explicit consent</td>
  </tr>
</table>

---

## 🚀 Quick Start

1. Grab the installer for your platform from [Releases](https://github.com/vibeinging/YiYi/releases/latest)
2. Walk through the setup wizard
3. Get an API key from [DeepSeek](https://platform.deepseek.com/api_keys), paste it in
4. Start chatting — Pro/Flash routing is automatic

> This release is DeepSeek V4 only. If you're still on OpenAI / Claude / Gemini, keep the previous build or export sessions before upgrading.

---

## 🎯 Features

| Module | What it does |
|---|---|
| 👥 **Buddies · Group Chat** | Adopt AI buddies with personalities · group them for free-range chat (staggered replies / natural wind-down / @ to summon / 1:1) |
| 🧠 **ReAct Agent** | think → act → observe loop · 60+ built-in tools · parallel sub-agents |
| 🎯 **Built-in Skills** | Office (docx/pdf/pptx/xlsx) · creative · frontend · MCP builder · theme factory… custom + marketplace |
| 🤖 **Multi-platform Bot** | WeChat · QQ · DingTalk · Feishu · WeCom · Discord · Telegram · Webhook |
| 🔌 **MCP Protocol** | Plug in external MCP servers, expose your own skills |
| 🖱️ **Desktop Control** | Background macOS control via cua-driver MCP — doesn't steal cursor or Space |
| 🌱 **Long-term Growth** | Nightly meditation · failure reflection · learn from corrections · capability profile |
| 🛡️ **Safe by Default** | Folder allowlist · shell static analysis · SSRF guard · prompt-injection guard |

---

<details>
<summary><b>🔬 DeepSeek V4 deep integration</b> — performance / cost / UX / robustness</summary>

**Performance & cost**

| Item | How |
|---|---|
| Pro / Flash routing | Main loop on V4 Pro; compaction, meditation, heartbeat, connection tests on V4 Flash. Flow-level routing, ~10× cheaper |
| Prefix-cache hits | Tools array sorted by name for byte stability; system prompt split into static/dynamic blocks. Hit rate shown live |
| Long-context compaction | Triggers at 80% (800K); under 500K compaction is disabled to preserve prefix cache |
| Error-code specialization | 503 + Server busy → 5s exponential backoff; 402 → top-up page; 429 + balance keyword → no retry |
| Flash-accelerated tools | `compact_context` for long docs, `parallel_analyze` for N Flash calls — offload heavy subtasks from Pro |

**UX**

| Item | How |
|---|---|
| Reasoning chain | `reasoning_content` streams in, collapsible, persisted; effort toggle: OFF / HIGH / MAX |
| Chinese thinking | System prompt forces thinking in Chinese — no English-then-translate |
| Parallel tool calls | `parallel_tool_calls: true` + prompt-level guidance; engine uses `join_all` |
| Cache-hit badge | Each reply footer: `↑12,453  ↓1,028  cache 73%` — you see the savings |

**Robustness**

| Item | How |
|---|---|
| Loop guard | Same (tool, args) called 3× → auto-block; same tool fails 8× → friendly halt |
| Browser Fetch | Real Chrome 131 UA, webdriver disabled; Cloudflare/Akamai challenge pages detected and redirected to web_search |
| Workspace time machine | Shadow-git snapshot before/after every turn (your `.git` untouched), one-click rollback |

</details>

<details>
<summary><b>🌱 Long-term growth</b> — nightly meditation, learn from corrections, white-box co-construction</summary>

A desktop-agent wrapper solves "one task at a time" but starts from zero every session. YiYi's other main thread: keep the model in your workflow and make it stronger over time.

- **Nightly meditation**: a background Flash run distills the day's interactions into behavioral principles
- **Tiered memory**: HOT (active context) / COLD (SQLite) / MEMME (vector recall) — routed by recency and importance
- **Learn from corrections**: tell it "don't do that again" once → written to feedback memory → avoided next time
- **Failure reflection**: tool fails repeatedly or loop_guard fires → writes a reflection → consulted on similar tasks later
- **Capability profile**: see what's improving and what's regressing
- **White-box growth suggestions**: agent-proposed skills don't auto-apply — they queue for your review. Even a full inbox doesn't affect runtime — zero-risk accumulation

This thread needs a model running in the background — correcting, reflecting, consolidating — so it has to be cheap enough to leave on. Another reason for V4.

</details>

<details>
<summary><b>💸 About money</b> — no subscription, you pay DeepSeek directly</summary>

YiYi doesn't charge a subscription. You pay for the compute it uses on your behalf — directly to DeepSeek, by usage.

- **In-app top-up in one step**: when balance is low, tap the prompt; the DeepSeek official top-up page opens in a sandbox webview (their session, not YiYi's backend)
- **Balance and usage always visible**: every reply shows what that turn cost; account page shows total balance and recent spend
- **¥1 goes a long way for casual chat**: cheap models, prefix-cache reuse, background work runs on Flash
- **No need to know "model" / "token"**: YiYi picks the heavy or light model itself — you just talk

</details>

<details>
<summary><b>🏗️ Tech stack</b> — Rust / Tauri 2 · React 18 · DeepSeek V4 · SQLite · MCP</summary>

- Frontend: React 18, TypeScript, Tailwind, Vite, xterm.js
- Backend: Rust, Tauri 2.x
- Agent: ReAct main loop + `spawn_agents` parallel sub-agents + free-range async group-chat loop (staggered replies / natural wind-down) + `loop_guard`
- LLM: DeepSeek V4 Pro/Flash dual-model, `UsageSource`-driven routing, prefix-cache hit tracking, streaming reasoning
- Cost: `engine/pricing.rs` V4 price table; process-level cost side-channel aggregating background calls
- Context: 800K triggers auto-compaction, below 500K compaction disabled to preserve prefix cache
- Workspace: shadow-git snapshot (per-turn), user's `.git` untouched
- Database: SQLite (WAL)
- Vector memory: [MemMe](https://github.com/vibeinging/MemMe) tiered memory + meditation consolidation
- Python: PyO3 embedded, ships with pypdf / python-docx / openpyxl / python-pptx
- Browser: Playwright bridge for interactive flows; system Chrome headless for screenshots / HTML fetch

</details>

<details>
<summary><b>🛠️ Local development</b></summary>

```bash
git clone https://github.com/vibeinging/YiYi.git
cd YiYi/app
npm install
npm run tauri dev          # dev mode
npm run tauri build        # production build
```

Requirements: Node.js 20+, Rust 1.77+, Python 3.13. See [CLAUDE.md](./CLAUDE.md).

</details>

---

## 🧭 What we're aiming for

- **Lower both kinds of cost** — no AI jargon to learn (no "model" / "token" / "prompt"), and you pay DeepSeek by usage: no subscription, no markup
- Be **the DeepSeek-native desktop AI**, period — no other model, this one mastered
- Engineer for both **peak capability** and **minimal cost** — no compromise
- Build an AI that doesn't just help you once, but **grows with you** the longer you keep it around

## 🤝 Contributing

PRs and issues welcome. Before submitting, please run `cd app && npx tsc --noEmit` and `cd app/src-tauri && cargo test --features test-support`. Conventions in [CLAUDE.md](./CLAUDE.md).

[![Contributors](https://contrib.rocks/image?repo=vibeinging/YiYi)](https://github.com/vibeinging/YiYi/graphs/contributors)

## 💬 Community

- [Issues](https://github.com/vibeinging/YiYi/issues) — bug reports / feature requests
- [Discussions](https://github.com/vibeinging/YiYi/discussions) — usage tips / skill sharing / Q&A

<div align="center">

> *If you enjoy using it, that's all the motivation I need.*
>
> *Built for love — don't worry about my costs.*

</div>

## ⭐ Star History

<a href="https://star-history.com/#vibeinging/YiYi&Date">
  <img src="https://api.star-history.com/svg?repos=vibeinging/YiYi&type=Date" alt="Star History Chart" width="600" />
</a>

## 📜 License

[Apache 2.0](./LICENSE)

---

<div align="center">
<sub>Tauri 2 · Rust · React · TypeScript · SQLite · MCP · DeepSeek V4</sub>
</div>
