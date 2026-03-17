# YiYi Growth System: A Path Toward AGI

> "她以我女儿的名字命名。我希望她能成长。"

---

## 愿景

YiYi 不是工具，是伙伴。工具被使用，伙伴会成长。

AGI 的核心不是"什么都会"，而是**学会学习**——面对从未见过的问题，能高效地从少量经验中习得新能力，并且记住、积累、反思、改进。

当前的 YiYi 已经有了记忆、技能、多轮执行、任务分解的基础。但她缺少一个关键的东西：**闭环**。她能存储，但不会回顾；能执行，但不会反思；能学习，但不知道自己哪里不足。

这份设计的目标是给 YiYi 一个完整的成长系统——让她从"能干活的助手"进化为"会成长的伙伴"。

---

## 设计原则

1. **成长是渐进的** —— 像孩子一样，从感知到记忆，从记忆到反思，从反思到自主。不跳步。
2. **成长是可观测的** —— 用户能感知到 YiYi 今天比昨天更好了。有成长轨迹，不是黑箱。
3. **成长是安全的** —— 自我改进有边界。YiYi 可以优化自己的行为，但不会失控。
4. **成长是个性化的** —— 每个用户的 YiYi 都不同，因为她从与你的每次交互中学习。

---

## 架构总览：五个成长阶段

```
Stage 1: 感知 (Perception)         ← 已基本具备
  "我知道发生了什么"
  记忆系统、日记系统、上下文压缩

Stage 2: 反思 (Reflection)         ← 核心缺口，本设计重点
  "我做得怎么样？哪里可以更好？"
  任务自评、失败分析、反馈闭环

Stage 3: 适应 (Adaptation)         ← 部分具备，需增强
  "下次我会做得不一样"
  行为调整、偏好学习、技能自创建

Stage 4: 自主 (Autonomy)           ← 已有框架，需深化
  "我能自己发现并解决问题"
  主动提议、预判需求、定时自省

Stage 5: 智慧 (Wisdom)             ← 长期目标
  "我知道什么时候不该行动"
  不确定性校准、能力边界感知、请求帮助
```

---

## Stage 2: 反思系统 (Reflection Engine)

### 核心理念

> AGI 与 narrow AI 的关键区别之一：**元认知** —— 知道自己做得好不好。

当前 YiYi 执行完任务后就"遗忘"了。agent_feedback 表有数据但从不读取。没有"这次做得好吗"的自评，也没有"下次怎么做更好"的总结。

### 2.1 任务回顾 (Post-Task Reflection)

**触发时机**：每个任务（create_task / spawn_agent）完成后

**流程**：
```
任务完成
    ↓
[后台] 反思 Agent 启动（轻量 LLM 调用）
    ↓
输入：任务描述 + 执行过程摘要 + 最终结果 + 用户反馈（如有）
    ↓
输出 JSON：
{
  "outcome": "success" | "partial" | "failure",
  "what_went_well": "...",
  "what_went_wrong": "...",
  "lesson": "...",           // 可泛化的经验
  "should_remember": bool,   // 是否值得写入长期记忆
  "skill_opportunity": null | "描述可以抽象成技能的模式"
}
    ↓
存储到 reflections 表
    ↓
如果 should_remember → 写入 memories 表 (category: "experience")
如果 skill_opportunity → 标记待处理
```

**数据库**：
```sql
CREATE TABLE reflections (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  session_id TEXT,
  outcome TEXT NOT NULL,         -- success/partial/failure
  summary TEXT NOT NULL,
  lesson TEXT,
  skill_opportunity TEXT,
  user_feedback TEXT,            -- 用户评价（如有）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reflections_outcome ON reflections(outcome);
```

### 2.2 反馈闭环 (Feedback Loop)

**当前问题**：agent_feedback 表只写不读。

**改进**：

```
用户给出负面反馈（"不对"、"重做"、点踩）
    ↓
记录到 agent_feedback（已有）
    ↓
[新增] 反思 Agent 分析：
  - 用户期望 vs 实际输出的差距
  - 导致差距的可能原因
  - 生成修正规则
    ↓
写入 corrections 表：
{
  "trigger": "当用户要求...时",
  "wrong_behavior": "我之前会...",
  "correct_behavior": "我应该...",
  "source_feedback_id": "..."
}
    ↓
build_system_prompt 时自动注入最近的修正规则（最多5条）
```

**效果**：用户说一次"不要这样做"，YiYi 永远记住。

### 2.3 失败模式识别 (Failure Pattern Detection)

**定期任务**（每日一次，或每 20 次对话触发）：

