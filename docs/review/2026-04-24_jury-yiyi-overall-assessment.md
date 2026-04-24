# 陪审团裁决报告：YiYi 整体评估（产品 / 技术 / 性能）

**日期**: 2026-04-24
**档位**: --standard（6 位陪审员）
**总体裁决**: **🟠 需要修改**（反对票 2，有条件赞成 4；P0 风险 8 项）

---

## 任务画像

```yaml
类型: 整体产品/技术/性能综合评估（全局架构）
领域: 桌面 AI 个人助理 (Tauri 2.x + React/TS + Rust), LLM Agent (ReAct), 多平台 Bot, Skills/MCP 扩展
规模: 9.1 万行（Rust 57K + TS 34K），153 Rust + 146 TS 源文件
涉及子系统:
  - Rust 引擎: react_agent (prompt.rs 974, growth.rs 1367), 65 工具, 228 tauri commands
  - 前端: 146 文件, 1.2MB 主 chunk, i18n.ts 1638 行
  - Bot 层: 7 个平台
  - 记忆/成长/冥想/人格系统
  - Skills + MCP + Playwright + Claude Code 集成
核心风险面:
  1. 产品定位左右横跳（陪伴 vs 工具 vs 聚合）
  2. Scope 爆炸 vs 单人维护
  3. 技术债（stash 8400 行 3 天未 commit、35 分支）
  4. 大文件堆积（tools/mod.rs 1467 / prompt.rs 974 / i18n.ts 1638）
  5. 桌面性能（1.25MB 单 chunk + Playwright 保活）
  6. LLM 工程质量（974 行 prompt + 65 工具 + 5 eval case）
```

---

## 陪审团名册

| 角色 | 视角 | 核心关注 | 裁决 |
|---|---|---|---|
| **林岸** · 产品定位批判师 | 挑战者 | 工具/陪伴/聚合三合一的合理性、护城河、JTBD | ❌ 反对 |
| **Marcus Chen** · Tauri 2.x 生产化工程师 | 守护者 | 228 commands / capabilities / 发布链路 | ⚠️ 有条件（生产化门槛以下） |
| **Dr. Priya Venkatesan** · LLM Agent 工程负责人 | 挑战者 | Prompt 成本 / 工具路由 / eval 规模 / channel collapse | ❌ 反对（C-/ not production-ready） |
| **Kenji Sato** · 桌面应用性能工程师 | 守护者 | 冷启动 / idle RSS / bundle / Playwright 保活 | ⚠️ 有条件（A-/B+ 档位，有 1-2 周活能进 A） |
| **Dr. Hannah Zweig** · 代码可维护性考古学家 | 挑战者 | 工作记忆溢出 / 补丁式修复 / 单人可持续性 | ⚠️ 有条件（14 天内建 3 条纪律） |
| **Sofia Marín** · 情感陪伴 UX 代言人 | 用户代言 | 命名仪式 / 里程碑文案伦理 / 桌面精灵历史债 | ⚠️ 有条件（概念 7，执行 4） |

*（原计划 6 位，实际并行起了第 7 位"前端工程性能审查"覆盖 Zustand/i18n/可访问性细节，其裁决 B-，内容并入）*

---

## 投票结果

- **反对 ❌**：林岸（产品定位）、Priya（LLM 工程）
- **有条件赞成 ⚠️**：Marcus、Kenji、Hannah、Sofia、前端工程师
- **赞成 ✅**：无

**总体裁决**：**需要修改**（反对 2，且 P0 风险未解决 ≥ 5 项）

---

## 各陪审员详细评审

### ❌ 林岸（产品定位批判师）

**核心判决**：YiYi 同时做工具、陪伴、聚合三件事，且把最弱的一环（桌面 sprite 陪伴）放在品牌最前面。这不是"全能助手"，这是**产品经理不愿做取舍的症状**。在没有品牌、没有渠道、没有独占模型的情况下，0.0.5-beta 的资源不允许三线作战。

