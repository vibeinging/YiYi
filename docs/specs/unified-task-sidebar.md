# 统一任务侧边栏：产品设计文档

> 状态：Confirmed
> 日期：2026-03-13
> 前置文档：[single-window-task-model.md](./single-window-task-model.md)、[single-window-ux-design.md](./single-window-ux-design.md)
>
> **决策记录（2026-03-13）**：
> 1. 任务详情 → **左侧滑出浮层**，覆盖主区域左半部分，Chat 仍在下层
> 2. 任务上下文 → **AI 总结背景**传递给任务（非原始消息传递）
> 3. 任务完成 → 主 Chat 插入**简短通知卡片含 Summary**，作为子任务记忆注入主对话
> 4. Agent 判断 → 新建 **`task_proposer` system skill**（独立判断逻辑）
> 5. 并发资源 → **独立通道**，主 Chat 和任务各有额度，触发 rate limit 则重试等待
> 6. 高级菜单 → **Popover + 可展开列表**（A+B 混合）
> 7. 不归档 → 按**最近操作时间**排序，支持**右键置顶**

---

## 一、设计目标

将侧边栏从"功能导航栏"重新定位为**任务管理中心**。所有需要持续执行、定时执行、或后台运行的工作，统一在侧边栏中管理。主区域永远是 Chat。

**核心变化**：
- 侧边栏 = 任务列表（进行中 + 定时 + 已完成）
- 所有高级功能（Skills / MCP / Bots / Workspace / Terminal / Settings）收入一个"高级"入口
- 长任务不再在聊天中阻塞，而是转入侧边栏后台执行

---

## 二、什么是"任务"

### 2.1 统一任务模型

"任务"是一个统一概念，涵盖所有**非即时完成**的工作：

| 任务类型 | 来源 | 示例 | 现有实现 |
|---------|------|------|---------|
| **即时长任务** | 用户在 Chat 发起，Agent 判断需要多步 | "帮我做个网站"、"重构这段代码" | auto-continue、Claude Code tool |
| **定时任务** | 用户设定周期性执行 | "每天 9 点给我发新闻" | CronJob |
| **一次性定时** | 用户设定某个时间点触发 | "明天下午 3 点提醒我开会" | CronJob (once) |
| **子任务** | Agent 自行拆分的工作项 | create_task 工具创建的子步骤 | Task 系统 |
| **Bot 触发任务** | 来自 Bot 消息的复杂请求 | Discord 用户让 Bot 做分析 | Bot session |

### 2.2 判断标准：什么算长任务？

Agent 在首轮回复时进行判断。以下条件满足任一即为长任务：

**明确信号（自动判定）**：
- Agent 调用了 `claude_code` 工具（天然是长任务）
- Agent 调用了 `request_continuation`（多轮执行）
- Agent 调用了 `spawn_agents`（多 Agent 并行）
- 用户显式使用 `/task` 命令

**启发式信号（Agent 自行判断）**：
- 任务涉及文件创建/修改（"帮我做一个..."、"创建一个..."）
- 任务涉及多步骤分析（"分析这份 100 页的报告"）
- 任务描述暗示高复杂度（"完整的"、"从零开始"、"全面的"）

**不算长任务**：
- 简单问答、闲聊
- 单步查询（天气、翻译一句话）
- 知识解释、概念说明

---

## 三、核心交互流程

### 3.1 长任务检测 → 用户确认 → 后台执行

```
用户在 Chat 发送消息
        │
        ▼
Agent 首轮处理
        │
        ├─ 判断为简单任务 → 主窗口直接回答（现有行为，不变）
        │
        └─ 判断为长任务 → 在 Chat 中插入确认卡片
                              │
                              ├─ 用户选择 [后台执行]
                              │       │
                              │       ▼
                              │   创建任务 → 出现在侧边栏
                              │   主窗口释放，用户可继续聊天
                              │   任务在后台独立 session 中执行
                              │
                              └─ 用户选择 [在这里继续]
                                      │
                                      ▼
                                  主窗口内完成（现有行为）
                                  不创建侧边栏任务
```

### 3.2 确认卡片设计

Agent 判断为长任务后，在聊天回复的末尾插入一个确认卡片：

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  这个任务需要一些时间来完成。                          │
│                                                     │
│  📋 创建个人作品集网站                                │
│  预计需要多轮执行，涉及文件创建和代码编写              │
│                                                     │
│  ┌──────────────┐    ┌──────────────────┐           │
│  │  🚀 后台执行  │    │  💬 在这里继续    │           │
│  └──────────────┘    └──────────────────┘           │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**实现方式**：
- Agent 通过调用 `propose_background_task` 工具来触发此卡片
- 工具参数包含：`task_name`（任务名称）、`task_description`（简要描述）、`estimated_complexity`（预估复杂度）
- 前端渲染为可交互的确认卡片，而不是纯文字

