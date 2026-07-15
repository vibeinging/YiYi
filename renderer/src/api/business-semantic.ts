import request from '@/utils/axios-req'

// ==================== 指标管理 API ====================

// 创建指标
export function createMetricReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metrics`,
    method: 'post',
    data
  })
}

// 获取指标列表（分页）
export function getMetricsReq(projectId: any, page = 1, pageSize = 20, activeOnly = false) {
  return request({
    url: `/api/projects/${projectId}/metrics`,
    method: 'get',
    params: { page, page_size: pageSize, active_only: activeOnly }
  })
}

// 更新指标
export function updateMetricReq(projectId: any, metricId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metrics/${metricId}`,
    method: 'put',
    data
  })
}

// 删除指标
export function deleteMetricReq(projectId: any, metricId: any) {
  return request({
    url: `/api/projects/${projectId}/metrics/${metricId}`,
    method: 'delete'
  })
}

// 批量删除指标（deleteAll=true 时删除该业务下全部指标）
export function deleteMetricsReq(projectId: any, { metricIds = null, deleteAll = false }: any = {}) {
  const data = deleteAll ? { delete_all: true } : { metric_ids: metricIds }
  return request({
    url: `/api/projects/${projectId}/metrics`,
    method: 'delete',
    data
  })
}

export function getMetricEmbeddingPendingCountReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/metrics/embedding_pending_count`,
    method: 'get'
  })
}

// metricId 不传或传 null：全业务分批向量化；timeout=0 关闭浏览器端限制（大规模需同步调大网关 read_timeout）
export function generateMetricEmbeddingsReq(projectId: any, metricId: any = null) {
  const params = metricId ? { metric_id: metricId } : {}
  const cfg = !metricId ? { timeout: 0 } : {}
  return request({
    url: `/api/projects/${projectId}/metrics/generate_embeddings`,
    method: 'post',
    params,
    ...cfg
  })
}

export function bulkImportMetricsReq(projectId: any, sourceId: any, sourceType: any, file: any, overwrite = false) {
  const formData = new FormData()
  formData.append('file', file)
  return request({
    url: `/api/projects/${projectId}/metrics/bulk_import`,
    method: 'post',
    params: {
      source_id: sourceId || '',
      source_type: sourceType || '',
      overwrite
    },
    data: formData,
    headers: { 'Content-Type': 'multipart/form-data' }
  })
}

// 搜索指标
export function searchMetricsReq(projectId: any, query: any, limit = 5) {
  return request({
    url: `/api/projects/${projectId}/metrics/search`,
    method: 'get',
    params: { query, limit }
  })
}

// ==================== 样例数据 API ====================

// 创建样例
export function createExamplesReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/examples`,
    method: 'post',
    data
  })
}

// 获取样例列表
export function getExamplesReq(projectId: any, page = 1, pageSize = 20, exampleType: any = null) {
  return request({
    url: `/api/projects/${projectId}/examples`,
    method: 'get',
    params: {
      page,
      page_size: pageSize,
      ...(exampleType ? { example_type: exampleType } : {})
    }
  })
}

// 获取样例统计
export function getExamplesStatsReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/examples/stats`,
    method: 'get'
  })
}

// 更新样例
export function updateExampleReq(projectId: any, exampleId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/examples/${exampleId}`,
    method: 'put',
    data
  })
}

// 删除样例
export function deleteExamplesReq(projectId: any, exampleIds: any) {
  return request({
    url: `/api/projects/${projectId}/examples`,
    method: 'delete',
    data: { example_ids: exampleIds }
  })
}

// 搜索样例
export function searchExamplesReq(projectId: any, query: any, exampleType: any = null, limit = 5) {
  return request({
    url: `/api/projects/${projectId}/examples/search`,
    method: 'post',
    params: {
      query,  // query 是字符串
      limit,
      ...(exampleType ? { example_type: exampleType } : {})
    }
  })
}

