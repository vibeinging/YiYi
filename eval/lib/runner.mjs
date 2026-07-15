// 任务运行器 + 断言 + 报告。任务文件只用 assert.* 写期望;runner 跑流程、收结果、出报告。
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function makeAssert() {
  const checks = [];
  const blockSqlText = (block) => {
    if (!block) return '';
    const parts = [block.type, block.title];
    const content = block.content;
    if (typeof content === 'string') parts.push(content);
    else if (content != null) {
      try { parts.push(JSON.stringify(content)); } catch { parts.push(String(content)); }
    }
    const metadata = block.metadata || {};
    for (const key of ['sql', 'query_sql', 'trace_input', 'trace_output', 'traceInput', 'traceOutput']) {
      if (metadata[key] != null) parts.push(String(metadata[key]));
    }
    return parts.filter(Boolean).join(' ');
  };
  return {
    ok(cond, msg) { checks.push({ ok: !!cond, msg }); },
    eq(a, b, msg) { checks.push({ ok: a === b, msg: `${msg}(期望 ${JSON.stringify(b)},实得 ${JSON.stringify(a)})` }); },
    status(resp, expected, msg) { checks.push({ ok: resp?.status === expected, msg: `${msg}(期望 ${expected},实得 ${resp?.status})` }); },
    contains(blocks, sub, msg) {
      const text = (blocks || []).map((b) => b.content).join(' ');
      checks.push({ ok: text.includes(sub), msg: `${msg}(含 "${sub}")` });
    },
    hasSql(blocks, msg) {
      const ok = (blocks || []).some((b) => /\bSELECT\b/i.test(blockSqlText(b)) || /sql/i.test(b?.type || ''));
      checks.push({ ok, msg });
    },
    blockType(blocks, type, msg) {
      const ok = (blocks || []).some((b) => new RegExp(type, 'i').test(b.type || ''));
      checks.push({ ok, msg });
    },

    /**
     * column_match 断言(KDD Cup official scorer)。
     * predictedColumns / goldColumns: 每列一个值数组 [[v1,v2,...], [v1,v2,...]]
     * score = recall - λ·(extra_cols/pred_cols),recall = matched_gold/total_gold。
     * task pass 默认按 recall,官方 leaderboard 分看连续 score。
     */
    columnsMatch(predictedColumns, goldColumns, msg, opts = {}) {
      const {
        extraColLambda = 0.3,
        caseSensitive = true,
        roundDecimals = 2,
        passMetric = 'recall',
        passThreshold = 1.0,
      } = opts;
      const result = scoreKddColumns(predictedColumns || [], goldColumns || [], { extraColLambda, caseSensitive, roundDecimals });
      const metricValue = Number(result[passMetric] ?? result.score ?? 0);
      const ok = metricValue >= passThreshold;
      const detail = result.unmatchedGold.length
        ? `未匹配 gold 列 ${JSON.stringify(result.goldSample)} vs 最接近 pred ${JSON.stringify(result.predSample)}`
        : '';
      checks.push({
        ok,
        msg: `${msg}(score=${result.score} recall=${result.recall} penalty=${result.extraColPenalty} ${passMetric}>=${passThreshold}${detail ? ' | ' + detail : ''})`,
        detail: { kind: 'column_match', passMetric, passThreshold, ...result },
      });
    },

    _checks: checks,
  };
}

// ── KDD official scorer(复刻官方 column signature + recall/lambda 公式)──
function kddNormalize(v, caseSensitive, roundDecimals) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && (Number.isNaN(v) || !Number.isFinite(v))) return '';
  const s = String(v).trim();
  if (s === '' || /^(null|none|nan|nat|<na>)$/i.test(s)) return '';

  const rounded = roundDecimalStringHalfUp(s, roundDecimals);
  if (rounded !== null) return rounded;

  const percentNumber = normalizeTrailingPercentNumber(s, roundDecimals);
  if (percentNumber !== null) return percentNumber;

  const normalizedDateTime = normalizeDateTime(s);
  if (normalizedDateTime !== null) return normalizedDateTime;

  return caseSensitive ? s : s.toLowerCase();
}

function normalizeTrailingPercentNumber(raw, decimals) {
  const m = String(raw).trim().match(/^(.+?)\s*[％%]$/);
  if (!m) return null;
  return roundDecimalStringHalfUp(m[1].trim(), decimals);
}

