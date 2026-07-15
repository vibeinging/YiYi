// 通用工具集(非组件,不引入 React hooks)。对齐原 Vue 工程 hooks/use-common.js。
import { notifications } from '@mantine/notifications'

// 非组件环境的 i18n：t/langTitle 直接复用 @/lang
import i18n, { t } from '@/lang'

export const sleepTimeout = (time: number) => {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clearTimeout(timer)
      resolve(null)
    }, time)
  })
}

//深拷贝
export function cloneDeep(value: any) {
  return JSON.parse(JSON.stringify(value))
}

//copyValueToClipboard
export const copyValueToClipboard = (value: any) => {
  navigator.clipboard.writeText(JSON.stringify(value))
  notifications.show({ color: 'green', message: t('common.copySuccess') })
}

// langTitle 复用 @/lang(语义一致：遍历 zh 顶层 key 拼 `${key}.${title}` 查 te)
export { langTitle } from '@/lang'

//get i18n instance
export const getLangInstance = () => {
  return i18n
}
