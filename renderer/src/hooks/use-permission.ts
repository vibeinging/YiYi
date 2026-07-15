import NProgress from 'nprogress'
import settings from '@/settings'
import { useBasicStore } from '@/store/basic'

NProgress.configure({ showSpinner: false })

export const progressStart = () => {
  if (settings.isNeedNprogress) NProgress.start()
}

export const progressClose = () => {
  if (settings.isNeedNprogress) NProgress.done()
}

/**
 * 重置登录状态(对齐原 use-permission.resetState)。
 * React Router 用静态路由,不需要原工程的 resetRouter/addRoute 动态路由重置,故只重置 basic store。
 */
export function resetState() {
  useBasicStore.getState().resetState()
}
