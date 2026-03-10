# YiClaw 新旧项目功能差异分析与实现计划

> 新项目: Rust/Tauri 桌面应用 (`app/src-tauri/`)
> 老项目: Python/FastAPI 服务 (`old_project/src/yipaw/`)
> 说明: 新项目不做本地模型管理 (llama.cpp, MLX, Ollama)

---

## 一、模块对比总览

| 模块 | 老项目 | 新项目 | 状态 |
|------|--------|--------|------|
| ReAct Agent | agentscope ReActAgent | 自研 Rust 实现 | DONE |
| 人格系统 | PromptBuilder + Hooks | 多语言模板 + Bootstrap flag | DONE |
| 记忆系统 | ReMeFb 语义向量搜索 | rg/grep 关键词搜索 | DONE (无向量) |
| Skills | 10 个内置 | 9 个内置 | DONE |
| MCP | agentscope 客户端 | 自研 stdio+HTTP | DONE |
| Cron 定时任务 | APScheduler | tokio-cron-scheduler | DONE |
| Heartbeat | 配置+执行 | 配置+执行+历史持久化 | DONE |
| LLM 客户端 | 多 Provider + 本地 | OpenAI 兼容 API | DONE (无本地) |
| 配置热重载 | ConfigWatcher | ConfigWatcher | DONE |
| 工具集 | 15 个 | 17 个 | DONE |
| 文档处理 | Python skills | Rust 原生 doc_tools | DONE |
| 嵌入式 Python | 原生 Python | tauri-plugin-python | DONE |
| 前端 UI | 4 页面 (React/Ant Design) | 13+ 页面 (React/Ant Design) | DONE |
| 环境变量 | .env 管理 | .env 管理 | DONE |
| Browser | Playwright | headless_chrome | DONE |
| **Channel 系统** | **7 个完整频道** | **7 个频道 (Discord/QQ/Telegram/DingTalk/Feishu/WeCom/Webhook)** | **DONE** |
| **多媒体消息** | **content_parts 体系** | **ContentPart enum + 入站解析（全部频道）** | **部分 DONE（入站完整，出站文本）** |
| **Workspace ZIP** | **整包导出/导入** | **前端 + 后端完整实现** | **DONE** |
| **run_python 工具** | **execute_python_code** | **工具定义 + 路由 + Python bridge** | **DONE** |
| **send_file_to_user** | **有** | **工具 + Tauri 事件 + 前端通知栏** | **DONE** |

---

## 二、待实现功能清单

### P0: Channel 系统实现

老项目支持 7 个频道，每个有完整的连接/收发/渲染逻辑。新项目目前只有配置管理 UI。

#### 2.1 Channel 基础架构 ✅

**新项目现状** (已完成):
- [x] `Channel` trait — `mod.rs` 定义了 `channel_type()`, `start()`, `stop()`, `send()`
- [x] `ContentPart` enum — Text, Image, File, Audio, Video
- [x] `ChannelManager` — 4 个 consumer worker, 消息路由, response handler 注册
- [x] `WebhookServer` — Axum HTTP 服务器，处理 DingTalk/Feishu/WeCom/Generic webhook
- [x] 重连机制 — Discord/QQ/Telegram 均有自动重连
- [x] `process_message` — MCP 工具支持 + history + max_iterations + working_dir

#### 2.2 具体频道实现

| 频道 | 新项目文件 | 状态 | 说明 |
|------|-----------|------|------|
| **Webhook** | `webhook_server.rs` (generic) | ✅ DONE | Axum HTTP 端点 |
| **DingTalk** | `webhook_server.rs` (handle_dingtalk) | ✅ DONE | Webhook 回调 + 发送 |
| **Feishu** | `webhook_server.rs` (handle_feishu) | ✅ DONE | Webhook 回调 + challenge 验证 |
| **Discord** | `discord.rs` | ✅ DONE | WebSocket gateway + 重连 |
| **QQ** | `qq.rs` | ✅ DONE | WebSocket gateway (频道/群/C2C) |
| **WeCom** | `webhook_server.rs` (handle_wecom) | ✅ DONE | Webhook + API 发送 |
| **Telegram** | `telegram.rs` | ✅ DONE | Bot API 长轮询 + Markdown 发送 |
| **iMessage** | 无 | P3 | macOS only, 低优先级 |

