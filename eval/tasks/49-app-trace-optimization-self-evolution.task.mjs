// 自主进化流程：从 Trace 问题沉淀到调优方案、调试轮次、Benchmark 回归和最新动态。
// 任务自带 OpenAI 兼容 fake model，避免依赖本机真实模型配置。
import { createServer } from 'node:http';
import { unlinkSync } from 'node:fs';

function dataOf(resp) {
  return resp?.json?.data ?? resp?.json ?? null;
}

function bodyText(resp) {
  try {
    return JSON.stringify(resp?.json || {}).slice(0, 800);
  } catch {
    return '';
  }
}

function cleanupGenerated(result) {
  const files = result?.materialized?.files || result?.files || null;
  for (const file of [files?.task_path, files?.payload_path]) {
    if (!file) continue;
    try {
      unlinkSync(file);
    } catch {
      // 生成文件可能已被其他清理逻辑删除，忽略即可。
    }
  }
}

function fakeWorkflowPayload(prompt) {
  if (prompt.includes('trace_tuning_proposer') || prompt.includes('trace_tuning_propose') || prompt.includes('调优方案')) {
    return {
      hypothesis: 'SQL 生成没有稳定使用 region=华东 过滤条件',
      change_type: 'prompt_rule',
      target: 'sql_generation',
      proposal: '在业务规则中加入区域过滤必须精确匹配用户问题中的区域名称，并把华东销售额问题加入回归集。',
      why: 'Trace 证据显示 sql_scan_operator 输入未包含 region=华东，导致答案混入其他区域。',
      risk: '规则过强可能影响没有区域条件的问题，需要用无区域问题做回归对照。',
      validation_plan: '重新运行 east-sales-autonomous-evolution Benchmark case，确认缺上下文时被 blocked，补齐数据后必须命中 300。',
      benchmark_focus: ['区域过滤', '销售额汇总', 'SQL 生成'],
      manual_steps: ['确认业务规则文案', '保存为调试轮次', '导入 Benchmark 用例', '运行回归并查看历史'],
      evidence_path: [{ span_id: 'sql-scan', observation: 'SQL 没有 region=华东 过滤条件' }],
      warnings: [],
    };
  }

  if (prompt.includes('trace_failure_diagnoser') || prompt.includes('Trace 诊断') || prompt.includes('diagnosis')) {
    return {
      failure_stage: 'sql_generation',
      confidence: 0.91,
      summary: '模型生成 SQL 时缺少 region=华东 过滤条件，导致统计口径错误。',
      evidence: [
        { source: 'span:sql-scan', observation: 'sql_scan_operator 输入只汇总 amount，没有区域过滤' },
      ],
      evidence_path: [{ span_id: 'sql-scan', observation: '缺少 where region = 华东' }],
      trace_gaps: [],
      recommended_actions: ['补充区域过滤业务规则', '把该问题加入 Benchmark 回归'],
    };
  }

  return {
    intent_summary: '统计华东区域销售额',
    data_sources: ['sales'],
    filters: { region: '华东' },
    metric_definition: 'sum(amount)',
    reference_steps: ['过滤 region=华东', '汇总 amount'],
    reference_sql: "select sum(amount) from sales where region = '华东'",
    final_answer_contract: '答案必须包含 300',
    trace_diff_summary: '原回答使用了错误区域口径',
    status: 'drafted',
  };
}

