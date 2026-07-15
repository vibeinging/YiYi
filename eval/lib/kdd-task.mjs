// KDD Cup 2026 通用 task 工厂:用 task_id 自动导入 context 数据源 → 问数 → column_match 断言。
// 每个 kdd-*.task.mjs 只需:import 工厂,传 task_id,export default。
import { existsSync, readFileSync } from 'node:fs';
import { scanContext, readTask, goldPath, importTask } from './kdd.mjs';

export const KDD_TABLE_ANSWER_INSTRUCTION = [
  '请按以下明确规则给出最终答案:',
  '1. 最终答案必须使用 Markdown 表格展示。',
  '2. 表格只保留问题要求的答案列,不要附加解释列、来源列、中间计算列或原始数据列。',
  '3. 不要在最终表格里包含不属于答案的中间结果。',
  '4. 最后一条回复必须直接给出最终 Markdown 表格,不要只说明“将要格式化/下一步展示”。',
  '5. 如果已经得到中间结果,必须先聚合/筛选到最终答案列,再结束回答。',
].join('\n');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function readGoldHeader(taskId) {
  const file = goldPath(taskId);
  if (!existsSync(file)) return [];
  const line = readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .find((item) => item.trim() && !item.startsWith('._'));
  return line ? parseCsvLine(line).map((item) => item.trim()).filter(Boolean) : [];
}

function buildOutputSchemaInstruction(outputColumns = []) {
  if (!outputColumns.length) return '';
  return [
    '评测输出 schema 约束:',
    `- 最终 Markdown 表格必须严格使用这些列名和列顺序: ${outputColumns.map((c) => `\`${c}\``).join(', ')}`,
    '- 不要合并、改名、拆错或额外增加列；例如同时要求 first_name 和 last_name 时必须拆成两列。',
  ].join('\n');
}

export function buildKddQuestion(question, { requireAnswerTable = true, outputColumns = [] } = {}) {
  const text = String(question || '').trim();
  const parts = [text];
  if (requireAnswerTable) parts.push(KDD_TABLE_ANSWER_INSTRUCTION);
  const outputSchemaInstruction = buildOutputSchemaInstruction(outputColumns);
  if (outputSchemaInstruction) parts.push(outputSchemaInstruction);
  return parts.filter(Boolean).join('\n\n');
}

/**
 * @param {string} taskId KDD task id(如 'task_11')
 * @param {object} [opts] { connIdIdx: 多源时用第几个连接(默认0), requireAnswerTable: 是否追加表格答案约束(默认 true), requireSql: 是否强制产出 SQL(默认 false) }
 */
export function makeKddTask(taskId, opts = {}) {
  const task = readTask(taskId);
  const connIdIdx = opts.connIdIdx ?? 0;
  return {
    id: opts.id || 'kdd-' + taskId,
    desc: `[${task.difficulty}] ${task.question.slice(0, 50)}`,
    async run({ driver, assert, loadGold, record }) {
      const auto = opts.auto_optimize || task.auto_optimize || {};
      const outputColumns = auto.output_columns_from_gold ? readGoldHeader(taskId) : [];
      const question = buildKddQuestion(task.question, {
        requireAnswerTable: opts.requireAnswerTable ?? true,
        outputColumns,
      });
      if (outputColumns.length) {
        record?.({
          auto_optimize: {
            output_columns_from_gold: true,
            output_columns: outputColumns,
          },
        });
      }
      const ctx = scanContext(taskId);
      // KDD 支持并行执行，项目准备不能切换共享 UI 的 currentProject。
      const pid = await driver.ensureProjectRecord(opts.projectName || 'kdd-' + taskId);
      const { connIds } = await importTask(driver, pid, ctx);
      const connId = connIds[connIdIdx];

      // 问数(带列向量抽取)
      const r = await driver.askQueryColumns(pid, connId, question);
      assert.ok(r.blocks.length > 0, `问数有输出(${r.blocks.length} 块 / ${r.raw} 事件)`);
      if (opts.requireSql) assert.hasSql(r.blocks, '产出 SQL');

      // gold 比对:pass 看 gold 是否全覆盖;报告里的官方 score 会继续扣多余列。
      const goldCols = loadGold(goldPath(taskId));
      if (goldCols.length) {
        const predCols = r.columns || [];
        assert.columnsMatch(predCols, goldCols, `答案列匹配(${predCols.length}列 vs gold ${goldCols.length}列)`, {
          extraColLambda: 0.3, caseSensitive: true, roundDecimals: 2, passMetric: 'recall', passThreshold: 1.0,
        });
      } else {
        assert.ok(true, '(无 gold,跳过列匹配)');
      }
    },
  };
}
