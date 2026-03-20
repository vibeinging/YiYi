---
name: skill_creator
description: "技能创建器：创建新技能、修改和改进现有技能、测试技能性能。当用户想要从零创建技能、编辑或优化现有技能、运行评估来测试技能、基准测试技能性能、或优化技能描述以提高触发准确性时使用。只要用户提到「创建技能」「新建skill」「改进技能」「技能模板」「skill开发」等相关话题，即使没有明确说出skill-creator，也应该使用此技能。"
metadata:
  {
    "yiyi":
      {
        "emoji": "🛠️",
        "requires": {},
        "priority": 100
      }
  }
---

# Skill Creator

创建新技能并迭代改进的核心技能。

## YiYi 技能系统说明

YiYi 的技能目录位于 `~/.yiyi/active_skills/`，每个技能是一个包含 `SKILL.md` 的文件夹。SKILL.md 使用 YAML frontmatter 定义元数据（name, description, metadata），正文为 Markdown 指令。

技能结构：
```
skill-name/
├── SKILL.md (必须)
│   ├── YAML frontmatter (name, description, metadata.yiyi.emoji/requires)
│   └── Markdown 指令
└── 附带资源 (可选)
    ├── scripts/    - 可执行脚本
    ├── references/ - 按需加载的文档
    └── assets/     - 模板、图标等资源文件
```

## 流程概览

创建技能的整体流程：

1. 明确技能要做什么、大致怎么做
2. 编写技能草稿
3. 用几个测试提示词试运行
4. 帮助用户定性和定量评估结果
   - 在后台运行测试期间，起草定量评估断言
   - 使用 `eval-viewer/generate_review.py` 脚本展示结果
5. 根据用户反馈重写技能
6. 重复直到满意
7. 扩大测试集，更大规模验证

你的任务是判断用户处于这个流程的哪个阶段，然后帮助他们推进。灵活应变——如果用户说「不需要跑一堆评估，直接和我聊就行」，那就按他们的方式来。

技能完成后，还可以运行描述优化器来提升技能的触发精度。

## 与用户沟通

注意根据上下文线索调整沟通方式。默认情况下：
- 「评估」和「基准测试」这类词可以直接用
- 对于 JSON、assertion 等技术术语，先确认用户是否熟悉再使用
- 不确定时简短解释术语即可

---

## 创建技能

### 捕获意图

先理解用户的意图。当前对话可能已经包含用户想要捕获的工作流（比如他们说「把这个变成一个技能」）。如果是，先从对话历史中提取信息——使用的工具、步骤序列、用户做的修正、观察到的输入输出格式。

1. 这个技能应该让 AI 能做什么？
2. 什么时候应该触发这个技能？（什么用户短语/上下文）
3. 期望的输出格式是什么？
4. 是否需要设置测试用例来验证？

### 调研与访谈

主动询问边缘情况、输入输出格式、示例文件、成功标准和依赖。在确定这些之前不要急着写测试提示词。

### 编写 SKILL.md

基于用户访谈，填写这些组件：

- **name**: 技能标识符（使用下划线命名，如 `my_skill`）
- **description**: 触发条件和功能描述。这是主要的触发机制——同时包含技能做什么和什么时候使用。为了对抗「触发不足」的倾向，描述要稍微「积极主动」一些
- **metadata**: YiYi 特有的元数据
  ```yaml
  metadata:
    {
      "yiyi":
        {
          "emoji": "适合的emoji",
          "requires": {}
        }
    }
  ```
- **技能正文**: Markdown 格式的指令

### 技能编写指南

#### 渐进式披露

技能使用三层加载系统：
1. **元数据**（name + description）- 始终在上下文中（~100词）
2. **SKILL.md 正文** - 技能触发时加载（理想<500行）
3. **附带资源** - 按需加载（不限大小，脚本可直接执行）

**关键模式：**
- SKILL.md 控制在 500 行以内
- 从 SKILL.md 清晰引用参考文件，说明何时读取
- 大参考文件（>300行）包含目录

#### 安全原则

技能不得包含恶意软件、漏洞利用代码或任何可能危及系统安全的内容。

#### 编写模式

优先使用祈使语气编写指令。

**定义输出格式：**
```markdown
## 报告结构
始终使用这个模板：
# [标题]
## 摘要
## 关键发现
## 建议
```

**示例模式：**
```markdown
## 提交信息格式
**示例 1:**
输入: 添加了使用JWT令牌的用户认证
输出: feat(auth): implement JWT-based authentication
```

### 编写风格

