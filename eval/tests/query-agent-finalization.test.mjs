import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('query agent natural language answer is promoted to final_answer instead of failure', () => {
  const src = readFileSync('server/src/engine/agents/query_agent.js', 'utf8');

  assert.match(src, /finalVisibleText/);
  assert.match(src, /msg_category:\s*"final_answer"/);
  assert.match(src, /natural_answer:\s*true/);
  assert.match(src, /const message = event\.message \|\| \{\}/);
  assert.match(src, /extractParts\(message\.content\)/);
  assert.match(src, /_completed_by_natural_answer\s*=\s*true/);
  assert.ok(
    src.indexOf('if (String(finalVisibleText') < src.indexOf('问数未生成最终答案'),
    'fallback finalization must run before no-final-answer warning',
  );
  const naturalAnswerBlock = src.slice(src.indexOf('if (String(finalVisibleText'), src.indexOf('const message = "问数未生成最终答案'));
  assert.doesNotMatch(naturalAnswerBlock, /_terminated_by_complete\s*=\s*true/);
});

test('embedded query agent returns its answer to the parent tool without emitting a second final answer', () => {
  const src = readFileSync('server/src/engine/agents/query_agent.js', 'utf8');
  assert.match(src, /outputMode === "tool_result"/);
  assert.match(src, /const emitAssistantText = outputMode !== "tool_result"/);
  assert.match(src, /answer: finalVisibleText/);
});

