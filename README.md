<div align="center">

<img src="app/src-tauri/icons/icon.png" width="120" height="120" alt="YiYi Logo" />

# YiYi

**你的 AI 桌面伙伴，越用越懂你**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/HungryFour/YiYi?include_prereleases)](https://github.com/HungryFour/YiYi/releases)

中文 | [English](./README_EN.md)

</div>

---

## 什么是 YiYi

YiYi 是一个**桌面 AI 个人助手**。她不只是聊天机器人——她能操作你的电脑、执行任务、管理文件，并且会从每次互动中学习和成长。

- **多模型支持**：OpenAI、Claude、DeepSeek、智谱、通义千问、Moonshot 等，随时切换
- **电脑操作**：文件读写、终端命令、浏览器操作、截图分析
- **技能系统**：20+ 内置技能，支持自定义扩展，像 App Store 一样丰富
- **多平台 Bot**：同时接入 Discord、QQ、Telegram、钉钉、飞书、企业微信
- **定时任务**：cron 表达式或自然语言，自动执行周期性工作
- **成长系统**：反思、记忆、冥想——用得越多，她就越懂你
- **MCP 协议**：连接外部工具服务器，无限扩展能力

## 快速开始

### 下载安装

前往 [Releases](https://github.com/HungryFour/YiYi/releases) 下载对应平台的安装包：

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

- **前端**：React 18 + TypeScript + Tailwind CSS + Vite
- **后端**：Rust + Tauri v2
- **AI 引擎**：ReAct Agent（思考 → 行动 → 观察循环）
- **数据库**：SQLite (WAL 模式)
- **Python 集成**：PyO3 嵌入式 Python 运行时

## 开发

```bash
# 克隆仓库
git clone https://github.com/HungryFour/YiYi.git
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
