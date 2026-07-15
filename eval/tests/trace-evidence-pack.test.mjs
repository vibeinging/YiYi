import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTraceEvidencePack,
  traceChildren,
  traceGetSpan,
  traceOverview,
  tracePayload,
  traceSearch,
} from '../../server/src/app/traces/trace_optimization/trace_evidence.js';
import { runTraceDebugger } from '../../server/src/app/traces/trace_optimization/trace_debugger.js';
import { runTuningProposalWorkflow } from '../../server/src/app/traces/trace_optimization/gold.js';

function traceFixture() {
  const largeOutput = 'row,'.repeat(2000);
  return {
    run: { runId: 'run-1', sessionId: 'session-1' },
    trace: {
      traceId: 'trace-1',
      spans: [
        {
          id: 'root',
          externalSpanId: 'agent-root',
          name: 'YiW',
          kind: 'agent',
          status: 'completed',
          depth: 0,
          input: '统计华东销售额',
          output: '华东销售额为 250',
        },
        {
          id: 'plan',
          externalSpanId: 'llm-sql-plan',
          externalParentSpanId: 'agent-root',
          name: 'LLM SQL Plan',
          kind: 'llm',
          status: 'completed',
          depth: 1,
          output: '需要查询 sales，但遗漏了 region=华东 过滤条件',
        },
        {
          id: 'tool',
          externalSpanId: 'sql_scan_operator',
          externalParentSpanId: 'llm-sql-plan',
          name: 'sql_scan_operator',
          kind: 'tool',
          status: 'completed',
          depth: 2,
          input: { sql: 'select sum(amount) from sales' },
          output: largeOutput,
          attrs: { sql: 'select sum(amount) from sales' },
        },
        {
          id: 'answer',
          externalSpanId: 'final-answer',
          externalParentSpanId: 'agent-root',
          name: 'LLM 返回',
          kind: 'llm',
          status: 'completed',
          depth: 1,
          output: '华东销售额为 250',
          attrs: { msg_category: 'final_answer' },
        },
      ],
    },
  };
}

test('trace evidence tools support overview, drilldown and payload paging', () => {
  const trace = traceFixture();
  const overview = traceOverview(trace);
  assert.equal(overview.total_spans, 4);
  assert.equal(overview.tool_spans, 1);

  const tool = traceGetSpan(trace, 'sql_scan_operator');
  assert.equal(tool.name, 'sql_scan_operator');
  assert.equal(traceChildren(trace, 'llm-sql-plan')[0].span_id, 'sql_scan_operator');
  assert.equal(traceSearch(trace, { query: 'region=华东' })[0].span_id, 'llm-sql-plan');

  const page = tracePayload(trace, { span_id: 'sql_scan_operator', field: 'output', limit: 40 });
  assert.equal(page.text.length, 40);
  assert.equal(page.next_offset, 40);
});

test('trace evidence pack selects relevant spans without embedding full payload', () => {
  const pack = buildTraceEvidencePack({
    traceSnapshot: traceFixture(),
    question: '统计华东销售额',
    expectedBehavior: '应该只统计 region = 华东 的 amount 合计',
    expectedAnswer: '300',
    actualOutput: '华东销售额为 250',
    assertionType: 'number_approx',
    mode: 'diagnosis',
    maxSpans: 4,
    previewChars: 120,
  });

  assert.equal(pack.version, 1);
  assert.equal(pack.trace_ref.trace_id, 'trace-1');
  assert.ok(pack.evidence_spans.length <= 4);
  assert.ok(pack.evidence_spans.some((span) => span.span_id === 'sql_scan_operator'));
  const sqlSpan = pack.evidence_spans.find((span) => span.span_id === 'sql_scan_operator');
  assert.match(sqlSpan.why_selected, /SQL|关键词|父子|span/);
  assert.ok(sqlSpan.output_preview.length < 180);
  assert.equal(sqlSpan.payload_ref.output, 'trace://span/sql_scan_operator/output');
});

