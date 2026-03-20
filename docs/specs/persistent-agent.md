# 持久化 Agent：长任务自主执行引擎

> 状态：Draft
> 日期：2026-03-12
> 作者：产品团队

---

## 一、背景与动机

### 1.1 问题

YiYi 当前的 Agent 是 **单轮对话驱动** 模式：

```
用户发消息 → ReAct Loop (think → act → observe) × N → 返回结果 → 停止等待
```

这对简单任务够用，但无法满足以下场景：

- **长任务**：「重构 auth 模块」「把这个项目的测试覆盖率从 30% 提到 80%」
- **持续工作**：Agent 需要自主规划、分步执行、跨小时/跨天推进
- **自主决策**：Agent 遇到问题自己想办法，不需要每步等用户确认
- **中途介入**：用户随时查看进度、给反馈、调整方向

### 1.2 竞品分析

| 产品 | 模式 | 长任务方案 | 核心机制 |
|------|------|-----------|---------|
| **OpenClaw** (145k+ stars) | 文件驱动、本地优先 | Heartbeat 定时唤醒 + Memory Flush + Context Compaction | HEARTBEAT.md 每 30min 唤醒；context 快满时自动 flush 到 MEMORY.md；向量索引跨 session 搜索记忆 |
| **Slock.ai** (SaaS) | Daemon + 云端 | Claude Code 进程常驻 + 独立 Workspace | 每个 Agent 独立目录 `~/.slock/agents/{id}/`；Activity 实时监控 |
| **Anthropic 官方** | Two-Agent Harness | 初始化 Agent + 执行 Agent + 文件传递状态 | feature_list.json 任务清单；claude-progress.txt 进度文件；每 session 只做一个 feature |

### 1.3 YiYi 的优势

- **已有 ReAct Agent 引擎**：加 outer loop 即可升级为自主循环
- **已有 Skills 系统**：Agent 能力可通过 Skill 扩展
- **已有 Cron 调度器**：天然支持 Heartbeat 定时唤醒
- **已有 Bot 系统**：任务完成/遇阻时可通过 6 个平台推送通知
- **已有全量工具**：文件读写、Shell、浏览器、截图、MCP、Claude Code、子 Agent
- **本地优先**：不依赖云端，数据完全在用户手中

---

## 二、核心概念

### 2.1 PersistentAgent

```
PersistentAgent
├── id: UUID
├── name: String                    # 用户命名，如 "重构工程师"
├── task_description: String        # 长期任务描述
├── status: Idle | Planning | Working | Paused | Blocked | Completed | Failed
├── workspace_dir: PathBuf          # 独立工作目录
├── config: AgentConfig             # model, skills, max_iterations, etc.
├── task_plan: TaskPlan             # 任务分解计划
├── progress: Vec<ProgressEntry>    # 进度日志
├── memory_dir: PathBuf             # Agent 专属记忆目录
└── created_at / updated_at
```

### 2.2 TaskPlan（借鉴 Anthropic feature_list）

```json
{
  "goal": "将 auth 模块从 session-based 重构为 JWT-based",
  "steps": [
    {
      "id": 1,
      "title": "分析现有 auth 代码结构",
      "description": "读取所有 auth 相关文件，理解当前实现",
      "status": "completed",
      "result_summary": "共 5 个文件，基于 express-session...",
      "completed_at": "2026-03-12T10:30:00Z"
    },
    {
      "id": 2,
      "title": "设计 JWT 方案",
      "description": "确定 token 格式、刷新策略、存储方式",
      "status": "in_progress",
      "started_at": "2026-03-12T10:31:00Z"
    },
    {
      "id": 3,
      "title": "实现 JWT 中间件",
      "status": "pending"
    },
    {
      "id": 4,
      "title": "迁移所有路由",
      "status": "pending"
    },
    {
      "id": 5,
      "title": "编写测试",
      "status": "pending"
    }
  ]
}
```

**规则**（借鉴 Anthropic）：
- Agent 只能修改 step 的 `status` 和 `result_summary`
- 不能删除或跳过 step
- 一次只执行一个 step
- 遇到需要用户决策的问题 → 状态改为 `blocked`，发通知

### 2.3 Agent 工作目录

```
~/.yiyiclaw/agents/{agent_id}/
├── task_plan.json          # 任务计划（Agent 自己生成和更新）
├── progress.md             # 进度日志（每步执行后追加）
├── memory.md               # Agent 长期记忆（跨 session 持久化）
├── memory/
│   └── YYYY-MM-DD.md       # 每日工作日志
├── workspace/              # Agent 的工作产出目录
│   └── ...                 # 代码、文件等
└── config.json             # Agent 配置
```

