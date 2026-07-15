// L1 应用/用例层 — 用户登录/信息/登出/项目。抽自 index.js,逻辑逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
//
// 覆盖:builtin-login / login / logout / me / projects
//
// 注:app/auth/ 比 routes/ 深一层 → engine/db 用 ../../。
// JWT 签发(signToken + JWT_SECRET/JWT_ALG/TOKEN_TTL)复制自 index.js(transport/auth.js
// 只有 verifyToken 用于鉴权;签发链路独立,登录类端点标 auth:false 由 transport 跳过校验)。
import jwt from 'jsonwebtoken';
import { ApiError } from '../../errors.js';
import {
  DESKTOP_COMPANY_ID,
  DESKTOP_USER_ID,
  DESKTOP_USER_USERNAME,
} from './desktop_ids.js';

const JWT_SECRET = process.env.JWT_SECRET || 'yiw-desktop-secret';
const JWT_ALG = 'HS256';
const TOKEN_TTL = '7d';

const signToken = (userId) => jwt.sign({ sub: userId }, JWT_SECRET, { algorithm: JWT_ALG, expiresIn: TOKEN_TTL });

// ── 用户/项目数据(复制自 index.js)──
async function getUserById(ctx, id) {
  return ctx.queryOne(
    `SELECT id, company_id, username, email, avatar_url, full_name, is_admin, can_create_project,
            is_active, last_login_at FROM users WHERE id=$1 AND deleted_at IS NULL`,
    [id],
  );
}

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

function userInfo(user, projects) {
  return {
    user_id: user.id,
    username: user.username,
    email: user.email,
    is_admin: user.is_admin,
    can_create_project: user.can_create_project,
    avatar_url: user.avatar_url,
    full_name: user.full_name,
    last_login_at: user.last_login_at,
    projects_count: projects.length,
    projects,
  };
}

// ── 内置公司+用户(普通版:免登录,下载即用)──
// 桌面端写死固定 ID(全零 UUID,见 desktop_ids.js):内置记录 id 永不变化,所有
// created_by / company_id / user_id 引用永远稳定,杜绝「每次重建产生新 UUID → 历史数据
// 变孤儿 → 对话查不到」的回归。
let _builtinUserId = null;
async function ensureBuiltinUser(ctx) {
  if (_builtinUserId) {
    const u = await getUserById(ctx, _builtinUserId);
    if (u) return u;
    _builtinUserId = null;
  }
  // upsert(INSERT OR IGNORE):用固定 id 保证内置 company/user 恒存在,不靠查询 + 不 randomUUID。
  // 旧库里这两行可能由历史随机 id 创建 → 由迁移脚本(scripts/migrate_desktop_ids.mjs)改写到固定 id。
  await ctx.query(
    `INSERT INTO companies (id,name,code,is_active,created_at,updated_at)
     VALUES ($1,'本地工作区','local',true,now(),now())
     ON CONFLICT(id) DO NOTHING`,
    [DESKTOP_COMPANY_ID],
  );
  await ctx.query(
    `INSERT INTO users (id,company_id,username,password_hash,full_name,is_admin,can_create_project,is_active,created_at,updated_at)
     VALUES ($1,$2,$3,'builtin-no-login','本地用户',true,true,true,now(),now())
     ON CONFLICT(id) DO NOTHING`,
    [DESKTOP_USER_ID, DESKTOP_COMPANY_ID, DESKTOP_USER_USERNAME],
  );
  const user = await getUserById(ctx, DESKTOP_USER_ID);
  _builtinUserId = user.id;
  return user;
}

// POST /api/user/login — 密码登录(前端发 MD5 后的密码;后端「password_hash === 收到值」直接比对)
export async function login(ctx, input) {
  const { username, password } = input.body || {};
  if (!username || !password) throw new ApiError('用户名或密码不能为空', 400);
  const user = await ctx.queryOne(`SELECT * FROM users WHERE username=$1 AND deleted_at IS NULL`, [username]);
  if (!user || user.password_hash !== password) throw new ApiError('用户名或密码错误', 401);
  if (!user.is_active) throw new ApiError('用户账号已被禁用', 403);
  await ctx.query(`UPDATE users SET last_login_at=now() WHERE id=$1`, [user.id]);
  const projects = await getUserProjects(ctx, user.id);
  const access_token = signToken(user.id);
  return { data: { access_token, token_type: 'bearer', user_info: userInfo(user, projects) }, message: '用户登录成功' };
}

// GET /api/user/builtin-login — 免凭证签发内置用户 token(桌面前端启动时自动调用,跳过登录页)
export async function builtinLogin(ctx, _input) {
  const user = await ensureBuiltinUser(ctx);
  const projects = await getUserProjects(ctx, user.id);
  const access_token = signToken(user.id);
  return { data: { access_token, token_type: 'bearer', user_info: userInfo(user, projects) }, message: '内置用户登录成功' };
}

// GET /api/user/me — 当前用户信息
export async function getMe(ctx, _input) {
  const user = await getUserById(ctx, ctx.userId);
  if (!user) throw new ApiError('用户不存在', 404);
  const projects = await getUserProjects(ctx, user.id);
  return { data: userInfo(user, projects), message: '获取用户信息成功' };
}

// POST /api/user/logout — 登出(无状态 JWT,空操作)
export async function logout(_ctx, _input) {
  return { data: null, message: '已登出' };
}

// GET /api/user/projects — 当前用户项目列表
export async function listUserProjects(ctx, _input) {
  const projects = await getUserProjects(ctx, ctx.userId);
  return { data: { items: projects, total: projects.length }, message: '获取项目成功' };
}
