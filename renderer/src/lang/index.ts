import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en'
import zh from './zh'
import settings from '@/settings'

/**
 * i18n 设置(对齐原 vue-i18n)。
 * - 字典 en/zh 直接复用 Vue 工程的 lang 文件(plain object,key 完全一致)。
 * - vue-i18n 用 `{name}` 单花括号插值,故把 i18next 插值定界符也设为 `{`/`}`,实现字典零改动。
 */
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh }
  },
  lng: settings.defaultLanguage,
  fallbackLng: 'zh',
  interpolation: {
    escapeValue: false,
    prefix: '{',
    suffix: '}'
  },
  returnNull: false
})

export default i18n

/** 非组件环境(axios 拦截器 / store / 守卫)取 t 用：i18n.t(...) */
export const t = i18n.t.bind(i18n)

/** 是否存在某个 key（对齐 vue-i18n te） */
export const te = (key: string) => i18n.exists(key)

/**
 * 把路由 meta.title 翻译成标题(对齐原 hooks/use-common.langTitle)。
 * 旧实现遍历 zh 的顶层 key 拼 `${key}.${title}` 查 te。这里保留同样语义。
 */
export const langTitle = (title?: string): string => {
  if (!title) return settings.title
  for (const key of Object.keys(zh)) {
    const full = `${key}.${title}`
    if (i18n.exists(full)) {
      const v = i18n.t(full)
      if (v) return v
    }
  }
  return title
}
