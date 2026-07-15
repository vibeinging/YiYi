// TODO(migration): Vue 指令(v-permission 形式)无 React 等价物，改为 useButtonCodes hook + ButtonCodes 包裹组件
/**
 * 按钮 code 权限指令 - 根据 buttonCodes 控制元素显示/隐藏
 * 使用示例(Vue 原版):
 * <button v-permission="['admin','editor']">操作</button>
 *
 * React 用法:
 * const hasPermission = useButtonCodes(['admin', 'editor'])
 * {hasPermission && <button>操作</button>}
 *
 * <ButtonCodes value={['admin', 'editor']}><button>操作</button></ButtonCodes>
 */

import { type ReactNode } from 'react'
import { useBasicStore } from '@/store/basic'

// 校验是否拥有(任一)按钮 code 权限
function hasButtonPermission(buttonCodes: string[], value: string[]): boolean {
  if (value && Array.isArray(value)) {
    if (value.length) {
      const permissionRoles = value
      return buttonCodes?.some((code) => permissionRoles.includes(code))
    }
    // 空数组时不做校验，默认显示(与原指令一致)
    return true
  } else {
    throw new Error(`need roles! Like v-permission="['admin','editor']"`)
  }
}

/**
 * 按钮 code 权限 hook - 返回是否拥有(任一)权限
 * 对应 Vue 指令的判定逻辑
 */
export function useButtonCodes(value: string[]): boolean {
  const buttonCodes = useBasicStore((s) => s.buttonCodes)
  return hasButtonPermission(buttonCodes, value)
}

interface ButtonCodesProps {
  value: string[]
  children: ReactNode
}

/**
 * 按钮 code 权限包裹组件 - 无权限则不渲染(等价于 Vue 指令移除元素)
 */
export function ButtonCodes({ value, children }: ButtonCodesProps) {
  const buttonCodes = useBasicStore((s) => s.buttonCodes)
  if (!hasButtonPermission(buttonCodes, value)) {
    return null
  }
  return <>{children}</>
}

export default ButtonCodes
