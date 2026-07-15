// auth 域路由表(用户登录/信息/登出/项目,抽自 index.js)。一域一文件,避免多 agent 扇出冲突。
// 登录类端点免鉴权(签发 token),显式标 auth:false;其余走 transport verifyToken。
import * as auth from '../app/auth/index.js';

export const authRoutes = [
  // ── 登录(免鉴权:签发 JWT)──
  { m: 'GET', p: '/api/user/builtin-login', fn: auth.builtinLogin, auth: false },
  { m: 'POST', p: '/api/user/login', fn: auth.login, auth: false },

  // ── 鉴权后 ──
  { m: 'POST', p: '/api/user/logout', fn: auth.logout, auth: true },
  { m: 'GET', p: '/api/user/me', fn: auth.getMe, auth: true },
  { m: 'GET', p: '/api/user/projects', fn: auth.listUserProjects, auth: true },
];
