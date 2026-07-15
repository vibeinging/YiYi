#!/usr/bin/env node
// yiw-eval —— app 内的 eval 框架(Node + CDP)。驱动真 app(渲染层→ipc→registry)做端到端/准确率测试,零 HTTP。
//
// 用法:
//   node eval/run.mjs                 # 自启一个 Electron 实例(:9333)跑全部任务,测完自杀
//   CDP_PORT=9223 node eval/run.mjs    # 连已在跑的实例(app 带 --remote-debugging-port=9223)
//   node eval/run.mjs nl2sql           # 只跑 id 含 "nl2sql" 的任务
//
// 任务放 tasks/*.task.mjs,default 导出 { id, desc, async run({driver, assert, writeFixture}) }。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { openSession } from './lib/cdp.mjs';
import { makeDriver } from './lib/driver.mjs';
import { runTasks, report, summarizeResults } from './lib/runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CDP_PORT || 9333);
const filter = process.argv[2] || null;
const concurrency = Math.max(1, Number(process.env.YIW_EVAL_CONCURRENCY || 1) || 1);
const shardCount = Math.max(1, Number(process.env.YIW_EVAL_SHARD_COUNT || 1) || 1);
const shardIndex = Math.max(0, Number(process.env.YIW_EVAL_SHARD_INDEX || 0) || 0);
if (shardIndex >= shardCount) throw new Error(`YIW_EVAL_SHARD_INDEX(${shardIndex}) 必须小于 YIW_EVAL_SHARD_COUNT(${shardCount})`);

const tasksDir = path.join(__dirname, 'tasks');
const tasks = [];
for (const f of readdirSync(tasksDir).filter((f) => f.endsWith('.task.mjs')).sort()) {
  const mod = await import(pathToFileURL(path.join(tasksDir, f)).href);
  if (mod.default) tasks.push(mod.default);
}
const generatedTasksDir = path.join(__dirname, 'generated', 'tasks');
const includeGenerated = process.env.YIW_EVAL_INCLUDE_GENERATED === '1'
  || Boolean(filter && /trace-benchmark|generated/i.test(filter));
if (includeGenerated) {
  try {
    for (const f of readdirSync(generatedTasksDir).filter((f) => f.endsWith('.task.mjs')).sort()) {
      const mod = await import(pathToFileURL(path.join(generatedTasksDir, f)).href);
      if (mod.default) tasks.push(mod.default);
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
}
console.log(`加载 ${tasks.length} 个任务${filter ? `(过滤 "${filter}")` : ''};并发 ${concurrency};分片 ${shardIndex + 1}/${shardCount};连接 app(CDP :${PORT})…`);

const startedAt = new Date().toISOString();
const runId = String(process.env.YIW_EVAL_RUN_ID || startedAt.replace(/[:.]/g, '-')).replace(/[^a-zA-Z0-9_-]/g, '_');
const resultsDir = process.env.EVAL_REPORT_DIR || path.join(__dirname, 'results');
const reportFile = process.env.YIW_EVAL_REPORT_FILE
  ? path.resolve(process.env.YIW_EVAL_REPORT_FILE)
  : path.join(resultsDir, `${runId}${filter ? `-${filter.replace(/[^a-zA-Z0-9_-]/g, '_')}` : ''}.json`);
mkdirSync(path.dirname(reportFile), { recursive: true });

function persistRun(results, status, error = null) {
  writeFileSync(reportFile, JSON.stringify({
    runId,
    startedAt,
    updatedAt: new Date().toISOString(),
    status,
    filter,
    cdpPort: PORT,
    totalLoadedTasks: tasks.length,
    completedTasks: results.length,
    summary: summarizeResults(results),
    error,
    results,
  }, null, 2));
}

let session = null;
let ok = false;
let results = [];

function interrupt(signal) {
  if (!results.length) {
    try {
      const current = JSON.parse(readFileSync(reportFile, 'utf-8'));
      if (Array.isArray(current.results)) results = current.results;
    } catch {}
  }
  persistRun(results, 'interrupted', signal);
  session?.close?.();
  console.log(`\n报告: ${reportFile}`);
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.once('SIGINT', () => interrupt('SIGINT'));
process.once('SIGTERM', () => interrupt('SIGTERM'));

session = await openSession({ port: PORT });
const driver = makeDriver(session);
try {
  await driver.login();
  results = await runTasks(driver, tasks, {
    filter,
    concurrency,
    shardIndex,
    shardCount,
    onResult: (_result, partialResults) => {
      results = partialResults;
      persistRun(partialResults, 'running');
    },
  });
  ok = report(results);
  persistRun(results, ok ? 'passed' : 'failed');
} catch (e) {
  const message = e?.message || String(e);
  console.error('eval 运行异常:', message);
  persistRun(results, 'error', message);
} finally {
  session.close();
}
console.log(`报告: ${reportFile}`);
process.exit(ok ? 0 : 1);
