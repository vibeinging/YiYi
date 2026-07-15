# SuperAgent 引擎(Node 迁移)

从 Python `yiw_kernel` + `core/agentic_flow` 逐文件迁移的问数 AI 引擎。

## 结构(对应 Python)
- core/      ← core/agentic_flow/core(BaseAgent ReAct循环 / AgentContext / LLM流式 / message构建 / turn压缩)
- tools/     ← planner/tools(nl2sql / semantic_* / web_search)+ dsagents/tools(format_result)
- datasources/ ← data_sources(datasource / data_profiler grep)
- semantic/  ← semantic_catalogs/business(grep_metrics / metric_view_query / disambiguation)
- utils/     ← core/utils(serialization / markdown) + i18n

## 迁移方式:拓扑分波,叶子优先,多 agent 并行,边迁边优化(去 Python 特性、用 Node 习惯)。
## 入口:superagent.js(SuperAgent 类),由 routes/chat.js 调用替换最小 NL2SQL。
