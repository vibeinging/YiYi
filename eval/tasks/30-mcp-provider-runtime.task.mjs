// MCP Provider runtime:验证连接测试、创建、重新发现、列表解析,有模型时验证 agent 可调用 MCP 工具。

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
      serverInfo: { name: 'yiw-eval-mcp', version: '1.0.0' }
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
          properties: { text: { type: 'string', description: 'text to echo' } },
          required: ['text'],
          additionalProperties: false
        }
      }]
    });
    return;
  }
  if (req.method === 'tools/call') {
    const value = req.params?.arguments?.text || '';
    send(req.id, { content: [{ type: 'text', text: 'echo:' + value }] });
    return;
  }
  send(req.id, {});
});
`;
}

export default {
  id: 'mcp-provider-runtime',
  desc: 'MCP Provider 发现与 agent 工具投影',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const streamBlocks = driver.raw.streamBlocks;
    const pid = await ensureProjectByApi(api, 'mcp-provider-runtime-eval');
    assert.ok(!!pid, '可通过 API 准备 eval 项目');
    const providerName = `evalmcp${Date.now().toString(36)}`;
    const expectedToolName = `mcp_${providerName}_echo`;
    let providerId = '';
    let sid = '';

    const payload = {
      provider_name: providerName,
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', buildFakeMcpServerCode()],
      env: { YIW_EVAL_MCP: '1' },
    };

    try {
      const availableTools = await api('GET', `/api/agent/skills/available-tools`);
      assert.status(availableTools, 200, '可读取 Agent 可用工具目录');
      const toolNames = (availableTools.json?.data || []).map((tool) => tool.name);
      assert.ok(toolNames.includes('mcp_provider_create'), 'Agent 工具目录包含 App MCP Provider 创建工具');
      assert.ok(toolNames.includes('project_mcp_provider_enable'), 'Agent 工具目录包含项目 MCP Provider 绑定工具');

      const tested = await api('POST', `/api/agent/mcp_providers/test`, payload);
      assert.status(tested, 200, 'MCP Provider 连接测试接口可用');
      assert.ok(tested.json?.data?.ok === true, `MCP Provider 连接测试成功(${tested.json?.data?.error || 'ok'})`);
      assert.eq(tested.json?.data?.tool_count, 1, '连接测试发现 1 个工具');
      assert.eq(tested.json?.data?.tools?.[0]?.name, 'echo', '连接测试发现 echo 工具');

      const projectCreate = await api('POST', `/api/projects/${pid}/mcp_providers`, payload);
      assert.status(projectCreate, 400, '项目 MCP API 不再创建私有 Provider 定义');

      const created = await api('POST', `/api/agent/mcp_providers`, payload);
      assert.status(created, 200, '可创建 App 级 MCP Provider');
      providerId = created.json?.data?.id || '';
      assert.ok(!!providerId, '创建返回 provider id');
      assert.eq(created.json?.data?.provider_name, providerName, '创建返回 provider_name 正确');
      assert.ok(Array.isArray(created.json?.data?.args), '创建返回 args 已解析为数组');

      const appListed = await api('GET', `/api/agent/mcp_providers`);
      assert.status(appListed, 200, '可列出 App 级 MCP Provider');
      const appRow = (appListed.json?.data || []).find((item) => item.id === providerId);
      assert.ok(!!appRow, 'App 列表包含刚创建的 MCP Provider');

      const listed = await api('GET', `/api/projects/${pid}/mcp_providers`);
      assert.status(listed, 200, '可列出 MCP Provider');
      const row = (listed.json?.data || []).find((item) => item.id === providerId);
      assert.ok(!!row, '项目列表包含从 App 继承的 MCP Provider');
      assert.ok(Array.isArray(row?.args), '列表返回 args 为数组');
      assert.eq(row?.env?.YIW_EVAL_MCP, '1', '列表返回 env 为对象');
      assert.eq(row?.enabled_override, null, '项目默认继承 App 启用状态');
      assert.ok(row?.is_enabled === true, 'App 默认启用时项目有效启用');

      const disabled = await api('PATCH', `/api/projects/${pid}/mcp_providers/${providerName}/binding`, {
        enabled_override: false,
      });
      assert.status(disabled, 200, '项目可禁用 App MCP Provider 绑定');
      assert.ok(disabled.json?.data?.is_enabled === false, '项目禁用后 effective disabled');

      const inherited = await api('DELETE', `/api/projects/${pid}/mcp_providers/${providerName}`);
      assert.status(inherited, 200, '项目可恢复 App MCP Provider 继承');
      assert.ok(inherited.json?.data?.is_enabled === true, '恢复继承后重新启用');

      const rediscovered = await api('POST', `/api/agent/mcp_providers/${providerName}/rediscover`);
      assert.status(rediscovered, 200, '可重新发现 MCP Provider');
      assert.ok(rediscovered.json?.data?.ok === true, `重新发现成功(${rediscovered.json?.data?.error || 'ok'})`);
      assert.eq(rediscovered.json?.data?.tool_count, 1, '重新发现得到 1 个工具');
      assert.eq(rediscovered.json?.data?.tools?.[0]?.name, 'echo', '重新发现得到 echo 工具');

      const model = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
      const modelName = model?.json?.data?.model_name || '';
      if (!modelName) {
        assert.ok(true, '未配置模型,跳过 agent MCP runtime 断言');
        return;
      }

      const sess = await api('POST', `/api/projects/${pid}/sessions`, {
        title: 'mcp-provider-runtime-eval',
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      sid = sess.json?.data?.id || sess.json?.data?.session_id;
      assert.ok(!!sid, '可创建 agent 会话');

      const marker = `mcp-eval-${Date.now().toString(36)}`;
      const out = await streamBlocks(`/api/agent/projects/${pid}/sessions/${sid}/chat`, {
        approval: 'full',
        message: [
          `这是 eval。请调用 MCP 工具 ${expectedToolName},参数 text 必须是 "${marker}"。`,
          `调用后只需要回答工具返回的原文。不要自己编造结果。`,
        ].join('\n'),
      });
      const blocks = out.blocks || [];
      const text = blocks.map((b) => `${b.type || ''} ${b.title || ''} ${b.content || ''}`).join('\n');
      assert.ok(text.includes(expectedToolName), `流中出现 MCP 工具名 ${expectedToolName}`);
      assert.ok(text.includes(`echo:${marker}`), 'MCP 工具调用返回 echo 结果');
    } finally {
      if (providerId) await api('DELETE', `/api/agent/mcp_providers/${providerName}`).catch(() => {});
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
    }
  },
};

async function ensureProjectByApi(api, name) {
  const list = await api('GET', `/api/projects?search=${encodeURIComponent(name)}`);
  const items = list.json?.data?.items || list.json?.data || [];
  const existing = items.find((item) => item.name === name);
  if (existing?.id) return existing.id;

  const created = await api('POST', '/api/projects', {
    name,
    description: `eval project ${name}`,
  });
  return created.json?.data?.id || created.json?.data?.project_id || '';
}
