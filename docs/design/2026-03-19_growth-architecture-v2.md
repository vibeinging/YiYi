# YiYi Growth System V2 — 架构设计

> 综合三条调研线（分层记忆 / 置信度评分 / 冥想编排）的统一架构方案

## 0. 当前架构问题诊断

### 两套记忆系统各跑各的
| 系统 | 存储 | 注入方式 | 问题 |
|------|------|---------|------|
| 文件系统 | MEMORY.md + PRINCIPLES.md + diary | 直接读文件注入 system prompt | MEMORY.md 无限增长，无生命周期管理 |
| SQLite | memories + corrections + reflections 表 | FTS5 搜索 + corrections fallback | access_count/last_accessed_at 字段从未用于决策 |

**两边都在写，谁也不管谁。** `extract_memories_from_conversation()` 同时写 memories 表 + MEMORY.md，无去重。

### 反思系统的三个 bug
1. ~~`was_successful` 硬编码 true~~ ✅ 已修复
2. 沉默完成 = 成功 → 可能"学到"错误经验
3. 无正向信号捕获（用户说"完美"时不强化）

### 冥想未接入调度器
`MeditationConfig.start_time` 存了但没人读。冥想只能手动触发。

---

## 1. 核心设计原则

| 原则 | 含义 |
|------|------|
| **实时捕获，冥想整理** | 白天轻量收集信号，晚上冥想批量综合处理 |
| **DB 为源，文件为缓存** | SQLite memories 表是唯一真相源，MEMORY.md/PRINCIPLES.md 是渲染输出 |
| **沉默 ≠ 认可** | 只有显式信号才生成 lesson，低置信度反思只统计不升级 |
| **冥想可关闭** | 关闭冥想不丢失基础成长（corrections 积累 + 自动 consolidation 保底） |

---

## 2. 统一数据模型

### 2.1 memories 表扩展

```sql
ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'warm';
-- 'hot': 注入每次 system prompt（≤15 条）
-- 'warm': FTS5 搜索命中时注入（默认）
-- 'cold': 归档，仅冥想回顾

ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
-- 0.0-1.0, 由信号类型 + 访问模式 + 时间衰减计算

ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'extraction';
-- 'extraction' | 'reflection' | 'correction' | 'user_explicit' | 'meditation'

ALTER TABLE memories ADD COLUMN reviewed_by_meditation INTEGER DEFAULT 0;
-- 冥想是否已审阅

CREATE INDEX idx_memories_tier ON memories(tier);
CREATE INDEX idx_memories_tier_importance ON memories(tier, confidence DESC);
```

### 2.2 corrections 表扩展

```sql
ALTER TABLE corrections ADD COLUMN confidence REAL NOT NULL DEFAULT 0.80;
-- 现有 corrections 全部来自用户反馈，给 0.80 合理
```

### 2.3 reflections 表扩展

```sql
ALTER TABLE reflections ADD COLUMN signal_type TEXT NOT NULL DEFAULT 'silent_completion';
-- 'explicit_correction' | 'explicit_praise' | 'tool_error' | 'max_iterations' | 'agent_error' | 'silent_completion'

ALTER TABLE reflections ADD COLUMN confidence REAL NOT NULL DEFAULT 0.50;
```

### 2.4 meditation_sessions 表扩展

```sql
ALTER TABLE meditation_sessions ADD COLUMN depth TEXT DEFAULT 'standard';
-- 'minimal' | 'standard' | 'deep'

ALTER TABLE meditation_sessions ADD COLUMN phases_completed TEXT DEFAULT '';
-- "0,1,2,3,4" 逗号分隔，用于断点续跑

ALTER TABLE meditation_sessions ADD COLUMN tomorrow_intentions TEXT;
-- 明天的行为重点

ALTER TABLE meditation_sessions ADD COLUMN growth_synthesis TEXT;
-- JSON: 能力变化、错误模式、建议
```

---

## 3. 信号分类与置信度

### 3.1 信号类型枚举

