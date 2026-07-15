import axiosReq from '@/utils/axios-req'

// ============ 项目接口 ============

export const getMyProjectsReq = (params: any = {}) => axiosReq({ url: '/api/projects', method: 'get', params })

export const getProjectDetailReq = (projectId: any) => axiosReq({ url: `/api/projects/${projectId}`, method: 'get' })

export const createProjectReq = (data: any) => axiosReq({ url: '/api/projects', data, method: 'post' })

export const updateProjectReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}`, data, method: 'put' })

export const deleteProjectReq = (projectId: any) => axiosReq({ url: `/api/projects/${projectId}`, method: 'delete' })

// 桌面端:确保项目本地工作区目录存在并用系统文件管理器打开
export const openProjectFolderReq = (projectId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/open-folder`, method: 'post' })

// 桌面端:获取当前工作区有效目录(跟随自定义位置)
export const getProjectWorkspaceDirReq = (projectId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/workspace-dir`, method: 'get' })

// 桌面端:更换工作区位置
export const setProjectWorkspaceDirReq = (projectId: any, path: string) =>
  axiosReq({ url: `/api/projects/${projectId}/workspace-dir`, method: 'put', data: { path } })

export const getAllProjectsReq = (params: any) => axiosReq({ url: '/api/projects/all', method: 'get', params })

// ============ 项目成员接口 ============

export const getProjectMembersReq = (projectId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/members`, method: 'get' })

export const addProjectMemberReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}/members`, data, method: 'post' })

export const updateMemberRoleReq = (projectId: any, userId: any, data: any) =>
  axiosReq({
    url: `/api/projects/${projectId}/members/${userId}`,
    data: { role_id: data.role_id, is_owner: data.is_owner },
    method: 'put'
  })

export const removeProjectMemberReq = (projectId: any, userId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/members/${userId}`, method: 'delete' })

export const transferProjectOwnershipReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}/transfer-ownership`, method: 'post', data })

// ============ 角色接口 ============

let rolesCache: any = null
let rolesLoadingPromise: Promise<any> | null = null

export const getRolesReq = (params: any = {}) => axiosReq({ url: '/api/projects/roles/list', method: 'get', params })

export const getRolesCachedReq = async () => {
  if (rolesCache) return { data: rolesCache }
  if (rolesLoadingPromise) return rolesLoadingPromise
  rolesLoadingPromise = getRolesReq()
  try {
    const res: any = await rolesLoadingPromise
    rolesCache = res.data || []
    return res
  } finally {
    rolesLoadingPromise = null
  }
}

export const clearRolesCache = () => {
  rolesCache = null
}

export const getRoleDetailReq = (roleId: any) => axiosReq({ url: `/api/projects/roles/${roleId}`, method: 'get' })

export const createRoleReq = (data: any) => axiosReq({ url: '/api/projects/roles', method: 'post', data })

export const updateRoleReq = (roleId: any, data: any) =>
  axiosReq({ url: `/api/projects/roles/${roleId}`, method: 'put', data })

export const deleteRoleReq = (roleId: any) => axiosReq({ url: `/api/projects/roles/${roleId}`, method: 'delete' })

// ============ 项目邀请链接接口 ============

export const createInviteLinkReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}/invite-links`, method: 'post', data })

export const getInviteLinksReq = (projectId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/invite-links`, method: 'get' })

export const revokeInviteLinkReq = (projectId: any, linkId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/invite-links/${linkId}/revoke`, method: 'post' })

export const deleteInviteLinkReq = (projectId: any, linkId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/invite-links/${linkId}`, method: 'delete' })

export const verifyProjectInviteReq = (code: any) => axiosReq({ url: `/api/projects/join/${code}/verify`, method: 'get' })

export const joinProjectByInviteReq = (code: any) => axiosReq({ url: `/api/projects/join/${code}`, method: 'post' })

// ============ 项目自定义模型接口 ============

export const getProjectModelsReq = (projectId: any, params: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models`, method: 'get', params })

export const createProjectModelReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models`, method: 'post', data })

export const updateProjectModelReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models`, method: 'put', data })

export const deleteProjectModelReq = (projectId: any, modelId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models/${modelId}`, method: 'delete' })

// ============ 项目开放访问接口 ============

export const setProjectOpenReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}/open`, method: 'put', data })

export const getOpenProjectsReq = (params: any) => axiosReq({ url: '/api/projects/open', method: 'get', params })
