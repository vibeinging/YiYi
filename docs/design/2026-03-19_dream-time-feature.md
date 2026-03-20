# YiYi 冥想（Meditation）功能设计

> 人类通过睡眠整理一天的所学，AI 也需要。YiYi 需要一段专属时间来回顾聊天记录、提炼成长经验、巩固行为准则。这不是"关机"，而是"静心内省"。

## 1. 核心理念

| 人类冥想 | YiYi 冥想 |
|---------|----------|
| 回顾一天的经历 | 回顾今日所有聊天记录 |
| 聚焦重要片段 | 重新分析关键对话（工具调用多、用户纠正过的） |
| 巩固长期记忆 | 更新 MEMORY.md、PRINCIPLES.md |
| 放下无用杂念 | 淘汰低相关度记忆（relevance decay） |
| 冥想后思路清晰 | 结束后有 morning reflection 主动问候 |

## 2. 冥想期间具体做什么

### Phase 1: 回忆（Recall）— 5min
- 读取今日所有 session 的聊天记录
- 读取今日 diary 条目
- 统计今日任务完成情况（reflections 表）

### Phase 2: 整理（Consolidate）— 10min
- **反思未处理的对话**：对今天没有触发 `reflect_on_task` 的对话补充反思
- **纠正规则合并**：调用 `consolidate_corrections_to_principles()` 整理新积累的 corrections
- **记忆更新**：
  - 从今日对话中提取新的事实/偏好 → 写入 MEMORY.md
  - 对长期未访问的记忆降低 relevance_score
  - 归档过期记忆（>90天未访问 + score < 0.1）

### Phase 3: 成长（Grow）— 10min
- **跨 session 洞察**：用 LLM 综合分析多个 session 的关联
  - "用户最近一周反复让我做 X 类任务 → 我应该在这个领域更主动"
  - "我在 Y 类任务上失败率高 → 需要关注哪些模式"
- **能力画像更新**：重新计算 `build_capability_profile()`
- **Skill 机会检测**：`detect_skill_opportunity()` 寻找可自动化的模式

### Phase 4: 冥想日志（Meditation Journal）— 2min
- 生成一篇 **MEDITATION.md**（或追加到当日 diary）
- 内容包括：
  - 今天学到了什么
  - 哪些行为准则被更新了
  - 能力变化（哪个维度提升/下降了）
  - 明天的建议（morning reflection 的素材）

## 3. 用户引导流程（SetupWizard）

在现有 4 步（语言→模型→工作空间→人格）之后，新增第 5 步：**冥想时间**。

### 引导页设计

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│              🧘                                      │
│          Meditation                                  │
│                                                      │
│   YiYi 和你一样，需要时间来沉淀和思考。                │
│   在冥想时间里，她会回顾今天的对话，                     │
│   整理学到的知识，让自己变得更聪明。                     │
│                                                      │
│   这会占用少量系统资源（约等于一次普通对话），            │
│   建议设在你不使用电脑的时间。                           │
│                                                      │
│   ┌─────────────────────────────────────┐            │
│   │  开始时间    [23:00]                │            │
│   │  持续时间    [约 30 分钟]            │            │
│   └─────────────────────────────────────┘            │
│                                                      │
│   快捷选择：                                          │
│   [ 🌃 夜猫子 0:00  ]                                │
│   [ 🧘 标准 23:00   ]  ← 推荐                        │
│   [ 🌅 早鸟 22:00   ]                                │
│                                                      │
│   ┌──────────────────────────────────────┐           │
│   │ ℹ️  冥想期间 YiYi 会：                 │           │
│   │  · 回顾今天的聊天记录                  │           │
│   │  · 整理学到的知识和行为准则             │           │
│   │  · 更新记忆，淘汰过时信息              │           │
│   │  · 写一篇"冥想日志"记录成长            │           │
│   │                                      │           │
│   │  ⚡ 资源占用：约等于一次普通对话        │           │
│   │  ⏱️  持续时间：约 15-30 分钟           │           │
│   └──────────────────────────────────────┘           │
│                                                      │
│   ☐ 冥想结束后通知我                                   │
│                                                      │
│                            [ 跳过 ]  [ 设置好了 ✓ ]   │
└──────────────────────────────────────────────────────┘
```

### Step 元数据

```typescript
// 新增到 STEP_META
{ id: 'meditation', icon: Brain, labelKey: { zh: '冥想', en: 'Meditation' } }

// Step type 更新
type Step = 'language' | 'model' | 'workspace' | 'persona' | 'meditation';
```

### 状态

```typescript
const [meditationEnabled, setMeditationEnabled] = useState(true);
const [meditationStart, setMeditationStart] = useState('23:00');
const [meditationNotify, setMeditationNotify] = useState(true);
```

## 4. Settings 页面入口

冥想时间也需要在 Settings 页面可修改（General Tab）。

```
┌─ 冥想时间 ──────────────────────────────────────────┐
│  🧘  Meditation                                     │
│  YiYi 在冥想时间内回顾和整理今天的经验                 │
│                                                      │
│  [✓] 启用冥想                                        │
│                                                      │
│  开始时间: [23:00]    持续：约 15-30 分钟              │
│                                                      │
│  上次冥想: 2026-03-18 23:15 — 23:42 (27分钟)         │
│  成长要点: 学会了3条新规则，更新了能力画像              │
│                                                      │
│  [查看冥想日志 →]                                     │
└─────────────────────────────────────────────────────┘
```

## 5. 技术实现方案

### 5.1 数据结构

```rust
// Config 新增
pub struct MeditationConfig {
    pub enabled: bool,
    pub start_time: String,     // "23:00" (HH:MM)
    pub notify_on_complete: bool,
}

