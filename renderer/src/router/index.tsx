import { createBrowserRouter } from 'react-router-dom'
import { routeObjects } from './routes'
import { setNavigate } from './navigation'

export const router = createBrowserRouter(routeObjects)

// 注入 navigate，供 store / axios / 守卫等非组件环境调用
setNavigate((to, opts) => router.navigate(to, opts))

export { constantRoutes } from './routes'
