// L1 应用/用例层 — 项目 CRUD / 工作区目录 / 技能 / 网络搜索 / Agent 类型 / 健康检查。
// 抽自 index.js,逻辑逐行对齐。签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
//
// 覆盖:
//   projects: GET 列 / POST 建 / GET 详情 / DELETE
//   workspace: GET/PUT workspace-dir / POST open-folder
//   skills:    Agent skill CRUD / enabled/list / available-tools
//   misc:      roles/list / health(/api/health,/health,auth:false)/ agents/types/config /
//              web-search-models(项目级)/ web-search-models/support
//
// 注:app/projects/ 比 routes/ 深一层 → engine/db 用 ../../。
// workspace helper / getUserProjects / getCompanyId 为 index.js 私有 helper,按 recipe 复制到本文件。
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { mkdirSync, realpathSync, lstatSync, symlinkSync, cpSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AgentSettings } from '../../engine/tools/agent_settings.js';
import {
  PI_TOOL_CATALOG,
  deletePiSkill,
  generatePiSkillDraft,
  getPiSkill,
  listEnabledPiSkills,
  listPiSkills,
  setPiSkillEnabled,
} from '../../engine/agents/pi_skill_registry.js';
import { ensureProjectWorkspaceContext, loadProjectDataSourceOverview } from '../../engine/agents/workspace_context.js';
import { ApiError } from '../../errors.js';

// ── 用户/项目数据(复制自 index.js)──
async function getUserProjects(ctx, userId) {
  const rows = await ctx.query(
    `SELECT p.id, p.name, p.description, p.status, p.is_open, p.created_at, p.updated_at, pm.is_owner, pm.role_id
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.deleted_at IS NULL
      WHERE pm.user_id = $1 AND p.deleted_at IS NULL
      ORDER BY p.created_at DESC`,
    [userId],
  );
  return rows.map((p) => ({
    id: p.id,
    project_id: p.id,
    name: p.name,
    project_name: p.name,
    description: p.description,
    status: p.status,
    is_open: p.is_open,
    created_at: p.created_at,
    updated_at: p.updated_at,
    is_owner: !!p.is_owner,
    role: p.is_owner ? 'owner' : 'member',
    role_id: p.role_id,
    permissions: p.is_owner ? ['*'] : [],
  }));
}

async function getCompanyId(ctx, userId) {
  const u = await ctx.queryOne(`SELECT company_id FROM users WHERE id=$1`, [userId]);
  return u?.company_id;
}

// ── 项目本地工作区目录(与 workspace_agent.ensureWorkspace 同路径:~/.yiw/projects/<id>)──
// 默认路径。更换位置时把这个路径变成「指向自定义目录的符号链接」,Agent 仍解析默认路径 →
// 透明跟随到自定义位置,无需改引擎。
function defaultWorkspaceDir(pid) {
  return join(homedir(), '.yiw', 'projects', String(pid));
}
// 有效目录:默认路径若是链接则跟随到真实(自定义)目录;不存在则返回默认路径。
function effectiveWorkspaceDir(pid) {
  const d = defaultWorkspaceDir(pid);
  try {
    return realpathSync(d);
  } catch {
    return d;
  }
}
// 默认路径是否已指向自定义位置(= 符号链接)
function isCustomWorkspace(pid) {
  try {
    return lstatSync(defaultWorkspaceDir(pid)).isSymbolicLink();
  } catch {
    return false;
  }
}
// 确保目录存在(新项目可能还没跑过会话 → 目录还没建;对链接是幂等 no-op)
async function ensureProjectDir(pid, project = null, ctx = null) {
  mkdirSync(defaultWorkspaceDir(pid), { recursive: true });
  const dir = effectiveWorkspaceDir(pid);
  const dataSources = ctx ? await loadProjectDataSourceOverview(ctx, pid) : null;
  ensureProjectWorkspaceContext({ cwd: dir, projectId: pid, project, dataSources: Array.isArray(dataSources) ? dataSources : undefined });
  return dir;
}
// 更换工作区位置:把现有内容拷到 newDir,再把默认路径替换成指向 newDir 的链接。
// 拷贝先于删除,失败则原状不动(异常向上抛)。
function relocateWorkspace(pid, newDir) {
  const def = defaultWorkspaceDir(pid);
  mkdirSync(newDir, { recursive: true });
  const newReal = realpathSync(newDir);
  let cur = null;
  try {
    cur = realpathSync(def);
  } catch {
    cur = null;
  }
  if (cur && cur !== newReal) {
    // 合并拷贝(已存在同名不覆盖、不报错);cpSync 会拦截「拷进自身子目录」
    cpSync(cur, newDir, { recursive: true, force: false, errorOnExist: false });
  }
  // 清掉默认路径处的旧链接 / 旧真实目录(内容已拷走)
  try {
    if (lstatSync(def).isSymbolicLink()) rmSync(def);
    else rmSync(def, { recursive: true, force: true });
  } catch {
    /* 不存在 */
  }
  symlinkSync(newReal, def, 'junction');
  return effectiveWorkspaceDir(pid);
}
// 用系统文件管理器打开目录(桌面端;sidecar 在用户 GUI 会话里,open/explorer/xdg-open 均可用)
function openInFileManager(dir) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => console.error('[open-folder]', e?.message || e));
  child.unref();
}

