/**
 * 路由导航桥(供非组件环境调用：store / axios 拦截器 / 权限守卫)。
 * createBrowserRouter 创建后通过 setNavigate 注入真实 navigate，避免 store ↔ router 循环依赖。
 */
export type NavigateFn = (to: string, opts?: { replace?: boolean }) => void

let _navigate: NavigateFn = () => {
  // 路由未就绪时回退到原生跳转
  if (typeof window !== 'undefined') window.location.assign('/agent')
}

export const setNavigate = (fn: NavigateFn) => {
  _navigate = fn
}

export const navigate: NavigateFn = (to, opts) => _navigate(to, opts)
