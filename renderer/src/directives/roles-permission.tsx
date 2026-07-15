// TODO(migration): Vue 指令 v-roles-permission 无 React 等价物，改为 useRolesPermission hook + RolesPermission 包裹组件
// TODO(migration): 源里基于 useBasicStore().roles 判定，但新版 basic store 未定义 roles 字段(原版亦为可选链、恒为 undefined)，此处用 (getState() as any).roles 防御读取以保持原行为
/**
 * 角色权限指令 - 用于基于角色控制元素显示/隐藏
 * 使用示例(Vue 原版):
 * <button v-roles-permission="['admin','editor']">仅管理员/编辑可见</button>
 *
 * React 用法:
 * const hasPermission = useRolesPermission(['admin', 'editor'])
 * {hasPermission && <button>仅管理员/编辑可见</button>}
 *
 * <RolesPermission value={['admin', 'editor']}><button>仅管理员/编辑可见</button></RolesPermission>
 */

import { type ReactNode } from 'react'
import { useBasicStore } from '@/store/basic'

// 校验是否拥有(任一)角色权限
function checkPermission(value?: string[]): boolean {
  if (value && Array.isArray(value)) {
    if (value.length > 0) {
      const permissionRoles = value
      const hasPermission = (useBasicStore.getState() as any).roles?.some((role: string) =>
        permissionRoles.includes(role)
      )
      return !!hasPermission
    }
    // 空数组：原指令不移除元素，等价于默认显示
    return true
  } else {
    throw new Error(`need roles! Like v-roles-permission="['admin','editor']"`)
  }
}

/**
 * 角色权限 hook - 返回是否拥有(任一)角色权限
 * 对应 Vue 指令 v-roles-permission 的判定逻辑
 */
export function useRolesPermission(value?: string[]): boolean {
  return checkPermission(value)
}

interface RolesPermissionProps {
  value?: string[]
  children: ReactNode
}

/**
 * 角色权限包裹组件 - 无对应角色则不渲染(等价于 Vue 指令移除元素)
 */
export function RolesPermission({ value, children }: RolesPermissionProps) {
  if (!checkPermission(value)) {
    return null
  }
  return <>{children}</>
}

export default RolesPermission
