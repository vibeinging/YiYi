---
name: trace_tuning_proposer
description: 基于 Trace 诊断、Gold Solve 和 evidence path 生成可人工确认的调优方案，不自动修改系统。
category: loop_engineering
runtime: workflow
side_effect: read
allow_implicit_invocation: false
default_enabled: true
requires_project: true
global: false
handler: trace_tuning_propose
tags:
  - builtin
  - loop_engineering
  - trace
  - proposal
  - eval
---

# 目标

基于一次 Trace 诊断结果，生成下一轮可以人工确认的调优方案。

本 Skill 只产出方案，不直接修改 prompt、tool schema、operator、router、元数据、Benchmark 或代码。

# 输入

调用方会提供：

- `draft`: 当前用例草稿，包含 question、expected、actual output、assertion type、tuning notes。
- `gold_solve`: 已生成或确认的 Step 0 参考解。
- `diagnosis`: Trace 诊断结果，包含 failure_stage、summary、evidence、evidence_path、trace_gaps、recommended_actions、trace_debugger。
- `trace_evidence_pack`: 服务端抽取的少量证据 span。
- `recent_attempts`: 当前用例最近的调试记录。

# 输出格式

必须只输出一个合法 JSON object：

```json
{
  "hypothesis": "",
  "change_type": "prompt_rule | tool_schema | operator_logic | metadata | benchmark_assertion | trace_instrumentation | manual_check",
  "target": "",
  "proposal": "",
  "why": "",
  "risk": "",
  "validation_plan": "",
  "benchmark_focus": [],
  "manual_steps": [],
  "evidence_path": [
    { "span_id": "", "observation": "" }
  ],
  "warnings": []
}
```

# 规则

1. 先判断 `failure_stage`。
   - `intent`、`routing`、`tool_selection` 更可能对应 prompt/routing/skill 描述。
   - `tool_input` 更可能对应 tool schema、参数生成约束或元数据。
   - `sql_generation` 更可能对应 SQL 生成规则、字段/指标元数据或 operator 逻辑。
   - `sql_execution` 更可能对应执行环境、连接、SQL 兼容性。
   - `tool_output_usage`、`final_answer` 更可能对应最终回答格式和结果使用规则。
   - `trace_incomplete` 优先提出补埋点或人工检查，不要假装知道根因。

2. 方案必须可验证。
   - `validation_plan` 必须说明跑哪些 Benchmark 或如何复现。
   - `benchmark_focus` 必须是下一轮需要覆盖的问题类型。

3. 方案必须可人工确认。
   - `proposal` 用短段落描述具体改什么。
   - `manual_steps` 给出 2 到 5 个操作步骤。
   - 不要输出“直接自动修复”。

4. 必须引用证据。
   - 优先复用 `diagnosis.evidence_path`。
   - 如果没有 span 证据，`change_type` 应偏向 `manual_check` 或 `trace_instrumentation`，并在 `warnings` 说明证据不足。

5. 不要编造文件路径、函数名、字段名或 schema。
   - 如果输入里没有明确目标，`target` 写业务对象或阶段名，例如 `sql_generation`、`sql_scan_operator`、`final_answer_contract`。

# 质量标准

- 输出要短而具体。
- 不能把风险写成空话。
- 每个方案都要能进入下一轮 attempt，然后通过 Benchmark 验证。
