import { useTranslation } from 'react-i18next'
import i18n from '@/lang'

/**
 * i18n hook(对齐原 hooks/use-i18n.ts，底层换成 react-i18next)。
 * 组件内：const { t } = useI18n()
 */
export const useI18n = () => useTranslation()

/** 便捷翻译方法(非组件可用) */
export const t = (key: string) => i18n.t(key)