function roundDecimalStringHalfUp(raw, decimals) {
  const s = String(raw).trim();
  const m = s.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!m) return null;

  const sign = m[1] === '-' ? '-' : '';
  const intPartRaw = m[2] || '0';
  const fracPartRaw = m[3] ?? m[4] ?? '';
  const exp = Number(m[5] || 0);
  let digits = intPartRaw + fracPartRaw;
  let decimalPos = intPartRaw.length + exp;

  if (decimalPos <= 0) {
    digits = '0'.repeat(-decimalPos) + digits;
    decimalPos = 0;
  } else if (decimalPos >= digits.length) {
    digits = digits + '0'.repeat(decimalPos - digits.length);
  }

  const whole = decimalPos > 0 ? digits.slice(0, decimalPos) : '0';
  const frac = decimalPos < digits.length ? digits.slice(decimalPos) : '';
  const keep = frac.slice(0, decimals).padEnd(decimals, '0');
  const next = frac[decimals] || '0';
  let scaled = BigInt((whole.replace(/^0+(?=\d)/, '') || '0') + keep);
  if (next >= '5') scaled += 1n;

  if (decimals === 0) {
    const out = scaled.toString();
    return sign && out !== '0' ? `-${out}` : out;
  }

  const scaledText = scaled.toString().padStart(decimals + 1, '0');
  const outWhole = scaledText.slice(0, -decimals).replace(/^0+(?=\d)/, '') || '0';
  const outFrac = scaledText.slice(-decimals);
  const isZero = /^0+$/.test(outWhole) && /^0+$/.test(outFrac);
  return sign && !isZero ? `-${outWhole}.${outFrac}` : `${outWhole}.${outFrac}`;
}

