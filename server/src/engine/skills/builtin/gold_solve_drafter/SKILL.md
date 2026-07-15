---
name: gold_solve_drafter
description: 基于 Eval Draft 的 question、expected、actual output 和 trace evidence 生成 Step 0 参考解草稿，用于后续人工确认和 trace 差异诊断。
category: loop_engineering
runtime: workflow
side_effect: read
allow_implicit_invocation: false
default_enabled: true
requires_project: true
global: false
handler: trace_gold_solve_draft
tags:
  - builtin
  - loop_engineering
  - gold_solve
  - eval
  - trace
---

# 目标

为 Eval Draft 生成 `Step 0 Gold Solve` 草稿，帮助用户先明确正确计算方式，再拿真实 trace 做差异诊断。

本 Skill 生成的是参考解草稿，不是线上执行路径，不是 Golden Path，也不会自动注入 agent 运行上下文。

# 输入

调用方会提供：

- `question`: 用户原始问题。
- `expected_behavior`: 正确行为或口径描述。
- `expected_answer`: 已知 expected answer，可为空。
- `assertion_type`: 当前评测断言方式。
- `actual_output`: 当时 agent 的错误或待复核回答。
- `trace_evidence_pack`: 服务端从完整 Trace 中抽取的证据包，包含 trace overview、少量关键 span、选择原因和 payload 引用。
- `replay_requirements`: 数据源、schema fingerprint、模型配置等重放上下文，可能不完整。

# 输出格式

必须只输出一个合法 JSON object：

```json
{
  "intent_summary": "",
  "data_sources": [],
  "filters": {},
  "metric_definition": "",
  "reference_steps": [],
  "reference_sql": "",
  "intermediate_expectations": [],
  "final_answer_contract": "",
  "trace_diff_summary": "",
  "warnings": [],
  "assumptions": []
}
```

# 规则

1. 不能把 `actual_output` 当作正确答案。
   - `actual_output` 只用于对比和诊断。
   - 正确口径必须来自 `question`、`expected_behavior`、`expected_answer` 和证据。

2. 不要伪造不存在的数据源、字段或 SQL。
   - 如果 trace/schema evidence 不足，写入 `warnings`。
   - 可以描述“需要确认的数据源/字段”，但不要把它说成已确认事实。

3. `reference_steps` 要表达正确计算方式。
   - 例如：选择数据源、过滤条件、实体识别、聚合口径、排序/TopN、最终输出格式。
   - 每一步应短句化，便于后续与 trace span 对比。

4. `reference_sql` 只有在字段和表信息足够明确时才填写。
   - 不确定时留空，并在 `warnings` 说明缺少 schema evidence。

5. `metric_definition` 用于描述指标口径。
   - 如果问题不是指标计算，可以简短说明判断/筛选口径。

6. `final_answer_contract` 必须说明最终答案应该怎么呈现。
   - 包括列名、排序、单位、小数位、是否允许解释文本等。

7. `trace_diff_summary` 用于指出 actual trace/output 与 expected 的明显差异。
   - 只能基于 `trace_evidence_pack.evidence_spans` 中的证据。
   - 如果证据不足，写“证据不足，待人工查看 trace”，并在 `warnings` 说明缺少哪类 span。

8. `warnings` 和 `assumptions` 要明确可执行。
   - warnings 表示阻碍确认参考解的问题。
   - assumptions 表示生成草稿时采用的假设。

# 质量标准

- 参考解宁可保守，也不要看似完整但基于猜测。
- 必须能帮助工程人员判断问题可能发生在理解、路由、工具输入、SQL、工具输出利用或最终回答。
- 输出只是一份草稿，用户确认前不能进入 Benchmark ready。
