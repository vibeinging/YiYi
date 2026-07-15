import axiosReq from '@/utils/axios-req'

/**
 * 获取项目的 Skill 列表
 */
export function listSkillsReq(projectId: any) {
  return axiosReq({
    url: `/api/projects/${projectId}/skills`,
    method: 'get'
  })
}

/**
 * 获取 Skill 详情
 */
export function getSkillDetailReq(projectId: any, skillName: any) {
  return axiosReq({
    url: `/api/projects/${projectId}/skills/${skillName}`,
    method: 'get'
  })
}

/**
 * 创建 Skill
 */
export function createSkillReq(projectId: any, data: any) {
  return axiosReq({
    url: `/api/projects/${projectId}/skills`,
    method: 'post',
    data
  })
}

/**
 * 更新 Skill
 */
export function updateSkillReq(projectId: any, skillName: any, data: any) {
  return axiosReq({
    url: `/api/projects/${projectId}/skills/${skillName}`,
    method: 'put',
    data
  })
}

/**
 * 删除 Skill
 */
export function deleteSkillReq(projectId: any, skillName: any) {
  return axiosReq({
    url: `/api/projects/${projectId}/skills/${skillName}`,
    method: 'delete'
  })
}

/**
 * 获取系统可用的工具列表
 */
export function getAvailableToolsReq(projectId: any) {
  return axiosReq({
    url: `/api/projects/${projectId}/skills/available-tools`,
    method: 'get'
  })
}

/**
 * AI 辅助生成 Skill 配置
 */
export function aiGenerateSkillReq(projectId: any, data: any) {
  return axiosReq({
    url: `/api/projects/${projectId}/skills/ai-generate`,
    method: 'post',
    data
  })
}

/**
 * 启用/禁用 Skill
 */
export function toggleSkillReq(projectId: any, skillName: any, data: any) {
  return axiosReq({
    url: `/api/projects/${projectId}/skills/${skillName}/toggle`,
    method: 'patch',
    data
  })
}

/**
 * 获取已启用的 Skill 列表
 */
export function getEnabledSkillsReq(projectId: any) {
  return axiosReq({
    url: `/api/projects/${projectId}/skills/enabled/list`,
    method: 'get'
  })
}

/**
 * App 级 Skill 列表
 */
export function listAppSkillsReq() {
  return axiosReq({
    url: '/api/agent/skills',
    method: 'get'
  })
}

export function getAppSkillDetailReq(skillName: any) {
  return axiosReq({
    url: `/api/agent/skills/${skillName}`,
    method: 'get'
  })
}

export function createAppSkillReq(data: any) {
  return axiosReq({
    url: '/api/agent/skills',
    method: 'post',
    data
  })
}

export function updateAppSkillReq(skillName: any, data: any) {
  return axiosReq({
    url: `/api/agent/skills/${skillName}`,
    method: 'put',
    data
  })
}

export function deleteAppSkillReq(skillName: any) {
  return axiosReq({
    url: `/api/agent/skills/${skillName}`,
    method: 'delete'
  })
}

export function getAppAvailableToolsReq() {
  return axiosReq({
    url: '/api/agent/skills/available-tools',
    method: 'get'
  })
}

export function aiGenerateAppSkillReq(data: any) {
  return axiosReq({
    url: '/api/agent/skills/ai-generate',
    method: 'post',
    data
  })
}

export function toggleAppSkillReq(skillName: any, data: any) {
  return axiosReq({
    url: `/api/agent/skills/${skillName}/toggle`,
    method: 'patch',
    data
  })
}

export function getEnabledAppSkillsReq() {
  return axiosReq({
    url: '/api/agent/skills/enabled/list',
    method: 'get'
  })
}
