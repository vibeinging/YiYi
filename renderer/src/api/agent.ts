import request from '@/utils/axios-req'

// 获取Agent类型配置（默认prompt等）
export function getAgentTypesConfig() {
  return request({
    url: '/api/agents/types/config',
    method: 'get'
  })
}

// 获取Agent配置（按类型和业务）
export function getAgentConfig(projectId: any, agentType: any) {
  return request({
    url: `/api/agents/projects/${projectId}/agents/config/${agentType}`,
    method: 'get'
  })
}

// 保存Agent配置
export function saveAgentConfig(projectId: any, data: any) {
  return request({
    url: `/api/agents/projects/${projectId}/agents/config`,
    method: 'post',
    data
  })
}

// 获取Agent详情（按ID）
export function getAgentDetail(projectId: any, agentId: any) {
  return request({
    url: `/api/agents/projects/${projectId}/agents/detail/${agentId}`,
    method: 'get'
  })
}

// 删除Agent配置
export function deleteAgentConfig(projectId: any, agentId: any) {
  return request({
    url: `/api/agents/projects/${projectId}/agents/detail/${agentId}`,
    method: 'delete'
  })
}

// 切换Agent启用/停用状态
export function toggleAgentActive(projectId: any, agentType: any, isActive: any) {
  return request({
    url: `/api/agents/projects/${projectId}/agents/config/${agentType}/toggle`,
    method: 'patch',
    params: {
      is_active: isActive
    }
  })
}