**两个按钮的行为**：

| 按钮 | 行为 |
|------|------|
| **后台执行** | 1. 创建新的 task session（`source = "task"`，`parent_session_id` 指向主聊天）<br>2. 将用户原始消息作为 task 的首条消息<br>3. 任务出现在侧边栏"进行中"区域<br>4. 主聊天 loading 结束，用户可继续输入<br>5. 助手在主聊天追加一条确认消息："好的，任务已在后台开始。你可以在左侧查看进度。" |
| **在这里继续** | 1. 不创建任务<br>2. Agent 继续在主聊天中执行（现有行为）<br>3. 如果是多轮任务，显示 LongTaskProgressPanel |

### 3.3 自动判定 vs 手动触发

某些场景可以跳过确认，直接创建任务：

| 场景 | 是否需要确认 | 理由 |
|------|------------|------|
| Agent 判断为长任务 | **需要确认** | 用户应有选择权 |
| 用户使用 `/task` 命令 | **不需要** | 用户已明确意图 |
| 定时任务创建 | **不需要** | 定时任务天然是后台的 |
| Claude Code 工具被调用 | **需要确认** | 用户可能想在当前窗口看过程 |
| Bot 收到复杂请求 | **不需要** | Bot 消息天然是后台处理 |

---

## 四、侧边栏重设计

### 4.1 新布局

```
┌──────────────────┐
│  ● YiYi      │  ← 品牌 + 连接状态
│                   │
│  ─── 进行中 ───   │
│                   │
│  ◉ 创建个人网站   │  ← 绿色脉冲点
│    正在编写样式... │
│    2m ago         │
│                   │
│  ◉ 代码重构       │
│    Claude Code    │
│    5m ago         │
│                   │
│  ─── 定时 ───     │
│                   │
│  🔄 每日新闻摘要  │
│    每天 08:00     │
│    上次: 3h前 ✓   │
│                   │
│  🔄 服务器监控    │
│    每 5min        │
│    上次: 2min前 ✓ │
│                   │
│  ─── 已完成 ───   │
│                   │
│  ✓ 分析报告       │
│    2h前           │
│                   │
│  ✓ PPT制作        │
│    昨天           │
│                   │
│  ─── 更多(4) ─── │  ← 折叠的更早完成任务
│                   │
│                   │
│  ┌───────────┐   │
│  │ 🔧 高级    │   │  ← 所有高级功能入口
│  └───────────┘   │
└──────────────────┘
```

### 4.2 侧边栏元素详解

#### 品牌区（顶部）
- 应用图标 + 名称
- 连接状态指示灯（绿 = 正常，红 = 异常）
- 可拖拽区域（macOS traffic lights）

#### 进行中区域
- 按开始时间倒序排列（最新的在上面）
- 每个条目显示：
  - 状态点（◉ 绿色脉冲 = running，◉ 黄色 = paused）
  - 任务名称（一行，截断）
  - 当前步骤描述（一行，灰色小字）
  - 相对时间（"2m ago"、"刚刚"）
- 点击条目 → 主区域切换到该任务的详情视图
- 右键条目 → 上下文菜单：暂停、取消、查看详情

#### 定时任务区域
- 按下次执行时间排序
- 每个条目显示：
  - 🔄 循环图标
  - 任务名称
  - 频率描述（"每天 08:00"、"每 5min"）
  - 上次执行状态 + 时间
- 点击条目 → 主区域显示执行历史
- 右键 → 暂停调度、立即执行、编辑、删除

#### 已完成区域
- 按最近操作时间倒序
- 每个条目显示：
  - ✓ 绿色勾号（成功）或 ✗ 红色叉号（失败）
  - 任务名称
  - 完成时间
- 点击 → 打开详情浮层查看结果
- **不自动归档**，所有任务永久保留在列表中
- 超过 10 个已完成任务时，折叠为"更多(N)"可展开

#### 排序与置顶

所有区域内的排序规则：
1. **置顶的任务**始终在各自区域的最前面（按置顶时间排序）
2. **非置顶的任务**按 `lastActivityAt`（最近操作时间）降序
3. `lastActivityAt` 在以下时机更新：状态变更、进度更新、用户查看详情、用户追加指令