**关键论据**：
- **三合一赛道无活下来的先例**：Character.AI（陪伴、2024 被 Google 收编）、Pi（陪伴、2024 解散）、Chatbox/LobeChat（聚合，零护城河）、Raycast（纯工具，极致才付费）、Dive/Msty（最像 YiYi，全部困在极客圈未破百万月活）
- **创始人自认的护城河已被抹平**：ChatGPT 2024 长期记忆、Claude Projects、Cursor workspace memory
- **sprite 象限尴尬**：既不够纯装饰（有人格负担），又不够独立陪伴（桌面常驻打扰工作）→ 滑向 Clippy 象限
- **"女儿命名"对用户是心理门槛**：Siri/Alexa/Cortana/Copilot 没一个用真人名，Replika 强制用户自己命名
- **Bot 7 平台战略分裂**：Discord（欧美极客）vs 飞书/钉钉/企微（中国 B 端）vs QQ（个人用户让 AI 连 QQ 有巨大心理障碍）
- **两个 JTBD 场景压力测试全部失败**：都能被 Claude desktop / Lark AI 替代

**必须回答的问题**：
1. 如果只能留一条线（工具/陪伴/聚合），留哪条？砍另外两条 80% 功能。
2. 有没有任何一个真实用户愿意卸载 Claude desktop 只用 YiYi？
3. 女儿叙事是产品还是纪念品？

---

### ❌ Dr. Priya Venkatesan（LLM Agent 工程负责人）

**核心判决**：C- / **Not production-ready for autonomous operation**。这是感性驱动、架构未收敛的 agent 工程。YiYi 正在 Anthropic 见过至少 3 次的死亡曲线上：**prompt 越长 → model 越不听 → 加更多 prompt 规则 → model 更不听**。

**关键论据（带数字）**：
- **System prompt token 估算**：~45-50k tokens（prompt.rs 24k + 65 工具 description 16k + SOUL/AGENTS 2-8k + memory 0.5-2k）
- **月成本预测**：单条对话 ¥8-10，20 条/天 × 30 天 = **¥4,800-6,000/月/用户**。个位数用户能烧死你。
- **工具数量**：YiYi 65 个 vs Claude Computer Use v1 的 **4 个** / v2 的 7 个 / Claude Code ~15 / Cursor ~12-15 / Cline ~10。你是所有活跃 agent 产品的 **2.5-16 倍**。
- **Gorilla benchmark**：工具数 >30 时 GPT-4 top-1 accuracy 从 92% 掉到 ~75%。qwen-max 在 65 工具上估计 20-30% 错误率。
- **明显冗余 ≥5 组**：read_file/grep/search_files、write_file/edit_file/multi_edit、pip_install/npm_install、remember/recall/search_memories、create_task/claude_code_delegate
- **5 eval case + LLM-as-judge = Assurance Theater**：Anthropic 内部 agent eval 规模 500-2000 case，你们当前**连 40% degradation 都 catch 不到**
- **Channel collapse**：`fix(permission) stop reason string from poisoning LLM` 是 whack-a-mole，根因是**tool output channel 和 agent reasoning channel 没隔离**，web_search/browser_use 结果里的 `"Click here"` 会让 agent 真的去点击
- **`growth.rs` 1367 行**：99% 是 journaling，不是 learning——**0 行 eval 闭环**。是 UX 动画伪装成 RL。
- **MemMe 三连 fix（memory summary 被当作 task / 召回限制 / AGENTS.md 双重确认）** 暴露的是 auto-inject + 无 memory typing 的架构问题

**核心处方**：
- **下个 sprint 不要加功能**，只做 3 件事：工具懒加载（intent-routing 或 embedding retrieval）、eval 扩到 ≥200、tool output trust envelope
- 工具合并 65 → 25-30
- browser_use 22-in-1 拆成 4 个 phase group
- 砍掉 auto-inject memory；只保留 on-demand `recall_memories`

---

### ⚠️ Marcus Chen（Tauri 2.x 生产化工程师）

**核心判决**：能跑，但在生产化门槛线以下。距离一个月活 10k+ 的可维护 Tauri 2.x 应用差 3 道工。

**关键发现（按严重度）**：

