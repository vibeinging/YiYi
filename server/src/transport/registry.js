// 总路由表:汇总各域子表(registry.<domain>.js)。迁移一个域 → 这里加一行 import + 展开。
import { membersRoutes } from './registry.members.js';
import { unstructuredRoutes } from './registry.unstructured.js';
import { dashboardRoutes } from './registry.dashboard.js';
import { reportsRoutes } from './registry.reports.js';
import { sessionRoutes } from './registry.session.js';
import { agentsRoutes } from './registry.agents.js';
import { datasourceRoutes } from './registry.datasource.js';
import { structuredRoutes } from './registry.structured.js';
import { businessRoutes } from './registry.business.js';
import { authRoutes } from './registry.auth.js';
import { projectsRoutes } from './registry.projects.js';
import { modelsRoutes } from './registry.models.js';
import { readsRoutes } from './registry.reads.js';
import { mcpRoutes } from './registry.mcp.js';
import { reportsDownloadRoutes } from './registry.reports_download.js';
import { chatRoutes } from './registry.chat.js';
import { agentActionRoutes } from './registry.agent_actions.js';
import { imRoutes } from './registry.im.js';
import { traceRoutes } from './registry.traces.js';
import { traceOptimizationRoutes } from './registry.trace_optimization.js';

export const ROUTES = [
  // ── 批1 ──
  ...membersRoutes,
  ...unstructuredRoutes,
  ...dashboardRoutes,
  ...reportsRoutes,
  // ── 批2 ──
  ...sessionRoutes,
  ...agentsRoutes,
  ...datasourceRoutes,
  ...structuredRoutes,
  // ── 批3 ──
  ...businessRoutes,
  // ── 批4 ──
  ...authRoutes,
  ...projectsRoutes,
  ...modelsRoutes,
  ...readsRoutes,
  ...mcpRoutes,
  ...reportsDownloadRoutes,
  ...imRoutes,
  ...traceRoutes,
  ...traceOptimizationRoutes,
  // ── 批5(流式)──
  ...agentActionRoutes,
  ...chatRoutes,
];
