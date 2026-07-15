import axiosReq from '@/utils/axios-req'

/**
 * MCP Provider 管理 API
 * App 级: /api/agent/mcp_providers 存定义
 * 项目级: /api/projects/{project_id}/mcp_providers 存绑定/启用覆盖
 */

export const listAppMcpProvidersReq = () => {
  return axiosReq({
    url: '/api/agent/mcp_providers',
    method: 'get'
  })
}

export const createAppMcpProviderReq = (payload: any) => {
  return axiosReq({
    url: '/api/agent/mcp_providers',
    data: payload,
    method: 'post'
  })
}

export const updateAppMcpProviderReq = (providerName: any, payload: any) => {
  return axiosReq({
    url: `/api/agent/mcp_providers/${providerName}`,
    data: payload,
    method: 'put'
  })
}

export const toggleAppMcpProviderReq = (providerName: any, payload: any) => {
  return axiosReq({
    url: `/api/agent/mcp_providers/${providerName}/toggle`,
    data: payload,
    method: 'patch'
  })
}

export const deleteAppMcpProviderReq = (providerName: any) => {
  return axiosReq({
    url: `/api/agent/mcp_providers/${providerName}`,
    method: 'delete'
  })
}

export const testAppMcpProviderReq = (payload: any) => {
  return axiosReq({
    url: '/api/agent/mcp_providers/test',
    data: payload,
    method: 'post'
  })
}

export const rediscoverAppMcpProviderReq = (providerName: any) => {
  return axiosReq({
    url: `/api/agent/mcp_providers/${providerName}/rediscover`,
    method: 'post'
  })
}

export const listMcpProvidersReq = (projectId: any) => {
  return axiosReq({
    url: `/api/projects/${projectId}/mcp_providers`,
    method: 'get'
  })
}

export const bindProjectMcpProviderReq = (projectId: any, providerName: any, payload: any) => {
  return axiosReq({
    url: `/api/projects/${projectId}/mcp_providers/${providerName}/binding`,
    data: payload,
    method: 'patch'
  })
}

export const deleteProjectMcpBindingReq = (projectId: any, providerName: any) => {
  return axiosReq({
    url: `/api/projects/${projectId}/mcp_providers/${providerName}`,
    method: 'delete'
  })
}

// 兼容旧调用名:项目级只用于绑定开关,不再更新 Provider 定义。
export const updateMcpProviderReq = (projectId: any, providerName: any, payload: any) => {
  return bindProjectMcpProviderReq(projectId, providerName, payload)
}

export const deleteMcpProviderReq = (projectId: any, providerName: any) => {
  return deleteProjectMcpBindingReq(projectId, providerName)
}

export const testMcpProviderReq = (_projectId: any, payload: any) => {
  return testAppMcpProviderReq(payload)
}

export const rediscoverMcpProviderReq = (_projectId: any, providerName: any) => {
  return rediscoverAppMcpProviderReq(providerName)
}