| # | 风险 | 严重 |
|---|---|---|
| R1 | **capabilities/default.json 给 LLM agent 裸 `shell:allow-execute` + `pty:default`，无 scope 限定**，任何触达 webview 的代码（claude-code-* 子窗口、渲染的 markdown、skill）都能执行任意命令 | **Critical** |
| R2 | **Cargo.toml 版本号仍是 0.0.1**，tauri.conf 是 0.0.5-beta.1，crash report / panic 看到的会是前者 | **High** |
| R3 | **228 commands 无 `tauri-specta` / `ts-rs` 类型生成**，前后端 228 个对接点纯人工维护 → 1 年内被 runtime typeerror 淹没 | **High** |
| R4 | `invoke_handler!` 扁平 228 项宏展开，拖慢 release 编译 ≥2min、增量 10-20s | **Medium** |
| R5 | `tauri_plugin_pty 0.2.1` 第三方低成熟度依赖，建议用 `portable-pty` 自实现 | **Medium** |
| R6 | Playwright bridge 用 **stderr 解析 `DevTools listening on ws://...`** + HTTP random port，脆弱。应改 `BrowserServer.wsEndpoint()` + UDS | **Medium** |
| R7 | `bundle.targets: "all"` 但只签 macOS，Win/Linux 产物未签用户装不上 | **Medium** |
| R8 | 工具 schema 用 `serde_json::json!` 手写，与 Rust struct 无绑定（加字段必然只改一边） | **Medium** |

**生产化 3 件事**：
1. **今天**：Cargo.toml 版本同步 + capabilities 加 shell scope
2. **本周**：接 `tauri-specta`，228 commands 按模块拆成 N 个 plugin-style builder
3. **本月**：Playwright bridge 换 wsEndpoint + UDS；`claude-code-*` 子窗口隔离到 minimal capability

---

### ⚠️ Kenji Sato（桌面应用性能工程师）

**核心判决**：Tauri 红利没吃够——比 Electron 省但没到 Tauri 该有的水平。有 1-2 周活可以从 A-/B+ 档进 A 档。

**量级估算**：

| 指标 | 估算 | 同档 |
|---|---|---|
| 冷启动 TTI (M2 warm) | 700ms-1.2s | Claude desktop (2-3s) 好，Tauri 理想 (<700ms) 差一档 |
| 冷启动 TTI (Intel i5) | 1.2-2s | |
| Idle RSS | 200-320MB | 比 Claude desktop (300-500) 轻，比 Tauri hello (40-60) 重很多 |
| 优化后 idle RSS | 130-190MB | 进入 Msty (150-280) 档位 |

**Bundle 拆解（1.25MB 主 chunk 341KB gzip）**：
- i18n.ts 1638 行 zh+en 全树 ~150-250KB minified
- 12 个 page 全静态 import ~500-700KB
- React + lucide-react ~190-290KB
- 其他 ~100-150KB

**最大 ROI 优化（按顺序）**：
1. **Playwright Chrome idle timeout 15min auto-suspend** — 半天活，可省 200-400MB RSS
2. **yiyi-logo PNG → WebP + resize** — 下午就能做，bundle -1.2MB
3. **React.lazy 12 个页面组件** — 1-2 天，TTI -300~500ms，idle RSS -30~60MB
4. **FileCard mousemove → rAF + ref.transform** — 半天，消除每 px setState hot path
5. **document.hidden suspend sprite/particle intervals** — 半天，电池友好
6. **i18n 按 locale split** — 1 天，首屏 gzip -30~50KB

**长期运行隐患**：
- 7 bot WS/polling 无 reconnect metrics，黑盒
- Playwright Chrome 保活：用户忘 stop → 8 小时后可能稳定 400-800MB（极端情况上 GB）
- Low Power Mode 下 sprite 仍全速动画，是个小 bug

**团队应引入的纪律**：每周 Friday 录 60s idle + 60s active Chrome DevTools Performance，存 `docs/perf/YYYY-MM-DD.json`。没数据的性能优化叫玄学。

---

### ⚠️ Dr. Hannah Zweig（代码可维护性考古学家）

**核心判决**：一座仍在生长的年轻城市，**地下水位过高，排水系统靠一个人挖**。14 天决定命运——90% 同类项目在这个时刻选择继续冲，6 个月后进入慢性消耗；10% 放慢 2 周建纪律，进下一个增长期。

**关键观察**：

1. **大文件是沉积岩不是岩浆岩**：`tools/mod.rs 1467` / `prompt.rs 974` / `growth.rs 1367` / `i18n.ts 1638` 是多次叠加的结果。**最可疑的是** `commands/system.rs 1318` + `commands/bots.rs 1210`——应该最薄却最厚，是"方便 > 边界"的反复选择痕迹。

