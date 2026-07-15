// MCP Provider 路由表。IM 远程控制走 /api/im/*。
import * as mcp from '../app/integrations/mcp.js';

export const mcpRoutes = [
  // ── App 级 MCP Provider Library ──
  { m: 'GET', p: '/api/agent/mcp_providers', fn: mcp.listAppMcpProviders, auth: true },
  { m: 'POST', p: '/api/agent/mcp_providers', fn: mcp.createAppMcpProvider, auth: true },
  { m: 'POST', p: '/api/agent/mcp_providers/test', fn: mcp.testAppMcpProvider, auth: true },
  { m: 'PATCH', p: '/api/agent/mcp_providers/:providerName/toggle', fn: mcp.toggleAppMcpProvider, auth: true },
  { m: 'POST', p: '/api/agent/mcp_providers/:providerName/rediscover', fn: mcp.rediscoverAppMcpProvider, auth: true },
  { m: 'GET', p: '/api/agent/mcp_providers/:providerName', fn: mcp.getAppMcpProvider, auth: true },
  { m: 'PUT', p: '/api/agent/mcp_providers/:providerName', fn: mcp.updateAppMcpProvider, auth: true },
  { m: 'DELETE', p: '/api/agent/mcp_providers/:providerName', fn: mcp.deleteAppMcpProvider, auth: true },

  // ── MCP Provider(/test 必须在动态 /:mid 路由前匹配)──
  { m: 'POST', p: '/api/projects/:pid/mcp_providers/test', fn: mcp.testMcpProvider, auth: true },
  { m: 'POST', p: '/api/projects/:pid/mcp_providers', fn: mcp.createMcpProvider, auth: true },
  { m: 'PATCH', p: '/api/projects/:pid/mcp_providers/:providerName/binding', fn: mcp.updateMcpProvider, auth: true },
  { m: 'PATCH', p: '/api/projects/:pid/mcp_providers/:mid', fn: mcp.updateMcpProvider, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/mcp_providers/:mid', fn: mcp.deleteMcpProvider, auth: true },
  { m: 'POST', p: '/api/projects/:pid/mcp_providers/:mid/rediscover', fn: mcp.rediscoverMcpProvider, auth: true },
];