**右键菜单**：
- 右键点击任务条目 → 弹出上下文菜单
- 菜单项：
  - 📌 置顶 / 取消置顶
  - 暂停 / 继续（仅 RUNNING / PAUSED）
  - 取消（仅 RUNNING / PAUSED / PENDING）
  - 重新执行（仅 COMPLETED / FAILED）
  - 删除（所有状态）

#### 高级入口（底部）— Popover + 可展开列表

🔧 图标按钮，支持两种交互模式：

**单击**：弹出 Popover 浮层菜单（悬浮在侧边栏右侧）

```
                    ┌───────────────────┐
                    │  🧩 Skills        │
                    │  ⚡ MCP 服务      │
                    │  🤖 Bots         │
                    │  📁 工作区        │
                    │  💻 终端          │
                    │  🔔 心跳监控      │
                    │  ─────────────── │
                    │  ⚙️  设置         │
  ┌────────────┐   └───────────────────┘
  │ 🔧 高级    │ ←
  └────────────┘
```

**长按或双击**：在侧边栏内展开为列表（占据侧边栏底部空间，挤压任务列表）

```
┌──────────────────┐
│  ...任务列表...   │
│                   │
│  ─── 高级 ───    │
│  🧩 Skills       │
│  ⚡ MCP 服务     │
│  🤖 Bots        │
│  📁 工作区       │
│  💻 终端         │
│  ⚙️  设置        │
│  [收起 ▲]        │
└──────────────────┘
```

点击菜单项 → 主区域切换到对应页面（高级页面通过浮层展示，与任务详情浮层共享 z-index 层级）。点击其他区域或切换页面后，Popover/展开列表自动收起。

### 4.3 侧边栏折叠态

窗口较窄或用户手动折叠时，侧边栏收窄为图标模式：

```
┌────┐
│ ●  │  ← 连接状态
│    │
│ 2  │  ← 进行中任务数（badge）
│    │
│ 🔄 │  ← 定时任务存在的指示
│    │
│    │
│ 🔧 │  ← 高级
└────┘
```

点击数字 badge → 展开侧边栏。

### 4.4 空状态

没有任何任务时的侧边栏：

```
┌──────────────────┐
│  ● YiYi      │
│                   │
│                   │
│    (空插画)       │
│                   │
│  还没有任务       │
│  在聊天中发起     │
│  复杂的请求，     │
│  它们会出现在这里 │
│                   │
│                   │
│  🔧 高级          │
└──────────────────┘
```

---

## 五、任务详情浮层

点击侧边栏的任务条目后，任务详情以**左侧滑出浮层**的形式覆盖在主区域上方。Chat 始终在下层保持状态，不被卸载。

### 5.1 浮层交互

**打开**：点击侧边栏任务条目 → 浮层从侧边栏右边缘向右滑出（`transform: translateX`，约 300ms ease-out）

**关闭**：
- 点击浮层左上角"← 返回"按钮
- 点击浮层右侧的半透明遮罩区域
- 按 Escape 键
- 点击侧边栏中其他非任务区域

**层叠关系**：
```
z-index 层级：
  底层 (z-0)    — Chat 主区域（始终渲染，不卸载）
  遮罩 (z-40)   — 半透明黑色遮罩（opacity 0.2，覆盖 Chat 区域）
  浮层 (z-50)   — 任务详情面板（480px 宽，从左侧滑出）
  侧边栏 (z-60) — 侧边栏始终在最上层
```

**视觉效果**：
- 浮层宽度：480px（可拖拽调整，最小 400px，最大 70% 窗口宽度）
- 浮层背景：`var(--color-bg-elevated)` + 左侧 1px border + box-shadow
- 遮罩：`rgba(0, 0, 0, 0.2)` + `backdrop-filter: blur(2px)`
- 动画：滑入 300ms ease-out，滑出 200ms ease-in

### 5.2 任务详情布局

