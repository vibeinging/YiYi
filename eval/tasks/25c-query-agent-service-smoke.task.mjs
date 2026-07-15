import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.resolve(__dirname, '../datasets/functional/input/task_多轮对话/context/db/trade_dist.sqlite');

function toolNames(blocks) {
  return (blocks || [])
    .filter((block) => block.type === 'tool')
    .map((block) => block.metadata?.tool_name)
    .filter(Boolean);
}

export default {
  id: 'query-agent-service-smoke',
  desc: '真实项目数据问题由 WorkspaceAgent 调用 query_project_data，再由 QueryAgent 返回结果',
  async run({ driver, assert }) {
    await driver.login();
    const pid = await driver.ensureProject('query-agent-service-smoke-eval');
    const imported = await driver.importDatabase(pid, DB_FILE, { name: 'query_agent_service_trade_dist' });
    assert.ok(!!imported.connId, `导入 SQLite 数据源(${imported.connId || 'none'})`);

    const [turn] = await driver.askAgentMultiTurn(
      pid,
      ['在 1997 年下单笔数最多的客户，公司名是什么？'],
      { title: 'query-agent-service-smoke' },
    );
    const tools = toolNames(turn.blocks);
    const text = (turn.blocks || []).map((block) => `${block.title || ''} ${block.content || ''}`).join('\n');
    const finalBlocks = (turn.blocks || []).filter((block) => block.metadata?.msg_category === 'final_answer');
    assert.ok(tools.includes('query_project_data'), `WorkspaceAgent 调用 query_project_data(${tools.join(',')})`);
    assert.eq(tools.some((name) => ['ls', 'read', 'grep', 'find'].includes(name)), false, '未使用本地文件工具猜项目数据');
    assert.ok(/Save-a-lot Markets/i.test(text), 'QueryAgent 返回正确客户公司名');
    assert.eq(/尚未绑定任何数据源|请先在项目设置里绑定/i.test(text), false, '未误报数据源缺失');
    assert.eq(finalBlocks.length, 1, `只输出一个 final_answer(实得 ${finalBlocks.length})`);
    assert.eq(finalBlocks[0]?.metadata?.handoff, true, '最终答案来自正式 service handoff');
    assert.eq(finalBlocks[0]?.metadata?.handoff_metadata?.sources?.[0]?.name, 'query_agent', '最终答案保留 QueryAgent 来源');

    const messagesResp = await driver.raw.api('GET', `/api/projects/${pid}/sessions/${turn.sid}/messages`);
    const messageData = messagesResp?.json?.data;
    const messages = Array.isArray(messageData) ? messageData : (messageData?.items || messageData?.messages || []);
    assert.eq(messages.filter((message) => message.role === 'assistant').length, 1, '顶层最终 assistant 只持久化一次');
  },
};
