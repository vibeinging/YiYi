/**
 * 调试用权限配置
 * 后端完成后删除此文件，改为从后端获取真实权限
 */

// 是否启用调试模式（生产环境必须为false）
export const DEBUG_AUTH_ENABLED = false

// 调试用户类型 - 修改这里切换不同角色进行测试
// 可选值: 'system_admin' | 'project_admin' | 'data_analyst' | 'viewer' | 'invited_user'
export const DEBUG_USER_TYPE = 'system_admin'

// 用户类型配置
const USER_TYPES: any = {
  // 系统管理员 - 拥有所有权限
  system_admin: {
    is_admin: true,
    can_create_project: true,
    // 在所有项目中都是项目管理员
    default_role: 'project_admin'
  },

  // 项目管理员 - 可创建项目，在项目内拥有全部权限
  project_admin: {
    is_admin: false,
    can_create_project: true,
    default_role: 'project_admin'
  },

  // 数据分析师 - 可创建项目，在项目内可配置数据和问数
  data_analyst: {
    is_admin: false,
    can_create_project: true,
    default_role: 'data_analyst'
  },

  // 查看者 - 不能创建项目，在项目内仅可问数
  viewer: {
    is_admin: false,
    can_create_project: false,
    default_role: 'viewer'
  },

  // 普通用户 - 不能创建项目，需要被邀请加入项目
  invited_user: {
    is_admin: false,
    can_create_project: false,
    default_role: 'viewer'
  }
}

// 角色权限定义
export const ROLE_PERMISSIONS: any = {
  project_admin: {
    id: 'role-001',
    name: '项目管理员',
    description: '拥有项目内所有权限',
    permissions: [
      'ask_data',
      'datasource_manage',
      'business_manage',
      'model_service_manage',
      'report_manage',
      'member_manage'
    ],
    is_system: true
  },
  data_analyst: {
    id: 'role-002',
    name: '数据分析师',
    description: '可配置数据和问数',
    permissions: ['ask_data', 'datasource_manage', 'business_manage'],
    is_system: true
  },
  report_creator: {
    id: 'role-003',
    name: '报表制作者',
    description: '可问数和创建报表',
    permissions: ['ask_data', 'report_manage'],
    is_system: true
  },
  viewer: {
    id: 'role-004',
    name: '查看者',
    description: '仅可问数',
    permissions: ['ask_data'],
    is_system: true
  }
}

// 获取当前调试用户的系统权限
export function getDebugSystemPermissions() {
  if (!DEBUG_AUTH_ENABLED) return null

  const userType = USER_TYPES[DEBUG_USER_TYPE]
  return {
    is_admin: userType.is_admin,
    can_create_project: userType.can_create_project
  }
}

// 获取当前调试用户在项目中的角色
export function getDebugProjectRole() {
  if (!DEBUG_AUTH_ENABLED) return null

  const userType = USER_TYPES[DEBUG_USER_TYPE]
  return ROLE_PERMISSIONS[userType.default_role]
}

// 检查当前调试用户是否有某个项目权限
export function hasDebugPermission(permission: any) {
  if (!DEBUG_AUTH_ENABLED) return false

  const userType = USER_TYPES[DEBUG_USER_TYPE]

  // 系统管理员拥有所有权限
  if (userType.is_admin) return true

  const role = ROLE_PERMISSIONS[userType.default_role]
  return role.permissions.includes(permission)
}

// 所有角色列表（用于下拉选择）
export function getAllRoles() {
  return Object.values(ROLE_PERMISSIONS)
}