```
┌──────────────────────────────────────────────────────────┐
│  ← 返回聊天        创建个人作品集网站        [暂停][取消]│
├──────────────────────────────────────────────────────────┤
│                                                          │
│  状态: ● 进行中     耗时: 4m 12s     步骤: 3/6          │
│  ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱  50%                           │
│                                                          │
│  ── 执行过程 ─────────────────────────────────────────   │
│                                                          │
│  ✓ 规划网站结构                              10:32:01    │
│    确定使用单页应用，包含首页、项目、简历三个板块          │
│                                                          │
│  ✓ 创建 HTML 框架                            10:32:15    │
│    ▸ write_file index.html                               │
│    ▸ write_file styles.css                               │
│                                                          │
│  ✓ 编写核心样式                              10:33:02    │
│    极简风格，黑白配色                                     │
│                                                          │
│  ● 添加动画效果                              10:34:10    │
│    正在为页面切换添加淡入淡出动画...                      │
│    ▸ edit_file styles.css (running)                      │
│                                                          │
│  ○ 创建项目展示页                                        │
│  ○ 生成预览                                              │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  [输入框: 对任务追加指令...]                    [发送]    │
└──────────────────────────────────────────────────────────┘
```

### 5.3 详情浮层的功能

**头部**：
- 返回按钮 → 关闭浮层，回到 Chat
- 任务名称
- 操作按钮：暂停 / 继续 / 取消

**状态栏**：
- 当前状态（进行中 / 已暂停 / 已完成 / 失败）
- 累计耗时（实时更新）
- 步骤进度（完成数 / 总数）
- 整体进度条

**执行时间线**：
- 类似 GitHub Actions 的步骤视图
- 每个步骤包含：
  - 状态图标（✓ 完成、● 进行中、○ 待开始）
  - 步骤标题（Agent 自动生成的描述）
  - 展开后的详细信息（工具调用列表、输出片段）
  - 时间戳
- 进行中的步骤实时更新

**底部输入框**：
- 向正在执行的任务追加指令
- 类似主 Chat 的输入框，但发送的消息进入任务的 session 而非主 Chat

### 5.4 Claude Code 任务的特殊展示

当任务是 Claude Code 类型时，详情视图增加终端输出区域：

```
┌──────────────────────────────────────────────────────────┐
│  ← 返回聊天        Claude Code: 重构登录模块   [取消]    │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  状态: ● 执行中     耗时: 2m 34s                         │
│                                                          │
│  ── 终端输出 ─────────────────────────── [弹出窗口 ↗] ─  │
│  ┌────────────────────────────────────────────────────┐  │
│  │ $ claude -p "重构登录模块..."                       │  │
│  │                                                    │  │
│  │ I'll refactor the login module. Let me start by    │  │
│  │ reading the current implementation...              │  │
│  │                                                    │  │
│  │ > Reading src/auth/login.ts                        │  │
│  │ > Reading src/auth/types.ts                        │  │
│  │ > Editing src/auth/login.ts                        │  │
│  │ > Writing src/auth/login.test.ts                   │  │
│  │ █                                                  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ── 工具调用 ──                                          │
│  ✓ Read login.ts                                         │
│  ✓ Read types.ts                                         │
│  ● Edit login.ts (running)                               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

终端输出区域右上角有"弹出窗口 ↗"按钮，可以将终端输出弹出到独立的 Tauri 窗口（复用已实现的 ClaudeCodeTerminal 组件）。

### 5.5 定时任务的详情浮层

```
┌──────────────────────────────────────────────────────────┐
│  ← 返回聊天       每日新闻摘要       [暂停调度][立即执行]│
├──────────────────────────────────────────────────────────┤
│                                                          │
│  🔄 每天 08:00     下次执行: 明天 08:00                  │
│  状态: 活跃       累计执行: 12 次     成功率: 100%        │
│                                                          │
│  ── 执行历史 ─────────────────────────────────────────   │
│                                                          │
│  ✓ 今天 08:02     耗时 45s                               │
│    "今日科技头条：OpenAI 发布 GPT-5..."                  │
│                              [查看完整结果]              │
│                                                          │
│  ✓ 昨天 08:01     耗时 38s                               │
│    "今日科技头条：Apple 发布 M5 芯片..."                  │
│                              [查看完整结果]              │
│                                                          │
│  ✓ 前天 08:03     耗时 52s                               │
│    "今日科技头条：特斯拉 FSD v14..."                      │
│                              [查看完整结果]              │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  [编辑频率]  [编辑提示词]  [删除任务]                     │
└──────────────────────────────────────────────────────────┘
```

### 5.6 已完成任务的详情浮层

```
┌──────────────────────────────────────────────────────────┐
│  ← 返回聊天       分析《市场趋势报告》     [重新执行]    │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ✓ 已完成     耗时: 2m 15s     完成于: 今天 14:32       │
│                                                          │
│  ── 执行结果 ─────────────────────────────────────────   │
│                                                          │
│  **报告摘要**                                            │
│                                                          │
│  **核心观点**：                                          │
│  1. AI Agent 市场预计 2027 年达到 1200 亿...              │
│  2. 多模态交互成为标配...                                │
│  3. 隐私计算需求爆发...                                  │
│                                                          │
│  **关键数据**：                                          │
│  - 全球 AI 支出同比增长 42%                              │
│  - ...                                                   │
│                                                          │
│  [复制结果]  [导出为文档]  [在聊天中引用]                 │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## 六、任务生命周期

