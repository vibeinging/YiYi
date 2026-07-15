import axiosReq from '@/utils/axios-req'

// ============ 用户认证接口 ============

export const loginReq = (subForm: any) => axiosReq({ url: '/api/user/login', data: subForm, method: 'post' })

// 桌面普通版「下载即用」免登录:以内置用户(local_user)登录。
// 桌面 Node 后端支持此端点;云后端无此端点(404)→ isNotTipErrorMsg 静默,守卫回退登录页。
export const builtinLoginReq = () =>
  axiosReq({ url: '/api/user/builtin-login', method: 'get', isNotTipErrorMsg: true })

export const registerReq = (subForm: any) => axiosReq({ url: '/api/user/register', data: subForm, method: 'post' })

export const verifyInviteKeyReq = (inviteKey: any) =>
  axiosReq({ url: '/api/user/verify-invite-link', data: { invite_code: inviteKey }, method: 'post' })

export const loginOutReq = () => axiosReq({ url: '/api/user/logout', method: 'post' })

// ============ 用户信息接口 ============

export const getUserProfileReq = () => axiosReq({ url: '/api/user/me', method: 'get' })

export const updateUserProfileReq = (data: any) => axiosReq({ url: '/api/user/me', data, method: 'put' })

export const changePasswordReq = (data: any) =>
  axiosReq({
    url: '/api/user/change-password',
    data: { old_password: data.old_password, new_password: data.new_password },
    method: 'post'
  })

// ============ 管理员接口 ============

export const getUserListReq = (params: any) => axiosReq({ url: '/api/user/admin/users', params, method: 'get' })

export const updateUserStatusReq = (userId: any, isActive: any) =>
  axiosReq({ url: `/api/user/admin/users/${userId}`, method: 'put', data: { is_active: isActive } })

export const updateUserPermissionsReq = (userId: any, data: any) =>
  axiosReq({ url: `/api/user/admin/users/${userId}/permissions`, data, method: 'put' })

export const searchUsersReq = (params: any) => axiosReq({ url: '/api/user/admin/users', params, method: 'get' })

// ============ 邀请链接接口 ============

export const getInviteLinksReq = (params: any) => axiosReq({ url: '/api/user/admin/invite-links', params, method: 'get' })

export const createInviteLinkReq = (data: any) => axiosReq({ url: '/api/user/admin/invite-links', data, method: 'post' })

export const revokeInviteLinkReq = (linkId: any) =>
  axiosReq({ url: `/api/user/admin/invite-links/${linkId}/revoke`, method: 'post' })

export const restoreInviteLinkReq = (linkId: any) =>
  axiosReq({ url: `/api/user/admin/invite-links/${linkId}/restore`, method: 'post' })

export const deleteInviteLinkReq = (linkId: any) =>
  axiosReq({ url: `/api/user/admin/invite-links/${linkId}`, method: 'delete' })
