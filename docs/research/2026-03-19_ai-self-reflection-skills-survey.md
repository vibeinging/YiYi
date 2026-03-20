# AI 自我反思/自我成长 Skills 调研

> 调研日期: 2026-03-19
> 目标: 寻找近期爆火的 AI Agent 自我反思、自我成长、从错误中学习的 Skill/工具，为 YiYi Growth System 提供设计灵感

---

## 一、核心发现：最相关的项目

### 1. claude-reflect (BayramAnnakov) -- 最火 Claude Code 反思 Skill

- **GitHub**: https://github.com/BayramAnnakov/claude-reflect
- **定位**: Claude Code 自学习系统，捕获纠正 -> 反思 -> 写入 CLAUDE.md，永不重复犯错
- **核心机制**:
  - **两阶段架构**: Stage 1 自动捕获(hooks 监听 session)，Stage 2 手动审核(`/reflect`)
  - **混合检测**: Regex 实时识别纠正标记 ("no, use X", "actually...") + 语义 AI 分析验证
  - **置信度评分**: 0.60-0.95，仅可复用的非临时纠正才会通过
  - **多目标同步**: `~/.claude/CLAUDE.md`(全局) + `./CLAUDE.md`(项目) + `AGENTS.md`(跨工具)
  - **Skill 发现**: `/reflect-skills` 分析 session 模式，将重复请求转化为可复用命令
- **关键设计理念**:
  - 人工审核 gate 确保质量（不会自动写入垃圾规则）
  - 智能过滤: 排除问题和一次性任务
  - 语义去重: 合并不同措辞但相同含义的条目

### 2. "One Prompt" 反思模式 (DEV.to 爆火文章)

- **来源**: https://dev.to/aviad_rozenhek_cba37e0660/self-improving-ai-one-prompt-that-makes-claude-learn-from-every-mistake-16ek
- **核心 Prompt**: "Reflect on this mistake. Abstract and generalize the learning. Write it to CLAUDE.md."
- **四步循环**: Reflect(分析失败) -> Abstract(提取模式) -> Generalize(创建框架) -> Document(写入 CLAUDE.md)
- **CLAUDE.md 架构**:
  - META 区: 教 Claude 如何写规则(ALWAYS/NEVER 格式)
  - Summary 区: 快速参考的绝对指令
  - Detail 区: 带推理和示例的详细指南
- **关键洞察**: 人类负责批判性思考(每个错误 5 秒)，AI 负责分析、抽象、格式化 -> 复利式改进

### 3. OpenClaw Self-Improving Agent -- 最完整的自成长 Skill

- **ClawHub**: https://clawhub.ai/ivangdavila/self-improving
- **LLMBase**: https://llmbase.ai/openclaw/self-improving/
- **定位**: OpenClaw 生态中的自改进 Agent Skill，分层记忆 + 自动晋升
- **分层记忆架构**:
  - **HOT 层** (`memory.md`): <=100 行，每次加载，已确认偏好
  - **WARM 层** (`projects/`, `domains/`): <=200 行，上下文匹配时加载
  - **COLD 层** (`archive/`): 长期未用模式归档
- **晋升机制**:
  - 7 天内成功应用 3+ 次 -> 晋升 HOT
  - 30 天未用 -> 降级 WARM
  - 90 天未用 -> 归档 COLD
- **学习信号**: 纠正(直接反馈) / 偏好(显式指令) / 模式候选(重复成功工作流)
- **关键原则**: "Never infer from silence alone" — 仅显式纠正或重复证据才触发学习

### 4. claude-reflect-system (haddock-development)

- **GitHub**: https://github.com/haddock-development/claude-reflect-system (80 stars)
- **特色**: 三级置信度系统
  - HIGH(纠正): "use X instead of Y" -> 关键修正
  - MEDIUM(认可): "Yes, perfect!" -> 最佳实践
  - LOW(观察): "Have you considered..." -> 待考虑
- **安全机制**: 自动时间戳备份 + YAML frontmatter 验证 + Git 版本控制 + 手动审核模式

---

## 二、基础设施层项目

### 5. Hindsight (vectorize-io) -- Agent Memory 基础设施

- **GitHub**: https://github.com/vectorize-io/hindsight (5.1k stars)
- **定位**: 仿生记忆系统，非 Skill 而是 Agent Memory 基础设施
- **核心循环**: Retain(存储) -> Recall(4 路并行检索) -> Reflect(深层分析形成新连接)
- **记忆类型**: World(事实) / Experiences(经验) / Mental Models(反思后的理解)
- **性能**: LongMemEval 91.4%，比全上下文基线高 +44.6 分

### 6. EvoAgentX -- 自进化 Agent 框架

- **GitHub**: https://github.com/EvoAgentX/EvoAgentX
- **定位**: 构建、评估、进化 LLM Agent 的开源框架
- **特色**: 目标驱动的自动优化，模块化设计，迭代反馈循环

### 7. SkillRL -- 技能强化学习

- **GitHub**: https://github.com/aiming-lab/SkillRL
- **定位**: 通过递归技能增强 RL 进化 Agent，从经验中学习高层可复用行为模式

---

## 三、对 YiYi Growth System 的启发

### 已有设计的对齐
YiYi 当前 growth system (corrections -> PRINCIPLES.md -> 时间优先覆盖) 与行业趋势高度吻合：
- 纠正捕获 -> 准则提炼 = claude-reflect 的核心模式
- 时间优先覆盖 = OpenClaw 的 HOT/WARM/COLD 降级思路的简化版

### 可借鉴的设计点

| 设计点 | 来源 | 说明 |
|--------|------|------|
| **置信度评分** | claude-reflect | 0.60-0.95 分级，避免低质量学习污染 |
| **分层记忆 + 自动晋升/降级** | OpenClaw | HOT/WARM/COLD 三层，7天3次晋升，30天未用降级 |
| **三级置信度** | haddock-development | HIGH(纠正)/MEDIUM(认可)/LOW(观察) |
| **多目标同步** | claude-reflect | 全局 + 项目级 + 跨工具 |
| **Skill 自动发现** | claude-reflect v2 | 重复模式自动提炼为可复用 Skill |
| **Retain-Recall-Reflect 循环** | Hindsight | 存储->检索->反思形成新连接 |
| **人工审核 Gate** | 多个项目 | 不自动写入，需确认才持久化 |
| **语义去重** | claude-reflect | 不同措辞相同含义的规则合并 |
| **"Never infer from silence"** | OpenClaw | 仅显式信号触发学习，避免误学 |
| **Reflect-Abstract-Generalize-Document** | DEV.to 文章 | 四步从具体错误到通用原则 |

### 建议优先级
1. **分层记忆 + 晋升/降级**: 当前 PRINCIPLES.md 是扁平的，可引入 HOT/WARM/COLD
2. **置信度系统**: 区分纠正/认可/观察三种反馈类型
3. **语义去重**: 避免 PRINCIPLES.md 膨胀
4. **Skill 自动发现**: 从重复模式中提炼新 Skill
