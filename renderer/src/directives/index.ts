// 指令 barrel
// 原 Vue 版本是 app.directive 聚合注册(ButtonCodes/CodesPermission/RolesPermission/permission)。
// React 不需要全局注册指令 → 改为 re-export 各 directive 模块(已转成 hook + 包裹组件)。
//
// Vue 指令 → React 用法对照:
//   v-codes-permission  → useHasCodesPermission(codes) / <CodesPermission value={codes}>
//   v-permission        → useHasPermission(value)      / <Permission value={value}>
//
// 下游可继续按原名 import:
//   import { Permission, useHasPermission } from '@/directives'
//   import { CodesPermission, useHasCodesPermission } from '@/directives'

// codes 权限指令(基于 basic store 的 codes)
export {
  CodesPermission,
  useHasCodesPermission,
  default as ButtonCodesPermission,
} from './codes-permission'

// 注册权限指令(基于 permissionManager)
export { Permission, useHasPermission, default as permission } from './permission'

// TODO(migration): button-codes(基于 basic store 的 buttonCodes)尚未迁移 → 待补 codes-permission 同款 hook/组件
// TODO(migration): roles-permission(基于 basic store 的 roles)尚未迁移 → 待补 codes-permission 同款 hook/组件
