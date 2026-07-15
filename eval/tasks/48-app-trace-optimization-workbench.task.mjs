// 自优化工作台功能闭环：会话复盘 → 用例草稿 → gold → attempt → benchmark case → materialize/run → UI 入口。
// 这条任务刻意避开真实 LLM 依赖，先覆盖确定性产品合同；LLM 链路由 trace / zszq / kdd 回归覆盖。
import { unlinkSync } from 'node:fs';

function dataOf(resp) {
  return resp?.json?.data ?? resp?.json ?? null;
}

function firstCase(overview, predicate = () => true) {
  return (overview?.cases || []).find(predicate) || null;
}

function cleanupGenerated(result) {
  const files = result?.materialized?.files || result?.files || null;
  for (const file of [files?.task_path, files?.payload_path]) {
    if (!file) continue;
    try {
      unlinkSync(file);
    } catch {
      // generated 测试产物已不存在时忽略。
    }
  }
}

async function apiJson(driver, method, url, body) {
  return driver.raw.api(method, url, body);
}

async function waitBodyText(driver, text, { timeout = 10000 } = {}) {
  await driver.ui.waitUntil(
    `() => document.body?.innerText?.includes(${JSON.stringify(text)})`,
    { timeout, label: `页面文本 ${text}` },
  );
}