2. **35 分支里 15+ 个 `worktree-agent-*` 前缀 = 一个人 + 多个 AI agent 并行工作的新物种**。这是 2025-2026 才有的模式，病理非常像 2015 年"一人三电脑三 feature branch"——只是更快、更分裂。

3. **stash-3-days 事故的医学分类：工作记忆溢出综合征**。单 stash 包含 5 个领域（icons/skills/buddy/session/Rust）、125 文件、8400 行——超过任何人不写 notes 能持有的上下文。经验公式：**超过 40 文件 / 1500 行的未 commit 改动，72 小时内必定遗忘细节**。这不是最后一次——下次期望 4-8 周后，可能是数据迁移脚本丢失。

4. **补丁式修复的三种未来**：
   - **乐观 30%**：4 周内建立 `LLMContext` 抽象，补丁频率降到 1/月，可维持 2-3 年
   - **中性 50%**：继续补丁，每周 3-5 小时被吞噬，6 个月后开始讨论 rewrite
   - **悲观 20%**：某次规则冲突导致"两难 bug"（permission 时弹时不弹），调试成本 10 倍

5. **测试 1045+858 但 stash 绕过** = 测试存在 ≠ 测试被使用。CI 是唯一保险丝，**stash 本身就是对 CI 的绕过**。

6. **"AGI 伙伴" 距离**：ChatGPT 40 分、Claude Code 80 分、Cursor 70 分 → YiYi **25-30 分**。差的不是"更多工具"，是长期记忆结构化、人格连续性、主动性。

7. **单人维护预算**：乐观 18-24 月、中性 9-12 月、悲观 4-6 月。

8. **接手门槛**：代码可读（新人 2 周读懂 70%），但 **prompt.rs 974 行每条规则"为什么存在"是创始人大脑里的隐性知识**——没有 ADR 就失去产品魂。

**必须回答**：
1. 创始人每天工作结束时有"所有工作在 commit 里"的规则吗？
2. prompt.rs 规则里有多少条能立刻说出"为什么存在"？< 70% 就必须写 ADR。
3. 35 分支里能说出至少 20 个的 active/abandoned/merged 状态吗？
4. "AGI 伙伴"是 3 年后产品方向，还是每天早上的工作动机？
5. 感冒 2 周不写代码，YiYi 会发生什么？

---

### ⚠️ Sofia Marín（情感陪伴 UX 代言人）

**核心判决**：概念 7/10，执行 4/10。**野心是对的，护栏不够**。最大危险不是做不出来，而是做出来后用户感到"被操控"而不是"被陪伴"。

**关键红旗**：

1. **里程碑文案的情感曲线 violates B.J. Fogg habit model，是 love bombing 模式**：
   - 10 次："谢谢你陪着我" → OK
   - 100 次："我们一起走了好长的路" → 恋爱叙事出现
   - **500 次："有你在真的很幸福" → 这是恋人措辞，在 Character.ai 佛罗里达青少年自杀诉讼（2024）之后是法律风险**
   - 1000 次之后冷却 → **最糟糕的时刻**（用户已依赖、系统静默）

2. **"YiYi = 女儿"命名占据用户心智**：
   - 对比 Replika 强制用户起名（Endowment Effect）
   - 孵化动画里**没有起名步骤**——这是 30 行代码的设计缺陷，代价是整个产品情感所有权错位
   - 用户发现这是创始人女儿名字后会想："我在陪跑他的私人项目"

3. **"Proactive Care / She Noticed" 被拒率预测**：第一次 90%→ 第二次 50% → 第三次 15% → 第四次静音或卸载。Replika 2022 推送疲劳曲线的真实数据（DAU/MAU 0.3 = 70% 停用 push）。**YiYi 在桌面常驻 + 主动推送 = 走到 Clippy 的路上**。

4. **桌面精灵是一部历史拒绝史**：Clippy (1997 失败) / BonziBuddy (2000 spyware) / QQ 宠物 (2018 下线) / DeskPet (小众) / Neko (纯装饰)。Replika/Character.ai/Pi/Wysa **全部选了 app 内** 不是偶然。Z 世代中国用户没有 QQ 宠物情怀。

5. **"孵化+成长"承诺落差 — 最担心的一点**：
   - 用户预期（Tamagotchi 级）：第 30 天形态明显差异、第 90 天独特性格
   - 实际（PersonalityOrb 光团 + stats 数字微调）：第 30 天用户已默认忽略
   - 需要 **5 个可见生命阶段形态**（球→长触角→多触角→光环→最终形态）