// ════════════════════════════════════════════
// 健康检查(auth:false)
// ════════════════════════════════════════════

// GET /api/health
export async function health(_ctx, _input) {
  return { data: { ok: true }, message: 'ok' };
}

// GET /health — 旧契约裸 { ok:true };transport 走标准信封,data 即 { ok:true }
export async function healthPlain(_ctx, _input) {
  return { data: { ok: true } };
}

// ════════════════════════════════════════════
// 项目 CRUD
// ════════════════════════════════════════════

// GET /api/projects — 项目列表(支持 search 服务端名字模糊匹配)
export async function listProjects(ctx, input) {
  let projects = await getUserProjects(ctx, ctx.userId);
  // 对齐生产契约:支持 search 服务端名字模糊匹配(eval 清理旧项目用它精确定位)
  const search = (input.query?.search || '').trim();
  if (search) {
    const kw = search.toLowerCase();
    projects = projects.filter((p) => String(p.name || '').toLowerCase().includes(kw));
  }
  return { data: { items: projects, total: projects.length, page: 1, per_page: projects.length }, message: '获取项目列表成功' };
}

// POST /api/projects — 创建项目(项目 + 创建者为 owner 成员 + 管理员角色)
export async function createProject(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const { name, description } = input.body || {};
  if (!name || !String(name).trim()) throw new ApiError('项目名称不能为空', 400);
  const pid = randomUUID();
  await ctx.query(
    `INSERT INTO projects (id,company_id,name,description,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'active',now(),now())`,
    [pid, cid, String(name).trim(), description || null],
  );
  // 管理员角色:优先系统 project_admin,否则任意系统管理员角色
  const adminRole = await ctx.queryOne(
    `SELECT id FROM roles WHERE deleted_at IS NULL AND (code='project_admin' OR (is_system=true AND (name LIKE '%管理员%' OR code LIKE '%admin%')))
      ORDER BY (code='project_admin') DESC, is_system DESC LIMIT 1`,
  ).catch(() => null);
  await ctx.query(
    `INSERT INTO project_members (id,project_id,user_id,role_id,is_owner,created_at,updated_at)
     VALUES ($1,$2,$3,$4,true,now(),now())`,
    [randomUUID(), pid, ctx.userId, adminRole?.id || null],
  );
  const p = await ctx.queryOne(
    `SELECT id, company_id, name, description, status, is_open, created_at, updated_at FROM projects WHERE id=$1`,
    [pid],
  );
  // 建项目即落本地工作区目录(失败不阻断创建,打开文件夹时还会兜底 mkdir)
  try { await ensureProjectDir(pid, p, ctx); } catch (e) { console.error('[ensureProjectDir]', e?.message || e); }
  return { data: { ...p, project_id: p.id, project_name: p.name, is_owner: true, role: 'owner', role_id: adminRole?.id || null, permissions: ['*'] }, message: '创建项目成功' };
}

