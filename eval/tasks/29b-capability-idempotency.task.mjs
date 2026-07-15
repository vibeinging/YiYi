function toolNames(blocks) {
  return (blocks || []).filter((block) => block.type === 'tool').map((block) => block.metadata?.tool_name).filter(Boolean);
}

function blockText(blocks) {
  return (blocks || []).map((block) => `${block.content || ''} ${JSON.stringify(block.metadata || {})}`).join('\n');
}

export default {
  id: 'capability-idempotency',
  desc: 'Agent 写能力重复提交只执行一次，并返回第一次结果',
  async run({ driver, assert }) {
    await driver.login();
    const pid = await driver.ensureProject('capability-idempotency-origin');
    const suffix = `${Date.now()}`;
    const projectName = `幂等能力测试-${suffix}`;
    const key = `create-project-${suffix}`;
    const result = await driver.askAgent(
      pid,
      `幂等测试：严格调用 capability_invoke 两次。两次都使用 operation_id=post.projects、完全相同的 body={"name":"${projectName}"}、完全相同的 idempotency_key="${key}"。不要改用其他工具，不要省略第二次调用。最后原样说明第二次工具结果。`,
      { title: 'capability-idempotency', approval: 'auto' },
    );
    const tools = toolNames(result.blocks);
    const text = blockText(result.blocks);
    assert.ok(tools.filter((name) => name === 'capability_invoke').length >= 2, 'Agent 连续提交两次相同写能力');
    assert.ok(/idempotent_replay[^\n]*true|"idempotent_replay":true/i.test(text), '第二次调用返回幂等重放标记');

    const listed = await driver.raw.api('GET', `/api/projects?search=${encodeURIComponent(projectName)}`);
    assert.status(listed, 200, '可查询幂等测试创建结果');
    const items = listed.json?.data?.items || [];
    assert.eq(items.filter((item) => item.name === projectName).length, 1, '相同幂等键只创建一个项目');
  },
};