// 生成样例向量（支持单个样例或全部）
export function generateExampleEmbeddingsReq(projectId: any, exampleId: any = null, exampleType: any = null) {
  return request({
    url: `/api/projects/${projectId}/examples/generate_embeddings`,
    method: 'post',
    params: {
      ...(exampleId ? { example_id: exampleId } : {}),
      ...(exampleType ? { example_type: exampleType } : {})
    }
  })
}

// ==================== 标准名词配置 API ====================

// 获取名词配置列表（分页）
export function getEntityConfigsReq(projectId: any, page = 1, pageSize = 20, tableName: any = null) {
  return request({
    url: `/api/projects/${projectId}/entity_configs`,
    method: 'get',
    params: {
      page,
      page_size: pageSize,
      ...(tableName ? { table_name: tableName } : {})
    }
  })
}

// 创建名词配置（从数据库提取）
export function createEntityConfigReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/entity_configs`,
    method: 'post',
    data
  })
}

// 更新名词配置
export function updateEntityConfigReq(projectId: any, configId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/entity_configs/${configId}`,
    method: 'put',
    data
  })
}

// 删除名词配置
export function deleteEntityConfigReq(projectId: any, configId: any) {
  return request({
    url: `/api/projects/${projectId}/entity_configs/${configId}`,
    method: 'delete'
  })
}

// 生成名词向量
export function generateEntityEmbeddingsReq(projectId: any, configId: any = null) {
  return request({
    url: `/api/projects/${projectId}/entity_configs/generate_embeddings`,
    method: 'post',
    params: configId ? { config_id: configId } : {}
  })
}

// ==================== 标准名词 API ====================

// 获取名词列表（分页）
export function getEntitiesReq(projectId: any, page = 1, pageSize = 20, configId: any = null) {
  return request({
    url: `/api/projects/${projectId}/entities`,
    method: 'get',
    params: {
      page,
      page_size: pageSize,
      ...(configId ? { config_id: configId } : {})
    }
  })
}

// 删除名词
export function deleteEntitiesReq(projectId: any, entityIds: any) {
  return request({
    url: `/api/projects/${projectId}/entities`,
    method: 'delete',
    data: { entity_ids: entityIds }
  })
}

// 搜索名词
export function searchEntitiesReq(projectId: any, query: any, limit = 10) {
  return request({
    url: `/api/projects/${projectId}/entities/search`,
    method: 'post',
    params: { query, limit }
  })
}

// 从 Excel/JSON 导入名词
export function importEntitiesFromExcelReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/entities/import_excel`,
    method: 'post',
    data
  })
}

// 创建字段名词
// columns: [{ column_name: string, description?: string }]
// sourceType: 'database' 或 'structured'
export function createColumnNameEntitiesReq(projectId: any, tableId: any, sourceType: any, columns: any) {
  return request({
    url: `/api/projects/${projectId}/entity_mappings/column_names`,
    method: 'post',
    data: {
      table_id: tableId,
      source_type: sourceType,
      columns
    },
    timeout: 300000 // 5分钟超时
  })
}

// 测试名词Agent替换
export function testEntityAgentReq(projectId: any, question: any) {
  return request({
    url: `/api/projects/${projectId}/entity_mappings/test_agent`,
    method: 'post',
    data: {
      question
    },
    timeout: 300000 // 5分钟超时
  })
}

// 批量撤销自动生成的实体配置(AgenticSearch fb_search fallback promote 出来的)
// 2026-05-31 D.3 — 后端 EntityMappingConfig.auto_promoted 字段 + API 待 PR1-5 整改后落地
// 前端先调真实 endpoint,后端 404 时 UI 优雅降级("功能开发中"),后端落地后无需前端改动
export function batchRevertAutoPromotedEntitiesReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/entity_mappings/revert_auto_promoted`,
    method: 'post',
    timeout: 60000
  })
}

// ==================== 指标视图定义 API ====================

export function createMetricViewReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views`,
    method: 'post',
    data
  })
}

export function previewMetricViewReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/preview`,
    method: 'post',
    data
  })
}