---

## 三、执行架构

### 3.1 自主循环（Outer Loop）

```
┌─────────────────────────────────────────────────────┐
│                  Outer Loop (自主循环)                 │
│                                                     │
│  1. 加载状态                                         │
│     ├── 读 task_plan.json                           │
│     ├── 读 progress.md                              │
│     ├── 读 memory.md + memory/today.md              │
│     └── git log（如有）                               │
│                                                     │
│  2. 评估下一步                                       │
│     ├── 找到第一个 pending/in_progress 的 step        │
│     ├── 如果全部 completed → 汇报完成                  │
│     └── 如果有 blocked step → 等待用户                 │
│                                                     │
│  3. 执行当前 step                                    │
│     └── Inner Loop (现有 ReAct Agent)                │
│         ├── think → act → observe                   │
│         ├── 使用所有工具（shell, file, browser,       │
│         │   mcp, claude_code, skills...）            │
│         └── 直到 step 完成或遇阻                      │
│                                                     │
│  4. 持久化                                          │
│     ├── 更新 task_plan.json（step status）            │
│     ├── 追加 progress.md                             │
│     ├── git commit（如有文件变更）                     │
│     └── memory flush（如 context 接近上限）            │
│                                                     │
│  5. 检查                                            │
│     ├── 检查用户反馈队列 → 有则处理                    │
│     ├── 检查 token 预算 → 超限则暂停                  │
│     ├── 检查时间限制 → 超时则暂停                     │
│     └── 检查取消信号 → 取消则停止                     │
│                                                     │
│  6. 继续 → 回到步骤 1                                │
└─────────────────────────────────────────────────────┘
```

### 3.2 与现有 ReAct Agent 的关系

```
现有:
  User Message → react_agent::run() → 返回结果

新增:
  PersistentAgent::run()
    └── loop {
          ctx = load_state()
          step = next_pending_step(ctx.task_plan)

          // 复用现有 ReAct Agent，传入 step 作为 prompt
          result = react_agent::run(
            prompt = format_step_prompt(step, ctx),
            tools = all_tools,
            skills = agent.skills,
            max_iterations = step.max_iterations,
          )

          persist_progress(step, result)
          check_feedback_queue()
          check_budget()
        }
```

### 3.3 Context 管理（借鉴 OpenClaw）

**问题**：长任务可能跨越多个 context window。

**方案**：

1. **Memory Flush**：当 token 使用接近阈值时，自动触发一轮特殊的 agent turn：
   ```
   System: "当前 session 即将结束。请将以下信息写入 memory.md：
   1. 你正在做什么
   2. 做到哪一步了
   3. 下一步计划
   4. 遇到的关键发现"
   ```

2. **Session 恢复**：新 session 开头自动注入：
   ```
   System: "你是持久化 Agent {name}。
   当前任务：{task_description}

   请先阅读以下文件恢复上下文：
   - task_plan.json（任务计划和进度）
   - progress.md（历史执行记录）
   - memory.md（你的长期记忆）
   - memory/{today}.md（今日工作日志）

   然后继续执行下一个 pending 的步骤。"
   ```

3. **Context Compaction**：超长对话自动压缩，保留最近 N 条消息 + 摘要。

### 3.4 Heartbeat 定时唤醒（借鉴 OpenClaw）

复用现有 `scheduler.rs` 的 Cron 能力：

```rust
// Agent 创建时注册一个 heartbeat cron job
scheduler.add_cron_job(CronJob {
    name: format!("agent_{}_heartbeat", agent.id),
    schedule: "*/30 * * * *",  // 每 30 分钟
    action: HeartbeatAction {
        agent_id: agent.id,
        // 1. 检查 Agent 状态
        // 2. 如果 Paused 且有未完成 step → 恢复执行
        // 3. 如果 Blocked → 检查是否可以自动解除
        // 4. 如果 Idle → 检查是否有新任务
    }
});
```

---

## 四、用户交互

### 4.1 创建 Agent

```
用户: "创建一个 Agent，帮我把项目的测试覆盖率从 30% 提到 80%"

系统:
1. 创建 PersistentAgent（分配 id、workspace）
2. Agent 进入 Planning 状态
3. Agent 分析项目，生成 task_plan.json
4. 展示计划给用户确认
5. 用户确认 → Agent 开始执行
```

### 4.2 查看进度

