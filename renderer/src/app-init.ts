/**
 * 应用启动初始化(对齐原 App.vue 的 onBeforeMount / onMounted)：
 * - 免登录模式注入临时 token
 * - 初始化主题(html className) + 语言
 */
import settings from '@/settings'
import i18n from '@/lang'
import { useBasicStore } from '@/store/basic'
import { useConfigStore } from '@/store/config'
import { toggleHtmlClass } from '@/theme/utils'

export function initApp() {
  const basic = useBasicStore.getState()
  const config = useConfigStore.getState()

  // 免登录模式：注入临时 token
  if (!settings.isNeedLogin) basic.setToken(settings.tmpToken)

  // 主题
  toggleHtmlClass(config.theme)

  // 语言
  i18n.changeLanguage(config.language)
  document.title = settings.title
}
