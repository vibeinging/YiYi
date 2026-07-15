// Skill Library / Project Binding:覆盖 App 级定义、默认开关、项目覆盖与 hard-off 语义。
export default {
  id: 'skill-library-binding',
  desc: 'App Skill Library 与项目 Skill Binding 契约',
  async run({ driver, assert }) {
    await driver.login();
    const pid = await driver.ensureProjectRecord('skill-library-binding-eval');
    const api = driver.raw.api;

    const skillName = `eval_skill_binding_${Date.now()}`;

    try {
      const availableTools = await api('GET', '/api/agent/skills/available-tools');
      assert.status(availableTools, 200, '可读取 App Agent 工具目录');
      const toolNames = (availableTools.json?.data || []).map((tool) => tool.name);
      for (const name of [
        'skill_list',
        'skill_create',
        'skill_update',
        'skill_toggle',
        'skill_delete',
        'project_skill_list',
        'project_skill_enable',
        'project_skill_disable',
      ]) {
        assert.ok(toolNames.includes(name), `工具目录包含 ${name}`);
      }

      const invalidName = await api('POST', '/api/agent/skills', {
        name: 'bad/skill',
        description: 'eval invalid name',
        instructions: 'should fail',
      });
      assert.status(invalidName, 400, 'Skill 名称不能包含路径字符');

      const builtinCreate = await api('POST', '/api/agent/skills', {
        name: 'smart_query',
        description: 'eval duplicate builtin',
        instructions: 'should fail',
      });
      assert.status(builtinCreate, 400, '不能创建与内置 Skill 同名的自定义 Skill');

      const missingInstructions = await api('POST', '/api/agent/skills', {
        name: `eval_skill_missing_${Date.now()}`,
        description: 'eval missing instructions',
      });
      assert.status(missingInstructions, 400, '创建 Skill 时 instructions 不能为空');

      const created = await api('POST', '/api/agent/skills', {
        name: skillName,
        description: 'eval: App Skill Library binding coverage',
        category: 'eval',
        tags: ['eval', 'binding'],
        allowed_tools: ['read', 'ls', 'project_list'],
        runtime: 'prompt',
        side_effect: 'read',
        requires_project: true,
        default_enabled: false,
        is_active: true,
        instructions: 'Eval skill instructions v1. Only read/list/project_list tools are allowed.',
      });
      assert.status(created, 200, '可创建 App 级 Skill 定义');
      assert.eq(created.json?.data?.name, skillName, '创建返回 Skill 名称正确');
      assert.eq(created.json?.data?.default_enabled, false, '创建时可设置 App 默认禁用');
      assert.eq(created.json?.data?.requires_project, true, '创建时可设置 requires_project');
      assert.ok(created.json?.data?.allowed_tools?.includes('project_list'), '创建结果保留产品工具白名单');

      const duplicate = await api('POST', '/api/agent/skills', {
        name: skillName,
        description: 'eval duplicate',
        instructions: 'duplicate',
      });
      assert.status(duplicate, 409, '重复创建同名 App Skill 返回 409');

      const appDetail = await api('GET', `/api/agent/skills/${encodeURIComponent(skillName)}`);
      assert.status(appDetail, 200, '可读取 App Skill 详情');
      assert.eq(appDetail.json?.data?.name, skillName, 'App Skill 详情名称正确');
      assert.eq(appDetail.json?.data?.is_enabled, false, 'default_enabled=false 时 App 详情显示未启用');

      const enabledApp = await api('GET', '/api/agent/skills/enabled/list');
      assert.status(enabledApp, 200, '可读取 App enabled skills');
      assert.ok(
        !(enabledApp.json?.data || []).some((skill) => skill.name === skillName),
        'requires_project 或 default disabled 的 Skill 不进入纯聊天 enabled 列表',
      );

      const projectListInitial = await api('GET', `/api/projects/${pid}/skills`);
      assert.status(projectListInitial, 200, '可读取项目 effective Skill 列表');
      const initialSkill = (projectListInitial.json?.data || []).find((skill) => skill.name === skillName);
      assert.ok(!!initialSkill, '项目列表包含 App Skill 定义');
      assert.eq(initialSkill?.enabled_override, null, '项目初始继承 App 默认状态');
      assert.eq(initialSkill?.is_enabled, false, 'App 默认禁用时项目 effective disabled');

      const projectEnabled = await api('PATCH', `/api/projects/${pid}/skills/${encodeURIComponent(skillName)}/binding`, {
        enabled_override: true,
      });
      assert.status(projectEnabled, 200, '项目可启用 App Skill 覆盖');
      assert.eq(projectEnabled.json?.data?.enabled_override, true, '项目启用覆盖写入 enabled_override=true');
      assert.eq(projectEnabled.json?.data?.is_enabled, true, '项目启用覆盖后 effective enabled');

      const hardOff = await api('PATCH', `/api/agent/skills/${encodeURIComponent(skillName)}/toggle`, {
        is_active: false,
      });
      assert.status(hardOff, 200, '可关闭 App Skill hard-off');
      assert.eq(hardOff.json?.data?.is_active, false, 'App hard-off 返回 is_active=false');

      const projectAfterHardOff = await api('GET', `/api/projects/${pid}/skills/${encodeURIComponent(skillName)}`);
      assert.status(projectAfterHardOff, 200, 'hard-off 后仍可读取项目 Skill');
      assert.eq(projectAfterHardOff.json?.data?.enabled_override, true, 'hard-off 不清除项目覆盖');
      assert.eq(projectAfterHardOff.json?.data?.is_enabled, false, 'App hard-off 阻止项目启用覆盖');
      assert.eq(projectAfterHardOff.json?.data?.availability, 'blocked', 'hard-off 后 availability=blocked');

      const hardOn = await api('PATCH', `/api/agent/skills/${encodeURIComponent(skillName)}/toggle`, {
        is_active: true,
        default_enabled: false,
      });
      assert.status(hardOn, 200, '可重新打开 App Skill hard-off');
      assert.eq(hardOn.json?.data?.is_active, true, 'App hard-on 返回 is_active=true');

      const projectAfterHardOn = await api('GET', `/api/projects/${pid}/skills/${encodeURIComponent(skillName)}`);
      assert.status(projectAfterHardOn, 200, 'hard-on 后可读取项目 Skill');
      assert.eq(projectAfterHardOn.json?.data?.is_enabled, true, 'hard-on 后项目 true 覆盖重新生效');

      const resetBindingByPatch = await api('PATCH', `/api/projects/${pid}/skills/${encodeURIComponent(skillName)}/binding`, {
        enabled_override: null,
      });
      assert.status(resetBindingByPatch, 200, '项目可通过 null 恢复继承');
      assert.eq(resetBindingByPatch.json?.data?.enabled_override, null, 'null 覆盖返回继承状态');
      assert.eq(resetBindingByPatch.json?.data?.is_enabled, false, '恢复继承后跟随 App default_enabled=false');

      const appDefaultOn = await api('PATCH', `/api/agent/skills/${encodeURIComponent(skillName)}/toggle`, {
        default_enabled: true,
      });
      assert.status(appDefaultOn, 200, '可打开 App 默认启用');
      assert.eq(appDefaultOn.json?.data?.default_enabled, true, 'App default_enabled=true');

      const projectAfterDefaultOn = await api('GET', `/api/projects/${pid}/skills/${encodeURIComponent(skillName)}`);
      assert.status(projectAfterDefaultOn, 200, 'App 默认打开后可读取项目 Skill');
      assert.eq(projectAfterDefaultOn.json?.data?.enabled_override, null, '项目仍保持继承');
      assert.eq(projectAfterDefaultOn.json?.data?.is_enabled, true, '继承 App default_enabled=true 后项目启用');

      const disabledByProject = await api('PATCH', `/api/projects/${pid}/skills/${encodeURIComponent(skillName)}/toggle`, {
        is_enabled: false,
      });
      assert.status(disabledByProject, 200, '兼容 toggle 路由可禁用项目 Skill');
      assert.eq(disabledByProject.json?.data?.enabled_override, false, '项目禁用写入 false 覆盖');
      assert.eq(disabledByProject.json?.data?.is_enabled, false, '项目禁用后 effective disabled');

      const resetByDelete = await api('DELETE', `/api/projects/${pid}/skills/${encodeURIComponent(skillName)}`);
      assert.status(resetByDelete, 200, '删除项目 Skill 绑定等价恢复继承');
      assert.eq(resetByDelete.json?.data?.enabled_override, null, '删除绑定后 enabled_override=null');
      assert.eq(resetByDelete.json?.data?.is_enabled, true, '删除绑定后继承 App default_enabled=true');

      const updated = await api('PUT', `/api/agent/skills/${encodeURIComponent(skillName)}`, {
        description: 'eval: updated skill description',
        instructions: 'Eval skill instructions v2. Use read/list only.',
        allowed_tools: ['read', 'ls'],
        tags: ['eval', 'updated'],
        requires_project: false,
      });
      assert.status(updated, 200, '可更新 App 自定义 Skill 定义');
      assert.eq(updated.json?.data?.description, 'eval: updated skill description', '更新后 description 生效');
      assert.ok(!updated.json?.data?.allowed_tools?.includes('project_list'), '更新后 allowed_tools 可收窄');
      assert.eq(updated.json?.data?.requires_project, false, '更新后 requires_project 可关闭');

      const builtinUpdate = await api('PUT', '/api/agent/skills/smart_query', {
        description: 'should fail',
      });
      assert.status(builtinUpdate, 400, '内置 Skill 不支持编辑定义');

      const builtinDefaultOff = await api('PATCH', '/api/agent/skills/smart_query/toggle', {
        default_enabled: false,
      });
      assert.status(builtinDefaultOff, 400, '系统内置 Skill 不能关闭 App 默认开关');

      const builtinHardOff = await api('PATCH', '/api/agent/skills/smart_query/toggle', {
        is_active: false,
      });
      assert.status(builtinHardOff, 400, '系统内置 Skill 不能关闭 App 总开关');

      const builtinProjectOff = await api('PATCH', `/api/projects/${pid}/skills/smart_query/binding`, {
        enabled_override: false,
      });
      assert.status(builtinProjectOff, 400, '系统内置 Skill 不能在项目里关闭');

      const builtinProjectDelete = await api('DELETE', `/api/projects/${pid}/skills/smart_query`);
      assert.status(builtinProjectDelete, 400, '系统内置 Skill 不能在项目里删除');

      const builtinDetail = await api('GET', '/api/agent/skills/smart_query');
      assert.status(builtinDetail, 200, '拒绝关闭后仍可读取内置 Skill');
      assert.eq(builtinDetail.json?.data?.is_enabled, true, '系统内置 Skill 始终保持启用');

      const deleted = await api('DELETE', `/api/agent/skills/${encodeURIComponent(skillName)}`);
      assert.status(deleted, 200, '可删除 App 自定义 Skill');

      const afterDelete = await api('GET', `/api/agent/skills/${encodeURIComponent(skillName)}`);
      assert.status(afterDelete, 404, '删除后 App Skill 详情返回 404');

      const projectAfterDelete = await api('GET', `/api/projects/${pid}/skills`);
      assert.status(projectAfterDelete, 200, '删除 App Skill 后项目列表仍可读取');
      assert.ok(
        !(projectAfterDelete.json?.data || []).some((skill) => skill.name === skillName),
        '删除 App Skill 后项目 effective 列表不再包含该定义',
      );
    } finally {
      await api('DELETE', `/api/agent/skills/${encodeURIComponent(skillName)}`).catch(() => {});
    }
  },
};
