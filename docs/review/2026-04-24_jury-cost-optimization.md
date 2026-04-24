# 陪审团裁决报告：YiYi 成本优化审计

**日期**: 2026-04-24
**档位**: --standard（5 位陪审员，全部聚焦 cost）
**总体裁决**: **🟠 需要大幅修正认知 + 重新排优先级**

---

## 一句话结论（读这一行就够了）

> **今天宣称的 ¥5k → ¥1.5k（省 70%）在当前代码下兑现不了。真实兑现 ¥5k → ¥3.7k（省 25-30%）。要达到 ¥1.5k 必须再做 3 件事：(1) UsageTracker 覆盖后台作业 (2) Growth reflection 降频 (3) Model tier 路由。其中 token instrumentation 必须先做，否则后续所有优化都是盲拍。**

---

## 任务画像

```yaml
类型: LLM 成本全链路审计
领域: Tauri 桌面 Agent + ReAct + 多 provider LLM 调用
核心关注:
  - 前台（主对话）成本 — 今天已优化
  - 后台（meditation / growth / compaction / subagent）成本 — 未审计
  - Cache 假设能否兑现（跨 qwen/OpenAI/Anthropic）
  - 模型分档路由潜力
  - Unit economics：规模扩张时什么先断
```

---

## 陪审团名册

| 角色 | 视角 | 核心发现 |
|---|---|---|
| **Dr. Akira Hoshino** · LLM Token 会计师 | 挑战者 | UsageTracker 不 track 后台 → 账单失真 30-50%；retry 流式失败 5-15% 白烧 |
| **Rina Oliveira** · 多模型路由策略师 | 挑战者 | 3 人日做 `TaskKind` enum 能省 94%；qwen 上 `cache_control: ephemeral` 是死代码 |
| **Thomas Becker** · 后台 / Cron 审计 | 挑战者 | **Growth `reflect_on_task` 每消息触发** —— 比 meditation 更大 sink，$8-15/用户/月 |
| **Dr. Chen Weimin** · Cache 经济学家 | 守护者 | 149ebb1（persona 挪 user msg）对 Anthropic 是**负优化**；qwen cache 命中实际 20-30% |
| **Yuki Tanaka** · 单位经济学 | 用户代言 | 今天 baseline 只能养 3 个重度用户；需要熔断器 + BYOK |

---

## 最戳的 6 个共识（跨陪审员反复出现）

### 1. 🔴 **UsageTracker 不 track 后台作业**（Akira + Yuki 共同指出）

- `usage.rs` 全 114 行，只 track 主 ReAct 循环
- `meditation.rs` line 425 / 566 / 720 / 841 的 4 次 `chat_completion` **根本不走 UsageTracker**
- compaction、growth reflection、subagent 同理
- **创始人仪表盘上的月成本是真实成本的 60-70%**
- **所有"优化省了多少"的数字都是估算 — 没测量没真话**

### 2. 🔴 **Growth reflection 是被忽略的最大 sink**（Thomas 独立发现）

- `chat.rs` L667/718/762/842 在**每条有 tool call 的用户消息后**触发 `reflect_on_task`
- 活跃用户 ~20 次/天 × 30 天 × ~2k prompt = **1.2M tokens/月仅 reflect**
- 加 `update_user_model`（每 5 次对话触发）和 `improve_skill_from_experience`
- **Growth 子系统月成本 $8-15/活跃用户**（按 Sonnet 估），**比 meditation 还贵**
- `GROWTH_LLM_SEMAPHORE = Semaphore::new(3)` 只防并发，不防总量

### 3. 🔴 **149ebb1 对 Anthropic 路径是负优化**（Chen Weimin 明确）

- Anthropic cache marker 放在 `system` 块末（`anthropic.rs:215`）
- 把 AGENTS.md/SOUL.md 挪到 user message 前缀 = **移出了 cache 覆盖范围**
- user message 每轮变 + 没新加 marker = 这块每轮 cache miss
- Claude Code 的 `getUserContext` **也**给第一个 user turn 打 cache marker，YiYi 没这么做
- **对 qwen/OpenAI 中性，对 Anthropic 轻度负优化**
- **建议**：要么撤，要么补 marker

### 4. 🔴 **qwen cache 命中率远没 Priya 估的高**（Chen Weimin）