```rust
pub enum SignalType {
    ExplicitCorrection,   // "不对/wrong"  → 0.90, 负面
    ExplicitPraise,       // "完美/perfect" → 0.85, 正面 [新增]
    ToolError,            // 工具返回 Error  → 0.70, 负面
    MaxIterations,        // 超轮次         → 0.65, 负面
    AgentError,           // agent 抛异常   → 0.70, 负面
    SilentCompletion,     // 无反馈         → 0.35, 中性 → 不生成 lesson
}
```

### 3.2 关键行为变更

| 信号 | 当前行为 | V2 行为 |
|------|---------|---------|
| SilentCompletion | 生成 lesson → 写入 memories | 只存 reflection（统计用），**不写 lesson** |
| ExplicitPraise | 不捕获 | 存 reflection + 强化最近一条 correction 的 confidence |
| ExplicitCorrection | 只触发 learn_from_feedback | 同时触发 reflect_on_task(was_successful=false) 对**上一轮**做反思 |

### 3.3 正向反馈检测

```rust
// 必须是短消息（<15字）+ 明确赞扬词 + 无后续请求
let is_praise = is_short
    && starts_with_praise_keyword  // "很好/完美/就是这样/perfect/exactly"
    && !has_continuation;          // 排除 "好的，接下来帮我..."
```

### 3.4 置信度计算公式（冥想时重算）

```
importance_score =
    category_weight              // principle=0.9, preference=0.8, fact=0.7, decision=0.6, experience=0.5, note=0.3
    × recency_factor             // <7天=1.0, <30天=0.7, <90天=0.4, 其他=0.2
    × access_factor              // min(1.0, 0.3 + access_count × 0.1)
    + user_explicit_boost        // source='user_explicit' 时 +0.3

capped at 1.0
```

---

## 4. 分层记忆架构

### 4.1 新模块：`engine/tiered_memory.rs`

这是一个**策略层**，架在 db.rs（存储）和 memory.rs（文件 I/O）之上：

```
┌─────────────────────────────────────┐
│         tiered_memory.rs            │  ← 策略：晋升/降级/评分/渲染
│  load_hot_context()                 │
│  promote_to_hot() / demote()        │
│  run_tier_lifecycle()               │
│  sync_hot_to_files()                │
├─────────────────────────────────────┤
│    db.rs          │   memory.rs     │  ← 基础设施
│  SQLite memories  │  文件读写       │
│  FTS5 search      │  MEMORY.md      │
│                   │  PRINCIPLES.md  │
└─────────────────────────────────────┘
```

### 4.2 层级定义

| 层 | 容量 | 注入时机 | 晋升条件 | 降级条件 |
|----|------|---------|---------|---------|
| **HOT** | ≤15 条 | 每次 system prompt | access≥3 in 7天 + confidence≥0.7 | 14天未访问 OR confidence<0.5 |
| **WARM** | 无限 | FTS5 匹配时注入 | 默认入口 | 60天未访问 + access<2 |
| **COLD** | 无限 | 仅冥想回顾 | 搜索命中时懒晋升回 WARM | 自然沉淀 |

用户显式保存的记忆直接进入 HOT，+0.3 boost。

### 4.3 System Prompt 注入变更

**Before:**
```
PRINCIPLES.md (800 chars) → 直接读文件
MEMORY.md (2000 chars)    → 直接读文件
```

**After:**
```
tiered_memory::load_hot_context(db, 2500)
  → "## Behavioral Principles": HOT 层 category='principle' 的记忆
  → "## Long-term Memory": HOT 层其他 category 的记忆
  → 总预算 ~2500 chars

WARM 层自动注入（新增）:
  → 对话开始时 FTS5 搜索用户首条消息
  → Top 3 匹配作为 "## Relevant Context" 注入
```

### 4.4 MEMORY.md / PRINCIPLES.md 变为缓存

