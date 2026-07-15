// City format ambiguity case:迁移源项目 task_entity_ambiguity_city_format。
// 目标:真实导入 orders.city 三个“广州”候选,验证 align_value 候选召回 + 选择后记忆复用。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '../..');
const SERVER_NATIVE_SQLITE = path.join(APP_ROOT, 'server/node_modules/better-sqlite3/build/Release/better_sqlite3.node');

export default {
  id: 'agent-disambiguation-city-format-case',
  desc: '源项目广州城市值形式歧义案例:align_value 候选与记忆复用',
  async run({ driver, assert, writeFixture }) {
    await driver.login();
    const pid = await driver.ensureProject('agent-disambiguation-city-format-eval');
    const csv = [
      'id,city,amount',
      '1,广州市,320',
      '2,广州地区,410',
      '3,广州天河区,510',
      '4,深圳市,600',
      '5,深圳南山区,450',
      '6,上海市,1200',
      '7,北京市,980',
    ].join('\n');
    const filePath = writeFixture('orders.csv', csv);
    const imported = await driver.importTable(pid, filePath, { dsName: `city-format-${Date.now()}` });
    const table = imported.table || imported.tables?.[0] || 'orders';
    assert.ok(imported.tables.includes(table), 'orders CSV 成功导入为可问数表');

    const result = runCityCase({
      pid,
      table,
      column: 'city',
      keyword: '广州',
      chosen: '广州地区',
    });

    assert.ok(result.before.success, '第一次 align_value 执行成功');
    const beforeValues = (result.before.data?.values || []).map((item) => item.value);
    for (const value of ['广州市', '广州地区', '广州天河区']) {
      assert.ok(beforeValues.includes(value), `第一次 align_value 召回候选 ${value}`);
    }
    assert.eq(Number(result.sumAmount), 410, '选择「广州地区」对应订单金额 410');

    assert.ok(result.after.success, '写入记忆后再次 align_value 执行成功');
    const afterValues = result.after.data?.values || [];
    assert.eq(afterValues[0]?.value, '广州地区', '记忆候选在第二次 align_value 中排在首位');
    assert.eq(afterValues[0]?.source, 'memory', '第二次 align_value 返回 memory 来源候选');
    assert.ok(result.after.data?._require_user_confirm === true, '存在记忆时仍要求用户确认,避免记忆遮蔽其他候选');
    const afterLabels = afterValues.map((item) => item.value);
    for (const value of ['广州市', '广州地区', '广州天河区']) {
      assert.ok(afterLabels.includes(value), `第二次 align_value 仍保留库存候选 ${value}`);
    }
  },
};

function nativeArch(filePath) {
  if (!existsSync(filePath)) return '';
  try {
    const out = execFileSync('file', [filePath], { encoding: 'utf8' });
    if (out.includes('arm64')) return 'arm64';
    if (out.includes('x86_64')) return 'x64';
  } catch {
    // ignore
  }
  return '';
}

function nodeArch(nodePath) {
  try {
    return execFileSync(nodePath, ['-p', 'process.arch'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function resolveServerNode() {
  const targetArch = nativeArch(SERVER_NATIVE_SQLITE);
  const candidates = [
    process.env.YIW_NODE_BIN,
    process.execPath,
    ...String(process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'node')),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ].filter((p, i, arr) => p && existsSync(p) && arr.indexOf(p) === i);
  return candidates.find((p) => !targetArch || nodeArch(p) === targetArch) || process.execPath;
}

function runCityCase(payload) {
  const script = `
    const input = JSON.parse(process.env.EVAL_PAYLOAD || '{}');
    const { query, queryOne } = await import('./server/src/db.js');
    const { BusinessDataSources } = await import('./server/src/engine/datasources/business_data_sources.js');
    const { GrepEntitiesTool } = await import('./server/src/engine/datasources/data_profiler_tool.js');
    const { DisambiguationService, normalize_keyword } = await import('./server/src/engine/semantic/disambiguation_service.js');
    const bds = new BusinessDataSources(input.pid, input.pid);
    await bds.load_sources();
    const ctx = {
      input_data: {
        project_id: input.pid,
        business_id: input.pid,
        session_id: 'eval-city-format-session',
        data_sources_info: { business_data_sources: bds },
      },
    };
    const tool = new GrepEntitiesTool();
    const before = await tool.execute(ctx, {
      table_name: input.table,
      column_name: input.column,
      keyword: input.keyword,
      limit: 10,
    });
    await query(
      \`DELETE FROM disambiguation_resolutions
        WHERE project_id=$1 AND source_table=$2 AND source_column=$3 AND normalized_keyword=$4\`,
      [input.pid, input.table, input.column, normalize_keyword(input.keyword)],
    ).catch(() => {});
    const candidates = (before.data?.values || []).map((item) => ({ value: item.value }));
    await DisambiguationService.record_resolution({ query, queryOne }, {
      project_id: input.pid,
      source_table: input.table,
      source_column: input.column,
      keyword: input.keyword,
      chosen_value: input.chosen,
      candidates,
      created_by: 'eval-user',
    });
    const after = await tool.execute(ctx, {
      table_name: input.table,
      column_name: input.column,
      keyword: input.keyword,
      limit: 10,
    });
    const ds = bds.get_database_sources()[0];
    const sumResult = await ds.query(
      \`SELECT SUM(amount) AS amount FROM "\${input.table}" WHERE city = '\${String(input.chosen).replace(/'/g, "''")}'\`,
      { project_id: input.pid },
    );
    const sumAmount = Number(sumResult.data?.[0]?.amount || 0);
    console.log('EVAL_RESULT:' + JSON.stringify({
      before: before.toDict ? before.toDict() : before,
      after: after.toDict ? after.toDict() : after,
      sumAmount,
    }));
  `;
  const child = spawnSync(resolveServerNode(), ['--input-type=module', '-e', script], {
    cwd: APP_ROOT,
    env: { ...process.env, EVAL_PAYLOAD: JSON.stringify(payload) },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
  });
  if (child.status !== 0) {
    throw new Error(`city case failed: ${child.stderr || child.stdout}`);
  }
  const line = String(child.stdout || '').split(/\r?\n/).find((item) => item.startsWith('EVAL_RESULT:'));
  if (!line) throw new Error(`city case missing result: ${child.stdout || child.stderr}`);
  return JSON.parse(line.slice('EVAL_RESULT:'.length));
}