function normalizeDateTime(s) {
  const dateOnly = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2].padStart(2, '0')}-${dateOnly[3].padStart(2, '0')}`;

  const dateTime = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})([T\s].*)$/);
  if (!dateTime) return null;
  const padded = `${dateTime[1]}-${dateTime[2].padStart(2, '0')}-${dateTime[3].padStart(2, '0')}${dateTime[4]}`;
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(padded)) return padded;

  const d = new Date(padded);
  if (Number.isNaN(d.getTime())) return padded;
  return d.toISOString().replace('.000Z', 'Z');
}

function columnSignature(column, caseSensitive, roundDecimals) {
  const sig = {};
  for (const v of column) {
    const nv = kddNormalize(v, caseSensitive, roundDecimals);
    sig[nv] = (sig[nv] || 0) + 1;
  }
  return sig;
}

function signaturesEqual(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export function scoreKddColumns(predCols, goldCols, { extraColLambda = 0.3, caseSensitive = true, roundDecimals = 2 } = {}) {
  if (!goldCols.length) {
    return {
      score: 1.0,
      recall: 1.0,
      extraColPenalty: 0.0,
      matchedCols: [],
      unmatchedGold: [],
      goldSample: {},
      predSample: {},
    };
  }
  if (!predCols.length) {
    const goldSample = {};
    goldCols.forEach((c, i) => goldSample[i] = c.slice(0, 5).map(v => kddNormalize(v, caseSensitive, roundDecimals)));
    return {
      score: 0.0,
      recall: 0.0,
      extraColPenalty: 0.0,
      matchedCols: [],
      unmatchedGold: goldCols.map((_, i) => i),
      goldSample,
      predSample: {},
    };
  }
  const goldSigs = goldCols.map(c => columnSignature(c, caseSensitive, roundDecimals));
  const predSigs = predCols.map(c => columnSignature(c, caseSensitive, roundDecimals));
  const usedPred = new Set();
  const matched = [];
  const unmatchedGold = [];
  const goldSample = {};
  const predSample = {};
  for (let gi = 0; gi < goldSigs.length; gi++) {
    let hit = -1;
    for (let pi = 0; pi < predSigs.length; pi++) {
      if (usedPred.has(pi)) continue;
      if (signaturesEqual(predSigs[pi], goldSigs[gi])) { hit = pi; break; }
    }
    if (hit >= 0) { matched.push([gi, hit]); usedPred.add(hit); }
    else {
      unmatchedGold.push(gi);
      goldSample[gi] = goldCols[gi].slice(0, 5).map(v => kddNormalize(v, caseSensitive, roundDecimals));
      // 找重合最多的 pred 列
      let bestPi = -1, bestCommon = 0;
      for (let pi = 0; pi < predSigs.length; pi++) {
        let common = 0;
        for (const [k, cnt] of Object.entries(goldSigs[gi])) common += Math.min(cnt, predSigs[pi][k] || 0);
        if (common > bestCommon) { bestCommon = common; bestPi = pi; }
      }
      if (bestPi >= 0) predSample[gi] = predCols[bestPi].slice(0, 5).map(v => kddNormalize(v, caseSensitive, roundDecimals));
    }
  }
  const recall = matched.length / goldCols.length;
  const extraPred = predCols.length - matched.length;
  const penalty = predCols.length > 0 ? extraColLambda * (extraPred / predCols.length) : 0;
  const score = Math.max(0, Math.min(1, recall - penalty));
  return {
    score: Math.round(score * 10000) / 10000,
    recall: Math.round(recall * 10000) / 10000,
    extraColPenalty: Math.round(penalty * 10000) / 10000,
    matchedCols: matched,
    unmatchedGold,
    goldSample,
    predSample,
  };
}

let _fxSeq = 0;
export function writeFixture(name, content) {
  const p = path.join(tmpdir(), `yiw-eval-${++_fxSeq}-${name}`);
  writeFileSync(p, content);
  return p;
}

/**
 * 读 KDD gold.csv → 转置成列向量(每列一个值数组)。
 * 对齐 Python pandas.read_csv 默认行为:第一行当表头(丢弃),后续行为数据,按列转置。
 * 跳过 AppleDouble ._* 和空行。
 */
export function loadGold(csvPath) {
  const text = readFileSync(csvPath, 'utf-8');
  const lines = text.trim().split(/\r?\n/).filter(l => l && !l.startsWith('._'));
  if (lines.length < 2) return []; // 只有表头或空 → 无数据列
  // CSV parse(简单版,处理引号)
  const parseLine = (line) => {
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  // 第一行 = 表头(丢弃,对齐 pandas 默认);后续行 = 数据
  const dataRows = lines.slice(1).map(parseLine);
  const ncol = Math.max(...dataRows.map(r => r.length));
  const cols = [];
  for (let c = 0; c < ncol; c++) cols.push(dataRows.map(r => r[c]));
  return cols;
}

export async function runTasks(driver, tasks, { filter, onResult, concurrency = 1, shardIndex = 0, shardCount = 1 } = {}) {
  const filtered = tasks.filter((task) => !filter || task.id.includes(filter));
  const safeShardCount = Math.max(1, Number(shardCount) || 1);
  const safeShardIndex = Math.max(0, Number(shardIndex) || 0);
  const selected = filtered.filter((_, index) => index % safeShardCount === safeShardIndex);
  const results = new Array(selected.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, selected.length || 1));

  async function runNext() {
    while (nextIndex < selected.length) {
      const index = nextIndex++;
      const task = selected[index];
    const assert = makeAssert();
    const started = Date.now();
    let error = null;
    let metadata = {};
    const record = (value) => {
      if (!value || typeof value !== 'object') return;
      metadata = { ...metadata, ...value };
    };
    try {
      await task.run({ driver, assert, writeFixture, loadGold, record });
    } catch (e) {
      error = e?.message || String(e);
    }
    const checks = assert._checks;
    const failed = checks.filter((c) => !c.ok).length;
    const result = { id: task.id, desc: task.desc, ms: Date.now() - started, checks, error, pass: !error && failed === 0, metadata };
      results[index] = result;
      await onResult?.(result, results.filter(Boolean));
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}

export function report(results) {
  console.log('\n══════ Eval 报告(CDP · 真 app · 零 HTTP)══════');
  let pass = 0;
  for (const r of results) {
    if (r.pass) pass++;
    console.log(`${r.pass ? '✓' : '✗'} ${r.id}  (${(r.ms / 1000).toFixed(1)}s)${r.desc ? ' — ' + r.desc : ''}`);
    if (r.error) console.log(`    ⚠ 异常: ${r.error}`);
    for (const c of r.checks) console.log(`    ${c.ok ? '·' : '✗ FAIL'} ${c.msg}`);
  }

  const summary = summarizeResults(results);
  if (summary.columnChecks.total) {
    console.log('\n列匹配汇总:');
    console.log(`  官方平均 score: ${summary.columnChecks.avgScore.toFixed(4)}`);
    console.log(`  平均 recall: ${summary.columnChecks.avgRecall.toFixed(4)}`);
    console.log(`  gold 覆盖率(recall=1): ${summary.columnChecks.goldCovered}/${summary.columnChecks.total} (${summary.columnChecks.goldCoverageRate.toFixed(2)}%)`);
    console.log(`  满分率(score=1): ${summary.columnChecks.perfect}/${summary.columnChecks.total} (${summary.columnChecks.perfectRate.toFixed(2)}%)`);
    if (summary.columnChecks.syntheticZero) console.log(`  未进入列判分的 KDD 任务按 0 计入: ${summary.columnChecks.syntheticZero}`);
  }

  console.log(`\n结果:${pass}/${results.length} 任务通过\n`);
  return pass === results.length;
}

export function summarizeResults(results) {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
  const columnChecks = collectColumnChecks(results);
  const n = columnChecks.length;
  const avgScore = n ? columnChecks.reduce((s, c) => s + Number(c.detail.score || 0), 0) / n : 0;
  const avgRecall = n ? columnChecks.reduce((s, c) => s + Number(c.detail.recall || 0), 0) / n : 0;
  const goldCovered = columnChecks.filter((c) => Number(c.detail.recall || 0) >= 1).length;
  const perfect = columnChecks.filter((c) => Number(c.detail.score || 0) >= 1).length;
  const syntheticZero = columnChecks.filter((c) => c.detail.syntheticZero).length;
  return {
    total,
    passed,
    failed,
    passRate: total ? passed / total : 0,
    columnChecks: {
      total: n,
      avgScore,
      avgRecall,
      goldCovered,
      goldCoverageRate: n ? goldCovered / n * 100 : 0,
      perfect,
      perfectRate: n ? perfect / n * 100 : 0,
      syntheticZero,
    },
  };
}

function collectColumnChecks(results) {
  const columnChecks = [];
  for (const r of results) {
    const matches = (r.checks || []).filter((c) => c.detail?.kind === 'column_match');
    if (matches.length) {
      columnChecks.push(...matches);
    } else if (/^kdd-/.test(r.id)) {
      columnChecks.push({
        ok: false,
        detail: {
          kind: 'column_match',
          score: 0,
          recall: 0,
          extraColPenalty: 0,
          syntheticZero: true,
        },
      });
    }
  }
  return columnChecks;
}
