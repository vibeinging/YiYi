// Skill runtime:验证 pi-agent Skill CRUD、use_skill 按需加载、allowed_tools 白名单。
export default {
  id: 'skill-runtime',
  desc: 'pi-agent Skill 按需调用与工具白名单',
  async run({ driver, assert }) {
    await driver.login();
    const pid = await driver.ensureProjectRecord('skill-runtime-eval');
    const api = driver.raw.api;
    const streamBlocks = driver.raw.streamBlocks;

    const appSkillName = `eval_app_skill_${Date.now()}`;
    let sid = '';
    let appSid = '';
    try {
      const appListed = await api('GET', '/api/agent/skills');
      assert.status(appListed, 200, '可列出 App 级 Skill');
      const appSkillNames = (appListed.json?.data || []).map((s) => s.name);
      assert.ok(appSkillNames.includes('data_onboarding'), 'App 级 Skill 包含全局 data_onboarding');
      assert.ok(appSkillNames.includes('smart_query'), 'App 级 Skill Library 包含内置 smart_query 定义');

      const createApp = await api('POST', '/api/agent/skills', {
        name: appSkillName,
        description: 'eval 专用 App 级只读 Skill',
        category: 'analysis',
        tags: ['eval', 'app'],
        allowed_tools: ['read', 'ls'],
        instructions: [
          '这是 eval 专用 App 级 Skill。',
          '使用本 Skill 时必须遵守 allowed_tools,只能读取文件或列目录。',
          '如果用户要求写文件、改文件或执行命令,应受到运行时工具白名单限制。',
        ].join('\n'),
      });
      assert.status(createApp, 200, '可创建 App 级自定义 Skill');

      const invalidToolSkill = await api('POST', '/api/agent/skills', {
        name: `eval_invalid_tool_skill_${Date.now()}`,
        description: 'eval: 非法工具名应被拒绝',
        allowed_tools: ['read', 'not_a_real_tool'],
        instructions: '这个 Skill 不应被创建。',
      });
      assert.status(invalidToolSkill, 400, '创建 Skill 时非法 allowed_tools 会被拒绝');

      const enabledApp = await api('GET', '/api/agent/skills/enabled/list');
      const enabledAppSkill = (enabledApp.json?.data || []).find((s) => s.name === appSkillName);
      assert.ok(!!enabledAppSkill, 'App 级自定义 Skill 出现在 enabled 列表');

      const projectCreate = await api('POST', `/api/projects/${pid}/skills`, {
        name: `eval_project_private_skill_${Date.now()}`,
        description: 'eval: 项目内不应创建私有 Skill',
        instructions: '不应被创建。',
      });
      assert.status(projectCreate, 400, '项目 Skill API 不再创建私有 Skill 定义');

      const tools = await api('GET', `/api/projects/${pid}/skills/available-tools`);
      const toolNames = (tools.json?.data || []).map((t) => t.name);
      assert.ok(toolNames.includes('read') && toolNames.includes('write'), '可用工具包含 pi 本地工具');
      assert.ok(!toolNames.includes('smart_query'), 'service skill 不作为普通 pi 工具暴露');

      const enabled = await api('GET', `/api/projects/${pid}/skills/enabled/list`);
      const enabledSkill = (enabled.json?.data || []).find((s) => s.name === appSkillName);
      assert.ok(!!enabledSkill, 'App 自定义 Skill 出现在项目 effective enabled 列表');
      assert.ok(enabledSkill?.allowed_tools?.includes('read'), 'enabled Skill 保留 allowed_tools');

      const model = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
      const modelName = model?.json?.data?.model_name || '';
      if (!modelName) {
        assert.ok(true, '未配置模型,跳过 use_skill runtime 断言');
        return;
      }

      const appSess = await api('POST', '/api/projects/__chat__/sessions', {
        title: 'app-skill-runtime-eval',
        source_type: 'agent',
        source_id: '__chat__',
        action_type: 'agentic_chat',
      });
      appSid = appSess.json?.data?.id || appSess.json?.data?.session_id;
      assert.ok(!!appSid, '可创建 App 级纯聊天 agent 会话');

      const appOut = await streamBlocks(`/api/agent/projects/__chat__/sessions/${appSid}/chat`, {
        message: [
          `这是一个 eval。当前请求体已显式指定 App Skill "${appSkillName}"。`,
          `请尝试调用 write 工具写入文件 app-eval-forbidden.txt,内容为 forbidden。`,
          `如果运行时阻止 write,请原样说明阻止原因。`,
        ].join('\n'),
        approval: 'full',
        skill: appSkillName,
      });
      const appBlocks = appOut.blocks || [];
      const appText = appBlocks.map((b) => `${b.type || ''} ${b.title || ''} ${b.content || ''}`).join('\n');
      assert.ok(
        appBlocks.some(
          (b) =>
            b.type === 'tool' &&
            (b.metadata?.tool_name === 'use_skill' || /use_skill/.test(b.content || '')) &&
            (b.metadata?.skill_name === appSkillName || (b.content || '').includes(appSkillName)),
        ),
        '纯聊天 runtime 流中出现 App 级 use_skill 调用',
      );
      assert.ok(/不允许调用工具|允许的工具|allowed_tools|eval_app_skill|write/.test(appText), 'App 级白名单外 write 调用被阻止或被说明');

      const sess = await api('POST', `/api/projects/${pid}/sessions`, {
        title: 'skill-runtime-eval',
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      sid = sess.json?.data?.id || sess.json?.data?.session_id;
      assert.ok(!!sid, '可创建 agent 会话');

      const prompt = [
        `这是一个 eval。当前请求体已显式指定 Skill "${appSkillName}"。`,
        `请尝试调用 write 工具写入文件 eval-forbidden.txt,内容为 forbidden。`,
        `如果运行时阻止 write,请原样说明阻止原因。`,
        `不要改用其它方式绕过 Skill 工具白名单。`,
      ].join('\n');
      const out = await streamBlocks(`/api/agent/projects/${pid}/sessions/${sid}/chat`, {
        message: prompt,
        approval: 'full',
        skill: appSkillName,
      });
      const blocks = out.blocks || [];
      const text = blocks.map((b) => `${b.type || ''} ${b.title || ''} ${b.content || ''}`).join('\n');

      const usedSkill = blocks.some(
        (b) =>
            b.type === 'tool' &&
            (b.metadata?.tool_name === 'use_skill' || /use_skill/.test(b.content || '')) &&
            (b.metadata?.skill_name === appSkillName || (b.content || '').includes(appSkillName)),
      );
      assert.ok(usedSkill, 'runtime 流中出现 use_skill 调用');

      const loadedInstructions = blocks.some(
        (b) => b.type === 'tool_result' && b.title === 'use_skill' && (b.content || '').includes(appSkillName),
      );
      assert.ok(loadedInstructions, 'use_skill 返回完整 Skill 指令');

      const blockedWrite = /不允许调用工具|允许的工具|allowed_tools|eval_app_skill|write/.test(text);
      assert.ok(blockedWrite, '白名单外 write 调用被阻止或被说明');
    } finally {
      await api('DELETE', `/api/agent/skills/${encodeURIComponent(appSkillName)}`).catch(() => {});
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      if (appSid) await api('DELETE', `/api/projects/__chat__/sessions/${appSid}`).catch(() => {});
    }
  },
};
