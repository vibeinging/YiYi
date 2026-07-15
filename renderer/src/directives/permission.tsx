// TODO(migration): Vue 指令 v-permission 无 React 等价物，改为 useHasPermission hook + Permission 包裹组件
/**
 * 权限指令 - 用于控制元素显示/隐藏
 * 使用示例(Vue 原版):
 * <button v-permission="'member_manage'">管理成员</button>
 * <div v-permission="['datasource_manage', 'business_manage']">数据管理</div>
 *
 * React 用法:
 * const canManage = useHasPermission('member_manage')
 * {canManage && <button>管理成员</button>}
 *
 * <Permission value="member_manage"><button>管理成员</button></Permission>
 * <Permission value={['datasource_manage', 'business_manage']}><div>数据管理</div></Permission>
 */

import { type ReactNode } from 'react'
import { permissionManager } from '@/permission/index'

// 支持字符串或数组形式的权限
type PermissionValue = string | string[]

// 校验是否拥有(任一)权限
function checkPermission(value?: PermissionValue): boolean {
  // 如果没有指定权限，默认显示
  if (!value) {
    return true
  }

  // 支持字符串或数组形式的权限
  const permissions = Array.isArray(value) ? value : [value]
  const hasAnyPermission = permissions.some((permission) =>
    permissionManager.hasPermission(permission)
  )

  return hasAnyPermission
}

/**
 * 权限 hook - 返回是否拥有(任一)权限
 * 对应 Vue 指令 v-permission 的判定逻辑
 */
export function useHasPermission(value?: PermissionValue): boolean {
  return checkPermission(value)
}

interface PermissionProps {
  value?: PermissionValue
  children: ReactNode
}

/**
 * 权限包裹组件 - 无权限则不渲染(等价于 Vue 指令隐藏元素)
 */
export function Permission({ value, children }: PermissionProps) {
  if (!checkPermission(value)) {
    return null
  }
  return <>{children}</>
}

export default Permission