#### 2.3 Channel Manager 服务化 ✅

- [x] 内嵌 Axum HTTP 服务器 — `WebhookServer` (DingTalk/Feishu/WeCom/Generic)
- [x] WebSocket 长连接 — Discord/QQ 使用 `tokio-tungstenite`
- [x] Response handlers — 各频道的回复处理器已注册

---

### P1: 多媒体消息处理 ✅ (入站解析)

**老项目参考**: `old_project/src/yipaw/app/channels/base.py`

**新项目状态**:
- [x] `ContentPart` enum 定义 — Text, Image, File, Audio, Video
- [x] Discord: attachments 解析 (image/file by content_type)
- [x] Telegram: photo/document/voice/audio/video 解析
- [x] DingTalk: text/image/file 类型解析
- [x] Feishu: text/image/file 类型解析
- [ ] **出站渲染**: Agent 输出多媒体时的发送逻辑 (优先级低，Agent 主要返回文本)
- [ ] `ContentPart` enum 定义
- [ ] 各频道的 ContentPart 解析 (incoming)
- [ ] 各频道的 ContentPart 渲染 (outgoing)
- [ ] Agent 工具支持多媒体输入

---

### P1: send_file_to_user 工具 ✅

**老项目参考**: `old_project/src/yipaw/agents/tools/__init__.py`

Agent 可以向用户/频道推送文件。在桌面应用场景下:
- [x] 实现为 Tauri 事件 (`agent://send_file`)，前端可监听并弹出保存对话框
- [x] 工具定义 + handler 在 `tools.rs`，通过全局 `APP_HANDLE` 发射事件

---

### P2: Workspace ZIP 导出/导入 ✅

**老项目参考**: `old_project/src/yipaw/app/routers/workspace.py`

新项目 `workspace.rs` 已有 `upload_workspace` 和 `download_workspace` 函数实现 ZIP 操作。

**状态**:
- [x] 后端: `workspace.rs` ZIP 打包/解包
- [x] 前端 API: `workspace.ts` upload/download 函数
- [x] UI: Workspace 页面导入/导出按钮

---

### P3: run_python 工具暴露 ✅

**状态**:
- [x] 工具定义: `builtin_tools()` 中 `run_python`
- [x] 路由: `execute_tool()` match arm
- [x] Handler: `run_python_tool()` 调用 `python_bridge::call_python("run_code", ...)`

---

### P1.5: send_file_to_user 工具 ✅

**新增** (新项目独有特性)

Agent 可以通过 `send_file_to_user` 工具向前端发送文件，触发通知栏显示。

**状态**:
- [x] 工具定义 + handler
- [x] Tauri 事件发射 (`agent://send_file`)
- [x] 前端通知栏 UI (App.tsx)

---

## 三、设计差异（无需对齐）

| 差异 | 说明 |
|------|------|
| 运行方式 | 老项目 FastAPI 服务器 (localhost:8088) → 新项目 Tauri 桌面应用 |
| Browser | Playwright → headless_chrome（功能等价） |
| 本地 LLM | 不做（明确排除） |
| Console 频道 | 不需要（前端直接就是 chat UI） |
| dingtalk_channel skill | 依赖频道实现，频道完成后再评估 |
| 向量搜索 | 不做（用 rg/grep 关键词搜索替代） |

---

## 四、实现顺序 (已完成)

