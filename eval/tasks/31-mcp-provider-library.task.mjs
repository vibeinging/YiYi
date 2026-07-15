// MCP Provider Library / Project Binding:覆盖 App 级 Provider 定义、项目覆盖与 runtime 前置契约。

function buildFakeMcpServerCode() {
  return String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    send(req.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'yiw-eval-mcp-library', version: '1.0.0' }
    });
    return;
  }
  if (req.method === 'notifications/initialized') return;
  if (req.method === 'tools/list') {
    send(req.id, {
      tools: [{
        name: 'echo',
        description: 'Return echo:<text> for eval',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false
        }
      }]
    });
    return;
  }
  if (req.method === 'tools/call') {
    send(req.id, { content: [{ type: 'text', text: 'echo:' + (req.params?.arguments?.text || '') }] });
    return;
  }
  send(req.id, {});
});
`;
}

export default {
  id: 'mcp-provider-library',
  desc: 'App MCP Provider Library 与项目 MCP Binding 契约',
  async run({ driver, assert }) {
    await driver.login();
    const pid = await driver.ensureProjectRecord('mcp-provider-library-eval');
    const api = driver.raw.api;

    const providerName = `evalmcplib${Date.now().toString(36)}`;
    let providerId = '';

    const payload = {
      provider_name: providerName,
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', buildFakeMcpServerCode()],
      env: { YIW_EVAL_MCP_LIBRARY: '1' },
      default_enabled: false,
      is_active: true,
    };

    try {
      const tools = await api('GET', '/api/agent/skills/available-tools');
      assert.status(tools, 200, '可读取 Agent 工具目录');
      const toolNames = (tools.json?.data || []).map((tool) => tool.name);
      for (const name of [
        'mcp_provider_list',
        'mcp_provider_create',
        'mcp_provider_update',
        'mcp_provider_toggle',
        'mcp_provider_delete',
        'mcp_provider_test',
        'mcp_provider_rediscover',
        'project_mcp_provider_list',
        'project_mcp_provider_enable',
        'project_mcp_provider_disable',
        'project_mcp_provider_reset',
      ]) {
        assert.ok(toolNames.includes(name), `工具目录包含 ${name}`);
      }

      const invalidName = await api('POST', '/api/agent/mcp_providers', {
        provider_name: 'Bad/Provider',
        command: process.execPath,
      });
      assert.status(invalidName, 400, '非法 MCP Provider 名称会被拒绝');

      const invalidTransport = await api('POST', '/api/agent/mcp_providers', {
        provider_name: `evalbadtransport${Date.now().toString(36)}`,
        transport: 'sse',
        command: process.execPath,
      });
      assert.status(invalidTransport, 400, '当前不支持非 stdio MCP transport');

      const failedTest = await api('POST', '/api/agent/mcp_providers/test', {
        provider_name: `evalfail${Date.now().toString(36)}`,
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.exit(2)'],
      });
      assert.status(failedTest, 200, '连接测试失败也返回标准响应');
      assert.eq(failedTest.json?.data?.ok, false, '连接测试失败时 ok=false');

      const projectCreate = await api('POST', `/api/projects/${pid}/mcp_providers`, payload);
      assert.status(projectCreate, 400, '项目 MCP API 不再创建私有 Provider 定义');

      const created = await api('POST', '/api/agent/mcp_providers', payload);
      assert.status(created, 200, '可创建 App 级 MCP Provider');
      providerId = created.json?.data?.id || '';
      assert.ok(!!providerId, '创建返回 Provider id');
      assert.eq(created.json?.data?.provider_name, providerName, '创建返回 Provider 名称正确');
      assert.eq(created.json?.data?.default_enabled, false, '创建时可设置 App 默认禁用');
      assert.eq(created.json?.data?.is_active, true, '创建时 App 总开关默认开启');

      const duplicate = await api('POST', '/api/agent/mcp_providers', payload);
      assert.status(duplicate, 409, '重复创建同名 MCP Provider 返回 409');

      const detail = await api('GET', `/api/agent/mcp_providers/${providerName}`);
      assert.status(detail, 200, '可读取 App MCP Provider 详情');
      assert.eq(detail.json?.data?.env?.YIW_EVAL_MCP_LIBRARY, '1', '详情返回 env 对象');
      assert.ok(Array.isArray(detail.json?.data?.args), '详情返回 args 数组');

      const appList = await api('GET', '/api/agent/mcp_providers');
      assert.status(appList, 200, '可列出 App MCP Provider');
      assert.ok((appList.json?.data || []).some((provider) => provider.provider_name === providerName), 'App 列表包含新 Provider');

      const projectListInitial = await api('GET', `/api/projects/${pid}/mcp_providers`);
      assert.status(projectListInitial, 200, '可读取项目 effective MCP Provider 列表');
      const initialProvider = (projectListInitial.json?.data || []).find((provider) => provider.provider_name === providerName);
      assert.ok(!!initialProvider, '项目列表包含 App Provider 定义');
      assert.eq(initialProvider?.enabled_override, null, '项目初始继承 App 默认状态');
      assert.eq(initialProvider?.is_enabled, false, 'App 默认禁用时项目 effective disabled');

      const projectEnable = await api('PATCH', `/api/projects/${pid}/mcp_providers/${providerName}/binding`, {
        enabled_override: true,
      });
      assert.status(projectEnable, 200, '项目可启用 App MCP Provider 覆盖');
      assert.eq(projectEnable.json?.data?.enabled_override, true, '项目启用覆盖写入 true');
      assert.eq(projectEnable.json?.data?.is_enabled, true, '项目启用覆盖后 effective enabled');

      const appHardOff = await api('PATCH', `/api/agent/mcp_providers/${providerName}/toggle`, {
        is_active: false,
      });
      assert.status(appHardOff, 200, '可关闭 App MCP Provider hard-off');
      assert.eq(appHardOff.json?.data?.is_active, false, 'hard-off 返回 is_active=false');

      const projectAfterHardOff = await api('GET', `/api/projects/${pid}/mcp_providers`);
      assert.status(projectAfterHardOff, 200, 'hard-off 后项目列表仍可读取');
      const blockedProvider = (projectAfterHardOff.json?.data || []).find((provider) => provider.provider_name === providerName);
      assert.eq(blockedProvider?.enabled_override, true, 'hard-off 不清除项目覆盖');
      assert.eq(blockedProvider?.is_enabled, false, 'App hard-off 阻止项目启用覆盖');
      assert.eq(blockedProvider?.availability, 'blocked', 'hard-off 后 availability=blocked');

      const appHardOn = await api('PATCH', `/api/agent/mcp_providers/${providerName}/toggle`, {
        is_active: true,
      });
      assert.status(appHardOn, 200, '可重新打开 App MCP Provider hard-off');
      assert.eq(appHardOn.json?.data?.is_active, true, 'hard-on 返回 is_active=true');

      const projectAfterHardOn = await api('GET', `/api/projects/${pid}/mcp_providers`);
      const enabledAgain = (projectAfterHardOn.json?.data || []).find((provider) => provider.provider_name === providerName);
      assert.eq(enabledAgain?.is_enabled, true, 'hard-on 后项目 true 覆盖重新生效');

      const projectDisable = await api('PATCH', `/api/projects/${pid}/mcp_providers/${providerName}/binding`, {
        enabled_override: false,
      });
      assert.status(projectDisable, 200, '项目可禁用 App MCP Provider 覆盖');
      assert.eq(projectDisable.json?.data?.enabled_override, false, '项目禁用覆盖写入 false');
      assert.eq(projectDisable.json?.data?.is_enabled, false, '项目禁用后 effective disabled');

      const projectReset = await api('DELETE', `/api/projects/${pid}/mcp_providers/${providerName}`);
      assert.status(projectReset, 200, '删除项目 MCP binding 等价恢复继承');
      assert.eq(projectReset.json?.data?.enabled_override, null, '恢复继承后 enabled_override=null');
      assert.eq(projectReset.json?.data?.is_enabled, false, '恢复继承后跟随 App default_enabled=false');

      const appDefaultOn = await api('PATCH', `/api/agent/mcp_providers/${providerName}/toggle`, {
        default_enabled: true,
      });
      assert.status(appDefaultOn, 200, '可打开 App MCP Provider 默认启用');
      assert.eq(appDefaultOn.json?.data?.default_enabled, true, 'App default_enabled=true');

      const projectAfterDefaultOn = await api('GET', `/api/projects/${pid}/mcp_providers`);
      const inheritedOn = (projectAfterDefaultOn.json?.data || []).find((provider) => provider.provider_name === providerName);
      assert.eq(inheritedOn?.enabled_override, null, '项目仍保持继承');
      assert.eq(inheritedOn?.is_enabled, true, '继承 App default_enabled=true 后项目启用');

      const updated = await api('PUT', `/api/agent/mcp_providers/${providerName}`, {
        command: process.execPath,
        args: ['-e', buildFakeMcpServerCode()],
        env: {
          YIW_EVAL_MCP_LIBRARY: '2',
          YIW_EVAL_MCP_UPDATED: 'yes',
        },
        default_enabled: true,
      });
      assert.status(updated, 200, '可更新 App MCP Provider 定义');
      assert.eq(updated.json?.data?.env?.YIW_EVAL_MCP_LIBRARY, '2', '更新后 env 生效');
      assert.eq(updated.json?.data?.env?.YIW_EVAL_MCP_UPDATED, 'yes', '更新后新增 env 生效');

      const rediscovered = await api('POST', `/api/agent/mcp_providers/${providerName}/rediscover`);
      assert.status(rediscovered, 200, '可重新发现 App MCP Provider');
      assert.eq(rediscovered.json?.data?.ok, true, '重新发现成功');
      assert.eq(rediscovered.json?.data?.tool_count, 1, '重新发现得到 1 个工具');
      assert.eq(rediscovered.json?.data?.tools?.[0]?.name, 'echo', '重新发现得到 echo 工具');

      const unknownBinding = await api('PATCH', `/api/projects/${pid}/mcp_providers/not_existing_eval_provider/binding`, {
        enabled_override: true,
      });
      assert.status(unknownBinding, 404, '绑定不存在的 App MCP Provider 返回 404');

      const deleted = await api('DELETE', `/api/agent/mcp_providers/${providerName}`);
      assert.status(deleted, 200, '可删除 App MCP Provider');

      const afterDelete = await api('GET', `/api/agent/mcp_providers/${providerName}`);
      assert.status(afterDelete, 404, '删除后 App MCP Provider 详情返回 404');

      const projectAfterDelete = await api('GET', `/api/projects/${pid}/mcp_providers`);
      assert.status(projectAfterDelete, 200, '删除 App Provider 后项目列表仍可读取');
      assert.ok(
        !(projectAfterDelete.json?.data || []).some((provider) => provider.provider_name === providerName),
        '删除 App Provider 后项目 effective 列表不再包含该定义',
      );
      providerId = '';
    } finally {
      if (providerId) await api('DELETE', `/api/agent/mcp_providers/${providerName}`).catch(() => {});
    }
  },
};
