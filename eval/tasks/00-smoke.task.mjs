// 冒烟:用真实页面验证 app 可操作。快,不调 LLM。
export default {
  id: 'smoke',
  desc: 'UI 冒烟',
  async run({ driver, assert }) {
    const pid = await driver.ensureProjectRecord('smoke-eval');
    assert.ok(!!pid, '可创建或选择项目');

    await driver.ui.goto('/agent');
    await driver.ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15000 });
    assert.ok(await driver.ui.exists('[data-testid="agent-message-input"]'), 'app 主界面输入框可用');
    assert.eq(await driver.ui.exists('#Sidebar'), false, 'app 主界面不挂载旧侧边栏');

    for (const path of ['/projects', '/database', `/project/${pid}/settings`, '/dashboard']) {
      await driver.ui.goto(path);
      await driver.ui.waitUntil(
        `() => location.pathname === '/agent'`,
        { timeout: 15000, label: `旧入口 ${path} 回到 app 主界面` },
      );
      assert.eq(await driver.ui.exists('#Sidebar'), false, `${path} 不应显示旧侧边栏`);
      assert.eq(await driver.ui.exists('[data-testid="database-page"]'), false, `${path} 不应显示旧数据库页`);
      assert.eq(await driver.ui.exists('[data-testid="project-page"]'), false, `${path} 不应显示旧项目页`);
    }
  },
};
