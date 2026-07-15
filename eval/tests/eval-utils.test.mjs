import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extractColumnsFromBlocks } from '../lib/driver.mjs';
import { buildKddQuestion, KDD_TABLE_ANSWER_INSTRUCTION } from '../lib/kdd-task.mjs';
import { scanContextDir } from '../lib/kdd.mjs';
import { makeAssert, scoreKddColumns, summarizeResults } from '../lib/runner.mjs';

test('scanContextDir recursively imports root-level context files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'yiw-eval-context-'));
  try {
    mkdirSync(path.join(root, 'csv'));
    mkdirSync(path.join(root, 'doc'));
    mkdirSync(path.join(root, '_parsed'));
    writeFileSync(path.join(root, 'patient_sex.csv'), 'id,sex\n1,M\n');
    writeFileSync(path.join(root, 'csv', 'Laboratory.csv'), 'id,wbc\n1,5\n');
    writeFileSync(path.join(root, 'doc', 'Patient.md'), '# Patient\n');
    writeFileSync(path.join(root, 'knowledge.md'), 'metric rule');
    writeFileSync(path.join(root, '_parsed', 'ignored.csv'), 'x\n1\n');
    writeFileSync(path.join(root, '._Laboratory.csv'), '');

    const ctx = scanContextDir(root);
    assert.deepEqual(ctx.csv.map((f) => path.basename(f)), ['Laboratory.csv', 'patient_sex.csv']);
    assert.deepEqual(ctx.structured.map((f) => path.basename(f)), ['Laboratory.csv', 'patient_sex.csv']);
    assert.deepEqual(ctx.doc.map((f) => path.basename(f)), ['Patient.md']);
    assert.equal(ctx.knowledge, 'metric rule');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractColumnsFromBlocks prefers final markdown table over earlier table blocks', () => {
  const blocks = [
    {
      type: 'json',
      title: '中间结果',
      display_type: 'table',
      content: JSON.stringify({ data: [{ city: 'wrong', amount: 1 }] }),
      metadata: { msg_category: 'tool_result' },
    },
    {
      type: 'markdown',
      title: '回答',
      content: '| city | amount |\n| --- | ---: |\n| 上海 | 10 |\n| 北京 | 20 |',
      metadata: { msg_category: 'final_answer' },
    },
  ];

  assert.deepEqual(extractColumnsFromBlocks(blocks), [
    ['上海', '北京'],
    ['10', '20'],
  ]);
});

test('extractColumnsFromBlocks uses final_result JSON data before fallback tables', () => {
  const blocks = [
    {
      type: 'json',
      title: '中间结果',
      display_type: 'table',
      content: JSON.stringify({ data: [{ value: 'intermediate' }] }),
      metadata: { msg_category: 'tool_result' },
    },
    {
      type: 'json',
      title: '查询结果',
      display_type: 'table',
      content: JSON.stringify({
        display_type: 'table',
        fields: [{ name: 'answer' }],
        data: [{ answer: 'final-a' }, { answer: 'final-b' }],
      }),
      metadata: { msg_category: 'final_result' },
    },
  ];

  assert.deepEqual(extractColumnsFromBlocks(blocks), [['final-a', 'final-b']]);
});

test('extractColumnsFromBlocks prefers final_result JSON over later markdown summary', () => {
  const blocks = [
    {
      type: 'json',
      title: '客户交易明细',
      display_type: 'table',
      content: JSON.stringify({
        display_type: 'table',
        data: [{ tx_id: 816173 }, { tx_id: 816174 }, { tx_id: 816175 }, { tx_id: 816181 }],
      }),
      metadata: { msg_category: 'final_result', savable_to_panel: true, recall: true },
    },
    {
      type: 'markdown',
      title: '回答',
      content: '| tx_id | amount |\n| --- | ---: |\n| 816173 | 800 |\n| 816176 | 1776 |',
      metadata: { msg_category: 'final_answer' },
    },
  ];

  assert.deepEqual(extractColumnsFromBlocks(blocks), [[816173, 816174, 816175, 816181]]);
});

test('extractColumnsFromBlocks does not treat intermediate tables as final answer', () => {
  const blocks = [
    {
      type: 'table',
      title: '中间结果：查询 publisher',
      display_type: 'table',
      content: JSON.stringify({ data: [{ content_index: 1, content: 'not final' }] }),
      metadata: { msg_category: 'intermediate_result' },
    },
  ];

  assert.deepEqual(extractColumnsFromBlocks(blocks), []);
});

test('summarizeResults counts KDD tasks without column checks as zero', () => {
  const summary = summarizeResults([
    {
      id: 'kdd-task_a',
      pass: true,
      checks: [{
        ok: true,
        detail: { kind: 'column_match', score: 1, recall: 1 },
      }],
    },
    {
      id: 'kdd-task_b',
      pass: false,
      checks: [],
      error: 'timeout',
    },
  ]);

  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.columnChecks.total, 2);
  assert.equal(summary.columnChecks.syntheticZero, 1);
  assert.equal(summary.columnChecks.avgScore, 0.5);
  assert.equal(summary.columnChecks.avgRecall, 0.5);
});

test('scoreKddColumns accepts a trailing percent sign as display formatting', () => {
  const result = scoreKddColumns([['52.17%']], [[52.17391304347826]], {
    extraColLambda: 0.3,
    caseSensitive: true,
    roundDecimals: 2,
  });

  assert.equal(result.recall, 1);
  assert.deepEqual(result.matchedCols, [[0, 0]]);
});

test('hasSql recognizes SQL carried in tool trace metadata', () => {
  const appAssert = makeAssert();
  appAssert.hasSql([
    {
      type: 'tool',
      content: 'sql_scan_operator {"question":"统计订单"}',
      metadata: {
        trace_output: '已查询并存入中间表 r_1\nSQL:\nSELECT COUNT(*) AS n FROM orders',
      },
    },
  ], '产出 SQL');

  assert.equal(appAssert._checks[0].ok, true);
});

test('stream driver keeps tool result preview for SQL assertions', () => {
  const src = readFileSync(path.join(process.cwd(), 'eval/lib/driver.mjs'), 'utf8');
  assert.match(src, /const result = payload\.result_preview == null \? '' : String\(payload\.result_preview\)/);
  assert.match(src, /trace_output: result/);
  assert.match(src, /\[name, args, result\]\.filter\(Boolean\)\.join\(' '\)/);
});

test('buildKddQuestion appends strict final table instruction by default', () => {
  const question = buildKddQuestion('What is the answer?');
  assert.ok(question.startsWith('What is the answer?'));
  assert.ok(question.includes(KDD_TABLE_ANSWER_INSTRUCTION));
  assert.ok(!question.includes('KDD 评测规则'));
  assert.ok(question.includes('最终答案必须使用 Markdown 表格展示'));
  assert.ok(question.includes('不要附加解释列'));
  assert.ok(question.includes('最后一条回复必须直接给出最终 Markdown 表格'));
});

test('buildKddQuestion can keep the raw question for reproduction', () => {
  assert.equal(buildKddQuestion('Raw question', { requireAnswerTable: false }), 'Raw question');
});
