---
name: trace_failure_diagnoser
description: 对比 Eval Draft、Step 0 Gold Solve、actual output 和 trace evidence，诊断失败发生在哪个 agent 流程阶段，并给出下一步调优建议。
category: loop_engineering
runtime: workflow
side_effect: read
allow_implicit_invocation: false
default_enabled: true
requires_project: true
global: false
handler: trace_failure_diagnose
tags:
  - builtin
  - loop_engineering
  - trace
  - diagnosis
  - eval
---

# 目标

基于 Gold Solve 和实际 Trace，判断一次失败或待复核回答的问题最可能发生在哪个阶段，并输出可执行的调优建议。

本 Skill 只做诊断，不直接修改 prompt、tool schema、operator、router、SQL 规则、元数据或评测断言。

# 输入

调用方会提供：

- `question`: 用户问题。
- `expected_behavior`: 正确行为或口径。
- `expected_answer`: expected answer，可为空。
- `actual_output`: 当时 agent 的输出。
- `assertion_type`: 当前断言方式。
- `gold_solve`: 已填写或生成的 Step 0 参考解。
- `trace_evidence_pack`: 服务端从完整 Trace 中抽取的证据包，包含 trace overview、少量关键 span、选择原因和 payload 引用。
- `replay_requirements`: 数据源、schema fingerprint、model profile 等上下文，可能不完整。

# 输出格式

如果当前证据已经足够，必须只输出一个合法 JSON object：

```json
{
  "failure_stage": "intent | routing | tool_selection | tool_input | sql_generation | sql_execution | tool_output_usage | final_answer | data_issue | assertion_issue | trace_incomplete | unknown",
  "confidence": 0.0,
  "summary": "",
  "evidence": [
    { "source": "gold_solve | trace | actual_output | expected | replay", "observation": "" }
  ],
  "evidence_path": [
    { "span_id": "", "observation": "" }
  ],
  "trace_gaps": [],
  "recommended_actions": [],
  "next_benchmark_focus": [],
  "warnings": []
}
```

如果当前证据不足，可以先只输出下钻动作：

```json
{
  "next_trace_actions": [
    {
      "type": "overview | get_span | children | parent | siblings | search | payload",
      "span_id": "",
      "query": "",
      "field": "input | output | logs | attrs",
      "reason": ""
    }
  ]
}
```

下钻动作由服务端执行，你不能自由读取数据库，也不能请求完整 Trace。每轮最多请求少量 span。

# 判断规则

1. 先看 Gold Solve，再看 actual trace。
   - Gold Solve 表达“正确应该怎么做”。
   - `trace_evidence_pack` 表达“系统实际做了什么”，只能基于其中的 span 证据下结论。

2. 不要因为最终答案错就直接判 `final_answer`。
   - 如果 SQL 或工具输入已错，失败阶段应落在更早位置。
   - 如果工具输出正确但最终回答没使用，才考虑 `tool_output_usage` 或 `final_answer`。

3. 如果 trace evidence 不完整，优先输出 `trace_incomplete` 或降低 confidence。

4. 常见阶段：
   - `intent`: 用户意图、指标、实体或时间范围理解错。
   - `routing`: 选错 agent / skill / 工具链路。
   - `tool_selection`: 应调用工具但没调用，或选择了错误工具。
   - `tool_input`: 工具参数、字段、过滤条件、connection_id 错。
   - `sql_generation`: SQL 逻辑、聚合、join、排序、limit 错。
   - `sql_execution`: SQL 执行报错或运行环境问题。
   - `tool_output_usage`: 工具结果正确，但 LLM 没读取/误读/丢弃。
   - `final_answer`: 计算已正确，但最终表达、格式、单位、小数位、列顺序错。
   - `data_issue`: 数据源、schema、元数据、样本数据本身有问题。
   - `assertion_issue`: 评测断言或 gold 格式不合理。

5. `recommended_actions` 要具体。
   - 好：`在 sql_scan_operator 输入协议中强制传入 order_by 与 limit，并在 BaseTool trace attrs 记录最终 SQL`。
   - 差：`优化 prompt`。

6. `next_benchmark_focus` 应描述下一轮回归重点。
   - 例如：`同类 TopN 排序问题`、`销售额口径聚合问题`、`最终 Markdown 表格列裁剪`。

7. `evidence_path` 必须引用具体 `span_id`。
   - 每条根因判断至少对应一个 span。
   - 如果没有足够 span 证据，输出 `trace_incomplete`，不要编造 evidence path。

8. 需要下钻时，优先请求最小动作。
   - 怀疑某个工具参数错：先 `get_span` 目标工具，再看 `parent`。
   - 怀疑子调用内部错：先 `children`，再选择具体子 span。
   - 不知道 span id：用 `search` 搜 tool 名、字段名、SQL 片段或错误关键词。
   - input/output 被截断：用 `payload` 分段读取。

# 质量标准

- 输出要保守，证据不足时明确说证据不足。
- 每个结论必须能回到输入证据。
- 不要提出无法验证的调优建议。