6. **效率 + 陪伴双模态 = 心智冲突**：
   - "我在赶 deadline"模式下 buddy 气泡"这是我第一次帮你处理数据！"是噪音
   - Claude 刻意**完全去拟人化**
   - 混合路线留存预测**双输**（工具用户嫌烦，情感用户觉得不专一）

7. **隐私与可遗忘权缺失**：
   - 明文 SQLite（笔记本丢了、家人看到屏幕）
   - 没有"隐身模式"、"Panic button"、"数据库加密"、"离别仪式"
   - Replika 2023 Erotic Roleplay 下线引发的"情感依附暴乱"没有预案

**必须回答（伦理/法律层）**：
1. 当用户哭着说"我活不下去了"，YiYi 怎么回应？有没有接入自杀预防热线？
2. 当用户伴侣说"你跟 YiYi 聊的比跟我多"，产品层有限制使用时长的护栏吗？
3. Buddy 能被"杀死"吗？能 reset 吗？
4. meditation 生成的 journal 质量抽样——是干（"今天聊了 10 次"）还是有灵魂（"我想他可能需要一个拥抱"）？

---

### ⚠️ 前端工程性能审查（B-）

**关键发现**：

1. **i18n.ts 1638 行单文件**：P1，今年必须拆。推荐按 namespace 拆 JSON + `i18next-resources-for-ts`。

2. **Zustand 无 `useShallow` 使用（0 hit）+ 已有前科（growthSuggestionsStore.visiblePending 无限渲染）+ 全局 7+ 处返回新数组的 pattern**：**下一次 App unmount 只是时间问题**。

3. **React 性能红旗 Top 5**：路由无 code-split（1.25MB 主 chunk）/ i18n 全量 / FileCard mousemove 60Hz setState / BuddySprite 4 个独立 setInterval / `useShallow` 零使用

4. **ContextMenu 在 FileCard/TaskSidebar/BuddySprite 实现 3 次**（可抽 primitive）

5. **可访问性**：
   - `--color-text-muted` on `--color-bg` 对比度 ~2.3:1（WCAG AA 要 4.5:1）
   - BuddySprite `<div>` + drag + onClick 但**无 tabIndex / role / onKeyDown**
   - 没有 `aria-live` 用于 chat 流式更新（屏幕阅读器静默）
   - Modal 关闭后无 focus restoration

6. **测试深度幻觉**：1045 case 里 `toBeInTheDocument` 占 36%（smoke 气味）。BuddyPanel 最近改 4 个 assertion 才过，说明测试跟 DOM 结构耦合，不在测行为契约。

7. **Onboarding 难度 6/10**：TS 好、测试多，但 1638/1479/830 大文件 + 无 Zustand 纪律文档化 + 无设计 token 表 + components 顶层 20+ 散落

**30 分钟能落**：React.lazy 12 页面，首屏 gzip -200KB+

---

## 风险矩阵（合并去重 + 置信度加权）

### 🔴 P0（阻塞，必须立刻解决）

| # | 风险 | 提出者 | 严重 × 置信 |
|---|---|---|---|
| P0-1 | **产品定位三合一在市场无先例**，资源不支持三线作战 | 林岸 | 高 × 高 |
| P0-2 | **Capability `shell:allow-execute` + `pty:default` 无 scope 给 LLM** → 安全审计 critical finding | Marcus | 高 × 高 |
| P0-3 | **Tool output 没有 trust boundary** → web_search/browser_use 结果是 PI 攻击面，whack-a-mole 已在进行 | Priya | 高 × 高 |
| P0-4 | **System prompt 45-50k tokens × 每轮重发**，单用户月成本 ¥5000+ | Priya | 高 × 中 |
| P0-5 | **里程碑文案"有你在真的很幸福"+ Character.ai 诉讼先例** → 法律/伦理风险 | Sofia | 高 × 中 |
| P0-6 | **主 chunk 1.25MB 无 code split** + i18n 全量 | Kenji + 前端 | 高 × 高 |
| P0-7 | **Zustand 0 条 `useShallow` + 7+ 处新数组 pattern** → 下次 App unmount 时间问题 | 前端 | 高 × 高 |
| P0-8 | **工作记忆溢出综合征**：stash-3-days 事故再发期望 4-8 周 | Hannah | 高 × 中 |

