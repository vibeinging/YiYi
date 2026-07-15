---
name: benchmark_case_normalizer
description: 将用户粘贴的非标准 Benchmark 内容清洗成 YiW 统一 Benchmark Case。适用于 JSON、JSONL、CSV、表格文本和自然语言清单。
category: loop_engineering
runtime: workflow
side_effect: read
allow_implicit_invocation: false
default_enabled: true
requires_project: true
global: false
handler: trace_benchmark_normalize
tags:
  - builtin
  - loop_engineering
  - benchmark
  - eval
  - normalize
---

# 目标

把用户提供的非标准 Benchmark 内容清洗为结构化 Benchmark Case 数组，供 `Trace 与优化 / Benchmark` 预览和确认导入。

本 Skill 只做清洗和规范化，不负责运行 Benchmark，不负责创建 `app/eval` task，不负责根据缺失信息编造 gold。

# 输入

调用方会提供：

- `format_hint`: `auto | json | jsonl | csv | text`
- `content`: 用户粘贴的原始 Benchmark 内容

原始内容可能是：

- JSON 或 JSONL。
- CSV/Markdown 表格。
- 文档片段。
- 自然语言问题清单。
- 混合了 question、gold、expected、assertion、tags 的非标准内容。

# 输出格式

必须只输出一个合法 JSON object：

```json
{
  "cases": [],
  "warnings": [],
  "assumptions": [],
  "unparsed": []
}
```

每个 case 尽量包含：

```json
{
  "id": "stable_case_key",
  "question": "用户问题",
  "expected_behavior": "正确行为描述",
  "answer_type": "text | number | boolean | list | table | json | manual",
  "assertion": {
    "type": "exact | text_contains | number_approx | list_match | table_match | json_match | sql_result | llm_judge | manual"
  },
  "gold": null,
  "metadata": {
    "tags": [],
    "difficulty": "",
    "source": "ai_normalized"
  },
  "gold_solve": {}
}
```

# 规则

1. 不要编造 gold。
   - 如果原始内容没有明确 gold/expected answer，将 `gold` 置为 `null`。
   - 同时在 `warnings` 中说明该 case 缺少 gold。

2. `answer_type` 必须从以下枚举中选择：
   - `text`
   - `number`
   - `boolean`
   - `list`
   - `table`
   - `json`
   - `manual`

3. 数值答案：
   - `gold` 形如 `{ "value": 123.45, "unit": "optional" }`。
   - 默认 assertion 使用 `number_approx`。
   - 如果原始内容没有容差，使用 `{ "type": "absolute", "value": 0.01 }`，并在 assumptions 中说明。

4. 列表答案：
   - `gold` 形如 `{ "items": [], "order": "ordered | unordered" }`。
   - Top N、排名、时间序列、明确排序问题使用 `ordered`。
   - 实体集合、分类集合、去重集合默认 `unordered`。
   - 不确定时使用 `unordered` 并写入 warning。

5. 表格答案：
   - `gold` 必须尽量包含 `columns` 和 `rows`。
   - `columns` 元素形如 `{ "name": "column_name", "type": "string | number | boolean | date" }`。
   - Top N、排名、趋势表默认 `row_order=ordered`。
   - 普通明细集合默认 `row_order=unordered`。
   - KDD/官方输出类评测通常 `allow_extra_columns=false`。

6. JSON 答案：
   - 保留对象或数组结构。
   - 不确定结构时使用 `manual` 或 `llm_judge`，并写 warning。

7. 文本答案：
   - 有明确完整答案时可使用 `exact`。
   - 只有关键词时使用 `text_contains`。

8. `id` 要稳定、简短、英文或蛇形命名。
   - 原始内容有 id 就保留。
   - 没有 id 时根据问题语义生成。

9. `gold_solve` 只接收原始内容中已经出现的计算步骤、参考 SQL、口径说明。
   - 不要为了填充 `gold_solve` 自行推导完整 SQL。

10. 无法解析的内容放入 `unparsed`，不要丢弃。

# 质量标准

- 宁可返回 `draft/manual`，也不要输出看似确定但实际猜测的 gold。
- 每个 warning 要能帮助用户修正输入。
- 保留顺序语义，因为这会直接影响 Benchmark 判分。