test('trace debugger executes controlled trace actions between model rounds', async () => {
  const calls = [];
  const result = await runTraceDebugger(null, {
    projectId: 'project-1',
    skillName: 'trace_failure_diagnoser',
    task: '诊断失败',
    traceSnapshot: traceFixture(),
    baseInput: {
      question: '统计华东销售额',
      expected_answer: '300',
      actual_output: '250',
      trace_evidence_pack: buildTraceEvidencePack({ traceSnapshot: traceFixture() }),
    },
    async runStep(_ctx, params) {
      calls.push(params.input.trace_debugger.round);
      if (calls.length === 1) {
        return {
          skill: { name: 'trace_failure_diagnoser' },
          data: {
            next_trace_actions: [
              {
                type: 'get_span',
                span_id: 'sql_scan_operator',
                reason: '需要查看 SQL 工具输入输出',
              },
            ],
          },
        };
      }
      assert.equal(params.input.trace_debugger.observations[0].result.span_id, 'sql_scan_operator');
      return {
        skill: { name: 'trace_failure_diagnoser' },
        data: {
          failure_stage: 'sql_generation',
          confidence: 0.9,
          summary: 'SQL 缺少 region=华东 过滤条件',
          evidence: [{ source: 'trace', observation: 'sql_scan_operator 输入 SQL 未包含 region 过滤' }],
          evidence_path: [{ span_id: 'sql_scan_operator', observation: 'SQL 未过滤华东' }],
          trace_gaps: [],
          recommended_actions: ['补充 SQL 生成过滤条件约束'],
          next_benchmark_focus: ['区域过滤问题'],
          warnings: [],
        },
      };
    },
  });

  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.data.failure_stage, 'sql_generation');
  assert.equal(result.data.trace_debugger.observations.length, 1);
  assert.equal(result.data.trace_debugger.observations[0].action.type, 'get_span');
});

test('tuning proposal workflow uses diagnosis evidence and returns confirmable attempt draft', async () => {
  const traceSnapshot = traceFixture();
  const draft = {
    id: 'draft-1',
    question: '统计华东销售额',
    expected_behavior: '应该只统计 region = 华东 的 amount 合计',
    expected_answer: '300',
    actual_output: '华东销售额为 250',
    assertion_type: 'text_contains',
    failure_category: 'sql_filter',
    tuning_notes: 'region 必须精确过滤',
    trace_snapshot_json: JSON.stringify(traceSnapshot),
  };
  const gold = {
    intent_summary: '统计华东销售额',
    data_sources: JSON.stringify(['sales']),
    filters_json: JSON.stringify({ region: '华东' }),
    metric_definition: 'sum(amount)',
    reference_steps_json: JSON.stringify(['过滤 region=华东', '汇总 amount']),
    reference_sql: "select sum(amount) from sales where region = '华东'",
    final_answer_contract: '答案包含 300',
  };
  const diagnosis = {
    failure_stage: 'sql_generation',
    confidence: 0.88,
    summary: 'SQL 缺少 region=华东 过滤条件',
    evidence_path: [{ span_id: 'sql_scan_operator', observation: 'SQL 没有 where region' }],
    next_benchmark_focus: ['区域过滤问题'],
  };
  const calls = [];
  const result = await runTuningProposalWorkflow(null, {
    projectId: 'project-1',
    draft,
    gold,
    body: { diagnosis },
    recentAttempts: [{ id: 'attempt-1', hypothesis: '旧假设' }],
    async runStep(_ctx, params) {
      calls.push(params);
      assert.equal(params.skillName, 'trace_tuning_proposer');
      assert.equal(params.input.draft.question, '统计华东销售额');
      assert.equal(params.input.diagnosis.failure_stage, 'sql_generation');
      assert.equal(params.input.trace_evidence_pack.mode, 'diagnosis');
      assert.ok(params.input.trace_evidence_pack.evidence_spans.some((span) => span.span_id === 'sql_scan_operator'));
      assert.equal(params.input.recent_attempts.length, 1);
      assert.equal(Object.prototype.hasOwnProperty.call(params.input, 'trace_snapshot'), false);
      return {
        skill: { name: 'trace_tuning_proposer', runtime: 'workflow' },
        data: {
          hypothesis: 'SQL 生成阶段漏掉区域过滤',
          change_type: 'tool_schema',
          target: 'sql_scan_operator',
          proposal: '在 SQL 工具输入协议中强制保留 region 过滤条件。',
          why: 'Gold Solve 要求 region=华东，但工具输入 SQL 没有 where 条件。',
          risk: '过强约束可能影响不需要区域过滤的问题。',
          validation_plan: '重跑区域过滤类 Benchmark。',
          manual_steps: ['确认字段 region 存在', '调整 SQL 生成规则', '重跑 Benchmark'],
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(result.skill.name, 'trace_tuning_proposer');
  assert.equal(result.data.change_type, 'tool_schema');
  assert.equal(result.data.target, 'sql_scan_operator');
  assert.equal(result.data.benchmark_focus[0], '区域过滤问题');
  assert.equal(result.data.evidence_path[0].span_id, 'sql_scan_operator');
  assert.match(result.data.validation_plan, /Benchmark/);
});
