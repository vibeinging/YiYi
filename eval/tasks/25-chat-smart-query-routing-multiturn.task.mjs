// 项目 chat 多轮路由:复用 functional/task_多轮对话 的全部问题。
// 关键点:走 /api/agent/projects/:pid/sessions/:sid/chat,不显式传 skill,
// 同时验证 WorkspaceAgent 自动调用 query_project_data 和逐轮答案命中原始 gold。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASK_ROOT = path.resolve(__dirname, '../datasets/functional/input/task_多轮对话');
const TASK_FILE = path.join(TASK_ROOT, 'task.json');
const DB_FILE = path.join(TASK_ROOT, 'context/db/trade_dist.sqlite');

function readOriginalTask() {
  return JSON.parse(readFileSync(TASK_FILE, 'utf8'));
}

// 对齐 functional-task.mjs 的文本命中逻辑:支持千分位和数值等价。
function textContains(text, expected) {
  const haystack = String(text || '');
  const needle = String(expected ?? '');
  if (haystack.includes(needle)) return true;

  const noComma = needle.replace(/,/g, '');
  if (haystack.replace(/,/g, '').includes(noComma)) return true;

  const num = Number(needle);
  if (!Number.isNaN(num) && Number.isFinite(num)) {
    const matches = haystack.match(/-?[\d,]+\.?\d*/g) || [];
    for (const m of matches) {
      const mn = Number(m.replace(/,/g, ''));
      if (!Number.isNaN(mn) && Math.abs(mn - num) < 0.01) return true;
    }
  }
  return false;
}

function perTurnRuleForTask(task) {
  return (task.assertions || []).find((assertion) => assertion.type === 'per_turn') || {};
}

export default {
  id: 'chat-smart-query-routing-multiturn',
  desc: '项目 chat 复用源库多轮问数任务并自动调用 query_project_data',
  async run({ driver, assert }) {
    await driver.login();
    const task = readOriginalTask();
    const questions = task.questions || [];
    const perTurnRule = perTurnRuleForTask(task);
    const expected = Array.isArray(perTurnRule.expected) ? perTurnRule.expected : [];
    const configuredPassRatio = Number(perTurnRule.pass_ratio);
    const passRatio = Number.isFinite(configuredPassRatio) && configuredPassRatio >= 0 && configuredPassRatio <= 1
      ? configuredPassRatio
      : 1;
    const turnCount = questions.length;

    assert.ok(turnCount > 0, '源库多轮对话问题非空');
    assert.eq(expected.length, turnCount, `源库逐轮 gold 与问题数量一致(${turnCount})`);

    const pid = await driver.ensureProject('chat-smart-query-routing-multiturn-eval');
    const imported = await driver.importDatabase(pid, DB_FILE, { name: 'trade_dist_multiturn' });
    assert.ok(!!imported.connId, `导入原始多轮 SQLite 数据源(${imported.connId || 'none'})`);

    const results = await driver.askAgentMultiTurn(pid, questions, {
      title: `chat-smart-query-routing-multiturn-${turnCount}`,
    });

    assert.eq(results.length, turnCount, `App 实际执行源库全部 ${turnCount} 轮问题`);
    assert.eq(new Set(results.map((r) => r.sid)).size, 1, `${turnCount} 轮复用同一个 agent 会话`);

    let routed = 0;
    let answerHits = 0;
    const routeFailures = [];
    const answerFailures = [];

    for (let i = 0; i < results.length; i++) {
      const blocks = results[i].blocks || [];
      const text = blocks.map((b) => `${b.type || ''} ${b.title || ''} ${b.content || ''}`).join('\n');
      const selected = blocks.find((b) => b.type === 'tool' && b.metadata?.tool_name === 'query_project_data');
      const localTool = blocks.find((b) => b.type === 'tool' && ['ls', 'read', 'grep', 'find'].includes(b.metadata?.tool_name));

      const routeOk = !!selected && !localTool && !/数据接入|data_onboarding/.test(text);
      if (routeOk) routed++;
      else routeFailures.push(i + 1);

      const exp = expected[i];
      const expList = Array.isArray(exp) ? exp : [exp];
      const answerOk = expList.every((item) => textContains(text, item));
      if (answerOk) answerHits++;
      else answerFailures.push(`${i + 1}:${expList.join('+')}`);
    }

    assert.eq(routed, questions.length, `自动路由准确率 ${routed}/${questions.length}`);
    assert.ok(routeFailures.length === 0, `未误入本地文件夹或 data_onboarding 的轮次:${routeFailures.join(',') || '无'}`);
    assert.ok(
      answerHits / expected.length >= passRatio,
      `答案逐轮准确率 ${answerHits}/${expected.length};阈值 ${passRatio};失败轮次 ${answerFailures.join(',') || '无'}`,
    );
  },
};
