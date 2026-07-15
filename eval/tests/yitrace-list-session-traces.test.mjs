import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YIW_TRACE_READ_TIMEOUT_MS = '25';
process.env.YIW_TRACE_WORKER_TIMEOUT_MS = '25';
process.env.YIW_TRACE_WORKER_STARTUP_DELAY_MS = '1000';

const traces = await import('../../server/src/app/traces/yitrace_service.js');

function makeCtx({ runs = [], messages = [] } = {}) {
  return {
    async query(sql) {
      if (sql.includes('FROM agent_runs')) return runs;
      if (sql.includes('FROM session_messages')) return messages;
      return [];
    },
  };
}

test('listSessionTraces does not block on yiTrace session listing when no app runs exist', async () => {
  let sessionsCalled = false;
  traces.__setYiTraceDbForTest({
    async sessions() {
      sessionsCalled = true;
      return new Promise(() => {});
    },
  });

  const started = Date.now();
  const res = await traces.listSessionTraces(makeCtx(), {
    params: { pid: 'project-1', sid: 'session-1' },
    query: { limit: 1 },
  });

  traces.__resetYiTraceDbForTest();
  assert.equal(sessionsCalled, false);
  assert.deepEqual(res.data.items, []);
  assert.equal(res.data.enabled, true);
  assert.ok(Date.now() - started < 100);
});

test('listSessionTraces returns fallback items when a yiTrace run read times out', async () => {
  traces.__setYiTraceDbForTest({
    async trace() {
      return new Promise(() => {});
    },
    async span() {
      return null;
    },
  });

  const res = await traces.listSessionTraces(makeCtx({
    runs: [{
      id: 'run-1',
      session_id: 'session-1',
      project_id: 'project-1',
      user_id: 'user-1',
      status: 'completed',
      skill_name: 'smart_query',
      mode: 'agent',
      created_at: '2026-07-07T00:00:00.000Z',
      updated_at: '2026-07-07T00:00:01.000Z',
      finished_at: '2026-07-07T00:00:02.000Z',
    }],
    messages: [{
      id: 'message-1',
      role: 'user',
      content_items: JSON.stringify([{ type: 'text', content: '问题' }]),
      sequence_number: 1,
      created_at: '2026-07-07T00:00:00.000Z',
    }],
  }), {
    params: { pid: 'project-1', sid: 'session-1' },
    query: { limit: 1, resolve_trace: '1' },
  });

  traces.__resetYiTraceDbForTest();
  assert.equal(res.data.traceReadTimeout, true);
  assert.equal(res.data.items.length, 1);
  assert.equal(res.data.items[0].runId, 'run-1');
  assert.equal(res.data.items[0].trace, null);
  assert.equal(res.data.items[0].question.questionText, '问题');
});

test('listSessionTraces returns fallback immediately while yiTrace worker warms up', async () => {
  const previousDir = process.env.YIW_YITRACE_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'yiw-yitrace-large-'));
  await mkdir(join(dir, 'segments'));
  await writeFile(join(dir, 'wal.log'), Buffer.from('x'));
  process.env.YIW_YITRACE_DIR = dir;

  try {
    const started = Date.now();
    const res = await traces.listSessionTraces(makeCtx({
      runs: [{
        id: 'run-large',
        session_id: 'session-1',
        project_id: 'project-1',
        user_id: 'user-1',
        status: 'completed',
        skill_name: 'smart_query',
        mode: 'agent',
        created_at: '2026-07-07T00:00:00.000Z',
        updated_at: '2026-07-07T00:00:01.000Z',
        finished_at: '2026-07-07T00:00:02.000Z',
      }],
      messages: [{
        id: 'message-1',
        role: 'user',
        content_items: JSON.stringify([{ type: 'text', content: '问题' }]),
        sequence_number: 1,
        created_at: '2026-07-07T00:00:00.000Z',
      }],
    }), {
      params: { pid: 'project-1', sid: 'session-1' },
      query: { limit: 1 },
    });

    traces.__resetYiTraceDbForTest();
    assert.ok(Date.now() - started < 250);
    assert.equal(res.data.traceResolveDeferred, true);
    assert.equal(res.data.traceReadTimeout, true);
    assert.equal(res.data.traceWarmupPending, true);
    assert.equal(res.data.items.length, 1);
    assert.equal(res.data.items[0].runId, 'run-large');
    assert.equal(res.data.items[0].trace, null);
  } finally {
    traces.__resetYiTraceDbForTest();
    if (previousDir === undefined) delete process.env.YIW_YITRACE_DIR;
    else process.env.YIW_YITRACE_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
});
