# Claude Code Agent 系统深度分析 — YiYi 可借鉴的关键能力

> 来源：Claude Code 源码分析系列第 12/13/14 篇
> 日期：2026-04-03

---

## 一、Claude Code 核心架构哲学

三篇放在一起看，Claude Code 的 Agent 系统有一条清晰的设计主线：**"分层隔离 + 穿透例外"**

| 层次 | Agent 系统 | 内置 Agent | 任务系统 |
|------|-----------|-----------|---------|
| 隔离 | 子 Agent 默认隔离所有可变状态 | 每个 Agent 有独立工具集和 Prompt | 每个 Task 有独立输出和状态 |
| 穿透例外 | MCP 工具无条件穿透过滤层 | `criticalSystemReminder` 每轮重注入 | 任务注册穿透到全局 Store |
| 设计原则 | 遗漏隔离=bug，遗漏共享=功能不全 | Prompt+工具双保险 | 极简多态（只保留 kill） |

## 二、6 个关键借鉴能力

### 1. 专用 Agent 分级体系

Claude Code 不是一个万能 Agent，而是 6 个专用 Agent 的协作网络。搜索用 Haiku（便宜模型），规划用 Opus（强模型），通用用默认模型。Explore Agent 每周 3400 万+次调用，省掉 CLAUDE.md 注入后每周省 5-15 GB token。

### 2. 对抗性 Verification Agent

Prompt 约 130 行，核心理念是预判模型逃避倾向并逐条驳斥。"读代码不是验证——去运行它"、"识别你自己的合理化倾向"。对提升长任务可靠性 ROI 极高。

### 3. 统一任务框架

7 种任务类型统一管理所有异步工作。5 状态极简状态机（pending → running → completed/failed/killed）。三级优先级通知队列（now > next > later）确保用户操作响应性。

### 4. 穿透式上下文隔离

`createSubagentContext()` 对所有可变状态默认隔离，需共享的必须 opt-in。`setAppStateForTasks` 穿透到根 Store 保证任务注册不丢失。遗漏隔离导致 bug，遗漏共享只导致功能不全——后者更易发现修复。

### 5. 成本控制三板斧

- 模型分级：搜索用 Haiku，规划用 Opus
- 上下文裁剪：只读 Agent 省略不需要的上下文
- Prompt Cache：Fork 模式让子 Agent 复用父级缓存前缀

### 6. 安全与防护

- 双保险：Prompt 约束 + 工具黑名单独立生效
- 防递归 Fork：消息标签扫描 + querySource 双重检测
- 每轮重注入：`criticalSystemReminder` 防长对话遗忘
- 僵尸进程清理：Agent 退出自动 kill 所有子任务

## 三、实施优先级

| 优先级 | 能力 | 理由 |
|--------|------|------|
| P0 | Explore Agent（只读，便宜模型） | 搜索量大，成本节省最显著 |
| P1 | 统一 TaskKind 框架 | 整合现有分散的任务管理 |
| P1 | Verification Agent | 提升长任务可靠性，ROI 高 |
| P2 | 穿透式上下文隔离 | Spawn Agent 已有，需正式化 |
| P2 | 每轮重注入关键约束 | 安全性增强 |
| P3 | Fork 模式 + Prompt Cache 优化 | 多 Agent 成熟后再做 |
