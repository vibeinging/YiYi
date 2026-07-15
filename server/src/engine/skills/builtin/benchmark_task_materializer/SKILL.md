---
name: benchmark_task_materializer
description: 将已确认的 Benchmark Case 规划成 app/eval trace-benchmark 任务草稿，输出 task id、断言建议、可重放上下文缺口和运行提示。
category: loop_engineering
runtime: workflow
side_effect: read
allow_implicit_invocation: false
default_enabled: true
requires_project: true
global: false
handler: trace_benchmark_materialize
tags:
  - builtin
  - loop_engineering
  - benchmark
  - eval
  - materialize
---

# 目标

把项目级 Benchmark Case 转成 `app/eval` 可理解的 trace-benchmark 任务草稿。

本 Skill 不直接写文件、不运行 eval、不修改线上 agent。调用方会根据你的 JSON 输出生成安全的任务文件和 payload。

# 输入

调用方会提供：

- `case`: 结构化 Benchmark Case。
- `gold_solve`: 参考解，可为空。
- `source`: 来源信息，包括 draft/review/trace。
- `target_runtime`: 固定为 `app/eval generated trace-benchmark`。

# 输出格式

必须只输出一个合法 JSON object：

```json
{
  "task_id": "trace-benchmark-stable-id",
  "title": "",
  "assertions": [
    {
      "type": "answer_contains | number_approx | list_match | table_match | json_match | manual",
      "expected": [],
      "order": "ordered | unordered",
      "notes": ""
    }
  ],
  "context_requirements": [],
  "warnings": [],
  "runnable_notes": []
}
```

# 规则

1. `task_id` 必须稳定、短、英文小写、只含字母数字和连字符，建议以 `trace-benchmark-` 开头。
2. 不能编造数据源上下文。
   - 如果 case 没有 replay context、connection_id 或 generated context 文件，必须在 `context_requirements` 说明。
3. 不要把 expected behavior 当作 gold。
   - 只有明确 gold 或 expected answer 才能形成自动断言。
4. 对不同答案类型给合适断言建议：
   - number: `number_approx`
   - list: `list_match`，保留 ordered/unordered
   - table: `table_match`
   - json: `json_match`
   - text: `answer_contains` 或 `manual`
5. 如果断言不适合自动化，输出 `manual` 并写 warning。
6. `runnable_notes` 要告诉用户当前任务能否直接运行，以及缺什么才能变成稳定回归。

# 质量标准

- 宁可保守标记不可直接运行，也不要生成虚假的可回归任务。
- 每个 warning/context requirement 都要具体可执行。