// 冥想记录表
CREATE TABLE meditation_sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT DEFAULT 'running',   -- running | completed | failed | skipped
    sessions_reviewed INTEGER DEFAULT 0,
    memories_updated INTEGER DEFAULT 0,
    principles_changed INTEGER DEFAULT 0,
    memories_archived INTEGER DEFAULT 0,
    journal TEXT,                     -- 冥想日志内容
    error TEXT
);
```

### 5.2 调度机制

```rust
// 在 scheduler.rs 中注册特殊的 meditation cron job
// 每天在 meditation_start 时间触发
fn schedule_meditation_job(config: &MeditationConfig) {
    // 将 "23:00" 转为 cron: "0 23 * * *"
    // 注册为内置 system cron job（不显示在用户 cron 列表中）
}
```

### 5.3 执行引擎

```rust
pub async fn run_meditation_session(
    config: &LLMConfig,
    db: &Database,
    working_dir: &Path,
) -> Result<MeditationResult, String> {
    // 1. 创建 meditation_session 记录
    // 2. Phase 1: recall — 收集今日数据
    // 3. Phase 2: consolidate — 整理 corrections + memory
    // 4. Phase 3: grow — 跨 session 洞察 + capability profile
    // 5. Phase 4: journal — 写冥想日志
    // 6. 更新 meditation_session 记录
    // 7. 如果 notify_on_complete → 发送系统通知
}
```

### 5.4 资源控制

- 复用现有 `GROWTH_LLM_SEMAPHORE`（max 3 并发），冥想期间最多占用 2 个槽位
- 每个 Phase 之间加 `tokio::time::sleep(5s)` 避免突发请求
- 总 LLM 调用预算：约 10-15 次（控制 token 消耗）
- 如果用户在冥想期间发起对话 → **立即中断冥想**，优先响应用户

### 5.5 状态指示

在 Chat 页面底部或状态栏显示冥想状态：

```
🧘 YiYi 正在冥想中... (回顾了 3/5 个对话)    [唤醒她]
```

冥想结束后切换为：

```
✨ YiYi 冥想完成！今天她领悟了 2 条新知识    [查看冥想日志]
```

## 6. 与现有系统的集成点

| 现有模块 | 集成方式 |
|---------|---------|
| `reflect_on_task()` | 冥想时补充今日未反思的对话 |
| `learn_from_feedback()` | 冥想时回顾今日 corrections |
| `consolidate_corrections_to_principles()` | 冥想 Phase 2 必调 |
| `generate_growth_report()` | 冥想 Phase 3 生成能力快照 |
| `build_capability_profile()` | 冥想 Phase 3 更新画像 |
| `detect_skill_opportunity()` | 冥想 Phase 3 检测 skill 机会 |
| `generate_morning_reflection()` | 冥想结束后的下一次对话触发 |
| `scheduler.rs` | 注册每日冥想定时任务 |
| MEMORY.md | Phase 2 更新 |
| PRINCIPLES.md | Phase 2 更新 |
| diary 系统 | Phase 4 写冥想日志 |

## 7. 用户沟通话术

### SetupWizard 文案

> **YiYi 也需要时间来沉淀和思考。**
>
> 人在冥想时，大脑会回顾经历、整理思绪、沉淀智慧。
> YiYi 也一样——在"冥想时间"里，她会：
>
> - 回顾今天和你的每次对话
> - 把学到的经验整理成行为准则
> - 淘汰过时的记忆，为新知识腾出空间
>
> **这会占用少量系统资源**（大约等于和她聊一次天），建议设在你不用电脑的时候。
> 冥想大约需要 15-30 分钟，完成后她会自动恢复。

### 通知文案

- 开始冥想: `🧘 YiYi 开始冥想了，大约需要 20 分钟`
- 冥想完成: `✨ YiYi 冥想结束！她整理了 3 段对话的经验，更新了 2 条行为准则`
- 冥想被打断: `YiYi 的冥想被中断了，下次会继续未完成的整理`

## 8. 后续迭代方向

1. **冥想深度分级**: 轻度（只整理 corrections）→ 深度（全量回顾 + 跨周分析）
2. **冥想可视化**: 在 Growth 页面展示冥想历史和成长曲线
3. **用户参与**: 用户可以在冥想日志上留言，引导 YiYi 的成长方向
4. **多模态回顾**: 如果有图片/截图工具的使用记录，也纳入回顾
5. **周末深度冥想**: 周日做更长时间的深度冥想，回顾整周