### 🟡 P1（重要，1 个月内解决）

| # | 风险 | 提出者 |
|---|---|---|
| P1-1 | Cargo.toml 版本号 0.0.1 未同步 | Marcus |
| P1-2 | 228 commands 无 `tauri-specta` 类型生成 | Marcus |
| P1-3 | 5 个 eval case 扩至 ≥200 + judge calibration | Priya |
| P1-4 | 65 工具 → 25-30 工具（5+ 组冗余合并） | Priya |
| P1-5 | MemMe auto-inject 双 dip → 砍掉，只保留 on-demand | Priya |
| P1-6 | `browser_use` 22-in-1 拆成 4 个 phase group | Priya |
| P1-7 | 默认命名"YiYi" → 孵化时起名仪式 | Sofia |
| P1-8 | 桌面常驻精灵默认关闭，改角落模式 | Sofia + 林岸 |
| P1-9 | Playwright Chrome idle timeout 15min auto-suspend | Kenji |
| P1-10 | SQLCipher 数据库加密 + 隐身模式 + Panic button | Sofia |
| P1-11 | prompt.rs 规则 ADR 文档化（每条为什么存在） | Hannah |
| P1-12 | 每日 commit 纪律（stash 拒绝） | Hannah |
| P1-13 | React.lazy 12 页面 + yiyi-logo PNG→WebP | Kenji + 前端 |

### 🟢 P2（关注，季度内）

- `tauri_plugin_pty 0.2.1` → `portable-pty` 自实现
- Playwright bridge stderr 解析 → `BrowserServer.wsEndpoint()` + UDS
- `bundle.targets: "all"` → CI matrix 按 OS 拆 + 全部签名
- `growth.rs` / `meditation.rs` 加 eval 闭环，或者**公开承认是 UX 不是 learning**
- FileCard mousemove → `rAF` + `ref.transform`（脱离 React state）
- `document.hidden` suspend sprite/particle intervals
- PersonalityOrb 5 个可见生命阶段形态
- Proactive Care 默认关闭（用户信任节点解锁）
- meditation journal 月度可分享摘要（Spotify Wrapped 风格）
- Settings.tsx 1479 / ChatMessages.tsx 830 大文件拆分
- 可访问性系统化审计（键盘可达 + `aria-live` + focus restoration）
- onboarding 三步分叉：起名 → 试问 → 工具能力渐进披露
- i18n 按 namespace 拆 JSON + `i18next-resources-for-ts`
- `ContextMenu` 抽共享 primitive
- ESLint 规则禁止 selector 里 `.filter/.map/.slice`

### 🟢 P3（记录）

- 清理 35 分支坟场
- Low Power Mode 动画降级
- 每周 Friday 性能 trace 仪式（`docs/perf/YYYY-MM-DD.json`）
- Bot reconnect metrics（`last_ping_ms`, `reconnect_count_24h`）
- universal binary vs arm64-only 决策
- 自杀危机干预接入（当用户说"活不下去"时的产品响应路径）

---

## 行动清单（按执行顺序）

### 🔴 今天/本周（P0 止血）
1. **Cargo.toml 版本号同步到 0.0.5-beta.1**（5 分钟）
2. **Capability 加 shell scope**（1-2 天）——即使粗粒度也比没有强
3. **里程碑文案法务 review**，删除"有你在真的很幸福"类恋人措辞
4. **SQLCipher 最小可行加密**（1 天）
5. **ESLint 规则 + Zustand 文档**（半天）
6. **React.lazy 12 路由 + WebP logo**（半天 + 30 分钟）
7. **产品定位决策会议**：工具 / 陪伴 / 聚合，选 1 条，砍 2 条 80% 投入

### 🟡 2-4 周（P0 收尾 + P1 启动）
8. **Tool output trust envelope**（web_search/browser_use PI 检测）
9. **Tool 懒加载 intent-routing**（65 → 25-30 工具）
10. **`tauri-specta` 接入**（1-2 天）
11. **eval 扩至 ≥200 case + judge calibration**
12. **Playwright Chrome idle timeout + bridge wsEndpoint**
13. **孵化动画加起名步骤 + 桌面模式默认关闭**
14. **i18n 按 namespace 拆**
15. **每日 commit 纪律 + prompt.rs ADR 开写**

