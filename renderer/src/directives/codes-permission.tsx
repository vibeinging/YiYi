// TODO(migration): Vue 指令 v-codes-permission 无 React 等价物，改为 useHasCodesPermission hook + CodesPermission 包裹组件
/**
 * codes 权限指令 - 用于控制元素显示/隐藏(基于 basic store 的 codes)
 * 使用示例(Vue 原版):
 * <button v-codes-permission="['admin','editor']">管理</button>
 *
 * React 用法:
 * const has = useHasCodesPermission(['admin', 'editor'])
 * {has && <button>管理</button>}
 *
 * <CodesPermission value={['admin', 'editor']}><button>管理</button></CodesPermission>
 */

import { type ReactNode } from 'react'
import { useBasicStore } from '@/store/basic'

// 校验是否拥有(任一)codes 权限
function checkPermission(value?: string[]): boolean {
  if (value && Array.isArray(value)) {
    if (value.length > 0) {
      const permissionRoles = value
      // 注：源 store 字段为 codes(此处保持与 Vue 版一致)
      const codes = (useBasicStore.getState() as any).codes as string[] | undefined
      const hasPermission = codes?.some((role) => permissionRoles.includes(role))
      return !!hasPermission
    }
    // 空数组：源逻辑不做移除，默认显示
    return true
  } else {
    throw new Error(`need codes! Like v-codes-permission="['admin','editor']"`)
  }
}

/**
 * codes 权限 hook - 返回是否拥有(任一)codes 权限
 * 对应 Vue 指令 v-codes-permission 的判定逻辑
 */
export function useHasCodesPermission(value?: string[]): boolean {
  return checkPermission(value)
}

interface CodesPermissionProps {
  value?: string[]
  children: ReactNode
}

/**
 * codes 权限包裹组件 - 无权限则不渲染(等价于 Vue 指令移除元素)
 */
export function CodesPermission({ value, children }: CodesPermissionProps) {
  if (!checkPermission(value)) {
    return null
  }
  return <>{children}</>
}

export default CodesPermission
