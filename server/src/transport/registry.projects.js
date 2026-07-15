// projects 域路由表(项目 CRUD / 工作区目录 / 技能 / 角色 / 网络搜索支持 / Agent 类型 / 健康检查,
// 抽自 index.js)。一域一文件,避免多 agent 扇出冲突。
// /health 类无鉴权,显式标 auth:false。
//
// 路由顺序:字面段路由(roles/list、skills/*)排在 :id 参数路由前,避免被参数段误捕获。
import * as projects from '../app/projects/index.js';

export const projectsRoutes = [
  // ── 健康检查(免鉴权)──
  { m: 'GET', p: '/api/health', fn: projects.health, auth: false },
  { m: 'GET', p: '/health', fn: projects.healthPlain, auth: false },

  // ── Agent 类型 / 网络搜索支持(字面路径)──
  { m: 'GET', p: '/api/agents/types/config', fn: projects.getAgentTypesConfig, auth: true },
  { m: 'GET', p: '/api/web-search-models/support', fn: projects.listWebSearchSupport, auth: true },

  // ── 角色列表(字面 roles/list,排在 :id 前)──
  { m: 'GET', p: '/api/projects/roles/list', fn: projects.listRoles, auth: true },

  // ── 项目 CRUD ──
  { m: 'GET', p: '/api/projects', fn: projects.listProjects, auth: true },
  {
    m: 'POST', p: '/api/projects', fn: projects.createProject, auth: true,
    capability: {
      title: '创建问数项目', domain: 'projects', safety: 'write',
      input_schema: {
        body: {
          type: 'object', required: ['name'], additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1 },
            description: { type: 'string' },
            session_id: { type: ['string', 'null'] },
          },
        },
      },
    },
  },

  // ── 技能(:pid/skills/* 字面子段,排在 :id 前)──
  { m: 'GET', p: '/api/projects/:pid/skills', fn: projects.listSkills, auth: true },
  { m: 'POST', p: '/api/projects/:pid/skills', fn: projects.createSkill, auth: true },
  { m: 'GET', p: '/api/projects/:pid/skills/enabled/list', fn: projects.listEnabledSkills, auth: true },
  { m: 'GET', p: '/api/projects/:pid/skills/available-tools', fn: projects.listAvailableTools, auth: true },
  { m: 'POST', p: '/api/projects/:pid/skills/ai-generate', fn: projects.aiGenerateSkill, auth: true },
  { m: 'PATCH', p: '/api/projects/:pid/skills/:skillName/binding', fn: projects.toggleSkill, auth: true },
  { m: 'PATCH', p: '/api/projects/:pid/skills/:skillName/toggle', fn: projects.toggleSkill, auth: true },
  { m: 'GET', p: '/api/projects/:pid/skills/:skillName', fn: projects.getSkillDetail, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/skills/:skillName', fn: projects.updateSkill, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/skills/:skillName', fn: projects.deleteSkill, auth: true },

  // ── 工作区目录 ──
  { m: 'POST', p: '/api/projects/:id/open-folder', fn: projects.openFolder, auth: true },
  { m: 'GET', p: '/api/projects/:id/workspace-dir', fn: projects.getWorkspaceDir, auth: true },
  { m: 'PUT', p: '/api/projects/:id/workspace-dir', fn: projects.updateWorkspaceDir, auth: true },

  // ── 项目详情 / 删除(参数 :id 兜底,排在字面路由后)──
  { m: 'GET', p: '/api/projects/:id', fn: projects.getProject, auth: true },
  { m: 'DELETE', p: '/api/projects/:id', fn: projects.deleteProject, auth: true },
];
