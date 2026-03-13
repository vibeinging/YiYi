# 单主窗口 + 任务子窗口：对话模型重构

> 状态：Discovery / 调研中
> 日期：2026-03-12
> 作者：产品团队

---

## 一、问题

当前 YiYiClaw 采用传统的**多 Session 对话模型**（类似 ChatGPT）：用户可以创建无限个对话 Session，每个 Session 有独立的消息历史。

**问题是**：
1. 普通用户不理解"对话管理"——他们只想跟 AI 说话，不想管理 20 个对话窗口
2. Session 列表越来越长，找不到之前的内容
3. 长期任务（如"帮我做一个网站"）和日常问答混在一个 Session 里，上下文污染
4. 定时任务的执行结果散落在 CronJobs 页面，跟对话割裂

---

## 二、竞品调研

### 2.1 行业现状

| 产品 | Session 模型 | 长任务处理 | 日常/复杂分离 | 核心亮点 |
|------|-------------|-----------|--------------|---------|
| **ChatGPT** | 多 Session + Projects | Canvas(编辑)、Deep Research(后台)、Tasks(定时) | 部分分离（多入口） | Projects 按项目组织；Deep Research 有中间过程展示 |
| **Claude Desktop** | 多 Session + Projects | Artifacts(内嵌产物)、Computer Use(流式步骤) | 未分离 | Artifacts 是对话内嵌可交互内容的标杆 |
| **Apple Intelligence/Siri** | 无 Session（单入口） | 不支持长任务 | 天然分离（路由到具体 App） | 零学习成本；深度系统集成 |
| **Cursor** | 侧边栏聊天 + Composer | Background Agent(云端后台执行) | 四层递进(Tab→Chat→Agent→BG) | BG Agent 是最成熟的后台长任务模型 |
| **Devin/Manus** | 每任务一个 Workspace | 核心能力（全过程可视） | 仅面向复杂任务 | Manus 步骤化进度条；Devin 实时环境预览 |
| **Rabbit R1/AI Pin** | 无 Session（即时交互） | 不支持 | 仅日常问答 | 已证明为失败方向——硬件限制 AI 能力 |
| **Arc Browser** | 无独立对话 | 不涉及 | AI 嵌入浏览行为 | "Browse for Me" 搜索范式 |
| **Notion AI/Copilot** | 嵌入宿主应用 | Copilot Agents(后台工作流) | 天然分离（嵌入式 vs 独立聊天） | 零切换成本；上下文自动关联 |

### 2.2 行业趋势

**趋势 1：从"聊天"到"任务"的范式转移**
行业正从"对话为中心"转向"任务/产物为中心"。Canvas、Artifacts、Background Agent、Manus 都体现了这一点——用户关心的是最终产出，对话正在变成任务的附属品。

**趋势 2：分层交互成为标配**

| 层级 | 交互模式 | 代表 |
|------|---------|------|
| L0 | 内联/即时（自动补全、摘要） | Cursor Tab、Notion AI 内联 |
| L1 | 对话问答（单轮或短多轮） | Siri、Arc Search |
| L2 | 会话级协作（多轮迭代，有产物） | ChatGPT Canvas、Claude Artifacts |
| L3 | 后台任务（可离手，异步通知） | Cursor BG Agent、Devin、ChatGPT Tasks |

**趋势 3：后台执行 + 进度可视化是长任务的答案**
三种范式：全过程实时可视（Devin）、计划+进度条（Manus）、状态列表+结果查看（Cursor BG Agent）。

**趋势 4：上下文自动关联取代手动管理**
让 AI 自动理解当前上下文，减少 Session 管理负担。

**趋势 5：嵌入式 AI vs 独立 Agent 两极化**
低门槛浅能力（Notion AI）vs 高门槛深能力（Devin）。中间产品通过增加功能层级覆盖两端。

### 2.3 对 YiYiClaw 的启示

1. **主窗口应是"命令中心"而非"聊天窗口"** — 展示所有正在进行的活动概览
2. **任务子窗口需要三种形态** — 内嵌面板(短任务)、独立子窗口(复杂任务)、后台任务卡片(可离手任务)
3. **进度展示** — 有计划就展示计划（Manus 模式）；可折叠详情；允许中途介入
4. **统一入口 + 自动分流** — 根据任务复杂度自动路由到不同处理模式
5. **通知是后台任务的必要闭环** — 系统通知 + 托盘变化 + 主窗口状态更新

---

## 三、核心设计

### 3.1 一个主窗口

用户打开 YiYiClaw，看到的就是**一个对话窗口**。不需要"新建对话"，不需要管理 Session 列表。

- 主窗口是"万能入口"：问问题、下指令、闲聊
- 上下文在主窗口内自然流转，类似跟一个助手持续对话
- 主窗口有记忆能力（已有 memory 系统），不会因为"新对话"而遗忘

### 3.2 任务自动弹出子窗口