```
前端 Agent 面板:
┌──────────────────────────────────────┐
│ 🔨 测试覆盖率提升 Agent              │
│ 状态: Working (Step 3/8)            │
│                                      │
│ ✅ 1. 分析现有测试结构 (2min)         │
│ ✅ 2. 识别未覆盖模块 (5min)           │
│ 🔄 3. 编写 auth 模块测试 (进行中...)  │
│ ⏳ 4. 编写 db 模块测试               │
│ ⏳ 5. 编写 API 路由测试              │
│ ⏳ 6. 编写集成测试                   │
│ ⏳ 7. 修复失败的测试                  │
│ ⏳ 8. 验证覆盖率达标                  │
│                                      │
│ 实时输出:                            │
│ > 正在为 auth/login.rs 编写单元测试... │
│ > 创建 tests/auth/test_login.rs      │
│                                      │
│ [暂停] [发消息] [取消]                │
└──────────────────────────────────────┘
```

### 4.3 中途介入

用户可以随时：
- **发消息**：Agent 在下一轮 check 时读取并处理
- **暂停**：Agent 完成当前 tool call 后暂停
- **调整计划**：修改 task_plan 中未开始的 step
- **取消**：Agent 停止，保留已完成的工作

### 4.4 通知推送

Agent 在以下时刻通过 Bot 系统推送通知：
- 任务计划生成完毕，等待确认
- 某个 step 完成
- 遇到阻塞，需要用户决策
- 全部任务完成
- 执行失败

---

## 五、数据模型

### 5.1 SQLite 表

```sql
CREATE TABLE persistent_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    task_description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planning',  -- planning|working|paused|blocked|completed|failed
    workspace_dir TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',         -- JSON: model, skills, budget, etc.

    -- 执行统计
    total_steps INTEGER DEFAULT 0,
    completed_steps INTEGER DEFAULT 0,
    total_tokens_used INTEGER DEFAULT 0,
    total_cost_usd REAL DEFAULT 0,

    -- 时间
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,

    -- 关联
    session_id TEXT,                           -- 关联的 chat session（用于 UI 展示）
    heartbeat_job_id TEXT                      -- 关联的 cron job
);

CREATE TABLE agent_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES persistent_agents(id),
    step_index INTEGER NOT NULL,
    step_title TEXT NOT NULL,
    status TEXT NOT NULL,                      -- started|completed|failed|blocked
    result_summary TEXT,
    tokens_used INTEGER DEFAULT 0,
    duration_secs INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE agent_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES persistent_agents(id),
    message TEXT NOT NULL,
    processed INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
);
```

### 5.2 Config 结构

```json
{
  "model": "claude-sonnet-4-6",
  "skills": ["coding_assistant", "browser_visible"],
  "max_iterations_per_step": 50,
  "max_total_tokens": 5000000,
  "max_duration_hours": 24,
  "heartbeat_interval_minutes": 30,
  "auto_commit": true,
  "notification_bot_id": "discord_xxx",
  "memory_flush_threshold_tokens": 4000,
  "working_dir_override": null
}
```

---

## 六、安全与资源控制

### 6.1 Token 预算

```rust
struct TokenBudget {
    max_total: u64,          // 总 token 上限
    used: AtomicU64,         // 已使用
    max_per_step: u64,       // 单步上限
    warning_threshold: f64,  // 80% 时发警告
}
```

每次 LLM 调用后更新计数。接近上限时：
1. 80% → 通知用户
2. 100% → 暂停 Agent，等待用户追加预算或确认

### 6.2 时间限制

- 单步执行超时：默认 30 分钟
- 总任务时长限制：默认 24 小时（可配置）
- Heartbeat 间隔：默认 30 分钟

### 6.3 权限隔离

- 每个 Agent 有独立 workspace，默认不能访问其他 Agent 的目录
- 危险操作（rm -rf、push 等）仍需用户审批
- Agent 不能修改自己的 config 和 budget

### 6.4 并发控制

- 同时运行的 PersistentAgent 数量限制：默认 3 个
- 同一 Agent 不能并发执行（加锁）
- 不同 Agent 的 workspace 隔离，避免文件冲突

---

## 七、实现计划

### Phase 1：基础框架（MVP）

- [ ] `PersistentAgent` 数据模型 + DB 表
- [ ] `agent_runner.rs`：outer loop 实现（复用 react_agent）
- [ ] 任务计划生成（LLM 自动分解）
- [ ] 进度持久化（task_plan.json + progress.md）
- [ ] 前端 Agent 管理面板（创建/查看进度/暂停/取消）
- [ ] Tauri command 层

### Phase 2：持久化增强

