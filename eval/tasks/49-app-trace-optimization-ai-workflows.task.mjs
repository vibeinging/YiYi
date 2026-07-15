// 自优化 AI workflow 成功路径：Benchmark AI 清洗、文件夹清洗、Gold Solve 生成、Trace 诊断。
// 无 PRIMARY 模型时记录跳过，避免无模型 CI 把确定性回归打红。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function dataOf(resp) {
  return resp?.json?.data ?? resp?.json ?? null;
}

function bodyText(resp) {
  try {
    return JSON.stringify(resp?.json || {}).slice(0, 600);
  } catch {
    return '';
  }
}

async function hasPrimaryModel(driver) {
  const resp = await driver.raw.api('GET', '/api/llm_model/active?category=PRIMARY').catch(() => null);
  const data = dataOf(resp);
  const list = Array.isArray(data) ? data : data?.items || data?.data || [];
  if (Array.isArray(list) && list.some((item) => String(item?.category || '').toUpperCase() === 'PRIMARY')) return true;
  const models = await driver.raw.api('GET', '/api/llm_model/llm_models?category=PRIMARY').catch(() => null);
  const modelData = dataOf(models);
  const modelList = Array.isArray(modelData) ? modelData : modelData?.items || modelData?.data || [];
  return Array.isArray(modelList) && modelList.length > 0;
}

export default {
  id: 'app-trace-optimization-ai-workflows',
  desc: '自优化 AI workflow 成功路径：清洗 Benchmark、生成 gold solve、Trace 诊断',
  async run({ driver, assert, record }) {
    await driver.login();
    const primaryReady = await hasPrimaryModel(driver);
    record({ primary_model_ready: primaryReady });
    if (!primaryReady) {
      assert.ok(true, '没有 PRIMARY 模型，AI workflow 成功路径跳过');
      return;
    }

    const projectName = `trace-opt-ai-eval-${Date.now()}`;
    const pid = await driver.createProject(projectName);
    const api = (method, url, body) => driver.raw.api(method, url, body);
    record({ project_id: pid, project_name: projectName });

    const normalizeResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/benchmark/normalize`, {
      format_hint: 'json',
      content: JSON.stringify({
        cases: [
          {
            case_key: 'ai-normalize-number',
            question: '2 加 2 等于几？',
            expected_behavior: '回答数字 4',
            answer_type: 'number',
            assertion: { type: 'number_approx' },
            gold: { value: 4 },
          },
        ],
      }),
    });
    assert.status(normalizeResp, 200, `AI Benchmark 清洗成功 ${bodyText(normalizeResp)}`);
    const normalized = dataOf(normalizeResp);
    assert.ok((normalized?.cases || []).length >= 1, 'AI Benchmark 清洗返回 case');
    assert.ok(Number(normalized?.valid_count || 0) >= 1, 'AI Benchmark 清洗返回有效 case');
    assert.ok(Boolean(normalized?.skill?.name), 'AI Benchmark 清洗返回 workflow skill metadata');

    const folder = mkdtempSync(join(tmpdir(), 'trace-opt-ai-folder-'));
    writeFileSync(join(folder, 'cases.json'), JSON.stringify({
      cases: [
        {
          case_key: 'folder-case-text',
          question: '请说出公司名 YiW',
          expected_behavior: '回答里包含 YiW',
          answer_type: 'text',
          gold: { value: 'YiW' },
        },
      ],
    }, null, 2));
    const folderResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/benchmark/normalize-folder`, {
      folder_path: folder,
      format_hint: 'folder',
    });
    assert.status(folderResp, 200, `AI Benchmark 文件夹清洗成功 ${bodyText(folderResp)}`);
    const folderData = dataOf(folderResp);
    assert.eq(folderData?.source?.type, 'folder_import', '文件夹清洗返回 folder_import source');
    assert.ok((folderData?.cases || []).length >= 1, '文件夹清洗返回 case');

    const reviewResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/reviews`, {
      run_id: 'run-trace-opt-ai-eval',
      session_id: 'session-trace-opt-ai-eval',
      trace_id: 'trace-opt-ai-eval',
      target_type: 'run',
      question: '统计华东销售额',
      actual_output: '华东销售额为 250',
      trace_snapshot: {
        traceId: 'trace-opt-ai-eval',
        spans: [
          {
            id: 'root',
            name: 'YiW',
            depth: 0,
            input: '统计华东销售额',
            output: '华东销售额为 250',
            logs: [{ message: 'skill smart_query selected' }],
          },
          {
            id: 'sql-scan',
            parentId: 'root',
            name: 'sql_scan_operator',
            depth: 1,
            input: 'select sum(amount) from sales',
            output: '250',
          },
        ],
      },
      status: 'incorrect',
      severity: 'high',
      reason_code: 'sql_filter',
      reason_text: '过滤条件错误',
      expected_behavior: '应该只统计 region = 华东 的 amount 合计',
      source: 'eval',
    });
    assert.status(reviewResp, 200, 'AI workflow 测试 review 创建成功');
    const review = dataOf(reviewResp);

    const draftResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/from-review`, {
      review_id: review.id,
      question: '统计华东销售额',
      expected_behavior: '应该只统计 region = 华东 的 amount 合计',
      expected_answer: '300',
      assertion_type: 'text_contains',
      failure_category: 'sql_filter',
      tuning_notes: 'region=华东 是严格过滤条件',
    });
    assert.status(draftResp, 200, 'AI workflow 测试 draft 创建成功');
    const draft = dataOf(draftResp);

    const goldResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/gold-solve/generate`, {
      question: '统计华东销售额',
      expected_behavior: '应该只统计 region = 华东 的 amount 合计',
      expected_answer: '300',
      assertion_type: 'text_contains',
    });
    assert.status(goldResp, 200, `AI 生成 gold solve 成功 ${bodyText(goldResp)}`);
    const gold = dataOf(goldResp);
    assert.ok(Boolean(gold?.gold_solve?.intent_summary || gold?.gold_solve?.final_answer_contract), 'AI gold solve 返回参考解内容');
    assert.eq(gold?.draft?.status, 'reviewable', 'AI gold 初稿不自动 verified');

    const diagnoseResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/diagnose`, {
      persist_attempt: true,
      gold_solve: gold?.gold_solve || {},
      attempt: { source: 'diagnosis', status: 'planned' },
    });
    assert.status(diagnoseResp, 200, `AI Trace 诊断成功 ${bodyText(diagnoseResp)}`);
    const diagnosis = dataOf(diagnoseResp);
    assert.ok(Boolean(diagnosis?.summary), 'AI Trace 诊断返回 summary');
    assert.ok(Array.isArray(diagnosis?.evidence), 'AI Trace 诊断返回 evidence');
    assert.ok(Boolean(diagnosis?.attempt?.id), 'persist_attempt 生成 attempt');

    const proposalResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/tuning-proposal`, {
      diagnosis,
      gold_solve: gold?.gold_solve || {},
    });
    assert.status(proposalResp, 200, `AI 调优方案生成成功 ${bodyText(proposalResp)}`);
    const proposal = dataOf(proposalResp);
    assert.ok(Boolean(proposal?.proposal || proposal?.hypothesis), 'AI 调优方案返回 proposal 或 hypothesis');
    assert.ok(Boolean(proposal?.change_type), 'AI 调优方案返回 change_type');
  },
};