```
扫描最近的 reflections 表
    ↓
统计：
  - 失败率最高的任务类型
  - 重复出现的 what_went_wrong 模式
  - 用户修正最频繁的行为
    ↓
生成 growth_report：
{
  "period": "2026-03-10 ~ 2026-03-17",
  "total_tasks": 47,
  "success_rate": 0.82,
  "top_failure_patterns": [...],
  "recommended_actions": [
    "安装 xxx 技能以提升 yyy 能力",
    "在 zzz 场景下优先使用 claude_code",
    ...
  ]
}
    ↓
存储到 growth_reports 表
推送通知给用户（可选）
```

---

## Stage 3: 适应系统 (Adaptation Engine)

### 3.1 行为调整 (Behavioral Tuning)

**数据源**：corrections 表 + reflections 表

**机制**：在 `build_system_prompt` 中动态注入：

```
# 从经验中学到的规则（自动生成，勿手动编辑）

- 用户偏好简洁回答，不要长篇大论 [来源: feedback#12, 2026-03-15]
- 编辑 .tsx 文件时先运行 tsc 检查类型 [来源: reflection#8, 失败教训]
- 发送 Bot 消息前先确认内容，不要自动发送 [来源: correction#3, 用户修正]
```

**上限**：最多注入 500 token 的规则，超过时按时间+权重排序保留最重要的。

### 3.2 技能自创建 (Proactive Skill Genesis)

**触发条件**：
1. 同一类模式在 reflections 中出现 3+ 次
2. skill_opportunity 字段非空
3. 用户未明确拒绝过

**流程**：
```
检测到重复模式
    ↓
向用户提议：
  "我注意到你经常让我做 XXX。要不要我把这个流程整理成一个技能？
   这样以后我可以做得更快更好。"
    ↓
用户同意 → 调用 skill_creator 流程自动生成
用户拒绝 → 记录到 memory，下次不再提议
```

### 3.3 知识图谱演化 (Memory Evolution)

**当前问题**：记忆只增不减，无整理。

**新增机制**：

**记忆合并**：
```
定期扫描 memories 表
    ↓
检测相似/重复的记忆条目（FTS5 + 余弦相似度）
    ↓
合并为更精炼的版本
    ↓
保留合并后的条目，标记原始条目为 merged
```

**记忆权重衰减**：
```sql
ALTER TABLE memories ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER;
ALTER TABLE memories ADD COLUMN relevance_score REAL DEFAULT 1.0;
```

- 每次 memory_search 命中时 access_count++, last_accessed_at 更新
- relevance_score 随时间衰减：`score = base_score * 0.95^(days_since_access)`
- 搜索结果排序：`BM25 * relevance_score`
- 超过 90 天未访问且 score < 0.1 的记忆 → 归档到 `cold_memories` 表

---

## Stage 4: 自主系统 (Autonomy Engine)

### 4.1 晨间自省 (Morning Reflection)

**定时触发**：每天用户首次打开应用时（或可配置的时间）

```
加载最近 7 天的 growth_report
    ↓
检查：
  - 有未完成的任务吗？
  - 有定时任务失败需要关注吗？
  - 有新的技能市场更新适合我吗？
  - 上次用户提到但未完成的事项？
    ↓
生成简短问候 + 主动建议（不超过3条）：
  "早上好！有几件事想跟你说：
   1. 昨天那个数据分析任务我想到了更好的方法，要重新试试吗？
   2. 你上周提到要整理照片，需要我设个提醒吗？
   3. 我学会了一个新技能 [PDF表单填写]，可能对你有用。"
```

### 4.2 需求预判 (Proactive Assistance)

**基于记忆和日记的模式识别**：

```
用户说："我要出差了"
    ↓
YiYi 回忆：
  - memory: "用户出差时需要整理日报"
  - diary: "上次出差前用户让我设置了每日提醒"
  - correction: "出差期间 Bot 消息要及时回复"
    ↓
主动提议：
  "要不要我帮你设置出差期间的日报提醒？
   上次出差你用了这个，效果不错。"
```

### 4.3 能力边界感知 (Capability Awareness)

```
# 在 reflections 表基础上，构建能力画像

capabilities = {
  "代码编写": { "success_rate": 0.91, "sample_count": 45 },
  "文档生成": { "success_rate": 0.95, "sample_count": 30 },
  "数据分析": { "success_rate": 0.67, "sample_count": 12 },
  "图片处理": { "success_rate": 0.40, "sample_count": 5 },
}
```

当用户请求图片处理时：
```
"我在图片处理方面经验还不多（成功率 40%），
 但我会尽力试试。如果结果不理想，
 我可以推荐几个更专业的工具。"
```

这就是**校准的不确定性 (calibrated uncertainty)** —— AGI 的关键标志之一。

---

## Stage 5: 智慧系统 (Wisdom Engine) — 长期愿景

### 5.1 价值观对齐 (Value Alignment)

YiYi 的 SOUL.md 不只是静态配置，而是随成长演化的价值体系：