当用户发起一个**需要持续执行的任务**时，系统自动创建一个独立的"任务窗口"：

**触发条件**（Agent 自动判断或用户显式触发）：
- "帮我创建一个网站" → 创建任务窗口
- "每天早上帮我整理新闻" → 创建定时任务窗口
- "分析这份 100 页的报告" → 创建任务窗口
- "今天天气怎么样" → 不创建，主窗口直接回答

**触发方式**：
- **路径 A（推荐）**：Agent 主动创建 — 在工具系统中注册 `create_task` 工具，Agent 根据用户意图自行决定
- 路径 B：前端启发式 — auto_continue 模式启用时自动弹出为子窗口

**任务窗口特性**：
- 有独立的上下文和 working_dir
- 可以在后台运行（对应现有的 auto-continue 能力）
- 有进度展示（进度条、阶段标记）
- 完成后通知用户，结果可在主窗口查看
- 可以暂停/恢复/取消

### 3.3 用户视角的交互流

```
用户打开 App → 主窗口（唯一入口）

用户："帮我做一个个人博客网站"
  ↓
Agent 判断：这是一个长期任务
  ↓
主窗口显示："好的，我会帮你创建网站。已开启专项任务 →"
  ↓
底部/侧边出现"任务卡片"：[创建个人博客网站 — 进行中...]
  ↓
用户可以：
  a) 点击任务卡片 → 展开查看详细进度和对话
  b) 继续在主窗口聊别的 → "明天天气怎么样？"
  c) 在主窗口追问 → "网站做得怎么样了？" → Agent 自动关联到任务

任务完成 → 系统通知 + 托盘提醒 → 任务卡片变为 [个人博客网站 — 已完成]
```

### 3.4 任务面板设计

**任务面板位置**：底部可折叠面板或侧边栏（类似 IDE 的 Terminal Panel）

**任务卡片信息**：
- 任务名称 + 图标
- 状态标签：`运行中` / `已暂停` / `已完成` / `失败`
- 关键进度信息（当前步骤 / 总步骤数）
- 操作按钮：暂停、取消、查看详情

**任务详情抽屉**：
- 完整的对话历史（复用现有消息渲染组件）
- 工具调用面板（复用 ToolCallPanel）
- 执行日志流
- 中途介入输入框

**任务状态机**：
```
         用户取消
创建 → 运行中 ──→ 已取消
         │  ↑
    暂停 ↓  │ 恢复
        已暂停
         │
         ↓
    已完成 / 失败 → 归档
```

### 3.5 核心用户场景

| 场景 | 用户行为 | 系统响应 |
|------|---------|---------|
| 日常快速问答 | "今天天气怎么样" | 主窗口直接回答 |
| 长期复杂任务 | "帮我建一个网站" | 创建任务子窗口，后台执行 |
| 定时任务 | "每天早上帮我整理新闻" | 创建定时任务，归入任务面板 |
| 多任务并行 | 第一个任务未完成时发起第二个 | 两个任务卡片并列，各自独立执行 |
| 中途介入 | 点击任务卡片 → 输入补充指令 | 暂停当前步骤，处理用户输入后继续 |
| 查询任务状态 | 在主窗口说"网站做得怎么样了" | Agent 自动关联任务，返回进度摘要 |
| Bot 消息 | Discord 收到用户消息 | 路由到主窗口或自动创建任务 |

---

## 四、技术可行性评估

### 4.1 关键发现

代码库已有多个机制天然支持 Task 模型：

1. **`persistent_agents` 表已存在** — 有 `session_id, status, task_description, task_plan, steps` 等字段，是"任务"模型的雏形
2. **`sessions.source` 字段** — 已区分 `chat/bot/cronjob/unified`，新增 `task` 值即可
3. **`list_sessions_by_source()` 已存在** — 后端过滤几乎不需要改
4. **auto-continue 机制** — 已具备长任务多轮执行、进度汇报、预算控制、取消能力
5. **Spawn Agent** — 已实现子 agent 并行执行
6. **Tauri event payload 已含 `session_id`** — 支持多 session 事件分发
7. **react_agent.rs 完全无状态** — Task 只需用不同 `session_id` 调用同一 API

### 4.2 各模块改动量

| 模块 | 当前状态 | 改动方案 | 改动量 |
|------|---------|---------|--------|
| **DB** | sessions 表 + source 字段 | 新增 `parent_session_id` + `task_status` 两列（ALTER TABLE） | **小** |
| **ReAct Agent** | 无状态纯函数 | 无需修改 | **无** |
| **Commands** | chat_stream_start 绑定 session_id | 新增 create_task/list_tasks 命令；chat_cancelled 改为 per-session | **中** |
| **Scheduler** | CronJob Isolated 模式已有独立 session | 触发时创建 Task Session | **小** |
| **前端 Chat** | Chrome-style session tabs | 移除 Tab 栏 → 单窗口 + TaskPanel | **大** |
| **chatStreamStore** | 全局单例 store | 改为 per-session 实例 或 Task 用独立轻量 store | **中** |
| **Memory** | per-session recall | 无需修改（全局 recall 已支持） | **无** |