```
Phase 1: 基础设施 ✅
  1. run_python 验证 ................. ✅ 已实现
  2. Workspace ZIP 验证 .............. ✅ 已实现
  3. send_file_to_user ............... ✅ 已实现 (Tauri event + 前端通知栏)

Phase 2: Channel 基础架构 ✅
  4. Channel trait + ContentPart ..... ✅ 已实现
  5. ChannelManager (生命周期/重连) .. ✅ 已实现 + MCP 工具支持
  6. 内嵌 HTTP 服务器 ............... ✅ Axum WebhookServer

Phase 3: Channel 实现 ✅
  7. Webhook 频道 ................... ✅ generic webhook
  8. DingTalk 频道 .................. ✅ webhook callback + 图文解析
  9. Feishu 频道 .................... ✅ webhook + challenge + 富文本解析
  10. Discord 频道 .................. ✅ WebSocket gateway + attachment 解析
  11. QQ 频道 ....................... ✅ WebSocket gateway (频道/群/C2C)
  12. WeCom 企业微信 ................ ✅ webhook + API
  13. Telegram 频道 ................. ✅ Bot API 长轮询 + photo/document 解析

Phase 4: 多媒体消息 ✅ (入站)
  14. Discord attachments 解析 ....... ✅ Image/File 按 content_type
  15. Telegram photo/document 解析 ... ✅ 各媒体类型到 ContentPart
  16. DingTalk/Feishu 富文本解析 .... ✅ text/image/file 类型

Phase 5: 剩余 (低优先级)
  17. 多媒体消息出站渲染 ............ P3 (Agent 输出含图片时发送)
  18. iMessage ...................... P3 (macOS only)
```

**总结**: 核心功能已全部实现，剩余为低优先级增强项目。

---

## 五、文件路径参考

### 新项目关键文件
```
app/src-tauri/src/
  commands/
    agent.rs ............ 聊天命令 (chat, history, /compact)
    channels.rs ......... 频道配置管理
    skills.rs ........... Skills CRUD
    cronjobs.rs ......... 定时任务
    heartbeat.rs ........ 心跳
    workspace.rs ........ 工作区文件管理
    models.rs ........... LLM Provider 管理
    mcp.rs .............. MCP 客户端管理
    env.rs .............. 环境变量
    browser.rs .......... 浏览器控制
    shell.rs ............ Shell 执行
  engine/
    react_agent.rs ...... ReAct 循环 + 人格 + 压缩
    tools.rs ............ Agent 工具集 (17个)
    doc_tools.rs ........ 文档处理 (PDF/XLSX/DOCX)
    mcp_runtime.rs ...... MCP 运行时
    llm_client.rs ....... LLM API 调用
    python_bridge.rs .... Python 嵌入桥接
    channels/
      manager.rs ........ Channel 消息路由
    scheduler.rs ........ Cron 调度器
    config_watcher.rs ... 配置热重载
  state/
    mod.rs .............. AppState
    config.rs ........... 配置结构
    providers.rs ........ LLM Provider 定义
```

### 老项目参考文件
```
old_project/src/yipaw/
  app/
    channels/
      base.py ........... BaseChannel 基类
      manager.py ........ ChannelManager
      renderer.py ....... 消息渲染
      dingtalk/ ......... 钉钉实现
      feishu/ ........... 飞书实现
      discord_/ ......... Discord 实现
      qq/ ............... QQ 实现
      telegram/ ......... Telegram 实现
      imessage/ ......... iMessage 实现
    mcp/ ................ MCP 管理
    crons/ .............. 定时任务
  agents/
    react_agent.py ...... YiPawAgent
    prompt.py ........... PromptBuilder
    tools/ .............. Agent 工具
    skills/ ............. 内置 Skills
    memory/ ............. 记忆管理
    hooks/ .............. Bootstrap/Compaction
    md_files/ ........... 人格模板 (zh/en)
  providers/ ............ LLM Provider 注册
  config/ ............... 配置管理
```