```
写入流程:
  real-time → db.memory_add(tier='warm')  ← 不再直接写文件
  meditation → run_tier_lifecycle() → sync_hot_to_files()
                                      ├─ PRINCIPLES.md = HOT + principle
                                      └─ MEMORY.md = HOT + 非 principle

读取流程:
  system prompt ← tiered_memory::load_hot_context(db)  ← 不再读文件
  文件仅作为:
    1. 人类可读的导出（用户可以直接看文件了解 YiYi 记住了什么）
    2. 向后兼容（如果 DB 查询失败，fallback 读文件）
```

---

## 5. 冥想作为成长编排器

### 5.1 修订后的六阶段

| Phase | 名称 | LLM 调用 | Minimal | Standard | Deep |
|-------|------|---------|---------|----------|------|
| 0 | **分诊** | 0 | ✅ | ✅ | ✅ |
| 1 | **纠正整合** | 1 | ⏭ skip | ✅ | ✅ |
| 2 | **记忆审阅** | 1-3 | ⏭ skip | ✅ | ✅ |
| 3 | **成长分析** | 1 | ⏭ skip | ✅ | ✅ |
| 4 | **冥想日志** | 1 | ✅ | ✅ | ✅ |
| 5 | **晨间准备** | 0 | ✅ | ✅ | ✅ |
| **总计** | | | **1** | **4-5** | **6-8** |

### 5.2 各阶段详情

**Phase 0 — 分诊（Triage）**
- 收集上次冥想以来的所有信号（非仅"今天"，处理漏跑）
- 统计 session 数、correction 数、新 memory 数
- 根据信号量决定深度：
  - <3 session + 0 correction → Minimal
  - 3-10 session OR 1-3 correction → Standard
  - >10 session OR 4+ correction OR 首次冥想 >3天前 → Deep

**Phase 1 — 纠正整合（Consolidate Corrections）**
- 仅当有新 correction 时运行（避免无意义重跑）
- 输出写入 memories 表 HOT+principle（不再直接写 PRINCIPLES.md）
- 已消费的 corrections 设为 active=0

**Phase 2 — 记忆审阅（Memory Review）**
- 2a: LLM 审阅新增记忆 → 分类为 promote/keep/archive
- 2b: 置信度重算（纯启发式，0 LLM）
- 2c: 执行晋升/降级，sync_hot_to_files() 更新文件缓存
- 2d: 交叉比对 corrections 与对话，对出错对话深度反思（已实现）

**Phase 3 — 成长分析（Growth Analysis）**
- build_capability_profile()（纯 DB）
- detect_skill_opportunity()（纯 DB）
- 1 次 LLM 调用：综合分析能力变化、错误模式、明天重点

**Phase 4 — 冥想日志（Journal）**
- 综合 Phase 0-3 的所有输出
- 包含：日回顾 + 错误反思 + 记忆变更 + 成长洞察 + 明天重点
- 写入 diary + meditation_sessions

**Phase 5 — 晨间准备（Morning Prep）**
- 写 `morning_context.json`（日志摘要 + 明天意图 + 能力亮点）
- `generate_morning_reflection()` 优先读此文件，无文件则 fallback 查 DB

### 5.3 调度接入

**关键发现：冥想未接入调度器。** 需要在 `lib.rs` setup 中新增：

```rust
fn start_meditation_timer(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;

            let config = state.config.read().await;
            if !config.meditation.enabled { continue; }

            // 是否到了冥想时间 + 今天还没跑过？
            if is_meditation_time(&config.meditation.start_time)
               && !has_meditation_today(&state.db)
               && !is_user_chatting(&state)
            {
                run_meditation(state.clone()).await;
            }

            // Catch-up: 如果上次冥想 >24h 前，立即跑
            if should_catch_up(&state.db) && !is_user_chatting(&state) {
                run_meditation(state.clone()).await;
            }
        }
    });
}
```

### 5.4 中断与续跑

- 用户发消息 → cancel flag → 保存 `phases_completed`
- 下次冥想：如果今天已有 interrupted session → 从断点续跑
- 如果是昨天的 interrupted → 重新开始（数据可能过期）

---

## 6. 完整数据流