解释为什么某些事情很重要，而不是堆砌死板的 MUST。利用心智理论让技能通用而不是局限于特定示例。先写草稿，然后用新鲜眼光审视改进。

### 测试用例

编写技能草稿后，想出 2-3 个真实的测试提示词。与用户分享确认后运行。

保存测试用例到 `evals/evals.json`：

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "用户的任务提示",
      "expected_output": "期望结果描述",
      "files": []
    }
  ]
}
```

参见 `references/schemas.md` 获取完整 schema。

## 运行和评估测试用例

将结果放在 `<skill-name>-workspace/` 目录中（作为技能目录的同级）。在工作区内，按迭代组织（`iteration-1/`、`iteration-2/` 等），每个测试用例一个目录。

### 步骤 1: 启动所有运行

对每个测试用例，同时启动两个子 agent——一个带技能，一个不带。同一轮全部启动。

**带技能运行：**
```
执行此任务:
- 技能路径: <path-to-skill>
- 任务: <eval prompt>
- 输入文件: <eval files if any>
- 保存输出到: <workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/
```

**基线运行：**
- 创建新技能：不使用任何技能，保存到 `without_skill/outputs/`
- 改进现有技能：使用旧版本，先快照 (`cp -r`)

为每个测试用例写 `eval_metadata.json`。

### 步骤 2: 运行期间起草断言

利用等待时间起草定量断言并向用户解释。好的断言是客观可验证的，且有描述性名称。主观技能（写作风格、设计质量）更适合定性评估。

### 步骤 3: 运行完成后捕获计时数据

子 agent 完成时保存 `timing.json`：
```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

### 步骤 4: 评分、聚合、启动查看器

1. **评分** — 读取 `agents/grader.md` 评估每个断言。保存到 `grading.json`
2. **聚合基准** — 运行：
   ```bash
   python -m scripts.aggregate_benchmark <workspace>/iteration-N --skill-name <name>
   ```
3. **分析** — 参见 `agents/analyzer.md` 分析基准数据
4. **启动查看器**：
   ```bash
   python <skill-creator-path>/eval-viewer/generate_review.py \
     <workspace>/iteration-N \
     --skill-name "my-skill" \
     --benchmark <workspace>/iteration-N/benchmark.json
   ```
   无显示环境用 `--static <output_path>` 生成静态 HTML。
5. 告诉用户结果已就绪

### 步骤 5: 读取反馈

用户完成后读取 `feedback.json`，空反馈表示满意，重点改进有具体意见的测试用例。

---

## 改进技能

### 改进思路

1. **从反馈中泛化** — 技能要能被广泛使用，不要过拟合到测试用例
2. **保持精炼** — 删除没有贡献的内容，阅读转录而不仅是最终输出
3. **解释原因** — 解释 **为什么** 而不是堆砌 ALWAYS/NEVER
4. **发现重复工作** — 如果多个测试用例都独立写了类似脚本，那就打包到 `scripts/`

### 迭代循环

1. 应用改进
2. 重新运行所有测试到新的 `iteration-<N+1>/`
3. 启动查看器（带 `--previous-workspace`）
4. 等待用户评审
5. 读取新反馈，继续改进

直到用户满意或反馈全为空。

---

## 描述优化

description 字段决定 AI 是否调用技能。技能完成后，可以优化描述提高触发准确性。

### 步骤 1: 生成触发评估查询

创建 20 个评估查询——should-trigger 和 should-not-trigger 混合。

查询必须真实具体：
- 差: `"格式化数据"`, `"提取PDF文本"`
- 好: `"我老板发了个xlsx文件在下载目录里，叫什么'Q4销售终版v2.xlsx'，她让我加一列显示利润率百分比"`

### 步骤 2: 用户评审

使用 `assets/eval_review.html` 模板让用户评审查询集。

### 步骤 3: 运行优化循环

```bash
python -m scripts.run_loop \
  --eval-set <path-to-trigger-eval.json> \
  --skill-path <path-to-skill> \
  --model <model-id> \
  --max-iterations 5 \
  --verbose
```

### 步骤 4: 应用结果

取 `best_description` 更新 SKILL.md frontmatter，展示前后对比和分数。

---

## 参考文件

- `agents/grader.md` — 评估断言
- `agents/comparator.md` — 盲比 A/B 对比
- `agents/analyzer.md` — 分析胜出原因
- `references/schemas.md` — JSON 结构定义

---

核心循环：

1. 明确技能目标
2. 草拟或编辑技能
3. 用测试提示词运行
4. 与用户评估输出（创建 benchmark.json + 运行 eval-viewer）
5. 重复直到满意
6. 打包最终技能
