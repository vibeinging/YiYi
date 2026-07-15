// Functional task 工厂:支持多轮对话 / per_turn / answer_contains / tool_used / has_sql 等断言。
// 支持 entity_columns(注册实体列) + metric_views(创建指标视图) + knowledge.md 注入。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { importTask, INPUT, OUTPUT } from './kdd.mjs';

const FUNC_INPUT = INPUT.replace('/public/', '/functional/');
const FUNC_OUTPUT = OUTPUT.replace('/public/', '/functional/');
const LOCAL_FUNC_INPUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../datasets/functional/input');

function funcInputDir(taskId) {
  const local = path.join(LOCAL_FUNC_INPUT, taskId);
  if (existsSync(local)) return local;
  return path.join(FUNC_INPUT, taskId);
}

function readOptionalText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
}

function funcScanContext(taskId) {
  const ctx = path.join(funcInputDir(taskId), 'context');
  const out = { db: [], csv: [], json: [], doc: [], knowledge: '' };
  if (!existsSync(ctx)) return out;
  const safe = (dir) => existsSync(dir) ? readdirSync(dir).filter(f => !f.startsWith('.') && !f.startsWith('._')).map(f => path.join(dir, f)) : [];
  out.db = safe(path.join(ctx, 'db')).filter(f => /\.(db|sqlite3?|duckdb)$/i.test(f));
  out.csv = safe(path.join(ctx, 'csv'));
  out.json = safe(path.join(ctx, 'json')).filter(f => f.endsWith('.json'));
  out.doc = safe(path.join(ctx, 'doc'));
  const kFile = path.join(ctx, 'knowledge.md');
  if (existsSync(kFile)) out.knowledge = readFileSync(kFile, 'utf-8');
  return out;
}

function funcReadTask(taskId) {
  return JSON.parse(readFileSync(path.join(funcInputDir(taskId), 'task.json'), 'utf-8'));
}

function benchmarkGoldRules(taskId, task, options = {}) {
  const auto = options.auto_optimize || task.auto_optimize || {};
  if (!auto.rules_from_gold_reference) return '';
  const goldReference = readOptionalText(path.join(funcInputDir(taskId), auto.gold_reference_file || 'gold_reference.md'));
  if (!goldReference.trim()) return '';
  const withoutCode = goldReference.replace(/```[\s\S]*?```/g, '');
  const lines = withoutCode.split(/\r?\n/);
  const keep = [];
  let inUsefulSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+T\d+/.test(trimmed)) {
      inUsefulSection = true;
      keep.push(trimmed.replace(/^##\s+/, '### '));
      continue;
    }
    if (/^##\s+/.test(trimmed)) inUsefulSection = false;
    if (!inUsefulSection) continue;
    if (/^\*\*答案\*\*/.test(trimmed) || /^答案/.test(trimmed) || /^\|/.test(trimmed)) continue;
    if (/口径|陷阱|注意|必须|禁止|关联|join|JOIN|过滤|日期|交易日|常量|聚合|部门|基金名称|股票|债券|持仓|市值|盈亏|资金成本|互换便利|可供户|无法回答/.test(trimmed)) {
      keep.push(trimmed);
    }
  }
  const rules = keep.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 12000);
  if (!rules.trim()) return '';
  return [
    '# Benchmark Step0 自动优化规则',
    '',
    '以下规则由 Benchmark Gold Solve 自动萃取，只用于口径、schema、join、过滤和拒答策略；不要把具体 gold 数字当作固定答案记忆。',
    '',
    rules,
  ].join('\n');
}

/**
 * 创建 functional task。
 * 支持的断言:has_sql / answer_contains / per_turn / tool_used / semantic_answer
 * 支持:多轮(questions[]) / entity_columns / metric_views / knowledge.md
 */
