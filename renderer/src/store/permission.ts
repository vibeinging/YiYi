import { create } from 'zustand'
import { permissionManager, type UserRole } from '@/permission/index'

export interface PermissionState {
  userRole: UserRole | null
  permissions: string[]
  isLoading: boolean
  lastUpdated: string | null
  refreshPermissions: () => Promise<void>
  clearPermissions: () => void
  checkPermission: (permission: string) => boolean
  notifyPermissionChanged: () => void
}

export const usePermissionStore = create<PermissionState>((set, get) => ({
  userRole: null,
  permissions: [],
  isLoading: false,
  lastUpdated: null,

  refreshPermissions: async () => {
    set({ isLoading: true })
    try {
      const userRole = permissionManager.getUserRole()
      set({
        userRole,
        permissions: userRole.permissions || [],
        lastUpdated: new Date().toISOString()
      })
    } finally {
      set({ isLoading: false })
    }
  },
  clearPermissions: () => {
    permissionManager.clearCache()
    set({ userRole: null, permissions: [], lastUpdated: null })
  },
  checkPermission: (permission) => permissionManager.hasPermission(permission),
  notifyPermissionChanged: () => {
    get().clearPermissions()
    get().refreshPermissions()
  }
}))

/** 派生 getter（对齐 Pinia getters） */
export const permissionGetters = {
  userRoleType: (s: PermissionState) => s.userRole?.type || 'unassigned',
  userRoleName: (s: PermissionState) => s.userRole?.name || '未知',
  isAdmin: (s: PermissionState) => s.userRole?.type === 'admin',
  isOwner: (s: PermissionState) => s.userRole?.type === 'owner',
  hasAnyManagePermission: (s: PermissionState) =>
    ['data_manage', 'model_service_manage', 'member_manage'].some((p) => s.permissions.includes(p))
}