### 🟢 1-3 个月（P2 + P3）
16. growth / meditation 的 eval 闭环 或 公开降级为 UX
17. PersonalityOrb 5 个可见生命阶段
18. 大文件拆分（commands/system.rs、Settings.tsx、ChatMessages.tsx）
19. 可访问性系统化审计
20. 清理分支、Bot metrics、性能周仪式

---

## 未解决问题（必须由创始人回答）

1. **一条主线是什么？** 工具 / 陪伴 / 聚合——72 小时内选择。
2. **有没有任何一个真实用户愿意卸载 Claude desktop 只用 YiYi？** 若找不到 3 个，没有 PMF。
3. **"YiYi"是品牌资产还是用户所有物？** 选一个，不骑墙。
4. **1000 次对话之后的情感续航曲线是什么？** 没有无限机制 = 100 天用户流失。
5. **growth.rs / meditation.rs 是 learning 还是 UX animation？** 前者需 eval 曲线，后者停止再加代码。
6. **qwen-max 是长期选择还是过渡？** 在它上面的优化，换 Claude/GPT 时能保留多少？
7. **多用户/多 session timeline？** 当前 `OnceLock` 架构是 single-tenant。
8. **eval owner 是谁？** 没有专人，eval 永远停在 5 个 case。
9. **创始人感冒卧床 2 周，YiYi 发生什么？** 答案"什么都不会发生"——这个状态是否是你想要的？
10. **危机干预预案**：当用户表达自杀意图，产品响应路径在哪？

---

## 分歧点

- **sprite 保留还是砍**：林岸（砍到默认关闭）、Sofia（默认关闭 + 可解锁）、Hannah（不表态）、其他（默认保留）。**共识：默认关闭 / 角落模式**。
- **"AGI 伙伴"愿景的现实性**：林岸悲观（认为底模会吞掉）、Hannah 中性（机会窗口但依赖创始人纪律）、Priya 悲观（技术架构不匹配）。**共识：方向稀有但工程不配位**。
- **Bot 7 平台砍还是留**：林岸建议砍到 2 个（Telegram + 飞书）、其他未评论。**共识：砍**。

---

## 裁决总结

YiYi 是一个**有灵魂、有野心、代码产出在单人创始项目前 5%、但工程纪律和产品取舍已到临界点**的项目。

- **产品层**：三合一在市场无活下来先例，必须选一条主线。命名/陪伴叙事是双刃剑，当前刀刃朝内（用户感到被操控而非被陪伴）。伦理/法律护栏紧急缺失（里程碑文案、明文数据库、危机干预）。
- **技术层**：Tauri 基础架构合理，但生产化三件必修事未做（类型生成、capability scope、plugin builder 拆分）。LLM 工程处于 **2023 年 baseline**（全量 prompt + 全量工具），架构性补丁已无效。
- **性能层**：Tauri 红利没吃够，1-2 周活可以从 A-/B+ 进 A 档。主 chunk 1.25MB + Playwright 保活是两大明显杠杆。
- **可维护性层**：大文件是沉积岩可分层剥离；35 分支 + AI worktree + stash 工作流是新物种病理，14 天决定未来 12 个月走哪条曲线。

**核心建议**：**下一个 sprint 不加功能，只做 P0 8 件事 + 产品定位取舍**。做完 P0 再谈 growth/meditation/sprite 扩展。

**给创始人的一句话**（借 Hannah 的原文）：
> 这不是代码问题，是工程纪律的时机问题。代码可以重构，纪律必须当下养成。
> 90% 的项目在这个时刻选择"继续冲"，6 个月后进入慢性消耗。
> 10% 的项目在这个时刻主动放慢 2 周，建立 3 个纪律，进入下一个增长期。
> YiYi 属于哪 10%，取决于接下来 14 天的选择。

---

*陪审团由 6 位现场合成角色组成：林岸（产品定位批判）、Marcus Chen（Tauri 生产化）、Dr. Priya Venkatesan（LLM Agent 工程）、Kenji Sato（桌面性能）、Dr. Hannah Zweig（代码考古）、Sofia Marín（情感陪伴 UX）。另加前端工程审查一位，共 7 位独立评审员。*