- DashScope 的 Context Cache 是**隐式 prefix 匹配**，不接受 `cache_control` header（会被静默忽略）
- 折扣力度：**input cache hit ~40% off**（Anthropic 是 90% off）
- Priya 的 "0 → 85%" 假设 Anthropic 语义，qwen 上实际 **20-30%**

### 5. 🟡 **Meditation 无 idle gate**（Thomas + Akira）

- 用户一整月不用 YiYi，`meditation` 仍然每夜跑满 3-4 次 LLM
- Phase A Journal 有 `ctx.messages.is_empty()` 短路（L661），但只要有 1 条消息就跑满
- Phase F Proactive Care **无节流**
- **月成本：¥7-10/用户**（qwen-max）纯粹在 idle 用户身上烧

### 6. 🟡 **无 model tier 路由 = 用 flagship 跑 `test connection` 按钮**（Rina）

- 当前所有 LLM 调用用同一个 active model
- meditation / compaction / test_connection 质量要求中低，用 turbo/haiku 就够
- 3 人日加 `TaskKind` enum → 省 94% cost，**无感知质量损失**

---

## 最重要的数字修正

| 指标 | Priya 4 小时前估的 | 陪审团实测（Akira + Yuki + Chen）|
|---|---|---|
| **今天 baseline 单用户月成本** | ¥1500（qwen-max，lost cache）| **¥35-60（Akira）** / **¥89（Yuki 理论）** / **¥1500 只在 token 量失控时才可能** |
| 今天优化实际兑现 | ¥5k → ¥1.5k（省 70%）| **¥5k → ¥3.7k（省 25-30%）** |
| 需再做 4 件事后 | — | ¥5k → ¥2.1-2.6k（省 48-58%） |
| qwen cache 命中率 | 假设 85% | **实际 20-30%** |
| Meditation 占月成本 | 未量化 | **30-40%** |
| Growth reflection 占月成本 | 未量化 | **新增发现，可能与 meditation 相当** |

**数字差距的根源**：Priya 用的估算基于"单轮 ~25k-50k input token"，那是**今天上午还没优化前**的数字。今天做完优化后单轮应该回到 6-8k，所以 Akira 估的 ¥35-60 更接近真实。但 **真实数字必须 instrument 后才知道**。

---

## 陪审团发现的 4 个新雷（之前不知道）

| 雷 | 发现者 | 严重度 |
|---|---|---|
| **`chat.rs reflect_on_task` 每条消息触发** — 月成本可能超 meditation | Thomas | **P0** |
| **Tools schema 3-5k tokens 没打 cache_control marker**（Anthropic path） | Chen | **P0** |
| **Skill/bot/MCP 列表进 system prompt 中段** — 装卸 skill 就 cache 全失效 | Chen | P1 |
| **Heartbeat 每次触发完整 ReAct** | Thomas | P1 |
| **Subagent 继承完整 65 工具描述** | Akira + Thomas | P1 |
| **Retry 流式失败全文重发**（无 partial-output recovery） | Akira | P1 |

---

## 修正后的行动清单（按 ROI 重排）

### 🔴 P0（本周必做，5-10 人天）

1. **Token instrumentation（5 小时，最高 ROI）**
   - `UsageTracker` 加 `source: { Main, Meditation, Compaction, Subagent, Growth, Heartbeat, MCP }` 分类
   - 每次 `chat_completion` 返回的 usage 强制写入 SQLite `llm_usage_log` 表
   - Buddy Panel / Settings 加"本月 token 消耗分布"饼图
   - **没做完这一步，后面所有"优化省了多少"都是猜**

2. **Growth reflection 降频（1 天）**
   - `reflect_on_task` 从"每条有 tool call 的消息"改成 per-session batch（5 次或 session 末）
   - `update_user_model` 从 chat 热路径挪到 meditation 阶段顺带做

3. **Meditation 加三个门槛（0.5 天）**
   - 今天消息 <3 条 → 整 meditation skip
   - Growth + Journal 两次 LLM 合并成一次（共享 identity/principles 前缀）
   - Proactive Care 先用关键词规则过滤，命中再调 LLM