async function startFakeWorkflowModel() {
  const calls = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        payload = {};
      }
      const prompt = (payload.messages || []).map((msg) => String(msg?.content || '')).join('\n');
      const content = JSON.stringify(fakeWorkflowPayload(prompt));
      calls.push({
        model: payload.model,
        response_format: payload.response_format,
        prompt_hint: prompt.slice(0, 240),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl-self-evolution-${calls.length}`,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export default {
  id: 'app-trace-optimization-self-evolution',
  desc: '自主进化闭环：Trace 问题 → gold → 诊断 → 调优方案 → attempt → Benchmark 回归 → 最新动态',
  async run({ driver, assert, record }) {
    await driver.login();
    const api = (method, url, body) => driver.raw.api(method, url, body);
    const projectName = `trace-opt-self-evolution-eval-${Date.now()}`;
    const pid = await driver.createProject(projectName);
    const fakeModel = await startFakeWorkflowModel();
    let modelId = '';

    try {
      record({ project_id: pid, project_name: projectName, fake_model_base_url: fakeModel.baseUrl });
      const modelResp = await api('POST', `/api/projects/${pid}/models`, {
        model_name: `eval-self-evolution-${Date.now()}`,
        display_name: 'Eval Self Evolution Model',
        category: 'PRIMARY',
        api_base: fakeModel.baseUrl,
        api_key: 'eval-key',
        api_format: 'chat_completions',
        supports_streaming: false,
        extra_config: { context_window: 8192 },
      });
      assert.status(modelResp, 200, `创建项目级 fake PRIMARY 模型 ${bodyText(modelResp)}`);
      modelId = dataOf(modelResp)?.id || '';
      assert.ok(Boolean(modelId), 'fake PRIMARY 返回模型 id');

      const traceSnapshot = {
        traceId: 'trace-self-evolution-eval',
        spans: [
          {
            id: 'root',
            externalSpanId: 'yiw-run',
            name: 'YiW',
            kind: 'agent',
            depth: 0,
            input: '统计华东销售额',
            output: '华东销售额为 250',
            attrs: { skill: 'smart_query', call_site: 'query_chat' },
          },
          {
            id: 'sql-scan',
            parentId: 'root',
            name: 'sql_scan_operator',
            kind: 'tool',
            depth: 1,
            input: { sql: 'select sum(amount) from sales' },
            output: { rows: [{ amount: 250 }] },
            logs: [{ message: 'scan completed without region filter' }],
          },
        ],
      };

      const reviewResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/reviews`, {
        session_id: 'session-self-evolution-eval',
        run_id: 'run-self-evolution-eval',
        trace_id: 'trace-self-evolution-eval',
        target_type: 'run',
        question: '统计华东销售额',
        actual_output: '华东销售额为 250',
        trace_snapshot: traceSnapshot,
        status: 'incorrect',
        severity: 'high',
        reason_code: 'sql_filter',
        reason_text: '区域过滤缺失',
        expected_behavior: '应该只统计 region = 华东 的销售额',
        source: 'eval-self-evolution',
      });
      assert.status(reviewResp, 200, '自主进化保存 Trace review');
      const review = dataOf(reviewResp);
      assert.ok(Boolean(review?.id), 'review 返回 id');

      const draftResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/from-review`, {
        review_id: review.id,
        question: '统计华东销售额',
        expected_behavior: '应该只统计 region = 华东 的销售额',
        expected_answer: '300',
        assertion_type: 'text_contains',
        tags: ['eval', 'self-evolution'],
        failure_category: 'sql_filter',
        tuning_notes: '自主进化：区域条件必须进入 SQL',
        replay_requirements: { dataset: 'sales.csv' },
        trace_snapshot: traceSnapshot,
      });
      assert.status(draftResp, 200, '自主进化从 review 生成 draft');
      const draft = dataOf(draftResp);
      assert.eq(draft?.status, 'reviewable', 'draft 初始进入 reviewable');

      const goldResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/gold-solve/generate`, {
        question: draft.question,
        expected_behavior: draft.expected_behavior,
        expected_answer: draft.expected_answer,
        assertion_type: draft.assertion_type,
      });
      assert.status(goldResp, 200, `自主进化生成 gold solve ${bodyText(goldResp)}`);
      const goldData = dataOf(goldResp);
      assert.ok(Boolean(goldData?.gold_solve?.reference_sql), 'gold solve 带 reference_sql');
      assert.eq(goldData?.draft?.status, 'reviewable', 'AI gold 初稿不自动变 ready');

      const verifiedGoldResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/gold-solve`, {
        ...(goldData?.gold_solve || {}),
        status: 'verified',
      });
      assert.status(verifiedGoldResp, 200, '自主进化人工确认 gold solve');
      assert.eq(dataOf(verifiedGoldResp)?.draft?.status, 'ready', '确认 gold 后 draft ready');

      const diagnosisResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/diagnose`, {
        persist_attempt: true,
        gold_solve: dataOf(verifiedGoldResp)?.gold_solve || goldData?.gold_solve || {},
        attempt: { source: 'diagnosis', status: 'planned' },
      });
      assert.status(diagnosisResp, 200, `自主进化 Trace 诊断成功 ${bodyText(diagnosisResp)}`);
      const diagnosis = dataOf(diagnosisResp);
      assert.eq(diagnosis?.failure_stage, 'sql_generation', '诊断定位到 sql_generation');
      assert.ok(Boolean(diagnosis?.attempt?.id), '诊断自动沉淀 attempt');

      const proposalResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/tuning-proposal`, {
        diagnosis,
        gold_solve: dataOf(verifiedGoldResp)?.gold_solve || {},
        recent_attempts: [diagnosis.attempt].filter(Boolean),
      });
      assert.status(proposalResp, 200, `自主进化生成调优方案 ${bodyText(proposalResp)}`);
      const proposal = dataOf(proposalResp);
      assert.eq(proposal?.change_type, 'prompt_rule', '调优方案给出变更类型');
      assert.ok((proposal?.benchmark_focus || []).includes('区域过滤'), '调优方案给出 Benchmark focus');
      assert.ok((proposal?.manual_steps || []).length >= 2, '调优方案给出人工确认步骤');

      const proposalAttemptResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/attempts`, {
        source: 'diagnosis',
        status: 'running',
        hypothesis: proposal.hypothesis,
        change_summary: proposal.proposal,
        diagnosis,
        metrics: { baseline_accuracy: 0, target_accuracy: 1 },
        notes: proposal.validation_plan,
        trace_id: 'trace-self-evolution-eval',
        run_id: 'run-self-evolution-eval',
        session_id: 'session-self-evolution-eval',
        span_id: 'sql-scan',
        trace_snapshot: traceSnapshot,
      });
      assert.status(proposalAttemptResp, 200, '调优方案沉淀为新一轮 attempt');
      const proposalAttempt = dataOf(proposalAttemptResp);
      assert.ok(Number(proposalAttempt?.attempt_index || 0) >= 2, '调优方案 attempt 接在诊断 attempt 之后');

      const attemptPassResp = await api('PUT', `/api/agent/projects/${pid}/trace-optimization/attempts/${proposalAttempt.id}`, {
        status: 'passed',
        source: 'benchmark',
        benchmark_result: { pass: true, focus: proposal.benchmark_focus },
      });
      assert.status(attemptPassResp, 200, '调优方案 attempt 可标记为 passed');

      const importResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/benchmark/cases/import`, {
        source_type: 'trace_self_evolution',
        source_object_id: draft.id,
        raw_input: 'eval self evolution case',
        cases: [{
          case_key: 'east-sales-autonomous-evolution',
          title: '自主进化回归：华东销售额',
          question: '统计华东销售额',
          expected_behavior: '回答必须只包含华东区域销售额 300',
          answer_type: 'text',
          assertion_type: 'text_contains',
          assertion: { type: 'text_contains' },
          gold: { value: '300' },
          metadata: {
            draft_id: draft.id,
            proposal_change_type: proposal.change_type,
            proposal_target: proposal.target,
          },
          tags: ['eval', 'self-evolution', 'trace'],
        }],
      });
      assert.status(importResp, 200, '自主进化导入 Benchmark 回归用例');
      const importedCase = dataOf(importResp)?.cases?.[0];
      assert.ok(Boolean(importedCase?.id), '导入后返回 Benchmark case id');
      assert.eq(importedCase?.status, 'ready', '有 gold 的自主进化 case 为 ready');

      const materializeResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/benchmark/cases/${importedCase.id}/materialize`, {
        skip_ai: true,
        write: false,
      });
      assert.status(materializeResp, 200, '自主进化 Benchmark 可 materialize 预览');
      const materialized = dataOf(materializeResp);
      assert.eq(materialized?.written, false, '预览不写生成任务文件');
      assert.eq(materialized?.runnable, false, '缺 replay context 时标记不可运行');
      assert.ok((materialized?.context_requirements || []).length > 0, '不可运行原因会返回上下文缺口');

      const runResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/benchmark/cases/${importedCase.id}/run`, {
        skip_ai: true,
        diagnose: false,
        timeout_ms: 30000,
      });
      assert.status(runResp, 200, '自主进化回归运行会记录结果');
      const runResult = dataOf(runResp);
      assert.eq(runResult?.run?.status, 'blocked', '缺上下文回归 run 被标记 blocked');
      assert.eq(runResult?.run?.diagnosis?.failure_stage, 'trace_incomplete', 'blocked run 有 trace_incomplete 诊断');
      cleanupGenerated(runResult);

      const summaryResp = await api('GET', `/api/agent/projects/${pid}/trace-optimization/summary`);
      assert.status(summaryResp, 200, '自主进化 summary 可读取');
      const summary = dataOf(summaryResp);
      assert.ok(summary.reviews.total >= 1, 'summary 记录 review');
      assert.ok(summary.drafts.ready >= 1, 'summary 记录 ready draft');
      assert.ok(summary.gold_solves.total >= 1, 'summary 记录 gold solve');
      assert.ok(summary.attempts.passed >= 1, 'summary 记录 passed attempt');
      assert.ok(summary.benchmark_cases.ready >= 1, 'summary 记录 Benchmark case');
      assert.ok(summary.benchmark_runs.failed >= 1, 'summary 记录 blocked/failed 回归');
      assert.eq(summary.latest_activity?.type, 'benchmark_run', '最新动态指向最近回归运行');

      const attemptsResp = await api('GET', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/attempts?limit=10`);
      assert.status(attemptsResp, 200, '自主进化 attempts 可读取');
      const attempts = dataOf(attemptsResp) || [];
      assert.ok(attempts.some((item) => item.id === proposalAttempt.id && item.status === 'passed'), 'attempt 历史包含已通过方案');

      const modelCalls = fakeModel.calls.length;
      record({
        fake_model_calls: modelCalls,
        latest_activity_type: summary.latest_activity?.type || '',
        benchmark_case_id: importedCase.id,
        benchmark_run_status: runResult?.run?.status || '',
      });
      assert.ok(modelCalls >= 3, 'fake 模型至少被 gold/diagnosis/proposal 三个 workflow 调用');
    } finally {
      if (modelId) {
        await api('DELETE', `/api/projects/${pid}/models/${modelId}`).catch(() => {});
      }
      await fakeModel.close();
    }
  },
};
