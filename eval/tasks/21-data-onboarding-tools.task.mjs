// Skill runtime:验证数据接入和项目管理产品工具已进入 pi-agent 工具目录,并且内置 Skill 默认启用。
export default {
  id: 'data-onboarding-tools',
  desc: 'data_onboarding/project_management 内置 Skill 与产品工具目录',
  async run({ driver, assert }) {
    await driver.login();
    const pid = await driver.ensureProjectRecord('data-onboarding-tools-eval');
    const api = driver.raw.api;

    const tools = await api('GET', `/api/projects/${pid}/skills/available-tools`);
    const toolNames = (tools.json?.data || []).map((t) => t.name);
    for (const name of [
      'project_list',
      'project_create',
      'project_session_move',
      'file_classify',
      'structured_import',
      'database_file_import',
      'unstructured_import',
      'job_status',
      'query_smoke_test',
      'skill_list',
      'skill_create',
      'skill_update',
      'skill_toggle',
      'project_skill_list',
      'project_skill_enable',
      'project_skill_disable',
    ]) {
      assert.ok(toolNames.includes(name), `可用工具包含 ${name}`);
    }
    assert.ok(!toolNames.includes('smart_query'), 'service skill 不作为普通 pi 工具暴露');

    const enabled = await api('GET', `/api/projects/${pid}/skills/enabled/list`);
    const skills = enabled.json?.data || [];
    const onboarding = skills.find((s) => s.name === 'data_onboarding');
    const projectManagement = skills.find((s) => s.name === 'project_management');
    const smartQuery = skills.find((s) => s.name === 'smart_query');
    assert.ok(!!onboarding, 'data_onboarding 默认启用');
    assert.ok(!!projectManagement, 'project_management 默认启用');
    assert.eq(smartQuery?.runtime, 'service', 'smart_query 是 service runtime');
    assert.eq(onboarding.runtime, 'prompt', 'data_onboarding 是 prompt runtime');
    assert.eq(projectManagement.runtime, 'prompt', 'project_management 是 prompt runtime');
    assert.ok(projectManagement.allowed_tools?.includes('project_session_move'), 'project_management 允许迁移当前会话到问数项目');
    assert.ok(projectManagement.allowed_tools?.includes('project_create'), 'project_management 负责创建问数项目');
    assert.ok(!onboarding.allowed_tools?.includes('project_create'), 'data_onboarding 不负责创建问数项目');
    assert.ok(!onboarding.allowed_tools?.includes('project_session_move'), 'data_onboarding 不负责迁移会话');
    assert.ok(onboarding.allowed_tools?.includes('structured_import'), 'data_onboarding 允许结构化导入工具');
    assert.ok(onboarding.allowed_tools?.includes('database_file_import'), 'data_onboarding 允许数据库文件导入工具');
    assert.ok(onboarding.allowed_tools?.includes('job_status'), 'data_onboarding 允许查询任务状态');

    const skillName = `eval_product_tool_skill_${Date.now()}`;
    try {
      const created = await api('POST', '/api/agent/skills', {
        name: skillName,
        description: 'eval: 验证自定义 Skill 可以选择产品工具',
        category: 'data',
        tags: ['eval'],
        allowed_tools: ['project_list', 'file_classify', 'job_status'],
        instructions: '只使用产品工具读取项目信息和识别文件。',
      });
      assert.status(created, 200, '可创建引用产品工具的 App 自定义 Skill');
      assert.ok(created.json?.data?.allowed_tools?.includes('file_classify'), '创建结果保留产品工具白名单');

      const projectSkills = await api('GET', `/api/projects/${pid}/skills/enabled/list`);
      const effective = (projectSkills.json?.data || []).find((s) => s.name === skillName);
      assert.ok(!!effective, 'App 自定义 Skill 默认进入项目 effective enabled 列表');
    } finally {
      await api('DELETE', `/api/agent/skills/${encodeURIComponent(skillName)}`).catch(() => {});
    }
  },
};
