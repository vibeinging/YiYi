// Chat product tools:验证 pi-agent 暴露给聊天的 Skill/MCP 创建工具已注册、
// 有参数 schema、进入确认治理集合。实际落库由 Skill/MCP Library API eval 覆盖。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PRODUCT_CONFIRM_TOOL_NAMES, PRODUCT_TOOL_NAMES } from '../../server/src/engine/agents/product_tool_catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_TOOLS_SOURCE = path.resolve(__dirname, '../../server/src/engine/agents/product_tools.js');

const CHAT_SKILL_TOOLS = [
  'skill_list',
  'skill_create',
  'skill_update',
  'skill_toggle',
  'skill_delete',
  'project_skill_list',
  'project_skill_enable',
  'project_skill_disable',
];

const CHAT_MCP_TOOLS = [
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
];

export default {
  id: 'chat-product-tools-skill-mcp',
  desc: '聊天产品工具注册 Skill/MCP 创建与绑定能力',
  async run({ driver, assert }) {
    await driver.login();
    const pid = await driver.ensureProjectRecord('chat-product-tools-skill-mcp-eval');
    const api = driver.raw.api;

    const available = await api('GET', `/api/projects/${pid}/skills/available-tools`);
    assert.status(available, 200, '可读取项目上下文 Agent 工具目录');
    const availableNames = (available.json?.data || []).map((tool) => tool.name);

    const appAvailable = await api('GET', '/api/agent/skills/available-tools');
    assert.status(appAvailable, 200, '可读取 App 上下文 Agent 工具目录');
    const appAvailableNames = (appAvailable.json?.data || []).map((tool) => tool.name);

    const source = readFileSync(PRODUCT_TOOLS_SOURCE, 'utf8');

    for (const name of [...CHAT_SKILL_TOOLS, ...CHAT_MCP_TOOLS]) {
      assert.ok(PRODUCT_TOOL_NAMES.has(name), `Product catalog 包含 ${name}`);
      assert.ok(availableNames.includes(name), `项目聊天工具目录包含 ${name}`);
      assert.ok(appAvailableNames.includes(name), `App 聊天工具目录包含 ${name}`);
      assert.ok(new RegExp(`${name}\\s*:`).test(source), `product_tools handler/schema 注册 ${name}`);
    }

    for (const name of [
      'skill_create',
      'skill_update',
      'skill_toggle',
      'skill_delete',
      'project_skill_enable',
      'project_skill_disable',
      'mcp_provider_create',
      'mcp_provider_update',
      'mcp_provider_toggle',
      'mcp_provider_delete',
      'mcp_provider_test',
      'mcp_provider_rediscover',
      'project_mcp_provider_enable',
      'project_mcp_provider_disable',
      'project_mcp_provider_reset',
    ]) {
      assert.ok(PRODUCT_CONFIRM_TOOL_NAMES.has(name), `写入/执行聊天工具 ${name} 进入确认治理集合`);
    }

    assert.ok(/createAppSkill/.test(source), 'skill_create handler 复用 App Skill Library 用例');
    assert.ok(/createAppMcpProvider/.test(source), 'mcp_provider_create handler 复用 App MCP Provider Library 用例');
    assert.ok(/setPiSkillEnabled/.test(source), 'project_skill_enable/disable handler 复用项目 Skill binding 用例');
    assert.ok(/updateMcpProvider/.test(source), 'project_mcp_provider_enable/disable handler 复用项目 MCP binding 用例');

    assert.ok(/skill_create:\s*Type\.Object/.test(source), 'skill_create 有参数 schema');
    assert.ok(/mcp_provider_create:\s*Type\.Object/.test(source), 'mcp_provider_create 有参数 schema');
    assert.ok(/project_skill_enable:\s*Type\.Object/.test(source), 'project_skill_enable 有参数 schema');
    assert.ok(/project_mcp_provider_enable:\s*Type\.Object/.test(source), 'project_mcp_provider_enable 有参数 schema');
  },
};