### 6.1 状态机

```
                用户选择"后台执行"  /  /task 命令  /  定时触发
                              │
                              ▼
                         ┌─────────┐
                    ┌──→ │ PENDING │ ──→ 排队等待资源
                    │    └────┬────┘
                    │         │ 资源就绪
                    │         ▼
                    │    ┌─────────┐
                    │    │ RUNNING │ ←──── 用户点击"继续"
                    │    └────┬────┘
                    │         │
                    │    ┌────┼──────────────┐
                    │    │    │              │
                    │  暂停  完成          出错/取消
                    │    │    │              │
                    │    ▼    ▼              ▼
                    │ ┌──────┐ ┌──────────┐ ┌──────────┐
                    │ │PAUSED│ │COMPLETED │ │  FAILED  │
                    │ └──┬───┘ └──────────┘ │ CANCELLED│
                    │    │                  └──────────┘
                    │    │ 继续
                    └────┘
```

### 6.2 各状态下的用户操作

| 状态 | 侧边栏显示 | 可执行操作 |
|------|-----------|-----------|
| **PENDING** | 灰色点 + "等待中" | 取消 |
| **RUNNING** | 绿色脉冲点 + 进度描述 | 暂停、取消、追加指令 |
| **PAUSED** | 黄色点 + "已暂停" | 继续、取消、追加指令 |
| **COMPLETED** | 绿色勾 ✓ | 查看结果、重新执行、归档 |
| **FAILED** | 红色叉 ✗ | 查看原因、重试、归档 |
| **CANCELLED** | 灰色叉 | 重新开始、归档 |

### 6.3 并发控制（独立通道）

**主 Chat 和后台任务使用独立的并发通道**，互不影响：

| 通道 | 并发额度 | 说明 |
|------|---------|------|
| 主 Chat | 1（串行） | 用户的实时对话，始终可用 |
| 后台任务 | 最多 3 个并行 | 长任务、Claude Code、定时任务执行 |

- 第 4 个后台任务进入 PENDING 排队
- 侧边栏显示排队提示："等待中（前面还有 1 个任务）"
- **Rate limit 处理**：任何通道触发 API rate limit 时，自动重试等待（指数退避，最大等待 60s），不报错给用户。侧边栏状态暂时显示"等待 API..."
- 主 Chat 触发 rate limit 不影响后台任务，反之亦然

### 6.4 任务完成通知 + 记忆注入

| 场景 | 通知方式 |
|------|---------|
| App 在前台，用户在 Chat 页 | 侧边栏任务条目变绿 + 主 Chat 插入通知卡片 |
| App 在前台，用户在其他页面 | 侧边栏任务条目变绿 + Toast 提示 |
| App 在后台（最小化到托盘） | 系统原生通知 + 托盘图标变化 |

**通知卡片设计**：

任务完成后，在主 Chat 中插入一张简短的通知卡片。卡片包含任务的 Summary，作为**子任务的记忆注入主对话上下文**。这样主 Chat 的 Agent 能感知到任务的结果，用户追问时能直接关联。

```
┌─────────────────────────────────────────────────┐
│  ✓ 任务完成：创建个人作品集网站                   │
│  耗时 6 分 12 秒 · 6 个步骤                      │
│                                                  │
│  Summary:                                        │
│  已创建极简风格的个人作品集网站，包含首页、项目    │
│  展示页（卡片布局）和简历页。使用了响应式设计，    │
│  文件位于 ~/Documents/YiYi/portfolio-site/    │
│                                                  │
│  产出文件: index.html, styles.css, projects.html  │
│                                                  │
│  [查看详情]  [打开文件夹]                         │
└─────────────────────────────────────────────────┘
```

**记忆注入机制**：

通知卡片同时以 `system` 角色消息写入主 Chat 的 session 历史（DB 中 role="system"），格式为：

```
[Task Completed] 创建个人作品集网站
Summary: 已创建极简风格的个人作品集网站...
Output files: index.html, styles.css, projects.html
Working dir: ~/Documents/YiYi/portfolio-site/
```

