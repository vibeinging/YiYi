// 传输层鉴权:从请求头解出 userId(JWT sub);失败返回 null。与 index.js 的 auth 中间件同密钥/算法。
import jwt from 'jsonwebtoken';
import { DESKTOP_USER_ID } from '../app/auth/desktop_ids.js';

const JWT_SECRET = process.env.JWT_SECRET || 'yiw-desktop-secret';
const JWT_ALG = 'HS256';

// 本地免鉴权开关:仅 eval/CI 场景显式开启(DESKTOP_NO_AUTH=1)。开启后 HTTP server 上的请求
// 一律视为内置用户(固定 id),跳过 token 校验 —— builtin-login 本就免凭证、token 里 userId
// 恒为固定值,登录流程对本地 eval 冗余。
// 前提:http_server.js 在此开关开启时仅绑 127.0.0.1(见 startHttpServer),不暴露到局域网。
export const DESKTOP_NO_AUTH = process.env.DESKTOP_NO_AUTH === '1';

export function verifyToken(headers = {}) {
  const h = headers.authorization || headers.Authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : h;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALG] }).sub || null;
  } catch {
    return null;
  }
}

// 解析请求的 userId:免鉴权开关开启时直接返回固定内置用户;否则回退 JWT 校验。
export function resolveUserId(headers = {}) {
  if (DESKTOP_NO_AUTH) return DESKTOP_USER_ID;
  return verifyToken(headers);
}
