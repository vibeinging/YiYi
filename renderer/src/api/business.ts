import request from '@/utils/axios-req'

// ==================== 业务管理API ====================

// 获取业务列表（分页）
export function getBusinessListReq(projectId: any, page: any = 1, pageSize: any = 20) {
  return request({
    url: `/api/projects/${projectId}/businesses`,
    method: 'get',
    params: {
      page,
      page_size: pageSize
    }
  })
}

// 创建业务
export function createBusinessReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/businesses`,
    method: 'post',
    data
  })
}

// 获取业务详情
export function getBusinessDetailReq(projectId: any, businessId: any) {
  return request({
    url: `/api/projects/${projectId}/business`,
    method: 'get'
  })
}

// 更新业务
export function updateBusinessReq(projectId: any, businessId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/business`,
    method: 'put',
    data
  })
}

// 删除业务
export function deleteBusinessReq(projectId: any, businessId: any) {
  return request({
    url: `/api/projects/${projectId}/business`,
    method: 'delete'
  })
}

// ==================== 数据源管理API ====================

// 获取业务关联的数据源列表
export function getBusinessDataSourcesReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/data-sources`,
    method: 'get'
  })
}

// 添加数据源到业务
export function addDataSourceToBusinessReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/data-sources`,
    method: 'post',
    data
  })
}

// 从业务移除数据源
export function removeDataSourceFromBusinessReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/data-sources`,
    method: 'delete',
    data
  })
}

// ==================== 实体配置引用管理API ====================

// 获取已引用的实体配置列表
export function getEntityRefsReq(projectId: any, params: any = {}) {
  return request({
    url: `/api/projects/${projectId}/entity_refs`,
    method: 'get',
    params
  })
}

// 获取可引用的实体配置（来自关联数据源）
export function getAvailableEntityConfigsReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/entity_refs/available`,
    method: 'get'
  })
}

// 添加实体配置引用
export function addEntityRefsReq(projectId: any, entityConfigIds: any) {
  return request({
    url: `/api/projects/${projectId}/entity_refs`,
    method: 'post',
    data: { entity_config_ids: entityConfigIds }
  })
}

// 移除实体配置引用
export function removeEntityRefReq(projectId: any, refId: any) {
  return request({
    url: `/api/projects/${projectId}/entity_refs/${refId}`,
    method: 'delete'
  })
}

// 切换实体引用启用状态
export function toggleEntityRefActiveReq(projectId: any, refId: any, isActive: any) {
  return request({
    url: `/api/projects/${projectId}/entity_refs/${refId}/active`,
    method: 'patch',
    data: { is_active: isActive }
  })
}
