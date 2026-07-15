#!/usr/bin/env node
// 真重启恢复 Eval：任务提交后关闭 Electron，再用同一数据目录启动 App，验证原 job 进入终态。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSession } from './lib/cdp.mjs';
import { makeDriver } from './lib/driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const home = process.env.YIW_EVAL_HOME || mkdtempSync(path.join(tmpdir(), 'yiw-restart-eval-'));
const port = Number(process.env.CDP_PORT || 9443);
const startedAt = new Date().toISOString();
const reportFile = path.join(__dirname, 'results', `${startedAt.replace(/[:.]/g, '-')}-background-job-real-restart.json`);
mkdirSync(path.dirname(reportFile), { recursive: true });
process.env.YIW_EVAL_HOME = home;
process.env.YIW_EVAL_ISOLATED = '1';
process.env.YIW_EVAL_VECTOR_ITEM_DELAY_MS = process.env.YIW_EVAL_VECTOR_ITEM_DELAY_MS || '2000';

let first = null;
let second = null;
const checks = [];
let jobId = null;
let status = 'failed';
let error = null;

function check(ok, message) {
  checks.push({ ok: Boolean(ok), message });
  if (!ok) throw new Error(message);
}

try {
  first = await openSession({ port });
  const driver = makeDriver(first);
  await driver.login();
  const pid = await driver.ensureProjectRecord(`real-restart-${Date.now()}`);
  const file = path.join(home, 'restart_items.csv');
  writeFileSync(file, 'id,name\n1,alpha\n2,beta\n');
  const imported = await driver.importTable(pid, file, { dsName: `restart-vector-${Date.now()}` });
  const tables = await driver.raw.api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables?per_page=100`);
  const tableIds = (tables.json?.data?.items || []).map((item) => item.id).filter(Boolean);
  const session = await driver.raw.api('POST', `/api/projects/${pid}/sessions`, {
    title: 'background-job-real-restart', source_type: 'agent', source_id: pid, action_type: 'agentic_chat',
  });
  const sid = session.json?.data?.id;
  const submitted = await driver.raw.api('POST', `/api/projects/${pid}/databases/${imported.connId}/tables/store-vectors`, {
    table_ids: tableIds, only_pending: false, session_id: sid,
  });
  jobId = submitted.json?.data?.job?.id;
  check(submitted.status === 200 && jobId, '后台任务提交成功并返回 job.id');
  check(submitted.json?.data?.job?.status === 'queued', '关闭 App 前任务仍为 queued');

  first.close();
  first = null;
  await sleep(2500);

  second = await openSession({ port });
  const restarted = makeDriver(second);
  await restarted.login();
  let event = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const messages = await restarted.raw.api('GET', `/api/projects/${pid}/sessions/${sid}/messages`);
    const data = messages.json?.data;
    const items = Array.isArray(data) ? data : (data?.items || data?.messages || []);
    event = items.map((message) => {
      try { return typeof message.message_metadata === 'string' ? JSON.parse(message.message_metadata) : message.message_metadata; }
      catch { return null; }
    }).find((metadata) => metadata?.background_job?.job_id === jobId)?.background_job;
    if (event) break;
    await sleep(500);
  }
  check(Boolean(event), 'App 重启后原任务产生终态事件');
  check(['completed', 'blocked_configuration', 'failed'].includes(event.status), `原 job.id 续跑到明确终态(${event.status})`);
  check(JSON.stringify(event.result?.requested_table_ids || []) === JSON.stringify(tableIds), '重启后仍使用原始表清单');
  status = 'passed';
} catch (cause) {
  error = cause?.stack || cause?.message || String(cause);
} finally {
  try { first?.close(); } catch {}
  try { second?.close(); } catch {}
  writeFileSync(reportFile, JSON.stringify({ startedAt, updatedAt: new Date().toISOString(), status, jobId, home, checks, error }, null, 2));
}

console.log(`真实重启 Eval: ${status === 'passed' ? '通过' : '失败'}`);
for (const item of checks) console.log(`${item.ok ? '✓' : '✗'} ${item.message}`);
console.log(`报告: ${reportFile}`);
if (error) console.error(error);
process.exit(status === 'passed' ? 0 : 1);