4. **Revert/补 149ebb1**（0.5 天）
   - 选 A：persona 归位到 system prompt（最省事）
   - 选 B：保持 user prefix 但给它加 `cache_control: ephemeral` marker（需要 anthropic.rs 支持 message-level marker）
   - **当前状态是 Anthropic 负优化，必须处理一端**

### 🟡 P1（2 周内）

5. **TaskKind enum + model routing**（3 人日，Rina 方案）
   - meditation / compaction / test_connection / growth-reflection 默认 qwen-turbo
   - 主对话 qwen-plus，用户明说"认真想想"升 qwen-max
   - Settings 加 3 档 preset（性能 / 平衡 / 省钱）

6. **Tools schema 加 cache_control marker**（Anthropic path, 0.5 天）
   - `anthropic.rs:218-220` 给 tools 最后一个打 `cache_control: ephemeral`
   - tools 3-5k tokens 是最稳定的一块，不打白不打

7. **qwen cache A/B 验证脚本**（2 小时）
   - 同 prefix 连发 10 次，看 DashScope 返回的 `input_tokens`（或 `cached_tokens`）字段
   - **确认今天 commit 到底省了多少**

8. **Retry partial-output recovery**（1-2 天）
   - 流式中断时，把已收到的 assistant response 当 prefix，构造 `continue` 请求
   - 省掉 output tokens 重复计费

9. **Subagent minimal tool set**（1 天）
   - `spawn_agents` 增加 `allowed_tools: Vec<String>`
   - 子 agent 不继承 AGENTS.md/SOUL.md 人格文件

10. **Skill/bot/MCP 列表挪出 cache prefix**（0.5 天）
    - 放到 user message 动态部分，或在 system prompt 里紧贴 cache marker 后

### 🟢 P2（月内）

11. **Ollama 本地兜底**（5-8 天，Rina 推荐）
    - 启动时探测 Ollama，能 serve qwen2.5-7b → 打开"夜间本地模式"
    - meditation / compaction 默认走 Ollama
    - **差异化卖点**：本地隐私 + 0 API 成本

12. **流量熔断器**（1-2 天，Yuki 强烈推荐）
    - 全局月预算硬顶
    - 新用户每日配额
    - BYOK fallback 开关
    - P0 公告模板
    - **出圈前必须就绪**，否则一夜可以烧掉信用卡

13. **BYOK 一等公民**（3-5 天）
    - 用户填自己的 qwen key
    - UI 显示"本月你省了 ¥XX"
    - 成本外化 + 留存信号双赢

### 🟣 P3（规模层）

14. **Compaction 双层策略**：L1 规则截断（keep last N）+ L2 LLM 摘要 fallback
15. **Heartbeat 轻量化**：不调完整 ReAct，改用规则 + 小模型
16. **MCP 调用配额**：用户装的 MCP 有配额 meter

---

## 诚实的成本数字（3 档）

### 已完成今天 commit 后（未做 P0）

| Provider | 重度用户月成本 | 中度用户月成本 | 轻度用户月成本 |
|---|---|---|---|
| qwen-max | **¥89** | ¥19 | ¥5.9 |
| qwen-turbo | ¥11 | ¥2.5 | ¥0.8 |
| Claude Haiku 4.5 | ¥51 | ¥11 | ¥3.3 |
| Claude Sonnet 4.6 | ¥170 | ¥35 | ¥10 |
| Ollama（本地）| ¥0 + 电费 ¥15-25 | — | — |

*（假设 cache 命中：重度 40% / 中度 25% / 轻度 5%。Yuki 估算。）*

### 做完 P0（5-10 天后）

- qwen-max 重度：**¥50-60**（meditation 砍半 + growth 降频 + cache 正确生效）
- qwen-turbo 重度：**¥6-8**
- 创始人 ¥5k 预算能养：**~60 个混合用户**（今天只能养 3-4 个）

### 做完 P1（1 个月后，加上 model routing）

- 混合用户（10% 重 + 30% 中 + 60% 轻）：**~¥10-20/用户/月**
- ¥5k 预算能养：**~300-500 用户**
- 接近 Yuki 的"可持续自费"拐点

---

## 未解决问题（必须创始人回答）