这样当用户在主 Chat 后续说"网站做好了吗"或"打开刚才做的网站"时，Agent 能从上下文中找到这条记忆。

---

## 七、前后端架构

### 7.1 数据模型

在现有 `sessions` 表基础上扩展：

```sql
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN task_status TEXT DEFAULT NULL;  -- PENDING/RUNNING/PAUSED/COMPLETED/FAILED/CANCELLED
ALTER TABLE sessions ADD COLUMN task_name TEXT DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN task_type TEXT DEFAULT NULL;    -- 'oneoff' | 'claude_code' | 'recurring' | 'sub_task'
ALTER TABLE sessions ADD COLUMN task_meta TEXT DEFAULT NULL;    -- JSON: { estimated_steps, current_step, progress_pct, ... }
ALTER TABLE sessions ADD COLUMN started_at INTEGER DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN finished_at INTEGER DEFAULT NULL;
```

Task 本质上是一个**带标记的 Session**。不新建表，复用 sessions 表，通过 `source = 'task'` + `task_status` 区分。

定时任务保留现有 `cronjobs` 表，但每次执行时创建一个 task session（`source = 'task'`，`task_type = 'recurring'`），关联到 cronjob。

### 7.2 新增 Tauri Commands

```rust
// 任务管理
#[tauri::command]
async fn create_task(session_id: String, task_name: String, task_type: String, message: String) -> Result<TaskInfo, String>;

#[tauri::command]
async fn list_tasks(status_filter: Option<String>) -> Result<Vec<TaskInfo>, String>;

#[tauri::command]
async fn get_task(task_session_id: String) -> Result<TaskInfo, String>;

#[tauri::command]
async fn pause_task(task_session_id: String) -> Result<(), String>;

#[tauri::command]
async fn resume_task(task_session_id: String, feedback: Option<String>) -> Result<(), String>;

#[tauri::command]
async fn cancel_task(task_session_id: String) -> Result<(), String>;

#[tauri::command]
async fn delete_task(task_session_id: String) -> Result<(), String>;

#[tauri::command]
async fn pin_task(task_session_id: String, pinned: bool) -> Result<(), String>;

// 任务确认（用户在 Chat 中选择"后台执行"时调用）
// context_summary 由 Agent 在 propose_background_task 时生成，是对当前对话背景的总结
#[tauri::command]
async fn confirm_background_task(
    parent_session_id: String,
    task_name: String,
    original_message: String,
    context_summary: String,  // AI 总结的对话背景
) -> Result<TaskInfo, String>;
```

### 7.3 新增 Tauri Events

```typescript
// 任务状态变更
'task://status_change' → { task_id, status, progress_pct?, current_step? }

// 任务创建（用于侧边栏实时更新）
'task://created' → { task_id, task_name, task_type }

// 任务完成
'task://completed' → { task_id, task_name, result_preview }

// 任务进度更新（步骤级别）
'task://progress' → { task_id, step_index, step_name, step_status }
```

### 7.4 新增 Agent 工具

```json
{
  "name": "propose_background_task",
  "description": "当你判断当前任务需要较长时间执行时，调用此工具向用户提议在后台执行。你需要总结当前对话的背景信息，作为任务的上下文传递。",
  "parameters": {
    "task_name": { "type": "string", "description": "任务名称，简洁明了（如：创建个人作品集网站）" },
    "task_description": { "type": "string", "description": "简要说明任务内容和预计步骤" },
    "context_summary": { "type": "string", "description": "对当前对话背景的总结。包括用户的需求细节、偏好、约束条件等。这段总结会作为任务的初始上下文。" },
    "estimated_steps": { "type": "number", "description": "预估步骤数" }
  }
}
```

此工具的 `execute_tool` 实现返回一个特殊的 ToolResult，前端识别后渲染为确认卡片。

**context_summary 示例**：
```
用户需要一个个人作品集网站。要求：极简风格，能展示项目截图和简历。
用户是产品经理，不会写代码，需要完整可用的成品。
之前在聊天中提到过喜欢黑白配色。
```

当用户确认"后台执行"时，`context_summary` 会作为任务 session 的首条 system 消息注入，让任务 Agent 拥有完整的背景信息。

### 7.5 前端状态管理

新增 `taskSidebarStore`（独立于 chatStreamStore）：

