import { type RouteObject, redirect } from 'react-router-dom'
import RouteGuard from './RouteGuard'

/**
 * Electron app 路由配置。
 * 只暴露 app 自身页面。未注册路径统一回到主工作区。
 */
const viewModules: Record<string, () => Promise<any>> = {
  'views/error-page/404': () => import('@/views/error-page/404'),
  'views/error-page/401': () => import('@/views/error-page/401'),
  'views/share/index': () => import('@/views/share/index'),
  'views/agent/index': () => import('@/views/agent/index'),
  'views/superagent-flow/editor': () => import('@/views/superagent-flow/editor')
}

const lazyOf = (key: string) => {
  const loader = viewModules[key]
  if (!loader) throw new Error(`[router] 找不到视图模块: ${key}`)
  return async () => {
    const m: any = await loader()
    return { Component: m.default }
  }
}

export interface RouteMeta {
  title?: string
  requireAdmin?: boolean
  requirePermission?: string | string[]
  requireProject?: boolean
  elSvgIcon?: string
  cachePage?: boolean
  hidden?: boolean
  affix?: boolean
  tooltip?: string
  public?: boolean
  [k: string]: any
}

export interface AppRoute {
  path?: string
  index?: boolean
  name?: string
  /** glob key: 'views/xxx/index' */
  view?: string
  hidden?: boolean
  meta?: RouteMeta
  redirectTo?: string | ((params: Record<string, string | undefined>, url: URL) => string)
  children?: AppRoute[]
}

export const constantRoutes: AppRoute[] = [
  { path: '/404', view: 'views/error-page/404', hidden: true, meta: { requireProject: false } },
  { path: '/401', view: 'views/error-page/401', hidden: true, meta: { requireProject: false } },
  { path: '/share/:shareToken', name: 'SharedSession', view: 'views/share/index', hidden: true, meta: { title: 'router.sharedSession', public: true, requireProject: false } },

  // YiW工作台(自带深色外壳)= 默认入口
  { path: '/agent', view: 'views/agent/index', hidden: true, meta: { title: 'YiW', requireProject: false } },
  { path: '/agent/project/:projectId/workflow-editor', view: 'views/superagent-flow/editor', hidden: true, meta: { title: 'workflow.editor.title' } },
  { path: '/agent/project/:projectId/workflow-editor/:workflowId', view: 'views/superagent-flow/editor', hidden: true, meta: { title: 'workflow.editor.title' } },
  // 兼容迁移前 Web 路径,避免旧入口/历史链接直接掉回主工作区。
  { path: '/project/:projectId/business/:businessId/workflow-editor', view: 'views/superagent-flow/editor', hidden: true, meta: { title: 'workflow.editor.title' } },
  { path: '/project/:projectId/business/:businessId/workflow-editor/:workflowId', view: 'views/superagent-flow/editor', hidden: true, meta: { title: 'workflow.editor.title' } },

  // 默认落到YiW
  { index: true, redirectTo: '/agent', hidden: true, meta: { requireProject: false } }
]

const allDescriptors: AppRoute[] = constantRoutes

// ── descriptor → React Router RouteObject ──
const toRouteObject = (r: AppRoute): RouteObject => {
  const handle = { meta: r.meta || {}, name: r.name }
  if (r.redirectTo) {
    const dest = r.redirectTo
    return {
      ...(r.index ? { index: true } : { path: r.path }),
      loader: ({ params, request }) =>
        redirect(typeof dest === 'function' ? dest(params as any, new URL(request.url)) : dest),
      handle
    } as RouteObject
  }
  const base: any = r.index ? { index: true } : { path: r.path }
  if (r.view) base.lazy = lazyOf(r.view)
  if (r.children) base.children = r.children.map(toRouteObject)
  base.handle = handle
  return base as RouteObject
}

const buildTree = (descriptors: AppRoute[]): RouteObject[] =>
  descriptors.map(toRouteObject)

export const routeObjects: RouteObject[] = [
  {
    element: <RouteGuard />,
    children: [
      ...buildTree(allDescriptors),
      // app 不保留旧 Web 路由表，任何未注册地址都回到主工作区。
      { path: '*', loader: () => redirect('/agent') }
    ]
  }
]