// GET /api/projects/:id — 项目详情
export async function getProject(ctx, input) {
  const projects = await getUserProjects(ctx, ctx.userId);
  const p = projects.find((x) => x.id === input.params.id);
  if (!p) throw new ApiError('项目不存在或无权限', 404);
  return { data: p, message: '获取项目成功' };
}

// DELETE /api/projects/:id — 软删项目
export async function deleteProject(ctx, input) {
  const { id } = input.params;
  const projects = await getUserProjects(ctx, ctx.userId);
  if (!projects.find((x) => x.id === id)) throw new ApiError('项目不存在或无权限', 404);
  await ctx.query(`UPDATE projects SET deleted_at=now(), updated_at=now() WHERE id=$1`, [id]);
  return { data: { id, deleted: true }, message: '删除项目成功' };
}

// ════════════════════════════════════════════
// 工作区目录
// ════════════════════════════════════════════

// POST /api/projects/:id/open-folder — 确保本地工作区目录存在并用系统文件管理器打开(桌面端)
export async function openFolder(ctx, input) {
  const projects = await getUserProjects(ctx, ctx.userId);
  const project = projects.find((x) => x.id === input.params.id);
  if (!project) throw new ApiError('项目不存在或无权限', 404);
  let dir;
  try {
    dir = await ensureProjectDir(input.params.id, project, ctx);
  } catch (e) {
    throw new ApiError('创建工作区目录失败: ' + (e?.message || e), 500);
  }
  openInFileManager(dir);
  return { data: { path: dir }, message: '已打开工作区文件夹' };
}

// GET /api/projects/:id/workspace-dir — 当前有效工作区目录(跟随自定义位置)
export async function getWorkspaceDir(ctx, input) {
  const projects = await getUserProjects(ctx, ctx.userId);
  if (!projects.find((x) => x.id === input.params.id)) throw new ApiError('项目不存在或无权限', 404);
  return { data: { path: effectiveWorkspaceDir(input.params.id), is_custom: isCustomWorkspace(input.params.id) }, message: 'ok' };
}

// PUT /api/projects/:id/workspace-dir — 更换工作区位置(内容迁到新目录 + 默认路径软链到新目录)
export async function updateWorkspaceDir(ctx, input) {
  const projects = await getUserProjects(ctx, ctx.userId);
  const project = projects.find((x) => x.id === input.params.id);
  if (!project) throw new ApiError('项目不存在或无权限', 404);
  const path = input.body?.path;
  if (!path || !String(path).trim()) throw new ApiError('目标路径不能为空', 400);
  if (!isAbsolute(String(path))) throw new ApiError('请提供绝对路径', 400);
  let dir;
  try {
    dir = relocateWorkspace(input.params.id, String(path).trim());
    const dataSources = await loadProjectDataSourceOverview(ctx, input.params.id);
    ensureProjectWorkspaceContext({
      cwd: dir,
      projectId: input.params.id,
      project,
      dataSources: Array.isArray(dataSources) ? dataSources : undefined,
    });
  } catch (e) {
    throw new ApiError('更换工作区位置失败: ' + (e?.message || e), 500);
  }
  return { data: { path: dir, is_custom: isCustomWorkspace(input.params.id) }, message: '工作区位置已更换' };
}

// ════════════════════════════════════════════
// 角色列表(公司级)
// ════════════════════════════════════════════

