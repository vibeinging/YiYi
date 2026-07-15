/**
 * 业务 API 密钥管理 API
 */
import request from '@/utils/axios-req'

/**
 * 列出业务的所有 API Key
 */
export function listApiKeys(businessId: any, projectId: any, isActive: any = null) {
  const params: any = { project_id: projectId }
  if (isActive !== null) {
    params.is_active = isActive
  }
  return request({
    url: `/api/businesses/${businessId}/api-keys`,
    method: 'get',
    params
  })
}

/**
 * 创建 API Key
 */
export function createApiKey(businessId: any, projectId: any, data: any) {
  return request({
    url: `/api/businesses/${businessId}/api-keys`,
    method: 'post',
    params: { project_id: projectId },
    data
  })
}

/**
 * 获取 API Key 详情
 */
export function getApiKey(businessId: any, keyId: any, projectId: any) {
  return request({
    url: `/api/businesses/${businessId}/api-keys/${keyId}`,
    method: 'get',
    params: { project_id: projectId }
  })
}

/**
 * 更新 API Key
 */
export function updateApiKey(businessId: any, keyId: any, projectId: any, data: any) {
  return request({
    url: `/api/businesses/${businessId}/api-keys/${keyId}`,
    method: 'put',
    params: { project_id: projectId },
    data
  })
}

/**
 * 删除 API Key
 */
export function deleteApiKey(businessId: any, keyId: any, projectId: any) {
  return request({
    url: `/api/businesses/${businessId}/api-keys/${keyId}`,
    method: 'delete',
    params: { project_id: projectId }
  })
}

/**
 * 启用/禁用 API Key
 */
export function toggleApiKey(businessId: any, keyId: any, projectId: any, isActive: any) {
  return request({
    url: `/api/businesses/${businessId}/api-keys/${keyId}/toggle`,
    method: 'post',
    params: {
      project_id: projectId,
      is_active: isActive
    }
  })
}

/**
 * 重新生成 API Key
 */
export function regenerateApiKey(businessId: any, keyId: any, projectId: any) {
  return request({
    url: `/api/businesses/${businessId}/api-keys/${keyId}/regenerate`,
    method: 'post',
    params: { project_id: projectId }
  })
}

/**
 * 批量启用所有 Key
 */
export function batchEnableKeys(businessId: any, projectId: any) {
  return request({
    url: `/api/businesses/${businessId}/api-keys/batch-enable`,
    method: 'post',
    params: { project_id: projectId }
  })
}

/**
 * 批量禁用所有 Key
 */
export function batchDisableKeys(businessId: any, projectId: any) {
  return request({
    url: `/api/businesses/${businessId}/api-keys/batch-disable`,
    method: 'post',
    params: { project_id: projectId }
  })
}