export function getMetricViewsReq(projectId: any, page = 1, pageSize = 20, activeOnly = false, sourceId: any = null, status: any = null) {
  return request({
    url: `/api/projects/${projectId}/metric-views`,
    method: 'get',
    params: {
      page,
      page_size: pageSize,
      active_only: activeOnly,
      ...(sourceId ? { source_id: sourceId } : {}),
      ...(status ? { status } : {})
    }
  })
}

export function getMetricViewDetailReq(projectId: any, metricViewId: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/${metricViewId}`,
    method: 'get'
  })
}

export function updateMetricViewReq(projectId: any, metricViewId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/${metricViewId}`,
    method: 'put',
    data
  })
}

export function deleteMetricViewReq(projectId: any, metricViewId: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/${metricViewId}`,
    method: 'delete'
  })
}

export function generateMetricViewEmbeddingsReq(projectId: any, metricViewId: any = null) {
  return request({
    url: `/api/projects/${projectId}/metric-views/embeddings`,
    method: 'post',
    params: metricViewId ? { metric_view_id: metricViewId } : {}
  })
}

// 查询列的 DISTINCT 值（支持模糊搜索）
export function getColumnDistinctValuesReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/column-distinct-values`,
    method: 'post',
    data
  })
}

// ==================== 指标状态管理 API ====================

// 更新单个指标的启用/禁用状态
export function updateMetricStatusReq(projectId: any, metricId: any, isActive: any) {
  return request({
    url: `/api/projects/${projectId}/metrics/${metricId}/status`,
    method: 'patch',
    data: { is_active: isActive }
  })
}

// 批量更新指标的启用/禁用状态
export function batchUpdateMetricsStatusReq(projectId: any, metricIds: any, isActive: any) {
  return request({
    url: `/api/projects/${projectId}/metrics/batch_update_status`,
    method: 'patch',
    data: { metric_ids: metricIds, is_active: isActive }
  })
}

// ==================== 指标码值管理 API ====================

// 从Excel导入指标码值配置
export function importCodeValuesReq(projectId: any, sourceId: any, sourceType: any, file: any, importFormat = 'by-metric') {
  const formData = new FormData()
  formData.append('file', file)
  return request({
    url: `/api/projects/${projectId}/metrics/code_values/import`,
    method: 'post',
    params: {
      source_id: sourceId,
      source_type: sourceType,
      import_format: importFormat
    },
    data: formData,
    headers: { 'Content-Type': 'multipart/form-data' }
  })
}

// 导出指标码值配置（Excel或JSON）
export function exportCodeValuesReq(projectId: any, sourceId: any = null, sourceType: any = null, exportType = 'excel', exportFormat = 'by-metric') {
  return request({
    url: `/api/projects/${projectId}/metrics/code_values/export`,
    method: 'get',
    params: {
      source_id: sourceId,
      source_type: sourceType,
      export_type: exportType,
      export_format: exportFormat
    },
    responseType: exportType === 'json' ? 'json' : 'blob'
  })
}


// ==================== 业务视图智能推荐 API ====================

// 切换业务视图状态: draft / active / inactive
export function updateMetricViewStatusReq(projectId: any, metricViewId: any, status: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/${metricViewId}/status`,
    method: 'patch',
    data: { status }
  })
}

// 发起智能推荐(立即返回 task_id,LLM 分析在后台推进,前端用 task_id 轮询)
export function runMetricViewRecommendationReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/recommendations`,
    method: 'post',
    data
  })
}

// 获取当前用户最近一次推荐任务结果
export function getLatestMetricViewRecommendationReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/recommendations/latest`,
    method: 'get'
  })
}

// 获取指定推荐任务详情
export function getMetricViewRecommendationTaskReq(projectId: any, taskId: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/recommendations/${taskId}`,
    method: 'get'
  })
}

// 批量应用推荐候选
export function applyMetricViewRecommendationReq(projectId: any, taskId: any, selections: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/recommendations/${taskId}/apply`,
    method: 'post',
    data: { selections }
  })
}
