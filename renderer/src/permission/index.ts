/**
 * 统一权限管理中心(对齐原 src/permission/index.js)。
 * React 版差异：store 改用 zustand，imperative 访问走 useXStore.getState()。
 */
import { useBasicStore } from '@/store/basic'
import { useProjectStore } from '@/store/project'

export const PERMISSIONS = {
  ASK_DATA: 'ask_data',
  DATA_MANAGE: 'data_manage',
  MODEL_SERVICE_MANAGE: 'model_service_manage',
  REPORT_MANAGE: 'report_manage',
  MEMBER_MANAGE: 'member_manage'
} as const

export interface UserRole {
  type: 'admin' | 'owner' | 'member' | 'guest'
  name: string
  level: 'system' | 'project' | 'none'
  permissions?: string[]
}

class PermissionManager {
  private _cache = new Map<string, { value: boolean; timestamp: number }>()
  private _cacheTimeout = 5000
  private _lastUserContext: string | null = null

  hasPermission(permission?: string): boolean {
    if (!permission) return true
    const cacheKey = `perm_${permission}_${this._getUserContextKey()}`
    const cached = this._cache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < this._cacheTimeout) return cached.value
    const result = this._checkPermission(permission)
    this._cache.set(cacheKey, { value: result, timestamp: Date.now() })
    return result
  }

  hasAnyPermission(permissions?: string[]): boolean {
    if (!permissions?.length) return true
    return permissions.some((p) => this.hasPermission(p))
  }

  hasAllPermissions(permissions?: string[]): boolean {
    if (!permissions?.length) return true
    return permissions.every((p) => this.hasPermission(p))
  }

  private _checkPermission(permission: string): boolean {
    const basic = useBasicStore.getState()
    const project = useProjectStore.getState()
    if (basic.userInfo?.is_admin) return true
    if (project.currentProject?.is_owner) return true
    const permissions = project.currentProject?.permissions || []
    return permissions.includes(permission)
  }

  isAdmin(): boolean {
    return !!useBasicStore.getState().userInfo?.is_admin
  }

  canCreateProject(): boolean {
    return useBasicStore.getState().userInfo?.can_create_project || this.isAdmin()
  }

  getUserRole(): UserRole {
    const basic = useBasicStore.getState()
    const project = useProjectStore.getState()
    if (basic.userInfo?.is_admin) return { type: 'admin', name: '系统管理员', level: 'system' }
    if (project.currentProject?.is_owner) return { type: 'owner', name: '项目负责人', level: 'project' }
    const cur = project.currentProject
    if (cur?.role) {
      return {
        type: 'member',
        name: (cur as any).role_name || '项目成员',
        level: 'project',
        permissions: cur.permissions || []
      }
    }
    return { type: 'guest', name: '访客', level: 'none' }
  }

  clearCache(): void {
    this._cache.clear()
    this._lastUserContext = null
  }

  private _getUserContextKey(): string {
    const basic = useBasicStore.getState()
    const project = useProjectStore.getState()
    const currentContext = `${basic.userInfo?.username}_${project.currentProject?.id || 'none'}`
    if (this._lastUserContext && this._lastUserContext !== currentContext) this.clearCache()
    this._lastUserContext = currentContext
    return currentContext
  }
}

export const permissionManager = new PermissionManager()

export const hasPermission = (p?: string) => permissionManager.hasPermission(p)
export const hasAnyPermission = (p?: string[]) => permissionManager.hasAnyPermission(p)
export const hasAllPermissions = (p?: string[]) => permissionManager.hasAllPermissions(p)
export const isAdmin = () => permissionManager.isAdmin()
export const canCreateProject = () => permissionManager.canCreateProject()
export const getUserRole = () => permissionManager.getUserRole()
export const clearPermissionCache = () => permissionManager.clearCache()