// GET /api/projects/roles/list — 前端读 res.data 为数组(非 {items})
export async function listRoles(ctx, _input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const rows = await ctx.query(
    `SELECT r.id, r.company_id, r.name, r.code, r.description, r.permissions, r.is_system, r.created_at,
            COALESCE(c.cnt, 0)::int AS user_count
       FROM roles r
       LEFT JOIN (SELECT role_id, COUNT(DISTINCT user_id) AS cnt FROM project_members WHERE deleted_at IS NULL GROUP BY role_id) c
         ON c.role_id = r.id
      WHERE (r.company_id=$1 OR r.is_system=true) AND r.deleted_at IS NULL ORDER BY r.is_system DESC, r.name`,
    [cid],
  );
  return { data: rows, message: '获取角色列表成功' };
}

// ════════════════════════════════════════════
// Skill 管理
// ════════════════════════════════════════════

// GET /api/projects/:pid/skills — Agent Skill 列表(内置 + 项目自定义)
export async function listSkills(ctx, input) {
  return { data: await listPiSkills(ctx, input.params.pid), message: '获取技能列表成功' };
}

// GET /api/projects/:pid/skills/enabled/list
export async function listEnabledSkills(ctx, input) {
  return { data: await listEnabledPiSkills(ctx, input.params.pid), message: '获取启用技能成功' };
}

// GET /api/projects/:pid/skills/available-tools
export async function listAvailableTools(_ctx, _input) {
  return { data: PI_TOOL_CATALOG, message: '获取可用工具成功' };
}

// GET /api/projects/:pid/skills/:skillName
export async function getSkillDetail(ctx, input) {
  return { data: await getPiSkill(ctx, input.params.pid, input.params.skillName), message: '获取技能详情成功' };
}

// POST /api/projects/:pid/skills
export async function createSkill(ctx, input) {
  throw new ApiError('项目内不创建 Skill 定义,请在 App 设置 → 技能中创建后绑定到项目', 400);
}

// PUT /api/projects/:pid/skills/:skillName
export async function updateSkill(ctx, input) {
  throw new ApiError('项目内不更新 Skill 定义,请在 App 设置 → 技能中更新定义', 400);
}

// DELETE /api/projects/:pid/skills/:skillName
export async function deleteSkill(ctx, input) {
  return { data: await deletePiSkill(ctx, input.params.pid, input.params.skillName, ctx.userId || ''), message: '已清除项目技能绑定' };
}

// PATCH /api/projects/:pid/skills/:skillName/toggle
export async function toggleSkill(ctx, input) {
  const raw = Object.prototype.hasOwnProperty.call(input.body || {}, 'enabled_override')
    ? input.body.enabled_override
    : input.body?.is_enabled;
  if (!(typeof raw === 'boolean' || raw === null)) throw new ApiError('is_enabled/enabled_override 必须为布尔值或 null', 400);
  const data = await setPiSkillEnabled(ctx, input.params.pid, input.params.skillName, raw, ctx.userId || '');
  return { data, message: '更新技能状态成功' };
}

// POST /api/projects/:pid/skills/ai-generate
export async function aiGenerateSkill(_ctx, input) {
  return { data: generatePiSkillDraft(input.body?.description || ''), message: '生成技能配置成功' };
}

// ════════════════════════════════════════════
// 网络搜索模型(支持服务列表 —— 项目级 web-search-models CRUD 归 models 域)
// ════════════════════════════════════════════

// GET /api/web-search-models/support
export async function listWebSearchSupport(_ctx, _input) {
  return {
    data: [
      { api: 'tavily', name: 'Tavily' },
      { api: 'bocha', name: '博查' },
      { api: 'serper', name: 'Serper' },
    ],
    message: '获取支持的搜索服务成功',
  };
}

// ════════════════════════════════════════════
// Agent 类型配置
// ════════════════════════════════════════════

// GET /api/agents/types/config — dbagents 类型清单(供「agent 配置」页渲染卡片)
export async function getAgentTypesConfig(_ctx, _input) {
  return { data: AgentSettings.agent_types, message: '获取Agent类型列表成功' };
}
