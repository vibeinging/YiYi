import test from 'node:test';
import assert from 'node:assert/strict';

import { AnalysisSession } from '../../server/src/engine/core/analysis_session.js';

test('AnalysisSession.completeOpenTasks marks all unfinished plan steps done', async () => {
  const queries = [];
  const session = new AnalysisSession({
    sessionId: 'session-plan-finalize',
    ctx: {
      async query(sql, params) {
        queries.push({ sql, params });
        return [];
      },
      async queryOne() {
        return null;
      },
    },
  });
  session.taskPlan = [
    { title: '查找客户', status: 'done' },
    { title: '查询订单', status: 'doing' },
    { title: '整合结果并回答问题', status: 'todo' },
  ];

  const finalPlan = await session.completeOpenTasks();

  assert.deepEqual(finalPlan.map((step) => step.status), ['done', 'done', 'done']);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /SET status='completed'/);
  assert.deepEqual(queries[0].params, ['session-plan-finalize']);
});

test('AnalysisSession.completeOpenTasks is a no-op when all steps are already done', async () => {
  const queries = [];
  const session = new AnalysisSession({
    sessionId: 'session-plan-finalized',
    ctx: {
      async query(sql, params) {
        queries.push({ sql, params });
        return [];
      },
      async queryOne() {
        return null;
      },
    },
  });
  session.taskPlan = [
    { title: '查找客户', status: 'done' },
    { title: '查询订单', status: 'completed' },
  ];

  const finalPlan = await session.completeOpenTasks();

  assert.equal(finalPlan, session.taskPlan);
  assert.deepEqual(finalPlan.map((step) => step.status), ['done', 'completed']);
  assert.equal(queries.length, 0);
});