- [ ] Memory Flush 机制（context 快满时自动写入）
- [ ] Session 恢复（从文件恢复上下文）
- [ ] Context Compaction（长对话压缩）
- [ ] Git auto-commit（每步完成后自动提交）

### Phase 3：自动化运维

- [ ] Heartbeat 定时唤醒（复用 scheduler）
- [ ] Bot 通知推送（任务完成/阻塞/失败）
- [ ] Token 预算管理 + 费用统计
- [ ] Agent 间协作（共享 memory、任务分配）

### Phase 4：高级能力

- [ ] 向量索引 memory 搜索（借鉴 OpenClaw 的 BM25 + Vector 混合）
- [ ] Agent 模板（预置常见任务类型）
- [ ] Agent 导入/导出（分享配置）
- [ ] Web Remote 模式（手机远程查看/控制 Agent）

---

## 八、评审结论（2026-03-12）

### 8.1 产品团队评审

**核心结论**：需求成立，但需缩小 MVP 范围并增加信任机制。

**场景聚焦**：高频场景集中在"大量重复性代码修改"类任务（测试生成、JS→TS 迁移、批量重构），而非开放式的"帮我做任何事"。

**关键调整建议**：

1. **增加渐进式信任机制**：新增 `autonomy_level` 配置
   - `step_confirm`：每步确认（新手默认）
   - `plan_confirm`：只确认计划（推荐默认）
   - `full_auto`：全自主（高级用户）

2. **费用控制**：默认 token 预算从 500 万降至 100 万（约 $3-6），UI 用金额而非 token 数展示（"本次任务预算上限约 $5"），实时显示已花费/预算。

3. **Bot 通知提前到 MVP**：这是相比 OpenClaw/Slock 的核心差异点。MVP 至少支持 1 个平台的通知推送。

4. **砍掉低价值功能**：
   - ~~Phase 3: Agent 间协作~~ → 桌面个人助手场景价值不高
   - ~~Phase 4: Agent 模板/导入导出~~ → 无社区生态支撑

5. **桌面端特有问题**：需解决 macOS App Nap（系统休眠后 Agent 被挂起）和"跨天任务需要不关机"的问题。增加"睡眠恢复"机制。

### 8.2 技术架构师评审

**核心结论**：架构可行，但建议先做 Phase 0.5 简化验证。

**可行性确认**：
- `react_agent::run_react_with_options()` 是无状态纯函数，支持被 outer loop 反复调用
- Context Compaction 已有现成实现（`compact_messages_if_needed()`，80K token 阈值）
- Scheduler 复用改造量小（~1 人天），Bot 通知推送极小（~0.5 人天）

**关键技术风险**：
1. **全局状态阻碍多 Agent**：`tools.rs` 的 `WORKING_DIR` 是全局唯一的。建议新增 `TASK_WORKING_DIR` task_local 变量，Agent 执行时设置，工具优先使用。改造量 ~2 人天。
2. **LLM 规划能力不稳定**：task_plan 质量高度依赖 LLM，不同模型差异大。这是最大的产品风险。
3. **跨 session 记忆有损**：LLM 通过读文件"回忆"而非真正记住，memory flush 写入不完整会导致重复工作。

**Phase 0.5 建议（验证性最小方案，2-3 人天）**：
```
"Sequential ReAct with Auto-Continue"
在 system_prompt 中添加指令：任务未完成时返回 [CONTINUE] 标记
在 chat_stream_start 外层加 while 循环，检测到 [CONTINUE] 自动继续
```
- 能处理 80% 长任务场景
- 改动量极小，低风险
- 验证用户需求和 LLM 能力后，再决定是否投入完整 Phase 1

**Phase 1 完整版工作量估算：13-16 人天（约 3 周单人）**

**数据存储建议**：task_plan 存 SQLite JSON 字段（事务性保证），memory/progress 保留文件（Agent 通过工具读写）。

### 8.3 QA 团队评审

**核心结论**：设计在故障恢复、数据一致性、安全边界三方面细节不足。

**高优先级缺失项**（必须在实现前补充）：