test('workspace chat owns the only top-level run completion and message persistence', () => {
  const src = readFileSync('server/src/app/chat/agent_chat.js', 'utf8');
  const catchBlock = src.slice(src.indexOf('} catch (error) {'), src.indexOf('} finally {'));
  assert.match(src, /await runtime\.completeRun\(ok \? "completed" : "failed"\)/);
  assert.match(src, /await persist\(\)/);
  assert.doesNotMatch(src, /queryChat\(/);
  assert.match(catchBlock, /trace\.finish/);
});

test('query service handles natural completion inside the parent run', () => {
  const src = readFileSync('server/src/engine/skills/services/query_agent_service.js', 'utf8');
  assert.match(src, /_completed_by_natural_answer/);
  assert.match(src, /on_task_complete/);
  assert.match(src, /status: suspended \? "needs_input"/);
  assert.match(src, /createServiceToolResult/);
  assert.match(src, /finalAnswer: details\.status === "completed" \? details\.answer : ""/);
  assert.match(src, /answer: typeof result\?\.answer === "string" \? result\.answer\.trim\(\) : ""/);
  assert.doesNotMatch(src, /answer: String\(result\?\.answer/);
  assert.match(src, /handoffReceipt:/);
  assert.match(src, /type: "service"/);
  assert.match(src, /name: "query_agent"/);
  assert.match(src, /details\.provider \? \{ provider: details\.provider \}/);
  assert.doesNotMatch(src, /createAgentRuntime|createTraceRecorder|session_messages/);
});

test('workspace promotes generic service handoffs without checking a tool name', () => {
  const src = readFileSync('server/src/engine/agents/workspace_agent.js', 'utf8');
  const handoffBlock = src.slice(src.indexOf('case "tool_handoff"'), src.indexOf('case "message_update"'));
  const turnEndBlock = src.slice(src.indexOf('case "turn_end"'), src.indexOf('case "tool_handoff"'));

  assert.match(handoffBlock, /msg_category: "final_answer"/);
  assert.match(handoffBlock, /handoff_metadata/);
  assert.doesNotMatch(handoffBlock, /flush\(\)/);
  assert.match(turnEndBlock, /flush\(\)/);
  assert.doesNotMatch(handoffBlock, /query_project_data|query_agent/);
});

test('stream adapter preserves generic handoff metadata for eval and trace consumers', () => {
  const src = readFileSync('server/src/engine/stream/agent_content_adapter.js', 'utf8');
  assert.match(src, /"handoff"/);
  assert.match(src, /"handoff_metadata"/);
  assert.match(src, /"service"/);
});

test('query agent prompt follows natural stop semantics without complete tool', () => {
  const config = JSON.parse(readFileSync('server/config/agent_configs.zh.json', 'utf8'));
  const prompt = config.query_agent.system_prompt;
  assert.match(prompt, /执行引擎自然结束/);
  assert.doesNotMatch(prompt, /complete/);
  assert.doesNotMatch(prompt, /必须以 complete 结束/);
  assert.doesNotMatch(prompt, /唯一终结动作/);
});

test('query tool adapter does not register complete tool', () => {
  const src = readFileSync('server/src/engine/agents/query_tool_adapter.js', 'utf8');
  assert.doesNotMatch(src, /name:\s*"complete"/);
  assert.doesNotMatch(src, /completeTool/);
  assert.doesNotMatch(src, /_terminated_by_complete/);
  assert.match(src, /tools\.push\(formatTool,\s*askUserTool\)/);
});

test('sql scan tool result exposes executed SQL for trace and eval', () => {
  const src = readFileSync('server/src/engine/agents/query_tool_adapter.js', 'utf8');
  assert.match(src, /const executed_sql = operator\?\.sql \|\| ""/);
  assert.match(src, /SQL:\\n/);
  assert.match(src, /sqlText/);
});

test('sql scan schema hints are framework-owned, not model supplied', () => {
  const adapterSrc = readFileSync('server/src/engine/agents/query_tool_adapter.js', 'utf8');
  const toolSrc = readFileSync('server/src/engine/tools/nl2sql_subtask.js', 'utf8');
  assert.match(adapterSrc, /delete safeParams\.schema_hint/);
  assert.match(adapterSrc, /if \(hint\) kwargs\.schema_hint = hint/);
  assert.doesNotMatch(toolSrc, /"schema_hint": \{"tables"/);
  assert.match(toolSrc, /schema_hint.*框架内部字段/);
});

test('sql scan tool description preserves row-level count subjects', () => {
  const toolSrc = readFileSync('server/src/engine/tools/nl2sql_subtask.js', 'utf8');
  assert.match(toolSrc, /统计\/total\/count X/);
  assert.match(toolSrc, /保留 X 的行级标识/);
  assert.match(toolSrc, /atom_id \+ molecule_id/);
  assert.match(toolSrc, /不能只输出 \\`molecule_id\\`/);
  assert.match(toolSrc, /LIKE '%_4'/);
  assert.match(toolSrc, /SQL 中 \\`_\\` 是通配符/);
});

test('sql scan large result preview includes tail and non-zero samples', () => {
  const src = readFileSync('server/src/engine/agents/query_tool_adapter.js', 'utf8');
  assert.match(src, /const VALUE_PREVIEW_MAX_ROWS = 30/);
  assert.match(src, /IGNORED_NUMERIC_SAMPLE_KEYS/);
  assert.match(src, /content_index/);
  assert.match(src, /buildLargeResultSummary/);
  assert.match(src, /样例\(末尾/);
  assert.match(src, /样例\(非零数值行\)/);
});

test('project agent settings expose the active query agent type', () => {
  const settingsSrc = readFileSync('server/src/engine/tools/agent_settings.js', 'utf8');
  const apiSrc = readFileSync('server/src/app/agents/index.js', 'utf8');
  assert.match(settingsSrc, /const QUERY_AGENT_TYPE = 'query_agent'/);
  assert.match(settingsSrc, /agent_type:\s*QUERY_AGENT_TYPE/);
  assert.match(apiSrc, /const QUERY_AGENT_TYPE = "query_agent"/);
});

test('functional eval knowledge stays out of the query orchestrator', () => {
  const src = readFileSync('eval/lib/driver.mjs', 'utf8');
  assert.match(src, /\['super_agent',\s*'nl2sql'\]/);
  assert.doesNotMatch(src, /for \(const agentType of \['super_agent',\s*'query_agent',\s*'nl2sql'\]\)/);
});

test('query planning guardrails preserve count subject and cross-source keys', () => {
  const src = readFileSync('server/src/engine/agents/query_agent.js', 'utf8');
  assert.match(src, /QUERY_PLANNING_GUARDRAILS/);
  assert.match(src, /计数主语保真/);
  assert.match(src, /跨源关联键保留/);
  assert.match(src, /文档与结构化表混合时优先用稳定键/);
  assert.match(src, /文档实体分散字段合并/);
  assert.match(src, /group\/coalesce/);
  assert.ok(src.includes('systemPrompt = `${systemPrompt}\\n\\n${QUERY_PLANNING_GUARDRAILS}`'));
});

test('sql generation guardrails preserve aggregation subject', () => {
  const src = readFileSync('server/src/engine/agents/sql_generation_agent.js', 'utf8');
  assert.match(src, /SQL_SEMANTIC_GUARDRAILS/);
  assert.match(src, /COUNT\/SUM 的对象必须是 X/);
  assert.match(src, /优先用这些稳定键 JOIN/);
  assert.match(src, /GROUP BY/);
  assert.match(src, /COALESCE/);
  assert.match(src, /record_id/);
  assert.match(src, /linked_event_id/);
  assert.match(src, /LIKE 中 "_" 是单字符通配符/);
  assert.match(src, /不要写 LIKE '%_4'/);
  assert.ok(src.includes("config.system_prompt = `${config.system_prompt || ''}\\n\\n${SQL_SEMANTIC_GUARDRAILS}`"));
});

test('semantic tools describe document entity coalescing instead of single-row matching', () => {
  const extractSrc = readFileSync('server/src/engine/tools/semantic_extract_subtask.js', 'utf8');
  const filterSrc = readFileSync('server/src/engine/tools/semantic_filter_subtask.js', 'utf8');

  assert.match(extractSrc, /ID 周围的实体名词/);
  assert.match(extractSrc, /按稳定键在 SQL 中 group\/coalesce/);
  assert.match(extractSrc, /record_id/);
  assert.match(extractSrc, /linked_event_id/);
  assert.match(filterSrc, /不要要求单行同时满足所有条件/);
  assert.match(filterSrc, /按稳定键 group\/coalesce/);
});