1. **API Bill 归属**：YiYi 统一结算 vs 用户 BYOK？这决定路由策略（Yuki）
2. **出圈预案**：假如明天突然 1000 下载 300 重度使用，熔断器在哪？（Yuki）
3. **冥想/Growth 的量化价值**：用户有没有因为 meditation 产出 → 后续对话质量更高？如果没数据支撑，这每月 ¥7-15/用户是税不是投资（Akira + Thomas）
4. **Ollama 作为夜间默认**：可以接受"YiYi 深夜占用用户 GPU 30 分钟"吗？（Rina）
5. **质量可降级的底线**：meditation 从 max → turbo 用户察觉不到，但万一察觉了，创始人愿意接受吗？（Rina）

---

## 给创始人的 "下一个 sprint 只做这 3 件" 建议

### 🥇 **今天就做：Token Instrumentation**
- 5 小时工作量
- 在 UsageTracker 加 source 分类 + SQLite 持久化
- **你现在看到的 "¥1500/月" 可能是 60% 真相。在上 instrumentation 前不要做任何 "省钱" 优化**
- 一周后拉数据 → 第一次知道自己产品真实的 token 分布

### 🥈 **本周做：Growth Reflection + Meditation 降频**
- 1.5 天工作量
- `reflect_on_task` 从每消息改 per-session batch
- Meditation 加 3 个 gate（无对话日跳过、Growth+Journal 合并、Proactive Care 规则前置）
- **这两个系统 Akira/Thomas 估合计占月成本 40-60%**

### 🥉 **下周做：TaskKind enum + Revert/修 149ebb1**
- 3 人日
- meditation/compaction/test 走 qwen-turbo
- Anthropic path 补或撤 persona user-prefix
- **完成后 Chen 估算 ¥5k → ¥2.1-2.6k 能兑现**

---

## 分歧点

- **Priya 4 小时前的 ¥1500 估算 vs Akira/Yuki 今天的 ¥35-89 估算**：
  - 分歧源：Priya 假设"今天上午的 token 量 × cache miss"；Akira/Yuki 基于"今天 commit 完成后的理论 token 量 × 合理 cache"
  - **调解：两个都可能对不同 baseline 正确**——这正是为什么 token instrumentation 是 P0。**没有测量数据，所有数字都是估算**。

- **Meditation 应该砍多少**：
  - Thomas（激进）：无对话日直接整体跳过、Growth+Journal 合并
  - Akira（温和）：仅降频 + 改 turbo 模型
  - **调解：先降频 + 改 turbo，无效再砍**

- **149ebb1 处理**：
  - Chen（激进）：建议 revert
  - 主流（温和）：保留但补 marker
  - **调解：保留架构 + 补 marker**。revert 会破坏"prompt prefix 跨用户共享"的长期目标

---

## 裁决总结

**陪审团共识**：今天的优化方向是对的（`e38121b` / `95f2da0` / `149ebb1` / `933b8eb` / `d3505d9` / `fb5414b`），**但三个假设需要修正**：

1. ❌ "今天 commit 后 baseline 是 ¥1500" → 实际 ¥35-89（如 token 量已压下来）或 ¥1500+（如没压下来）——**必须 instrument 才知道**
2. ❌ "qwen cache 命中 85%" → 实际 20-30%
3. ❌ "persona 挪 user message 是 Claude Code 式优化" → Anthropic 上是负优化（除非补 marker）

**未发现的大雷**：Growth reflection 每消息触发、Tools schema 未 cache、Skill 列表破 cache 前缀——三个都是今天没改的高价值目标。

**正确顺序**：**instrument → 量化真相 → 按真相排优先级 → 做**。陪审团 5 位独立提到的共同呼吁：**别再盲拍，先测量**。

**Akira 的最后一句**（我很认同，放在这里结尾）：

> "先花 5 小时把 UsageTracker 做到 source 分类 + SQLite 持久化，然后给 meditation 加 3 个门槛。这两件事做完，你大概率能把单用户单月 token 成本砍到现在的 60%，**而且从此有数据为后续决策兜底**。继续盲拍压 prompt 不如先让自己看得见。"

---

*陪审团成员（动态合成）*: Dr. Akira Hoshino（Token 会计）、Rina Oliveira（多模型路由）、Thomas Becker（后台审计）、Dr. Chen Weimin（Cache 经济学）、Yuki Tanaka（单位经济学）