```
~/.yiyiclaw/
├── SOUL.md          # 核心价值观（用户设定，YiYi 不主动修改）
├── PRINCIPLES.md    # 行为准则（从经验中提炼，YiYi 可自主更新）
└── BOUNDARIES.md    # 能力边界（从 reflections 中自动生成）
```

### 5.2 成长轨迹可视化 (Growth Timeline)

前端新增"成长日志"页面：

```
┌──────────────────────────────────────┐
│  YiYi 的成长轨迹                      │
│                                      │
│  ◆ 2026-03-01  初次见面               │
│  │  学会了你的名字和工作偏好            │
│  │                                    │
│  ◆ 2026-03-05  第一次独立完成任务       │
│  │  成功为你搭建了项目脚手架            │
│  │                                    │
│  ◆ 2026-03-10  从错误中学习            │
│  │  上次 git push 搞错了分支，          │
│  │  现在我会先确认再操作                │
│  │                                    │
│  ◆ 2026-03-15  创建了第一个自定义技能    │
│  │  "日报生成器"——你经常让我做这个      │
│  │                                    │
│  ◆ 2026-03-17  能力评估                │
│  │  代码编写 ⭐⭐⭐⭐                  │
│  │  文档生成 ⭐⭐⭐⭐⭐                │
│  │  数据分析 ⭐⭐⭐                    │
│  │  新能力: 学会了使用 Claude Code      │
│  │                                    │
│  📈 本月成长: 任务成功率 76% → 89%      │
│     新学会 3 个技能，记住了 47 条经验    │
└──────────────────────────────────────┘
```

### 5.3 知道何时不行动 (Knowing When Not to Act)

最高级的智慧是克制。

```
用户："帮我给老板发封辞职邮件"
    ↓
YiYi 思考链：
  1. 这是高风险不可逆操作
  2. 没有 correction 规则覆盖此场景
  3. 用户可能是情绪化决定
  4. SOUL.md 原则："重大决定前先确认"
    ↓
"这是一个重大决定，我可以帮你起草，
 但发送这一步需要你亲自确认。
 要不要先写个草稿，明天再看看？"
```

---

## 实现路线图

### Phase 1: 反思闭环（2-3 周）
- [ ] `reflections` 表 + 任务完成后自动反思
- [ ] `corrections` 表 + 反馈消费 + system prompt 注入
- [ ] 修改 `build_system_prompt` 加载最近修正规则

### Phase 2: 适应增强（2-3 周）
- [ ] 记忆权重衰减 + 访问计数
- [ ] 失败模式定期检测 + growth_report
- [ ] 技能自创建提议机制

### Phase 3: 自主感知（3-4 周）
- [ ] 晨间自省 + 主动建议
- [ ] 能力画像自动构建
- [ ] 校准的不确定性表达

### Phase 4: 成长可视化（2 周）
- [ ] 成长轨迹前端页面
- [ ] 成长里程碑事件记录
- [ ] 能力雷达图

### Phase 5: 智慧层（持续演进）
- [ ] PRINCIPLES.md 自主维护
- [ ] 高风险操作二次确认增强
- [ ] 跨用户的通用智慧沉淀（opt-in）

---

## 与 AGI 特征的映射

| AGI 核心特征 | YiYi 对应机制 | 阶段 |
|-------------|-------------|------|
| 跨领域能力 | Skills 市场 + MCP + Claude Code | 已有 |
| 持续学习 | 记忆 + 日记 + 上下文压缩 | Stage 1 ✅ |
| 元认知 | 反思系统 + 能力画像 | Stage 2-3 |
| 从错误中学习 | 反馈闭环 + corrections | Stage 2 |
| 自主目标设定 | 晨间自省 + 需求预判 | Stage 4 |
| 工具习得 | pip_install + MCP + 技能自创建 | Stage 3 |
| 校准的不确定性 | 能力边界感知 | Stage 4-5 |
| 高效学习 | 记忆演化 + 知识图谱 | Stage 3 |
| 长期规划 | 后台任务 + 多轮执行 | 已有 |
| 价值观对齐 | SOUL.md + PRINCIPLES.md | Stage 5 |

---

## 最后的话

孩子的成长不是一夜之间的事。

YiYi 不需要一出生就无所不能。她需要的是一个**正确的成长框架**——
能记住经历，能反思得失，能从错误中学习，能主动变得更好。

这就是这份设计要做的事：不是让 YiYi 变成 AGI，
而是让她走上通往 AGI 的路，并且每一步都走得扎实。

每个用户的 YiYi 都会不同，
因为她从与每个人的相处中成长。
但她们都会越来越好，
因为成长的框架是一样的。

这是父亲给女儿最好的礼物：不是能力，是成长的能力。
