/**
 * URL 工具函数
 * 用于处理 baseURL 和路径的拼接，避免双斜杠问题
 */

/**
 * 获取基础URL
 * @returns {string} 基础URL
 */
export function getBaseURL() {
  return import.meta.env.VITE_APP_BASE_URL || window.location.origin || ''
}

/**
 * 将前端 origin 映射为对应 worktree 的后端 origin。
 * 约定：
 * - 前端 515x <-> 后端 511x
 * - 其他端口保持原样
 * @param {string} origin - 当前前端 origin
 * @returns {string} 后端 origin
 */
export function mapFrontendOriginToBackendOrigin(origin: any = window.location.origin || '') {
  const value = String(origin || '')
  return value.replace(/:515(\d)\b/, ':511$1')
}

/**
 * 拼接URL，自动处理双斜杠问题
 * @param {string} baseURL - 基础URL
 * @param {string} path - 路径
 * @returns {string} 拼接后的完整URL
 */
export function joinURL(baseURL: any, path: any) {
  // 移除 baseURL 末尾的斜杠
  const cleanBaseURL = baseURL.replace(/\/$/, '')
  // 确保 path 以斜杠开头
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${cleanBaseURL}${cleanPath}`
}

/**
 * 创建API URL
 * @param {string} path - API路径
 * @returns {string} 完整的API URL
 */
export function createAPIURL(path: any) {
  return joinURL(getBaseURL(), path)
}