| # | 缺失项 | 说明 |
|---|--------|------|
| 1 | **崩溃恢复流程** | 需新增 `recovering` 状态；启动时扫描 working Agent；task_plan 原子写入（先写 tmp 再 rename）；孤儿进程清理 |
| 2 | **系统休眠处理** | 监听 macOS `NSWorkspaceDidWakeNotification`；Heartbeat 防堆积（唤醒后只执行一次）；网络连接重建 |
| 3 | **网络错误重试** | 指数退避（2s/4s/8s）；连续 N 次失败后暂停 Agent；429 读取 Retry-After |
| 4 | **LLM 异常分类** | token 超限 → 紧急 compaction；格式错误 → 重试 3 次后暂停；内容审核拒绝 → 标记 blocked |
| 5 | **死循环检测** | 跟踪最近 N 次 tool call 的 hash，重复率 >60% 判定为循环；注入特殊 prompt 引导换方案 |
| 6 | **数据一致性** | 明确 SQLite 为元数据 truth source，文件为 Agent 记忆 truth source；启动时对账 |
| 7 | **文件并发冲突** | Agent 写文件前检查 hash 是否与读取时一致；检测到外部修改标记 blocked |
| 8 | **Agent 锁实现** | 文件锁（flock）+ DB status 双重检查；锁超时自动释放防死锁 |

**异常场景清单（19 项）**：包括应用崩溃、系统休眠、网络中断、Rate Limit、死循环、Agent 偏离任务、磁盘满、文件冲突、多 Agent 同目录、Heartbeat 重叠、Provider 切换、Skill 热删除等。详见 QA 完整报告。

**安全边界补充**：
- Agent 不能通过 shell 修改自己的 config/budget（config 从 DB 内存快照读取，不依赖文件）
- Agent 不能创建新 Agent（Tauri command 层检查调用来源）
- Shell 命令路径限制硬编码到 workspace_dir

**可观测性建议**：增加 `last_activity_at` liveness 指标；结构化 JSON 日志（agent.log）；前端增加实时活动指示器。

---

## 九、修订后的实现计划

### Phase 0.5：快速验证（2-3 人天）

> 目标：用最小改动验证"长任务持续执行"的产品假设和 LLM 能力

- [ ] System prompt 注入 `[CONTINUE]` 指令
- [ ] `chat_stream_start` 外层 auto-continue while 循环
- [ ] 简单进度展示（累计轮次、已用 token）
- [ ] 基本安全阀（最大轮次、token 上限、用户取消）

### Phase 1：完整框架（13-16 人天）

> 前提：Phase 0.5 验证通过

- [ ] DB 表 + 数据模型（含 `recovering` 状态）
- [ ] `agent_runner.rs`：outer loop + 崩溃恢复 + 死循环检测
- [ ] 任务计划生成 + `autonomy_level` 渐进式信任
- [ ] 进度持久化（SQLite + memory 文件混合）
- [ ] Memory Flush（从 Phase 2 提前，MVP 必需）
- [ ] 简化版前端（Chat 页面内嵌长任务模式，非独立面板）
- [ ] 系统通知 + 1 个 Bot 平台通知
- [ ] 费用实时展示（金额而非 token）
- [ ] 基础 Tauri commands（create/list/pause/cancel/feedback）

### Phase 2：健壮性增强

- [ ] 系统休眠/唤醒恢复
- [ ] 网络错误指数退避重试
- [ ] LLM 异常分类处理（429/500/token超限/格式错误）
- [ ] Git auto-commit + 一键回滚
- [ ] 文件并发冲突检测
- [ ] 多 Agent 同目录冲突检测
- [ ] Agent 锁机制（flock + DB 双重检查）
- [ ] 结构化日志 + 可观测性指标

### Phase 3：自动化运维

- [ ] Heartbeat 定时唤醒（复用 scheduler）
- [ ] 全平台 Bot 通知推送
- [ ] Token 预算管理 + 费用统计面板
- [ ] LLM 并发调用 Semaphore（限制 3 路并发）
- [ ] macOS App Nap 禁用

### Phase 4：高级能力

- [ ] 向量索引 memory 搜索
- [ ] Web Remote 模式（手机查看/控制 Agent）
- [ ] 独立 Agent 管理面板（列表/详情/日志查看器）
- [ ] Agent 工作目录独立 git branch

---

## 十、参考资料

- [OpenClaw](https://github.com/openclaw/openclaw) — 文件驱动的持久化 Agent 架构，Heartbeat + Memory Flush
- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — Two-Agent Harness，feature_list + progress 文件
- [OpenClaw Memory Documentation](https://docs.openclaw.ai/concepts/memory) — 向量索引 + BM25 + 时间衰减的混合搜索
- [Slock.ai](https://slock.ai) — Daemon 模式远程控制 Claude Code Agent
- [Inside OpenClaw: How a Persistent AI Agent Actually Works](https://dev.to/entelligenceai/inside-openclaw-how-a-persistent-ai-agent-actually-works-1mnk)
- [You Could've Invented OpenClaw](https://gist.github.com/dabit3/bc60d3bea0b02927995cd9bf53c3db32)
