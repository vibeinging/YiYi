<div align="center">

**[English](README_EN.md)** | **中文**

<img src="app/src-tauri/icons/icon.png" width="120" height="120" alt="YiYi Logo" />

# YiYi

**Your AI Companion That Grows With You**

一个会成长的桌面 AI 伙伴 — 她能操控你的电脑、执行复杂任务、连接多个平台，并从每次互动中学习进化。

[![GitHub release](https://img.shields.io/github/v/release/HungryFour/YiYi?style=flat-square&color=orange)](https://github.com/HungryFour/YiYi/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square)](https://github.com/HungryFour/YiYi/releases)
[![License](https://img.shields.io/github/license/HungryFour/YiYi?style=flat-square)](LICENSE)

[下载安装](#-安装) · [功能介绍](#-核心功能) · [快速上手](#-快速上手)

</div>

---

## ✨ 核心功能

### 🧠 ReAct Agent 引擎

YiYi 的核心是一个 **ReAct（推理 + 行动）循环引擎**，能够自主完成复杂任务：

- **Think → Act → Observe** 迭代推理，像人一样思考和行动
- 40+ 内置工具：Shell 执行、文件读写、浏览器自动化、截图、日历、包管理……
- 支持 Sub-Agent 派生，将复杂任务分解为子工作流并行执行
- Token 感知的上下文压缩，长对话也不会丢失关键信息

### 🎯 Skills 技能系统

**24 个内置技能**，覆盖日常工作的方方面面：

| 分类 | 技能 |
|:---|:---|
| 📄 **办公套件** | Word、Excel、PDF、PPT 文档处理 |
| 🌐 **浏览器** | 可视化浏览器自动化、网页测试、SEO 分析 |
| ✉️ **通讯** | 邮件收发（IMAP）、新闻聚合 |
| 🎨 **内容创作** | Canvas 设计、算法艺术（p5.js）、前端设计 |
| ⏰ **自动化** | 定时任务调度、自动续行工作流 |
| 🔧 **开发** | 编程助手、MCP Builder、Claude Code 集成 |

> 支持自定义技能创建和技能市场，按需扩展 YiYi 的能力边界。

### 🤖 多平台 Bot 系统

一个 YiYi，连接七大平台：

<table>
<tr>
<td align="center"><b>Discord</b><br/>WebSocket</td>
<td align="center"><b>QQ</b><br/>WebSocket</td>
<td align="center"><b>Telegram</b><br/>Polling</td>
<td align="center"><b>DingTalk</b><br/>Stream</td>
<td align="center"><b>Feishu</b><br/>WebSocket</td>
<td align="center"><b>WeCom</b><br/>Webhook</td>
<td align="center"><b>Webhook</b><br/>通用</td>
</tr>
</table>

- MPSC 消息通道 → 去重 → 防抖(500ms) → 4 Worker 并发消费
- 支持图片、文件等多媒体附件
- 多 Bot 绑定同一会话

### 🌱 成长系统

YiYi 不只是工具，她会**成长**：

- **反思学习** — 捕捉你的纠正和认可，形成行为准则
- **冥想引擎** — 每日定时深度反思，巩固记忆、沉淀原则
- **分层记忆** — Hot / Warm / Cold 三级记忆体系，重要记忆不会遗忘
- **能力画像** — 可视化展示 AI 在各领域的成长轨迹

### 🔌 MCP 协议支持

- 作为 **MCP Client** 连接外部工具服务器，无缝集成第三方能力
- 作为 **MCP Server** 对外暴露本地技能，让其他应用调用 YiYi 的能力

### ⏰ 定时任务

- 支持 Cron 表达式、延迟执行、一次性任务
- 可视化任务管理面板
- 任务完成后推送通知

### 💻 终端集成

- 内置交互式终端（xterm.js）
- Claude Code 专属终端界面
- 支持 PTY 会话管理

---

## 🖥️ 界面预览

> 🚧 截图即将更新，敬请期待

---

## 📦 安装

### 下载安装包

前往 [Releases](https://github.com/HungryFour/YiYi/releases) 下载对应平台的安装包：

| 平台 | 格式 |
|:---|:---|
| **macOS** | `.dmg` |
| **Windows** | `.exe` (NSIS 安装包) |
| **Linux** | `.AppImage` |

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/HungryFour/YiYi.git
cd YiYi/app

# 安装前端依赖
npm ci

# 开发模式
npm run tauri dev

# 生产构建
npm run tauri build
```

---

## 🚀 快速上手

1. **启动 YiYi** — 首次运行会进入设置向导
2. **选择语言** — 支持中文 / English
3. **配置模型** — 填入你的 LLM API Key
4. **设置工作区** — 默认 `~/Documents/YiYi`
5. **开始对话** — 告诉 YiYi 你想做什么，她会自主完成

---

## 🏗️ 技术栈

Tauri 2 · Rust · React 18 · TypeScript · SQLite · MCP Protocol

---

## 🤝 贡献

欢迎任何形式的贡献！请通过 [Issues](https://github.com/HungryFour/YiYi/issues) 提交反馈或建议。

---

<div align="center">

**YiYi** — 以女儿之名，做最好的 AI 伙伴 🧡

</div>
