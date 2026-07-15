// Trace 完整性:从 functional 多轮对话抽前 5 问,验证每轮 trace 是否记录完整流程。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASK_ROOT = path.resolve(__dirname, '../datasets/functional/input/task_多轮对话');
const TASK_FILE = path.join(TASK_ROOT, 'task.json');
const DB_FILE = path.join(TASK_ROOT, 'context/db/trade_dist.sqlite');
const TRACE_TURN_COUNT = 5;

function readOriginalTask() {
  return JSON.parse(readFileSync(TASK_FILE, 'utf8'));
}

function expectedForTask(task) {
  const perTurn = (task.assertions || []).find((a) => a.type === 'per_turn');
  return Array.isArray(perTurn?.expected) ? perTurn.expected : [];
}

function textContains(text, expected) {
  const haystack = String(text || '');
  const needle = String(expected ?? '');
  if (haystack.includes(needle)) return true;

  const noComma = needle.replace(/,/g, '');
  if (haystack.replace(/,/g, '').includes(noComma)) return true;

  const num = Number(needle);
  if (!Number.isNaN(num) && Number.isFinite(num)) {
    const matches = haystack.match(/-?[\d,]+\.?\d*/g) || [];
    return matches.some((m) => {
      const mn = Number(m.replace(/,/g, ''));
      return !Number.isNaN(mn) && Math.abs(mn - num) < 0.01;
    });
  }
  return false;
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function tracePayload(resp) {
  return resp?.json?.data || resp?.json || {};
}

function spanKey(span = {}) {
  return String(span.externalSpanId || span.id || '');
}

function isRootSpan(span = {}) {
  return Number(span.depth || 0) === 0 || spanKey(span) === 'yiw-run';
}

function logsOf(spans = []) {
  return spans.flatMap((span) => (Array.isArray(span.logs) ? span.logs : [])).filter(Boolean);
}

async function waitForSessionTraces(driver, pid, sid, expectedRuns) {
  const api = driver.raw.api;
  let last = null;
  for (let i = 0; i < 30; i += 1) {
    const resp = await api('GET', `/api/agent/projects/${pid}/sessions/${sid}/traces?limit=20`).catch((error) => ({ error }));
    last = resp;
    const data = tracePayload(resp);
    const items = Array.isArray(data.items) ? data.items : [];
    const completeRuns = items.filter((item) => item.trace?.spans?.length);
    if (data.enabled !== false && completeRuns.length >= expectedRuns) return resp;
    await driver.raw.ev('await new Promise((resolve) => setTimeout(resolve, 1000))', { timeoutMs: 2500 }).catch(() => {});
  }
  return last;
}

export default {
  id: 'trace-multiturn-flow',
  desc: '从多轮问数抽 5 问验证 Trace 记录 root/span/log/attrs/问题映射',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const task = readOriginalTask();
    const questions = (task.questions || []).slice(0, TRACE_TURN_COUNT);
    const expected = expectedForTask(task).slice(0, TRACE_TURN_COUNT);

    assert.eq(questions.length, TRACE_TURN_COUNT, '从多轮任务抽取 5 个问题');
    assert.eq(expected.length, TRACE_TURN_COUNT, '同步抽取 5 个逐轮 gold');

    const pid = await driver.ensureProject('trace-multiturn-flow-eval');
    const imported = await driver.importDatabase(pid, DB_FILE, { name: 'trade_dist_trace_multiturn' });
    assert.ok(!!imported.connId, `导入多轮 SQLite 数据源(${imported.connId || 'none'})`);

    const results = await driver.askAgentMultiTurn(pid, questions, {
      title: 'trace-multiturn-flow-5',
    });
    const sid = results.find((item) => item.sid)?.sid || '';
    assert.ok(!!sid, '5 轮共用的 agent 会话存在');
    assert.eq(new Set(results.map((r) => r.sid).filter(Boolean)).size, 1, '5 轮复用同一个 agent 会话');

    let routed = 0;
    let answerHits = 0;
    for (let i = 0; i < results.length; i += 1) {
      const blocks = results[i].blocks || [];
      const text = blocks.map((b) => `${b.type || ''} ${b.title || ''} ${b.content || ''}`).join('\n');
      const selected = blocks.find((b) => b.type === 'tool' && b.metadata?.tool_name === 'query_project_data');
      if (selected) routed += 1;
      const expList = Array.isArray(expected[i]) ? expected[i] : [expected[i]];
      if (expList.every((item) => textContains(text, item))) answerHits += 1;
    }
    assert.eq(routed, TRACE_TURN_COUNT, `5 轮都由 WorkspaceAgent 调用 query_project_data`);
    assert.ok(answerHits >= 3, `5 轮答案至少命中 3 轮(${answerHits}/${TRACE_TURN_COUNT})`);

    const tracesResp = await waitForSessionTraces(driver, pid, sid, TRACE_TURN_COUNT);
    assert.status(tracesResp, 200, '可读取当前 session traces');
    const data = tracePayload(tracesResp);
    assert.ok(data.enabled !== false, `Trace DB 已启用(${data.dataDir || 'unknown dir'})`);

    const items = Array.isArray(data.items) ? data.items : [];
    assert.ok(items.length >= TRACE_TURN_COUNT, `返回至少 5 个 trace run(实得 ${items.length})`);

    let completedRuns = 0;
    for (let i = 0; i < TRACE_TURN_COUNT; i += 1) {
      const questionNo = i + 1;
      const question = questions[i];
      const item = items.find((run) => Number(run.question?.questionNo || 0) === questionNo)
        || items.find((run) => compact(run.question?.questionText).includes(compact(question).slice(0, 16)));

      assert.ok(!!item, `第 ${questionNo} 问有对应 trace run`);
      if (!item) continue;

      const status = String(item.status || '').toLowerCase();
      if (['completed', 'ok'].includes(status)) completedRuns += 1;
      assert.ok(['completed', 'ok', 'failed', 'error'].includes(status), `第 ${questionNo} 问 run 状态已记录(${item.status || 'unknown'})`);
      assert.ok(compact(item.question?.questionText).includes(compact(question).slice(0, 16)), `第 ${questionNo} 问映射到用户问题`);

      const trace = item.trace;
      assert.ok(!!trace, `第 ${questionNo} 问 trace 已写入 yiTrace`);
      if (!trace) continue;

      const spans = Array.isArray(trace.spans) ? trace.spans : [];
      const root = spans.find(isRootSpan) || spans[0];
      const children = spans.filter((span) => span !== root && !isRootSpan(span));
      const allLogs = logsOf(spans);

      assert.ok(spans.length >= 2, `第 ${questionNo} 问记录 root + 子流程 span(${spans.length})`);
      assert.ok(!!root, `第 ${questionNo} 问有 root span`);
      assert.ok(compact(root?.input).includes(compact(question).slice(0, 16)), `第 ${questionNo} 问 root span 输入是用户问题`);
      assert.ok(compact(root?.output).length > 0, `第 ${questionNo} 问 root span 记录最终输出`);
      assert.ok(children.length > 0, `第 ${questionNo} 问记录工具/执行子流程 span`);
      assert.ok(children.some((span) => compact(span.input).length || compact(span.output).length || (span.logs || []).length), `第 ${questionNo} 问子流程有输入/输出/日志`);
      assert.ok(allLogs.length > 0, `第 ${questionNo} 问记录流程日志`);
      assert.ok(
        children.some((span) => /query_project_data|QueryAgent|query_agent/i.test(`${span.name || ''} ${span.operation || ''} ${span.input || ''}`)),
        `第 ${questionNo} 问记录 query_project_data / QueryAgent 子流程`,
      );

      const attrs = root?.attrs || {};
      assert.eq(String(attrs.project_id || ''), String(pid), `第 ${questionNo} 问 trace attrs.project_id`);
      assert.eq(String(attrs.skill || ''), '', `第 ${questionNo} 问顶层 trace 不再固定 skill`);
      assert.eq(String(attrs.mode || ''), 'agent', `第 ${questionNo} 问 trace attrs.mode`);
      assert.eq(String(attrs.call_site || ''), 'agent_chat', `第 ${questionNo} 问 trace attrs.call_site`);
      assert.eq(String(attrs.external_run_id || ''), String(item.runId || ''), `第 ${questionNo} 问 trace attrs.external_run_id`);
    }
    assert.ok(completedRuns >= 4, `5 轮中至少 4 轮执行完成(${completedRuns}/${TRACE_TURN_COUNT})`);
  },
};