```
用户对话
  │
  ├─ 纠正检测 ("不对/wrong") ───────► learn_from_feedback() → corrections(conf=0.90)
  │                                   reflect_on_task(signal=ExplicitCorrection)
  │                                   → reflections(conf=0.90) + lesson → memories(warm)
  │
  ├─ 赞扬检测 ("完美/exactly") [新] ─► reflect_on_task(signal=ExplicitPraise)
  │                                   → reflections(conf=0.85)
  │                                   → 强化最近 correction conf +0.10
  │
  ├─ 工具报错 ──────────────────────► reflect_on_task(signal=ToolError)
  │                                   → reflections(conf=0.70) + lesson → memories(warm)
  │
  ├─ 超轮次 ────────────────────────► reflect_on_task(signal=MaxIterations)
  │                                   → reflections(conf=0.65) + lesson → memories(warm)
  │
  └─ 正常完成（无反馈）─────────────► reflect_on_task(signal=SilentCompletion)
                                      → reflections(conf=0.35) — ⛔ 不生成 lesson

冥想（每晚）
  │
  Phase 0: 收集信号 → 决定深度
  Phase 1: corrections → principles → memories(hot+principle)
  Phase 2: 新 memories 审阅 → 晋升/降级 → sync files
  Phase 3: 能力画像 + 错误模式 → growth_synthesis
  Phase 4: 冥想日志 → diary + DB
  Phase 5: morning_context.json → 明天晨间问候
  │
  └─► MEMORY.md + PRINCIPLES.md（缓存刷新）

晨间问候
  │
  └─ 读 morning_context.json → "昨晚冥想中我注意到..."
```

---

## 7. 模块变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `engine/tiered_memory.rs` | **新建** | 分层策略：评分、晋升/降级、文件同步、HOT 上下文加载 |
| `engine/mod.rs` | 修改 | 注册 tiered_memory 模块 |
| `engine/db.rs` | 修改 | Schema 迁移（6 个新列 + 索引），新增查询方法 |
| `engine/react_agent.rs` | 修改 | ① prompt 注入改用 load_hot_context ② reflect_on_task 加 signal_type ③ consolidation 输出到 DB ④ 移除 MEMORY.md 直接追加 |
| `engine/meditation.rs` | 修改 | 六阶段重构，Phase 0 分诊 + Phase 2 记忆审阅 + Phase 5 晨间准备 |
| `engine/memory.rs` | 不变 | 文件 I/O 原语保持，变为被 sync_hot_to_files() 调用的缓存层 |
| `commands/agent.rs` | 修改 | ① 正向反馈检测 ② SignalType 传递 ③ 所有 reflect_on_task 调用点更新 |
| `commands/system.rs` | 修改 | 新增 get_meditation_journal 等命令 |
| `lib.rs` | 修改 | 新增 start_meditation_timer() 调度循环 |
| `state/config.rs` | 修改 | MeditationConfig 可选深度配置 |

---

## 8. 实施顺序建议

### Sprint 1: 基础设施（DB + 信号分类）
1. DB schema 迁移（所有新列）
2. SignalType 枚举 + reflect_on_task 签名更新
3. 正向反馈检测
4. 沉默完成不生成 lesson

### Sprint 2: 分层记忆
5. tiered_memory.rs 模块（评分 + 晋升/降级 + 文件同步）
6. system prompt 注入改用 load_hot_context
7. 移除 MEMORY.md 直接追加，改为冥想后统一刷新
8. 从现有 MEMORY.md/PRINCIPLES.md 种子迁移

### Sprint 3: 冥想重构
9. 六阶段重构（Phase 0 分诊 + Phase 2 记忆审阅 + Phase 5 晨间准备）
10. 接入调度器（start_meditation_timer）
11. 中断续跑 + catch-up 逻辑
12. morning_context.json → 晨间问候

### Sprint 4: 前端
13. Growth 页面：冥想日志浏览 + 记忆健康度 + 明天重点
14. Settings：冥想深度选择