### 4.3 渐进式实施方案（推荐）

#### Phase 1: Task = 带标记的 Session（MVP，约 3-5 天）

1. DB：`sessions` 表加 `parent_session_id` 和 `task_status` 两列
2. 后端：新增 `create_task` / `list_tasks` / `get_task_status` 三个 Tauri command
3. 前端：Chat 页面底部加可折叠"任务面板"，展示当前主会话关联的 task 列表
4. 入口：通过 `/task` slash command 或 AI `create_task` 工具调用创建
5. **不改变任何现有行为**，纯加法改动

#### Phase 2: 主窗口 + 任务隔离（体验升级，约 5-8 天）

1. 移除 Session Tab 栏，保留一个"主对话"
2. Task 面板升级：侧边栏/底部面板 + 任务卡片 + 点击展开详情抽屉
3. `chat_cancelled` 改为 `HashMap<String, AtomicBool>`（per-session 取消）
4. chatStreamStore 多实例化，支持主窗口和多个 Task 并行流式更新
5. AI 工具注册 `create_task`，让 AI 判断复杂请求后自动派发

#### Phase 3: CronJob 统一 + 高级功能（约 3-5 天）

1. CronJob 融合：Isolated CronJob 执行时自动创建 Task Session
2. Bot 路由整合：Bot 消息路由到主窗口或自动创建 task
3. `persistent_agents` 表功能合并到 Task 模型
4. 任务模板：常用任务模式保存为模板

### 4.4 技术风险

| 风险 | 等级 | 说明 | 缓解措施 |
|------|------|------|----------|
| 并行流式状态 | **高** | 多 Task 并行时前端状态同步和渲染压力 | per-session store + Task 详情按需加载 |
| `chat_cancelled` 全局单例 | **高** | 取消主窗口会影响所有任务 | Phase 2 改为 per-session；Phase 1 限制同时只有一个活跃 Task |
| LLM 并发限流 | **中** | 多 Task 并行触发 API rate limit | 请求队列 + 信号量（max 3 concurrent） |
| Context 隔离 | **中** | Task 的 prompt/memory 是否需要独立 | Phase 1 共享；Phase 2 支持 Task 级 skill override |
| 数据一致性 | **低** | 删除主会话是否级联删除 Task | `ON DELETE CASCADE` 或 `SET NULL` 保留历史 |

### 4.5 工作量预估

| 模块 | 预估工时 |
|------|----------|
| DB 迁移（schema + 查询） | 0.5 天 |
| 后端 commands（create_task / list_tasks） | 1 天 |
| 后端 cancellation per-session 改造 | 1 天 |
| 前端 TaskPanel + TaskDetailDrawer | 3 天 |
| chatStreamStore 多实例化 | 1.5 天 |
| AI create_task 工具注册 | 0.5 天 |
| CronJob 融合 | 1 天 |
| 测试 + 联调 | 2 天 |
| **合计** | **约 10-12 人日** |

### 4.6 可复用的现有组件

- `ToolCallPanel` — 任务详情中的工具调用展示
- `SpawnAgentPanel` — 子任务展示
- `LongTaskProgressPanel` — 任务进度面板
- `TaskExecutionDetail` — 任务详情抽屉的基础
- `MentionInput` / `SlashCommandPicker` — 主窗口输入
- 消息气泡渲染（Markdown + code highlight）
- Tauri event 事件分发机制
- CronJob dispatch 通知机制

---

## 五、核心产品问题（待决策）

### 5.1 主窗口的上下文管理

- **自动上下文压缩**：已有 `compact_messages` 机制（80000 tokens 阈值）
- **话题自动分段**：检测话题切换，自动归档旧话题
- **按需回溯**：用户说"之前那个 XXX"时能找回

### 5.2 多任务并行

- 建议默认 max 3 个并行任务（受 LLM 并发限制）
- 任务之间通过 memory 系统间接共享上下文（"用上个任务的结果..."）
- 资源分配：主窗口优先，任务排队执行

### 5.3 与现有功能的兼容

- 现有 Session 数据保持 `parent_session_id = NULL`，无需迁移
- Bot 消息新增"路由到主窗口"选项（保留现有独立 session 行为作为兼容）
- 定时任务渐进融合，Isolated CronJob → Task Session

---

## 六、下一步

1. [ ] **Phase 1 开发**：实现 Task = 带标记的 Session MVP
2. [ ] 原型设计：主窗口 + 任务面板的 UI 高保真设计稿
3. [ ] 用户测试：内部试用 Phase 1，收集反馈
4. [ ] Phase 2 迭代：基于反馈进行体验升级
