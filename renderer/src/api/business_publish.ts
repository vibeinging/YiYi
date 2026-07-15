/**
 * 业务发布配置 API
 */
import request from '@/utils/axios-req'

/**
 * 获取业务发布配置
 */
export function getPublishConfig(businessId: any, projectId: any) {
  return request({
    url: `/api/businesses/${businessId}/publish`,
    method: 'get',
    params: { project_id: projectId }
  })
}

/**
 * 创建或更新发布配置
 */
export function createOrUpdatePublishConfig(businessId: any, projectId: any, data: any) {
  return request({
    url: `/api/businesses/${businessId}/publish`,
    method: 'post',
    params: { project_id: projectId },
    data
  })
}

/**
 * 重新生成 API 密钥
 */
export function regenerateApiKey(businessId: any, projectId: any) {
  return request({
    url: `/api/businesses/${businessId}/publish/regenerate-key`,
    method: 'post',
    params: { project_id: projectId }
  })
}

/**
 * 切换发布状态
 */
export function togglePublishStatus(businessId: any, projectId: any, isPublished: any) {
  return request({
    url: `/api/businesses/${businessId}/publish/toggle`,
    method: 'post',
    params: {
      project_id: projectId,
      is_published: isPublished
    }
  })
}
