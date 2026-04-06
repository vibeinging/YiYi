<div align="center">

<img src="app/src-tauri/icons/icon.png" width="120" height="120" alt="YiYi Logo" />

# YiYi

**你的 AI 桌面伙伴，越用越懂你**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/vibeinging/YiYi?include_prereleases)](https://github.com/vibeinging/YiYi/releases)

中文 | [English](./README_EN.md)

</div>

---

## 什么是 YiYi

YiYi 是一个**桌面 AI 个人助手**。她不只是聊天机器人——她能操作你的电脑、执行长任务、管理文件、处理文档，并且会从每次互动中学习和成长。

- **多模型支持**：OpenAI、Claude、DeepSeek、智谱、通义千问、Moonshot 等，随时切换；支持自定义 Provider 插件扩展
- **电脑操作**：文件读写、终端命令、浏览器自动化、截图分析
- **长任务执行**：多步骤任务自动拆解与执行，支持中断恢复、暂停/继续
- **25 内置技能**：PDF/DOCX/XLSX/PPTX 文档处理、Canvas 画布、前端设计、微信公众号写作等，支持自定义扩展
- **多平台 Bot**：同时接入 Discord、QQ、Telegram、钉钉、飞书、企业微信，统一用户身份跨平台识别
- **定时任务**：cron 表达式或自然语言，自动执行周期性工作
- **成长系统**：反思、记忆、冥想——MemMe 向量记忆 + 冥想引擎，用得越多越懂你
- **Buddy 伙伴**：可孵化的桌面伙伴角色，观察你的习惯并陪伴成长
- **安全权限**：文件夹授权、敏感路径保护、Shell 命令安全分析，操作透明可控
- **MCP 协议**：连接外部工具服务器，无限扩展能力

## 快速开始

### 下载安装

前往 [Releases](https://github.com/vibeinging/YiYi/releases) 下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| macOS (Apple Silicon) | `YiYi_x.x.x_aarch64.dmg` |
| macOS (Intel) | `YiYi_x.x.x_x64.dmg` |
| Windows | `YiYi_x.x.x_x64-setup.exe` |
| Linux (Debian/Ubuntu) | `YiYi_x.x.x_amd64.deb` |
| Linux (通用) | `YiYi_x.x.x_amd64.AppImage` |

### 首次使用

1. 打开 YiYi，按照引导向导设置语言和 AI 模型
2. 填入模型提供商的 API Key
3. 开始对话！

## 技术架构

- **前端**：React 18 + TypeScript + Tailwind CSS + Vite + xterm.js 终端
- **后端**：Rust + Tauri v2
- **AI 引擎**：ReAct Agent（思考 → 行动 → 观察循环）+ 多 Agent 协作
- **数据库**：SQLite (WAL 模式)
- **Python 集成**：PyO3 嵌入式运行时，内置文档处理包（pypdf、python-docx、openpyxl、python-pptx）
- **向量记忆**：MemMe 向量存储，支持语义检索
- **浏览器自动化**：Playwright 桥接，支持页面操作与截图分析
- **内建服务**：axum HTTP/WebSocket 服务器（Bot Webhook、MCP Skill Server）

## 开发

```bash
# 克隆仓库
git clone https://github.com/vibeinging/YiYi.git
cd YiYi

# 安装前端依赖
cd app && npm install

# 开发模式运行
npm run tauri dev

# 构建生产版本
npm run tauri build
```

### 前置要求

- Node.js 20+
- Rust 1.77+
- Python 3.13（PyO3 需要）

## 许可证

[Apache License 2.0](LICENSE)