export default {
  id: 'app-trace-optimization-workbench',
  desc: '自优化工作台完整功能面：复盘、草稿、gold、attempt、Benchmark、运行历史、UI 导航',
  async run({ driver, assert, record }) {
    await driver.login();
    const projectName = `trace-opt-workbench-eval-${Date.now()}`;
    const pid = await driver.createProject(projectName);
    const api = (method, url, body) => apiJson(driver, method, url, body);
    record({ project_id: pid, project_name: projectName });

    const summary0 = await api('GET', `/api/agent/projects/${pid}/trace-optimization/summary`);
    assert.status(summary0, 200, '自优化 summary 可读取');
    assert.eq(dataOf(summary0).reviews.total, 0, '新项目没有历史 review');

    const traceSnapshot = {
      traceId: 'trace-opt-eval-trace',
      spans: [
        {
          id: 'root',
          externalSpanId: 'yiw-run',
          name: 'YiW',
          kind: 'agent',
          depth: 0,
          input: '统计华东销售额',
          output: '返回了错误区域口径',
          attrs: { project_id: pid, skill: 'smart_query', mode: 'smart_query', call_site: 'query_chat' },
          logs: [{ message: 'skill smart_query selected' }],
        },
        {
          id: 'tool-1',
          parentId: 'root',
          name: 'sql_scan_operator',
          kind: 'tool',
          depth: 1,
          input: { sql: 'select region, amount from sales' },
          output: { rows: [{ region: '华东', amount: 300 }] },
          logs: [{ message: 'scan completed' }],
        },
      ],
    };

    const reviewResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/reviews`, {
      session_id: 'session-trace-opt-eval',
      run_id: 'run-trace-opt-eval',
      trace_id: 'trace-opt-eval-trace',
      target_type: 'run',
      question: '统计华东销售额',
      actual_output: '华东销售额为 250',
      trace_snapshot: traceSnapshot,
      status: 'incorrect',
      severity: 'high',
      reason_code: 'sql_filter',
      reason_text: '区域过滤错了',
      expected_behavior: '应该只统计 region = 华东 的销售额',
      source: 'eval',
    });
    assert.status(reviewResp, 200, '保存会话复盘 review');
    const review = dataOf(reviewResp);
    assert.ok(Boolean(review?.id), 'review 返回 id');
    assert.eq(review.status, 'incorrect', 'review 状态保存');

    const reviewUpdateResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/reviews`, {
      run_id: 'run-trace-opt-eval',
      target_type: 'run',
      question: '统计华东销售额',
      actual_output: '华东销售额为 250',
      expected_behavior: '应该只统计 region = 华东 的销售额',
      status: 'incomplete',
      severity: 'medium',
      source: 'eval-update',
    });
    assert.status(reviewUpdateResp, 200, '相同 run_id 的 review 可更新');
    assert.eq(dataOf(reviewUpdateResp)?.id, review.id, 'review upsert 不重复创建');
    assert.eq(dataOf(reviewUpdateResp)?.status, 'incomplete', 'review 更新后的状态返回');

    const reviewsResp = await api('GET', `/api/agent/projects/${pid}/trace-optimization/reviews?limit=20`);
    assert.status(reviewsResp, 200, 'review 列表可读取');
    assert.ok((dataOf(reviewsResp) || []).some((item) => item.id === review.id), 'review 出现在列表');

    const draftResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/from-review`, {
      review_id: review.id,
      question: '统计华东销售额',
      expected_behavior: '应该只统计 region = 华东 的销售额',
      expected_answer: '300',
      assertion_type: 'text_contains',
      tags: ['eval', 'trace'],
      failure_category: 'sql_filter',
      tuning_notes: 'region=华东 时不要合并其他大区',
      replay_requirements: { dataset: 'sales.csv' },
      trace_snapshot: traceSnapshot,
    });
    assert.status(draftResp, 200, '从 review 生成用例草稿');
    const draft = dataOf(draftResp);
    assert.ok(Boolean(draft?.id), 'draft 返回 id');
    assert.eq(draft.status, 'reviewable', 'draft 有 expected 后进入 reviewable');
    assert.eq(draft.benchmark_status, 'reviewable', 'draft benchmark 状态同步');

    const draftAgainResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/from-review`, {
      review_id: review.id,
    });
    assert.status(draftAgainResp, 200, '重复从同一 review 生成 draft 可幂等返回');
    assert.eq(dataOf(draftAgainResp)?.id, draft.id, 'draft 不重复创建');

    const draftDetailResp = await api('GET', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}`);
    assert.status(draftDetailResp, 200, 'draft 详情可读取');
    assert.eq(dataOf(draftDetailResp)?.trace_snapshot?.spans?.length, 2, 'draft 保留 trace snapshot');

    const updatedDraftResp = await api('PUT', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}`, {
      expected_answer: '300',
      assertion_type: 'text_contains',
      tags: ['eval', 'ready'],
      tuning_notes: '后续参考：region 必须精确匹配华东',
      replay_requirements: { dataset: 'sales.csv', connection_id: 'missing-for-this-test' },
    });
    assert.status(updatedDraftResp, 200, 'draft 可编辑 expected / tags / replay requirements');
    assert.eq(dataOf(updatedDraftResp)?.tags?.includes('ready'), true, 'draft tags 已保存');
    assert.eq(dataOf(updatedDraftResp)?.replay_requirements?.connection_id, 'missing-for-this-test', 'draft replay requirements 已保存');

    const goldResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/gold-solve`, {
      status: 'verified',
      intent_summary: '统计华东区域销售额',
      data_sources: ['sales'],
      filters: { region: '华东' },
      metric_definition: 'sum(amount)',
      reference_steps: ['过滤 region=华东', '汇总 amount'],
      reference_sql: "select sum(amount) from sales where region = '华东'",
      final_answer_contract: '答案必须包含 300',
      trace_diff_summary: '原回答少算了 50',
    });
    assert.status(goldResp, 200, '保存并确认 gold solve');
    const goldData = dataOf(goldResp);
    assert.eq(goldData?.gold_solve?.status, 'verified', 'gold solve verified');
    assert.eq(goldData?.draft?.status, 'ready', 'verified gold 使 draft ready');

    const goldUpdateResp = await api('PUT', `/api/agent/projects/${pid}/trace-optimization/gold-solves/${goldData.gold_solve.id}`, {
      status: 'drafted',
      intent_summary: '重新检查华东区域销售额',
    });
    assert.status(goldUpdateResp, 200, 'gold solve 可通过独立接口更新');
    assert.eq(dataOf(goldUpdateResp)?.gold_solve?.status, 'drafted', 'gold solve 更新为 drafted');

    const goldVerifyAgainResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/gold-solve`, {
      status: 'verified',
      intent_summary: '统计华东区域销售额',
      final_answer_contract: '答案必须包含 300',
    });
    assert.status(goldVerifyAgainResp, 200, 'gold solve 可重新确认');
    assert.eq(dataOf(goldVerifyAgainResp)?.draft?.status, 'ready', 'draft 重新回到 ready');

    const attemptResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/attempts`, {
      source: 'manual',
      status: 'planned',
      hypothesis: 'SQL 过滤条件缺少 region',
      change_summary: '准备补充业务规则',
      diagnosis: { failure_stage: 'sql_generation', confidence: 0.8 },
      metrics: { baseline: 0, target: 1 },
      notes: '第一轮调试',
    });
    assert.status(attemptResp, 200, '创建调试轮次 attempt');
    const attempt = dataOf(attemptResp);
    assert.eq(attempt.attempt_index, 1, 'attempt index 从 1 开始');

    const attemptUpdateResp = await api('PUT', `/api/agent/projects/${pid}/trace-optimization/attempts/${attempt.id}`, {
      status: 'passed',
      source: 'benchmark',
      change_summary: '已补充华东过滤规则',
      benchmark_result: { pass: true },
    });
    assert.status(attemptUpdateResp, 200, '更新 attempt 状态');
    assert.eq(dataOf(attemptUpdateResp)?.status, 'passed', 'attempt 更新为 passed');

    const attemptsResp = await api('GET', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/attempts?limit=10`);
    assert.status(attemptsResp, 200, 'attempt 列表可读取');
    assert.ok((dataOf(attemptsResp) || []).some((item) => item.id === attempt.id), 'attempt 出现在列表');

    const invalidGenerateResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/gold-solve/generate`, {
      question: '',
      expected_behavior: '',
      expected_answer: '',
    });
    assert.status(invalidGenerateResp, 400, 'AI gold 生成缺输入时返回 400，不误调用模型');

    const invalidProposalResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/tuning-proposal`, {
      diagnosis: {},
    });
    assert.status(invalidProposalResp, 400, '调优方案缺诊断时返回 400，不误调用模型');

    const invalidNormalizeResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/benchmark/normalize`, {
      content: '',
      format_hint: 'auto',
    });
    assert.status(invalidNormalizeResp, 400, 'Benchmark 清洗缺内容时返回 400');

    const invalidFolderResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/benchmark/normalize-folder`, {
      folder_path: '/path/that/does/not/exist/yiw-trace-opt-eval',
      format_hint: 'folder',
    });
    assert.status(invalidFolderResp, 404, 'Benchmark 文件夹不存在时返回 404');

    const importCasesResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/benchmark/cases/import`, {
      source_type: 'ai_import',
      raw_input: 'eval fixture',
      cases: [
        {
          case_key: 'east-sales-text',
          title: '华东销售额文本题',
          question: '统计华东销售额',
          expected_behavior: '回答包含 300',
          answer_type: 'text',
          assertion: { type: 'text_contains' },
          gold: { value: '300' },
          metadata: { project_name: projectName },
          tags: ['eval'],
        },
        {
          case_key: 'east-sales-number',
          question: '华东销售额是多少',
          expected_behavior: '返回数值 300',
          answer_type: 'number',
          assertion: { type: 'number_approx', numeric_tolerance: { type: 'absolute', value: 0.01 } },
          gold: { value: 300 },
          metadata: {},
        },
        {
          case_key: 'top-regions-list',
          question: '列出销售额最高的区域',
          expected_behavior: '返回有序列表',
          answer_type: 'list',
          assertion: { type: 'list_match', order: 'ordered' },
          gold: { items: ['华东', '华南'], order: 'ordered' },
          metadata: {},
        },
        {
          case_key: 'region-table',
          question: '按区域汇总销售额',
          expected_behavior: '返回表格',
          answer_type: 'table',
          assertion: { type: 'table_match', row_order: 'unordered' },
          gold: {
            columns: [{ name: 'region' }, { name: 'amount', type: 'number' }],
            rows: [{ region: '华东', amount: 300 }],
          },
          metadata: {},
        },
        {
          case_key: 'invalid-missing-question',
          answer_type: 'text',
          gold: { value: 'invalid' },
        },
      ],
    });
    assert.status(importCasesResp, 200, '导入 Benchmark cases');
    const imported = dataOf(importCasesResp);
    assert.eq(imported.imported_count, 4, '导入 4 条有效 case');
    assert.eq(imported.skipped_count, 1, '跳过 1 条无效 case');
    assert.ok(imported.cases.every((item) => item.status === 'ready'), '有 gold 的 case 进入 ready');

    const benchmarkResp = await api('GET', `/api/agent/projects/${pid}/trace-optimization/benchmark?case_limit=20&report_limit=5`);
    assert.status(benchmarkResp, 200, 'Benchmark overview 可读取');
    const benchmark = dataOf(benchmarkResp);
    assert.ok(benchmark.task_count > 0, 'Benchmark overview 返回内置任务清单');
    assert.ok((benchmark.cases || []).length >= 4, 'Benchmark overview 返回入库 cases');

    const blockedCase = firstCase(benchmark, (item) => item.case_key === 'east-sales-number');
    assert.ok(Boolean(blockedCase?.id), '可选择一条缺上下文的 ready case');
    const materializePreviewResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/benchmark/cases/${blockedCase.id}/materialize`, {
      skip_ai: true,
      write: false,
    });
    assert.status(materializePreviewResp, 200, 'Benchmark materialize 预览可用');
    const materializePreview = dataOf(materializePreviewResp);
    assert.eq(materializePreview.written, false, 'materialize 预览不写文件');
    assert.eq(materializePreview.runnable, false, '缺上下文 case 标记为不可运行');
    assert.ok((materializePreview.context_requirements || []).length > 0, 'materialize 返回上下文缺口');

    const runBlockedResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/benchmark/cases/${blockedCase.id}/run`, {
      skip_ai: true,
      diagnose: false,
      timeout_ms: 30000,
    });
    assert.status(runBlockedResp, 200, '运行缺上下文 case 时记录 blocked run');
    const blockedRunResult = dataOf(runBlockedResp);
    assert.eq(blockedRunResult?.run?.status, 'blocked', '缺上下文 run 状态为 blocked');
    assert.eq(blockedRunResult?.run?.diagnosis?.failure_stage, 'trace_incomplete', 'blocked run 有诊断说明');
    cleanupGenerated(blockedRunResult);

    const runsResp = await api('GET', `/api/agent/projects/${pid}/trace-optimization/benchmark/cases/${blockedCase.id}/runs?limit=5`);
    assert.status(runsResp, 200, 'Benchmark run 列表可读取');
    assert.ok((dataOf(runsResp) || []).some((item) => item.status === 'blocked'), 'run history 包含 blocked 记录');

    const summary1 = await api('GET', `/api/agent/projects/${pid}/trace-optimization/summary`);
    assert.status(summary1, 200, '最终 summary 可读取');
    const summary = dataOf(summary1);
    assert.ok(summary.reviews.total >= 1, 'summary 统计 review');
    assert.ok(summary.drafts.ready >= 1, 'summary 统计 ready draft');
    assert.ok(summary.gold_solves.total >= 1, 'summary 统计 gold solve');
    assert.ok(summary.attempts.passed >= 1, 'summary 统计 passed attempt');
    assert.ok(summary.benchmark_cases.ready >= 4, 'summary 统计 ready benchmark cases');
    assert.ok(summary.benchmark_runs.failed >= 1, 'summary 把 blocked run 计入失败类');

    await driver.ui.goto('/agent#trace-case-build');
    await waitBodyText(driver, '优化工作台', { timeout: 20000 });
    await waitBodyText(driver, '自优化');
    await waitBodyText(driver, '用例构建');
    await waitBodyText(driver, '会话复盘');
    await waitBodyText(driver, '样本优化');
    await waitBodyText(driver, '导入测试集');
    await waitBodyText(driver, '工作流');

    await driver.ui.clickText('样本优化', { timeout: 10000 });
    await waitBodyText(driver, '优化证据链');
    await waitBodyText(driver, '生成调优方案');

    await driver.ui.clickText('添加用例', { timeout: 10000 });
    await driver.ui.waitUntil(
      `() => !!document.querySelector('[role="dialog"]') && document.body?.innerText?.includes('添加优化用例') && document.body?.innerText?.includes('从会话复盘创建')`,
      { timeout: 10000, label: '添加用例抽屉打开' },
    );
    await driver.ui.press('Escape');
    await driver.ui.waitUntil(
      `() => !document.querySelector('[role="dialog"]')`,
      { timeout: 10000, label: '添加用例抽屉关闭' },
    ).catch(() => {});

    await driver.ui.clickText('导入测试集', { timeout: 10000 });
    await waitBodyText(driver, '清洗预览');
    await waitBodyText(driver, '原始测试集');

    await driver.ui.clickText('用例运行', { timeout: 10000 });
    await waitBodyText(driver, '优化过程');
    await waitBodyText(driver, 'Trace 下钻');
    await waitBodyText(driver, '全部 Trace');
    await waitBodyText(driver, 'sql_scan_operator');
    await waitBodyText(driver, '用例库与运行历史');
    await waitBodyText(driver, '已入库用例');
    await waitBodyText(driver, '运行结果');

    await driver.ui.clickText('运行详情', { timeout: 10000 });
    await driver.ui.waitUntil(
      `() => !!document.querySelector('[role="dialog"]') && document.body?.innerText?.includes('运行详情')`,
      { timeout: 10000, label: '运行详情抽屉打开' },
    );
  },
};
