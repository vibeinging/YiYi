function toolNames(blocks) {
  return (blocks || [])
    .filter((block) => block.type === 'tool')
    .map((block) => block.metadata?.tool_name)
    .filter(Boolean);
}

function blockText(blocks) {
  return (blocks || [])
    .map((block) => `${block.type || ''} ${block.title || ''} ${block.content || ''}`)
    .join('\n');
}

export default {
  id: 'chat-followup-no-mode',
  desc: '同一会话的模型配置追问和问候始终由 WorkspaceAgent 处理，不依赖 mode，也不误调问数服务',
  async run({ driver, assert }) {
    await driver.login();
    const pid = await driver.ensureProject('chat-followup-no-mode-eval');
    const turns = await driver.askAgentMultiTurn(pid, [
      '查看当前 App 中已经配置的模型。请使用 App 能力查询真实配置，不要猜测，也不要使用命令行。',
      '只部署了这一个模型吗。',
      '你好',
    ], { title: 'chat-followup-no-mode' });

    assert.eq(turns.length, 3, '完成三轮真实会话');
    assert.eq(new Set(turns.map((turn) => turn.sid)).size, 1, '三轮使用同一个 session');

    const firstTools = toolNames(turns[0].blocks);
    assert.ok(firstTools.includes('capability_search'), `首轮调用 capability_search(${firstTools.join(',')})`);
    assert.ok(firstTools.includes('capability_invoke'), `首轮调用 capability_invoke(${firstTools.join(',')})`);

    for (const index of [1, 2]) {
      const tools = toolNames(turns[index].blocks);
      const text = blockText(turns[index].blocks);
      assert.eq(tools.includes('query_project_data'), false, `第 ${index + 1} 轮未误调 query_project_data`);
      assert.eq(/尚未绑定任何数据源|请先在项目设置里绑定/i.test(text), false, `第 ${index + 1} 轮未返回数据源门控错误`);
    }

    assert.ok(/一个|1 个|只有|当前.*模型/i.test(blockText(turns[1].blocks)), '第二轮能结合上文回答模型数量');
    assert.ok(/你好|您好|可以帮/i.test(blockText(turns[2].blocks)), '第三轮正常问候');
  },
};