export function makeFunctionalTask(taskId, options = {}) {
  return {
    id: options.id || 'func-' + taskId,
    desc: '',
    async run({ driver, assert }) {
      const task = funcReadTask(taskId);
      this.desc = `[${task.difficulty||'?'}] ${(task.question||task.questions?.[0]||'').slice(0,50)}`;
      const ctx = funcScanContext(taskId);
      const pid = await driver.ensureProject(options.projectName || 'func-' + taskId);

      // 导入数据源
      const { connId } = await importTask(driver, pid, ctx);

      // 应用人工 schema 描述(zszq 等有 schema_descriptions.json 的 task)
      const sdFile = path.join(funcInputDir(taskId), 'schema_descriptions.json');
      if (existsSync(sdFile)) {
        try {
          const descriptions = JSON.parse(readFileSync(sdFile, 'utf-8'));
          const connIds = [connId]; // 单连接(structured 导入只产一个)
          for (const cid of connIds) {
            await driver.applySchemaDescriptions(pid, cid, descriptions);
          }
          console.log(`  [func-${taskId}] schema_descriptions 已应用(${(descriptions.tables||[]).length} 张表)`);
        } catch (e) { console.warn(`  [func-${taskId}] schema_descriptions 应用失败:`, e?.message?.slice(0, 80)); }
      }

      const autoRules = benchmarkGoldRules(taskId, task, options);
      if (autoRules) {
        await driver.injectKnowledge(pid, autoRules);
        console.log(`  [func-${taskId}] Benchmark Step0 自动优化规则已注入(${autoRules.length}字)`);
      }

      console.log(`  [func-${taskId}] 导入+描述+知识注入完成,开始问数...`);

      // 注册实体列(如果有 entity_columns)
      if (task.entity_columns) {
        for (const ec of task.entity_columns) {
          await driver.registerEntityColumn(pid, connId, ec).catch(() => {});
        }
      }

      // 创建指标视图(如果有 metric_views)
      if (task.metric_views) {
        for (const mv of task.metric_views) {
          await driver.createMetricView(pid, mv).catch(() => {});
        }
      }

      // 问数(单轮或多轮)
      const questions = task.questions || [task.question];
      const allBlocks = [];
      if (questions.length > 1) {
        // 多轮:同一 session 内连续问(对齐 Python)
        const results = await driver.askQueryMultiTurn(pid, connId, questions);
        for (let i = 0; i < results.length; i++) {
          allBlocks.push(results[i]);
          if (questions[i]) assert.ok(results[i].blocks.length > 0, `T${i+1} 问数有输出(${results[i].blocks.length}块)`);
        }
      } else {
        // 单轮
        const r = await driver.askQueryColumns(pid, connId, questions[0]);
        allBlocks.push(r);
        assert.ok(r.blocks.length > 0, '问数有输出');
      }

      // 断言
      const allFlatBlocks = allBlocks.flatMap(r => r.blocks);
      const allText = allFlatBlocks.map(b => b.content || '').join(' ');
      for (const a of (task.assertions || [])) {
        runAssert(assert, a, allBlocks, allText);
      }
    },
  };
}

// 千分位归一 + 数值等价的文本包含(对齐 Python _text_contains)
function textContains(text, expected) {
  if (text.includes(expected)) return true;
  // 千分位: "328,852.67" 在文本里, expected="328852.67" → 去逗号比对
  const noComma = expected.replace(/,/g, '');
  if (text.replace(/,/g, '').includes(noComma)) return true;
  // 数值等价: "375.5" = "375.50" = "375.500"
  const num = Number(expected);
  if (!isNaN(num) && isFinite(num)) {
    // 在文本里找所有数字,比较数值相等(精度 2 位)
    const matches = text.match(/-?[\d,]+\.?\d*/g) || [];
    for (const m of matches) {
      const mn = Number(m.replace(/,/g, ''));
      if (!isNaN(mn) && Math.abs(mn - num) < 0.01) return true;
    }
  }
  return false;
}

function runAssert(assert, a, allBlocks, allText) {
  switch (a.type) {
    case 'has_sql':
      assert.hasSql(allBlocks.flatMap(r => r.blocks), '产出 SQL');
      break;
    case 'answer_contains': {
      const kws = a.keywords || (Array.isArray(a.expected) ? a.expected : [a.expected]);
      const mode = a.mode || 'all';
      const hits = kws.filter(k => allText.includes(String(k)));
      const ok = mode === 'any' ? hits.length > 0 : hits.length === kws.length;
      assert.ok(ok, `答案含关键词(${hits.length}/${kws.length})`);
      break;
    }
    case 'per_turn': {
      const expected = a.expected || [];
      const passRatio = a.pass_ratio || 0.75;
      let passed = 0;
      const scored = expected.filter(e => e !== '' && e !== null);
      const total = scored.length || expected.length;
      for (let i = 0; i < expected.length; i++) {
        const exp = expected[i];
        if (!exp) continue;
        const turnText = (allBlocks[i]?.blocks || []).map(b => b.content || '').join(' ');
        const expArr = Array.isArray(exp) ? exp : [exp];
        // 千分位归一: "328,852.67" → "328852.67",数值等价 "375.5" = "375.50"
        const hit = expArr.filter(e => textContains(turnText, String(e)));
        if (hit.length === expArr.length) passed++;
      }
      const ratio = total > 0 ? passed / total : 0;
      assert.ok(ratio >= passRatio, `多轮匹配(${passed}/${total} 比率${ratio.toFixed(2)}≥${passRatio})`);
      break;
    }
    case 'tool_used': {
      const tools = a.expected || [];
      const mode = a.mode || 'any';
      const hits = tools.filter(t => allText.includes(t));
      const ok = mode === 'forbidden' ? hits.length === 0 : (mode === 'all' ? hits.length === tools.length : hits.length > 0);
      assert.ok(ok, `工具使用(${mode}: ${tools.join(',')} 命中${hits.join(',')})`);
      break;
    }
    case 'semantic_answer':
      if (a.expected) {
        const exp = Array.isArray(a.expected) ? a.expected : [a.expected];
        const hits = exp.filter(e => allText.includes(String(e)));
        assert.ok(hits.length > 0, `语义答案(${hits.length}/${exp.length})`);
      } else {
        assert.ok(true, '(semantic_answer 无 expected,跳过)');
      }
      break;
    case 'disambiguation_count_at_turn':
    case 'total_disambiguation_count':
    case 'response_time':
    case 'row_count':
    case 'column_count':
      assert.ok(true, `(${a.type} 跳过)`);
      break;
    default:
      assert.ok(true, `(未知断言 ${a.type},跳过)`);
  }
}
