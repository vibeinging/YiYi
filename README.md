<div align="center">

<img src="app/src-tauri/icons/icon.png" width="120" height="120" alt="YiYi" />

# YiYi

**一个会陪你一起长大的桌面 AI 助手**
只接 DeepSeek V4，接到工程深处 · 后台冥想、纠正即学习、越用越懂你

[![GitHub release](https://img.shields.io/github/v/release/vibeinging/YiYi?style=flat-square&color=orange&include_prereleases)](https://github.com/vibeinging/YiYi/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square)](https://github.com/vibeinging/YiYi/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-green.svg?style=flat-square)](LICENSE)
[![Stars](https://img.shields.io/github/stars/vibeinging/YiYi?style=flat-square&color=yellow)](https://github.com/vibeinging/YiYi/stargazers)
[![Issues](https://img.shields.io/github/issues/vibeinging/YiYi?style=flat-square&color=red)](https://github.com/vibeinging/YiYi/issues)

中文 · [English](./README_EN.md)

[![macOS](https://img.shields.io/badge/macOS-下载-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/vibeinging/YiYi/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-下载-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/vibeinging/YiYi/releases/latest)
[![Linux](https://img.shields.io/badge/Linux-下载-FCC624?style=for-the-badge&logo=linux&logoColor=black)](https://github.com/vibeinging/YiYi/releases/latest)

<br/>

<img src="docs/screenshots/01-main.png" alt="YiYi 主界面" width="860" />

</div>

---

## ✨ 为什么是 YiYi

<table>
  <tr>
    <td align="center" width="33%" valign="top">
      <h3>🎯 工程深度</h3>
      <p>只接 DeepSeek V4。Pro / Flash 路由、prefix 缓存命中追踪、思考链流式渲染、并行工具调用——藏在多模型抽象层下做不到的细节。</p>
    </td>
    <td align="center" width="33%" valign="top">
      <h3>🌱 长期成长</h3>
      <p>常驻桌面。纠正一次就记住，每夜后台冥想沉淀经验。白盒共建的"成长建议"——agent 想到的会等你审。</p>
    </td>
    <td align="center" width="33%" valign="top">
      <h3>💸 两种成本都低</h3>
      <p>使用：不强制你懂 model / token。花钱：不收订阅、不抽成，API Key 直连 DeepSeek，每条回复底下看到这次花了多少。</p>
    </td>
  </tr>
</table>

---

## 📸 截图

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/02-buddy.png" alt="桌面小精灵" /></td>
    <td width="50%"><img src="docs/screenshots/03-skills.png" alt="技能库" /></td>
  </tr>
  <tr>
    <td align="center"><b>桌面小精灵</b><br/>常驻、有人格、会跟你商量</td>
    <td align="center"><b>技能库</b><br/>25+ 内置 · 自定义 · MCP 接入</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/04-tasks.png" alt="长任务" /></td>
    <td width="50%"><img src="docs/screenshots/05-authorize.png" alt="授权确认" /></td>
  </tr>
  <tr>
    <td align="center"><b>长任务</b><br/>自动拆解 · 可暂停 · 可恢复</td>
    <td align="center"><b>授权确认</b><br/>敏感操作要你明确同意</td>
  </tr>
</table>

---

## 🚀 快速开始

1. 去 [Releases](https://github.com/vibeinging/YiYi/releases/latest) 下载对应平台的安装包
2. 打开后按引导设置语言
3. 到 [DeepSeek 平台](https://platform.deepseek.com/api_keys) 申请 API Key，粘贴进去
4. 开始对话 —— Pro/Flash 路由系统自动决定，不用手动选

> 本版本只支持 DeepSeek V4。仍在用 OpenAI / Claude / Gemini 的，请保留旧版或先导出会话再升级。

---

## 🎯 主要功能

| 模块 | 一句话 |
|---|---|
| 🧠 **ReAct Agent** | think → act → observe 主循环 · 60+ 内置工具 · 子 agent 并行 |
| 🎯 **25+ 内置技能** | 办公 · 浏览器 · 通讯 · 创作 · 自动化 · 开发 |
| 🤖 **多平台 Bot** | QQ · 钉钉 · 飞书 · 企微 · Discord · Telegram · Webhook |
| 🔌 **MCP 协议** | 接入外部 MCP server，也对外暴露自己的技能 |
| 🖱️ **桌面操控** | 通过 cua-driver MCP 后台跑，不抢光标、不切 Space（macOS） |
| 🌱 **长期成长** | 后台冥想 · 失败反思 · 纠正即学习 · 能力画像 |
| 🛡️ **安全默认** | 文件夹白名单 · Shell 静态分析 · SSRF 防护 · prompt injection 防护 |

---

<details>
<summary><b>🔬 DeepSeek V4 深度适配</b> — 性能 / 成本 / 体验 / 鲁棒性</summary>

**性能与成本**

| 项目 | 做法 |
|---|---|
| Pro / Flash 路由 | 主循环 V4 Pro；压缩、冥想、心跳、连接测试走 V4 Flash。流程级路由，省约 10× 成本 |
| Prefix Cache 命中 | tools 数组按名排序保证字节稳定；system prompt 拆静态/动态块。命中率实时显示 |
| 长上下文压缩 | 触发阈值 80% 窗口（800K）；500K 以下主动禁用压缩，避免破坏 prefix cache |
| 错误码特化 | 503 + Server busy → 5s 起步退避；402 → 提示去 platform.deepseek.com 充值；429 + 余额关键词 → 不重试 |
| Flash 加速工具 | `compact_context` 压长文、`parallel_analyze` N 个 Flash 并发，繁重子任务从 Pro 卸载到 Flash |

**体验**

| 项目 | 做法 |
|---|---|
| 思考链 | reasoning_content 流式渲染、可折叠回看、历史持久化；effort 在 OFF / HIGH / MAX 之间切换 |
| 中文思考 | system prompt 显式要求 thinking 也用中文，不再英文思考再翻译 |
| 并行工具调用 | OpenAI 兼容请求显式 `parallel_tool_calls: true` + prompt 引导一次调多个独立查询；引擎层 `join_all` 并行 |
| 缓存命中徽章 | 每条回复底部一行：`↑12,453  ↓1,028  缓存命中 73%`，让你看见省了多少 |

**鲁棒性**

| 项目 | 做法 |
|---|---|
| 反鬼打墙 | 同 (tool, args) 调用 3 次自动 block；同工具失败 8 次中文友好 halt |
| Browser Fetch | 真实 Chrome 131 UA、关闭 webdriver 标识；Cloudflare/Akamai 挑战页识别后引导切 web_search |
| 工作区时光机 | 每个 turn 前后 shadow-git 快照（不动你的 `.git`），任意一步可一键回滚 |

</details>

<details>
<summary><b>🌱 长期成长机制</b> — 后台冥想、纠正即学习、白盒共建</summary>

桌面 Agent 套壳解决"一次任务"，但每开新会话都从零开始。YiYi 的另一条主线是把模型放在你的工作流里持续变强。

- **每夜冥想**：后台 Flash 模型复盘当日交互，把零散经验沉淀成行为准则
- **分层记忆**：HOT（活跃上下文）/ COLD（SQLite 持久）/ MEMME（向量召回）三层，按时效和重要度分流
- **纠正即学习**：你说一次"以后别这么做"，写进 feedback memory，下次自动避开
- **失败反思**：tool 连续失败、loop_guard 触发都会写 reflection；下次同类任务先翻反思笔记
- **能力画像**：哪些领域变强、变弱，可视化看得见
- **白盒共建成长建议**：agent 想到的可固化技能不直接生效，进"成长建议"等你审——满了也不出事，零风险积累

这条线需要模型一直在后台思考自己——纠正、反思、巩固——所以必须便宜到能放着不管。这是 YiYi 选择 V4 的另一个理由。

</details>

<details>
<summary><b>💸 关于钱</b> — 不收订阅费，用量直付 DeepSeek</summary>

YiYi 不收订阅费。你支付的是它代你跑事所用的算力——直接付给 DeepSeek，按用量算钱。

- **充值在 app 里一步完成**：余额不够时点提示，弹出 DeepSeek 官方充值页（沙盒 webview，登录态走他们家的，不走 YiYi 后台）
- **余额、用量随时能看**：每条回复底下看到这次花了多少；账户页有总余额和近期消耗
- **日常聊天，1 元能用很久**：模型选得便宜、引擎做了缓存复用、后台轻活全走 Flash
- **不用懂"model""token"这些词**：YiYi 自己决定何时用重模型、何时用轻模型，你只管说话

</details>

<details>
<summary><b>🏗️ 技术架构</b> — Rust / Tauri 2 · React 18 · DeepSeek V4 · SQLite · MCP</summary>

- 前端：React 18、TypeScript、Tailwind、Vite、xterm.js
- 后端：Rust、Tauri 2.x
- Agent：ReAct + spawn_agents 多 Agent 并行 + loop_guard 反鬼打墙
- LLM：DeepSeek V4 Pro / Flash 双模型，`UsageSource` 驱动路由，prefix 缓存命中率追踪，思考流式渲染
- 成本：`engine/pricing.rs` V4 价格表；进程级 cost side-channel 汇总后台调用
- 上下文：800K 触发自动压缩，500K 以下禁用以保护 prefix cache
- 工作区：shadow-git 快照（每 turn 前后），不动用户 `.git`
- 数据库：SQLite (WAL)
- 向量记忆：[MemMe](https://github.com/vibeinging/MemMe) 分层记忆 + 冥想巩固
- Python：PyO3 嵌入，自带 pypdf / python-docx / openpyxl / python-pptx
- 浏览器：Playwright bridge 跑交互流；系统 Chrome headless 跑轻量截图 / HTML fetch

</details>

<details>
<summary><b>🛠️ 本地开发</b></summary>

```bash
git clone https://github.com/vibeinging/YiYi.git
cd YiYi/app
npm install
npm run tauri dev          # 开发模式
npm run tauri build        # 生产构建
```

依赖：Node.js 20+、Rust 1.77+、Python 3.13。详见 [CLAUDE.md](./CLAUDE.md)。

</details>

---

## 🧭 我们想做成什么样

- **把你的两种成本都降到最低**——使用上不必懂 model / token / prompt 这些词；花钱按 DeepSeek 用量直付，不收订阅、不抽成
- 做**最契合 DeepSeek 的桌面 AI 助手**——别的模型都不接，把这一家吃透
- 在"**牛逼**"和"**省钱**"之间做工程，不让你二选一
- 让 AI 不只是工具，而是**会跟你一起长大的伙伴**——开着越久越懂你

## 🤝 贡献

欢迎 PR 与 Issue。提交前请运行 `cd app && npx tsc --noEmit` 和 `cd app/src-tauri && cargo test --features test-support`。规范见 [CLAUDE.md](./CLAUDE.md)。

[![Contributors](https://contrib.rocks/image?repo=vibeinging/YiYi)](https://github.com/vibeinging/YiYi/graphs/contributors)

## 💬 社区

- [Issues](https://github.com/vibeinging/YiYi/issues) — Bug 反馈 / 功能建议
- [Discussions](https://github.com/vibeinging/YiYi/discussions) — 使用心得 / 技能分享 / 问题讨论

<div align="center">

> *你们用得爽，我就开心，我就有动力。*
>
> *为爱发电，不用管我的成本。*

</div>

## ⭐ Star History

<a href="https://star-history.com/#vibeinging/YiYi&Date">
  <img src="https://api.star-history.com/svg?repos=vibeinging/YiYi&type=Date" alt="Star History Chart" width="600" />
</a>

## 📜 协议

[Apache 2.0](./LICENSE)

---

<div align="center">
<sub>Tauri 2 · Rust · React · TypeScript · SQLite · MCP · DeepSeek V4</sub>
</div>
