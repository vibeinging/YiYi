// agents 域路由表(Agent 配置 CRUD,抽自 routes/agents.js)。一域一文件,避免多 agent 扇出冲突。
// 去业务层:Agent 配置直接挂项目,不再有 :bid 中间段。
import * as agents from '../app/agents/index.js';

export const agentsRoutes = [
  { m: 'GET', p: '/api/agents/projects/:pid/agents/config/:agentType', fn: agents.getAgentConfig, auth: true },
  { m: 'POST', p: '/api/agents/projects/:pid/agents/config', fn: agents.saveAgentConfig, auth: true },
  { m: 'GET', p: '/api/agents/projects/:pid/agents/detail/:agentId', fn: agents.getAgentDetail, auth: true },
  { m: 'DELETE', p: '/api/agents/projects/:pid/agents/detail/:agentId', fn: agents.deleteAgent, auth: true },
  { m: 'PATCH', p: '/api/agents/projects/:pid/agents/config/:agentType/toggle', fn: agents.toggleAgent, auth: true },
];
