// TODO(migration): Vue 指令 v-lang 无 React 等价物，改为 Lang 组件 + useLang hook(基于 react-i18next，语言切换自动 re-render)
/**
 * 语言指令 - 按 i18n key/title 设置文本，并在语言切换时自动刷新
 * 使用示例(Vue 原版):
 * <span v-lang>menu.home</span>            // 文本本身即 title，按 langTitle 翻译
 * <el-input v-lang :placeholder="..."/>    // EL 组件改 props(placeholder/label)
 *
 * React 用法:
 * <Lang title="menu.home" />               // 渲染翻译后的文本
 * const text = useLang('menu.home')        // 取翻译后的文本(随语言响应)
 *
 * 说明：react-i18next 的 useTranslation 会在 i18n.changeLanguage 时触发 re-render，
 * 故无需像 Vue 那样手动 watch language 再写 el.innerText。langTitle 语义与原版一致
 * (遍历 zh 顶层 key 拼 `${key}.${title}` 查 te，命中则取译文，否则原样返回)。
 */

import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { langTitle } from '@/lang'

//element-plus(原版用于把指令落到 EL 组件的哪个 prop 上；React 直接用各组件 label/placeholder，此处保留备注)
const componentToProps = {
  ElInput: 'placeholder',
  ElTableColumn: 'label'
}

/**
 * 语言 hook - 返回按当前语言翻译后的文本
 * 对应 Vue 指令 v-lang 的核心逻辑(langTitle)
 */
export function useLang(title?: string): string {
  // 订阅语言变化：语言切换时 useTranslation 触发 re-render，langTitle 重新求值
  useTranslation()
  return langTitle(title)
}

interface LangProps {
  // 待翻译的 i18n key/title；不传则取 children 文本
  title?: string
  children?: ReactNode
}

/**
 * 语言文本组件 - 渲染按当前语言翻译后的文本(等价于 Vue 指令写 el.innerText)
 */
export function Lang({ title, children }: LangProps) {
  // title 优先；否则把 children 当作原始文本/title 传入 langTitle
  const raw = title ?? (typeof children === 'string' ? children : undefined)
  const text = useLang(raw)
  return <>{text}</>
}

// 兼容旧的 default-import(原 Vue 指令默认导出对象)。React 下指令已退化为组件/hook，
// 这里仍提供 default 以避免下游 `import lang from '@/directives/lang'` 报错。
export default Lang

// 备注：componentToProps 仅作语义参考，React 侧已由各组件原生 label/placeholder 承载
export { componentToProps }
