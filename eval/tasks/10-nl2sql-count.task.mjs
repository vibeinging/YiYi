// 深链路 NL2SQL:建项目 → 导 4 行表(后端自动绑项目)→ 问数"多少行" → 断言答 4 + 产出 SQL。
// 这是 HTTP eval 测不到的真实链路(真渲染层 + ipc + 真问数引擎 + 终态块)。调 LLM,慢。
export default {
  id: 'nl2sql-count',
  desc: '导入 4 行表 → 问"多少行" → 答 4 + 出 SQL',
  async run({ driver, assert, writeFixture }) {
    const fx = writeFixture('sales.csv', 'region,amount\nEast,100\nWest,200\nNorth,150\nSouth,250\n');
    const pid = await driver.ensureProject('nl2sql-eval');
    const { connId, table } = await driver.importTable(pid, fx);
    assert.ok(!!table, `导入建表(table=${table})`);

    const r = await driver.askQuery(pid, connId, `${table} 表里一共有多少行数据?`);
    assert.ok(r.blocks.length > 0, `问数有输出(${r.blocks.length} 块 / ${r.raw} 事件)`);
    assert.hasSql(r.blocks, '产出 SQL(SELECT)');
    assert.contains(r.blocks, '4', '答出 4 行');
  },
};