```typescript
interface TaskSidebarState {
  tasks: TaskInfo[];
  selectedTaskId: string | null;  // 当前浮层展示的任务（null = 浮层关闭）
  pinnedTaskIds: Set<string>;     // 用户置顶的任务

  // Actions
  loadTasks: () => Promise<void>;
  selectTask: (taskId: string | null) => void;  // null = 关闭浮层
  updateTask: (taskId: string, updates: Partial<TaskInfo>) => void;
  removeTask: (taskId: string) => void;
  pinTask: (taskId: string) => void;
  unpinTask: (taskId: string) => void;
}

interface TaskInfo {
  id: string;              // task session id
  name: string;
  type: 'oneoff' | 'claude_code' | 'recurring' | 'sub_task';
  status: TaskStatus;
  parentSessionId: string | null;
  progressPct: number;
  currentStep: string;
  startedAt: number | null;
  finishedAt: number | null;
  lastActivityAt: number;  // 最近操作时间（排序依据）
  resultPreview: string | null;
  pinned: boolean;
}

// 排序规则：置顶的在前 → 按 lastActivityAt 降序
// lastActivityAt 在以下时机更新：状态变更、进度更新、用户查看详情
```

### 7.6 浮层渲染

```typescript
// App.tsx 中，与 ChatPage 同级渲染（不是替换）
const selectedTaskId = useTaskSidebarStore(s => s.selectedTaskId);
const selectTask = useTaskSidebarStore(s => s.selectTask);

return (
  <>
    {/* Chat 始终渲染，不卸载 */}
    <ChatPage />

    {/* 任务详情浮层（覆盖在 Chat 上方） */}
    {selectedTaskId && (
      <>
        {/* 半透明遮罩 */}
        <div
          className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]"
          onClick={() => selectTask(null)}
        />
        {/* 详情面板（从左侧滑入） */}
        <TaskDetailOverlay
          taskId={selectedTaskId}
          onClose={() => selectTask(null)}
        />
      </>
    )}
  </>
);
```

点击侧边栏任务条目 → `selectTask(taskId)` → 浮层滑入。
点击遮罩 / 返回按钮 / Escape → `selectTask(null)` → 浮层滑出。
Chat 始终在下层，状态不丢失。

---

## 八、与现有系统的整合

### 8.1 CronJob → 定时任务

| 现有行为 | 新行为 |
|---------|--------|
| CronJob 在独立页面管理 | 定时任务在侧边栏显示，详情在主区域 |
| CronJob 执行结果在执行历史弹窗中查看 | 执行历史在任务详情视图中查看 |
| CronJob 创建通过 CronJobs 页面的表单 | 可以在 Chat 中用自然语言创建，也可以从高级入口创建 |

CronJobs 页面保留在"高级"菜单中，作为高级用户的管理界面。侧边栏的定时任务是其简化视图。

### 8.2 Task 系统（右侧面板）→ 合并

现有的 TaskPanel（右侧）和 TaskDetailDrawer 合并到侧边栏：

| 现有组件 | 去向 |
|---------|------|
| `TaskPanel`（右侧边栏） | 删除，功能由左侧边栏任务列表取代 |
| `TaskDetailDrawer` | 删除，功能由主区域 TaskDetailView 取代 |
| `taskStore` | 合并到 `taskSidebarStore` |

### 8.3 LongTaskProgressPanel → 保留但改变触发条件

- 当用户选择"在这里继续"时，LongTaskProgressPanel 继续在 Chat 中显示（现有行为）
- 当任务在后台执行时，进度信息显示在侧边栏条目和 TaskDetailView 中，不在主 Chat 中

### 8.4 ClaudeCodePanel / ClaudeCodeTerminal → 保留

- ClaudeCodePanel 在任务详情视图中复用
- ClaudeCodeTerminal 弹出窗口功能保留
- 当 Claude Code 是在后台任务中运行时，其流式事件通过 task session id 路由

### 8.5 迁移策略

不做数据迁移。现有的 sessions 数据 `parent_session_id` 默认为 NULL，不受影响。新的任务系统是纯增量。

---

## 九、分阶段实施

### Phase 1：侧边栏骨架 + 高级折叠（2-3天）

**目标**：完成侧边栏的视觉重设计，不涉及任务逻辑。

**改动**：
1. 重构 `App.tsx` 侧边栏布局
   - 移除现有导航列表
   - 添加任务列表区域（初始为空状态）
   - 底部添加"高级"弹出菜单（Popover），包含所有原有导航项
2. 主区域始终渲染 ChatPage（原有页面切换逻辑移到高级菜单的处理函数中）
3. 侧边栏折叠态适配

**不变**：所有功能页面保留，只是入口变了。

### Phase 2：任务创建 + 确认流程（3-4天）

**目标**：实现"长任务检测 → 确认 → 后台执行"的核心流程。

**改动**：
1. DB：sessions 表添加 task 相关字段
2. 后端：`create_task`、`list_tasks`、`get_task`、`confirm_background_task` 命令
3. Agent 工具：注册 `propose_background_task` 工具
4. 前端：确认卡片组件、`taskSidebarStore`
5. 侧边栏：渲染真实的任务列表
6. 后台任务执行：在独立 session 中运行 Agent，事件通过 task session id 路由

### Phase 3：任务详情浮层（2-3天）

**目标**：点击侧边栏任务 → 左侧滑出浮层显示详情。

**改动**：
1. `TaskDetailOverlay` 组件（浮层容器 + 动画 + 遮罩）
2. 执行时间线 + 进度 + 结果展示
3. 任务追加指令功能（浮层底部输入框）
4. 暂停 / 继续 / 取消操作
5. Claude Code 任务的终端输出展示（复用 ClaudeCodePanel）

### Phase 4：定时任务整合 + 合并清理（2-3天）

**目标**：将 CronJob 整合到侧边栏，清理旧组件。

**改动**：
1. CronJob 执行时自动创建 task session
2. 侧边栏显示定时任务
3. 定时任务详情视图（执行历史）
4. 移除右侧 TaskPanel 和 TaskDetailDrawer
5. 合并 taskStore 到 taskSidebarStore

### Phase 5：打磨（1-2天）

- 任务完成通知卡片（含 Summary + 记忆注入）
- 并发控制（独立通道 + rate limit 重试）
- 右键菜单（置顶、暂停、取消、删除）
- 浮层动画和过渡效果
- 空状态设计
- 排序逻辑（置顶优先 → lastActivityAt 降序）

**总计：约 10-15 天**

---

## 十、`task_proposer` System Skill

新建 `app/src-tauri/skills/task_proposer/SKILL.md`，作为 system skill（`always_active: true`），指导 Agent 何时建议后台执行：

```yaml
---
name: task_proposer
description: "Guide the agent to detect long-running tasks and propose background execution via propose_background_task tool."
metadata: { "yiyiclaw": { "emoji": "📋", "always_active": true } }
---
```

```markdown
# 长任务检测与后台执行

你具备检测长任务并建议后台执行的能力。

## 判断标准

**需要建议后台执行**：
- 需要创建多个文件的任务（网站、项目、文档集）
- 需要调用 claude_code 工具的编程任务
- 需要多步骤分析的复杂文件处理（长报告、大数据集）
- 用户明确使用"帮我做"、"创建"、"从零开始"等表述的创建型任务
- 预估执行时间超过 1 分钟的任务

**不需要建议**（直接在主窗口完成）：
- 简单问答、知识解释、闲聊
- 单文件读取、翻译一段文字、格式转换
- 查询类操作（天气、搜索、计算）
- 用户已使用 /task 命令（已是显式任务）

## 执行方式

1. 收到用户消息后，先分析任务复杂度
2. 如果判断为长任务，调用 `propose_background_task` 工具
3. 在 context_summary 中总结：用户需求细节、偏好、约束、对话中的相关背景
4. 等待用户选择（后台执行 or 在这里继续）
5. 如果用户选择"在这里继续"，正常执行任务
6. 不要反复询问，一次判断即可
```

此 skill 加入 `SYSTEM_SKILL_NAMES` 列表，与 `auto_continue` 同级。

---

## 附录：已确认的设计决策

| # | 决策点 | 结论 | 理由 |
|---|--------|------|------|
| 1 | 任务详情展示方式 | 左侧滑出浮层（480px），覆盖在 Chat 上方 | Chat 不被卸载，状态不丢失 |
| 2 | 任务上下文传递 | AI 调用 propose_background_task 时总结背景 | 比传原始消息更精炼，不泄露无关对话 |
| 3 | 任务完成通知 | 主 Chat 插入简短通知卡片含 Summary | 作为子任务记忆注入主对话，支持后续追问 |
| 4 | Agent 判断机制 | 新建 `task_proposer` system skill | 独立于 auto_continue，职责清晰 |
| 5 | 并发资源 | 独立通道，rate limit 自动重试 | 主 Chat 和任务互不阻塞 |
| 6 | 高级菜单 | 单击 Popover + 长按/双击展开列表 | 快速访问 + 常驻展示两种模式 |
| 7 | 任务保留策略 | 不归档，按 lastActivityAt 排序，支持置顶 | 简单直觉，用户自行管理 |
