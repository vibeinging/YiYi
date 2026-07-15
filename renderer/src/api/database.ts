import request from '@/utils/axios-req'
import { apiStreamFetch } from '@/utils/api-stream'
import { useBasicStore } from '@/store/basic'
import { useConfigStore } from '@/store/config'

// 获取token的辅助函数
function getToken() {
  return useBasicStore.getState().token
}

// 获取语言 header
function getLangHeader() {
  try {
    const language = useConfigStore.getState().language
    const langMap: any = { zh: 'zh-CN', en: 'en-US' }
    return langMap[language] || 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

// 获取环境变量
const env = import.meta.env

// 获取数据库列表
export function databaseListReq(projectId: any, keyword?: any) {
  return request({
    url: `/api/projects/${projectId}/databases`,
    method: 'get',
    params: {
      keyword
    }
  })
}

// 创建数据库配置
export function createDatabaseReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases`,
    method: 'post',
    data
  })
}

// 更新数据库配置
export function updateDatabaseReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${data.id}`,
    method: 'put',
    data
  })
}

// 删除数据库配置
export function deleteDatabaseReq(projectId: any, id: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${id}`,
    method: 'delete'
  })
}

// 获取数据库详情
export function getDatabaseDetailReq(projectId: any, id: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${id}`,
    method: 'get'
  })
}

// 测试数据库连接
export function testDatabaseConnectionReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/meta/test-connection`,
    method: 'post',
    data
  })
}

// 获取指定表的所有列信息
export function getTableColumnsReq(projectId: any, connectionId: any, tableId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}/columns`,
    method: 'get'
  })
}

// 同步数据库schema到业务数据库
export function syncDatabaseSchemaReq(projectId: any, connectionId: any, data: any = null) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync-schema`,
    method: 'post',
    data,
    ignoreLoading: true,
    timeout: 600000 // 10分钟（600秒），与后端超时配置保持一致
  })
}

// 按表同步
export function syncDatabaseTablesReq(projectId: any, connectionId: any, { tableIds = null, tableNames = null }: any = {}) {
  const data: any = {}
  if (tableIds) {
    data.table_ids = tableIds
  }
  if (tableNames) {
    data.table_names = tableNames
  }
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync-tables`,
    method: 'post',
    data,
    ignoreLoading: true,
    timeout: 600000
  })
}

// 获取元数据同步配置
export function getSyncConfigReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync-config`,
    method: 'get'
  })
}

// 保存元数据同步配置
export function updateSyncConfigReq(projectId: any, connectionId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync-config`,
    method: 'put',
    data
  })
}

// 手动触发元数据同步，并写入同步记录
export function triggerMetadataSyncReq(projectId: any, connectionId: any, data: any = {}) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metadata-sync`,
    method: 'post',
    data,
    ignoreLoading: true,
    timeout: 600000
  })
}

// 获取元数据同步记录
export function listSyncAuditsReq(projectId: any, connectionId: any, params: any = {}) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync-audits`,
    method: 'get',
    params,
    ignoreMsg: true,
    validateStatus: (status: number) => status < 500
  })
}

// 获取支持的数据库类型列表
export function supportDatabaseReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/meta/supported-types`,
    method: 'get'
  })
}

// 根据ID获取数据库信息
export function getDatabaseByIdReq(projectId: any, id: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${id}`,
    method: 'get'
  })
}

// 获取缓存的表列表
export function getCachedTablesReq(projectId: any, connectionId: any, params: any = {}) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables`,
    method: 'get',
    params
  })
}

// 获取原始数据库的表列表（用于按表同步）
export function getSourceTablesReq(projectId: any, connectionId: any, params: any = {}) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/source-tables`,
    method: 'get',
    params
  })
}

// 更新列信息（描述、高召回状态、示例值）
export function updateColumnDescriptionReq(projectId: any, connectionId: any, columnId: any, description: any, isHighRecall: any = null, exampleValues: any = null, enumMappings: any = null) {
  const data: any = { description }
  if (isHighRecall !== null) {
    data.is_high_recall = isHighRecall
  }
  if (exampleValues !== null) {
    data.example_values = exampleValues
  }
  if (enumMappings !== null) {
    data.enum_mappings = enumMappings
  }
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/columns/${columnId}`,
    method: 'put',
    data
  })
}

// 删除缓存的表
export function deleteCachedTableReq(projectId: any, connectionId: any, tableId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}`,
    method: 'delete'
  })
}

// 统一的Schema增强接口（支持流式和非流式）
export function enrichSchema(projectId: any, data: any) {
  // 根据 stream 参数决定是否使用流式输出
  const { stream = false, force_regenerate = false, user_requirements = null, ...requestData } = data

  if (stream) {
    // 流式请求 - 使用fetch处理SSE
    const baseUrl = env.VITE_APP_BASE_URL || ''
    return apiStreamFetch(baseUrl + `/api/projects/${projectId}/databases/enrich`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
        'Accept-Language': getLangHeader()
      },
      body: JSON.stringify({ ...requestData, stream: true, force_regenerate, user_requirements })
    })
  } else {
    // 非流式请求 - 使用封装的axios
    return request({
      url: `/api/projects/${projectId}/databases/enrich`,
      method: 'post',
      data: { ...requestData, stream: false, force_regenerate, user_requirements }
    })
  }
}

// 保存增强信息
export function saveEnhancementReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/save-enhancement`,
    method: 'post',
    data
  })
}

// Schema自动发现
export function discoverSchemasReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/meta/schemas/discover`,
    method: 'post',
    data
  })
}

// 获取数据库样例数据统计
export function getExamplesReq(projectId: any, databaseId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/examples`,
    method: 'get'
  })
}

// 获取数据库样例数据列表（支持分页）
export function getExamplesListReq(projectId: any, databaseId: any, page: any = 1, pageSize: any = 20) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/examples`,
    method: 'get',
    params: {
      list: 'true',
      page,
      page_size: pageSize
    }
  })
}

// 添加样例数据
export function addExamplesReq(projectId: any, databaseId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/examples`,
    method: 'post',
    data
  })
}

// 更新样例数据
export function updateExampleReq(projectId: any, databaseId: any, exampleId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/examples/${exampleId}`,
    method: 'put',
    data
  })
}

// 删除样例数据
export function deleteExamplesReq(projectId: any, databaseId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/examples`,
    method: 'delete',
    data
  })
}

// 搜索相似样例
export function searchExamplesReq(projectId: any, databaseId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/examples/search`,
    method: 'post',
    data
  })
}

// 生成表AI描述
export function generateTableDescriptionReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/generate-table-description`,
    method: 'post',
    data,
  })
}

// 生成表AI描述（单表，复用批量生成服务）
export function generateSingleTableDescriptionReq(projectId: any, connectionId: any, tableId: any, limitExamples: any = 2, extraNotes: any = null) {
  const data: any = {
    connection_id: connectionId,
    table_id: tableId,
    limit_examples: limitExamples
  }
  // 如果有额外说明，添加到请求数据中
  if (extraNotes && extraNotes.trim()) {
    data.extra_notes = extraNotes.trim()
  }
  return request({
    url: `/api/projects/${projectId}/databases/generate-table-description`,
    method: 'post',
    data,
  })
}

// 生成数据库AI描述
export function generateDatabaseDescriptionReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/generate-description`,
    method: 'post',
  })
}

// 批量生成列描述和表描述（AI生成）
export function generateColumnsDescriptionsReq(projectId: any, connectionId: any, tableIds: any = null, limitExamples: any = 2, onlyPending: any = false) {
  return request({
    url: `/api/projects/${projectId}/databases/generate-columns-descriptions`,
    method: 'post',
    data: {
      connection_id: connectionId,
      table_ids: tableIds,
      limit_examples: limitExamples,
      only_pending: onlyPending
    }
  })
}


// 获取同步待处理表信息
export function getSyncPendingReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync_pending`,
    method: 'get'
  })
}

// 清除同步待处理表信息
export function clearSyncPendingReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync_pending`,
    method: 'delete'
  })
}

// 同步表的示例数据到列字段
export function syncTableExampleValuesReq(projectId: any, connectionId: any, tableId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}/sync_example_values`,
    method: 'post',
  })
}

// 批量同步多个表的示例数据到列字段
export function batchSyncTableExampleValuesReq(projectId: any, connectionId: any, tableIds: any, limit: any = 2) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/batch_sync_example_values`,
    method: 'post',
    data: {
      table_ids: tableIds,
      limit: limit
    }
  })
}

// 更新表的描述信息
export function updateTableDescriptionReq(projectId: any, connectionId: any, tableId: any, description: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}`,
    method: 'put',
    data: {
      description
    }
  })
}

// 更新表的高召回优先级状态
export function updateTableHighRecallReq(projectId: any, connectionId: any, tableId: any, isHighRecall: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}/high-recall`,
    method: 'put',
    data: {
      is_high_recall: isHighRecall
    }
  })
}

// 批量更新列信息（描述、关键词、高召回状态）
export function batchUpdateColumnsReq(projectId: any, connectionId: any, tableId: any, columns: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}/columns`,
    method: 'put',
    data: {
      columns: columns.map((col: any) => {
        const item: any = {
          column_id: col.column_id,
          description: col.description || ''
        }
        if (col.keywords !== null && col.keywords !== undefined) {
          item.keywords = col.keywords
        }
        if (col.is_high_recall !== null && col.is_high_recall !== undefined) {
          item.is_high_recall = col.is_high_recall
        }
        return item
      })
    }
  })
}

// 获取表的采样数据
export function getTableSampleReq(projectId: any, connectionId: any, tableId: any, limit: any = 10) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}/sample`,
    method: 'get',
    params: { limit }
  })
}

// ==================== 表向量存储和RAG召回API ====================

// 存储表描述到向量库
export function storeTableVectorsReq(projectId: any, databaseId: any, tableIds: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/tables/store-vectors`,
    method: 'post',
    data: {
      table_ids: tableIds
    },
  })
}

// 存储单个表描述到向量库
export function storeSingleTableVectorReq(projectId: any, databaseId: any, tableId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/tables/store-vector`,
    method: 'post',
    data: {
      table_id: tableId,
      database_id: databaseId
    },
  })
}

// 批量存储表所有列描述到向量库
export function storeTableColumnsVectorReq(projectId: any, databaseId: any, tableId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/tables/store-columns-vector`,
    method: 'post',
    data: {
      table_id: tableId,
      database_id: databaseId
    },
  })
}

// 使用RAG召回相关表
export function searchRelevantTablesReq(
  projectId: any,
  databaseId: any,
  question: any,
  similarityThreshold: any = 0.5,
  topK: any = 5
) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/semantic-retrieval`,
    method: 'post',
    data: {
      question,
      similarity_threshold: similarityThreshold,
      top_k: topK
    }
  })
}

// 清理表向量数据
export function clearTableVectorsReq(projectId: any, databaseId: any, tableIds: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/tables/clear-vectors`,
    method: 'post',
    data: {
      table_ids: tableIds
    }
  })
}

// 获取向量库集合统计信息
export function getCollectionStatsReq(projectId: any, databaseId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/collection-stats`,
    method: 'get'
  })
}

// 刷新数据库schema（重新从目标数据库获取）
export function refreshSchemaReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/refresh-schema`,
    method: 'post',
    timeout: 60000
  })
}

// ==================== 实体映射API ====================

// 创建实体映射
export function createEntityMappingsReq(projectId: any, connectionId: any, tableId: any, columnName: any, metadataFields: any = null) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}/entity_mappings`,
    method: 'post',
    data: {
      column_name: columnName,
      metadata_fields: metadataFields
    },
    timeout: 300000 // 5分钟超时，因为可能需要处理大量数据
  })
}

// 获取实体映射列表（已废弃，使用配置列表替代）
export function getEntityMappingsReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mappings`,
    method: 'get'
  })
}

// ==================== 实体映射配置管理API ====================

// 获取实体映射配置列表
export function getEntityMappingConfigsReq(projectId: any, connectionId: any, tableName: any = null) {
  const params = tableName ? { table_name: tableName } : {}
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mapping_configs`,
    method: 'get',
    params: params,
  })
}

// 创建实体映射配置
export function createEntityMappingConfigReq(projectId: any, connectionId: any, tableId: any, columnName: any, metadataFields: any = null, rule: any = null) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mapping_configs`,
    method: 'post',
    data: {
      table_id: tableId,
      column_name: columnName,
      metadata_fields: metadataFields,
      rule: rule
    },
    timeout: 300000 // 5分钟超时，因为可能需要处理大量数据
  })
}

// 删除实体映射配置（通过ID）
export function deleteEntityMappingConfigReq(projectId: any, connectionId: any, configId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mapping_configs/${configId}`,
    method: 'delete'
  })
}

// 删除实体映射配置（通过表名和列名，已废弃）
export function deleteEntityMappingConfigByNameReq(projectId: any, connectionId: any, tableName: any, columnName: any, confirmation: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mapping_configs`,
    method: 'delete',
    data: {
      table_name: tableName,
      column_name: columnName,
      confirmation: confirmation
    }
  })
}

// 更新实体映射配置（如 rule 字段）
export function updateEntityMappingConfigReq(projectId: any, connectionId: any, configId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mapping_configs/${configId}`,
    method: 'put',
    data
  })
}

// 删除实体映射
export function deleteEntityMappingsReq(projectId: any, connectionId: any, entityIds: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mappings`,
    method: 'delete',
    data: {
      entity_ids: entityIds
    },
  })
}

// 删除实体配置（按表和列）
export function deleteEntityConfigReq(projectId: any, connectionId: any, tableName: any, columnName: any, confirmation: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity-config`,
    method: 'delete',
    data: {
      table_name: tableName,
      column_name: columnName,
      confirmation: confirmation
    },
  })
}

// 搜索相似实体
export function searchSimilarEntitiesReq(projectId: any, connectionId: any, entityName: any, limit: any = 10) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mappings/search`,
    method: 'post',
    data: {
      entity_name: entityName,
      limit: limit
    }
  })
}

// 生成实体向量
export function generateEntityEmbeddingsReq(projectId: any, connectionId: any, tableName: any = null, columnName: any = null) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mappings/generate_embeddings`,
    method: 'post',
    data: {
      table_name: tableName,
      column_name: columnName
    },
    timeout: 1800000 // 30分钟超时
  })
}

// 创建列名实体
export function createColumnNameEntitiesReq(projectId: any, connectionId: any, tableId: any, columnNames: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mappings/column_names`,
    method: 'post',
    data: {
      table_id: tableId,
      column_names: columnNames
    },
    ignoreLoading: true,
    timeout: 300000 // 5分钟超时
  })
}

// 测试实体Agent替换（模拟EntityProcessorAgent完整流程）
export function testEntityAgentReq(projectId: any, connectionId: any, question: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mappings/test_agent`,
    method: 'post',
    data: {
      question: question
    },
    timeout: 300000 // 5分钟超时，因为涉及LLM调用
  })
}

// ========== 指标管理 API ==========

// 获取指标列表
export function getMetricsReq(projectId: any, connectionId: any, category: any = null) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics`,
    method: 'get',
    params: {
      category
    }
  })
}

// 创建指标
export function createMetricReq(projectId: any, connectionId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics`,
    method: 'post',
    data
  })
}

// 更新指标
export function updateMetricReq(projectId: any, connectionId: any, metricId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics/${metricId}`,
    method: 'put',
    data
  })
}

// 删除指标
export function deleteMetricReq(projectId: any, connectionId: any, metricId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics/${metricId}`,
    method: 'delete'
  })
}

// 生成指标向量
export function generateMetricEmbeddingsReq(projectId: any, connectionId: any, metricId: any = null) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics/generate_embeddings`,
    method: 'post',
    params: {
      metric_id: metricId
    },
    timeout: 300000 // 5分钟超时
  })
}

// 搜索指标
export function searchMetricsReq(projectId: any, connectionId: any, query: any, limit: any = 5) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics/search`,
    method: 'get',
    params: {
      query,
      limit
    }
  })
}

// ==================== 表间关系管理 ====================

// 获取表间关系列表
export function getRelationshipsReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships`,
    method: 'get'
  })
}

// 创建表间关系
export function createRelationshipReq(projectId: any, connectionId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships`,
    method: 'post',
    data
  })
}

// 更新表间关系
export function updateRelationshipReq(projectId: any, connectionId: any, relationshipId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships/${relationshipId}`,
    method: 'put',
    data
  })
}

// 删除表间关系
export function deleteRelationshipReq(projectId: any, connectionId: any, relationshipId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships/${relationshipId}`,
    method: 'delete'
  })
}

// 自动发现表间关系
export function discoverRelationshipsReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships/discover`,
    method: 'post',
    timeout: 300000 // 5分钟超时（含多批次LLM分析）
  })
}

// 批量创建候选关系（用户确认后）
export function batchCreateRelationshipsReq(projectId: any, connectionId: any, candidates: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships/batch-create`,
    method: 'post',
    data: { candidates },
    timeout: 30000
  })
}

// AI辅助建议关系
export function aiSuggestRelationshipsReq(projectId: any, connectionId: any, hint: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships/ai-suggest`,
    method: 'post',
    data: { hint },
    timeout: 60000
  })
}

// 上传嵌入式数据库文件（SQLite/DuckDB）
export function uploadDatabaseFileReq(projectId: any, file: any) {
  const localPath = file?.path || file?.webkitRelativePath
  if (localPath) {
    return request({
      url: `/api/projects/${projectId}/databases/upload-db-file`,
      method: 'post',
      data: { file_path: localPath },
      timeout: 300000
    })
  }

  const formData = new FormData()
  formData.append('file', file)

  return request({
    url: `/api/projects/${projectId}/databases/upload-db-file`,
    method: 'post',
    data: formData,
    headers: {
      'Content-Type': 'multipart/form-data'
    },
    timeout: 300000 // 5分钟超时，数据库文件可能较大
  })
}

// ==================== 数据源级实体管理 ====================

// 自动推荐实体列
export function suggestEntityColumnsReq(projectId: any, connectionId: any, params: any = {}) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_configs/suggest`,
    method: 'post',
    data: params,
    timeout: 300000
  })
}

// 批量创建推荐的实体配置
export function batchCreateEntityConfigsReq(projectId: any, connectionId: any, columns: any, rule: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_configs/batch_create`,
    method: 'post',
    data: { columns, rule },
    timeout: 300000
  })
}

// 数据源级向量生成
export function generateDatasourceEntityEmbeddingsReq(projectId: any, connectionId: any, configId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_configs/generate_embeddings`,
    method: 'post',
    params: configId ? { config_id: configId } : {},
    timeout: 300000
  })
}

// 数据源级实体向量搜索
export function searchDatasourceEntitiesReq(projectId: any, connectionId: any, query: any, limit: any = 10) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entities/search`,
    method: 'post',
    params: { query, limit }
  })
}

// 批量导入指标
export function bulkImportMetricsReq(projectId: any, connectionId: any, file: any) {
  const formData = new FormData()
  formData.append('file', file)

  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics/bulk_import`,
    method: 'post',
    data: formData,
    headers: {
      'Content-Type': 'multipart/form-data'
    },
    timeout: 300000 // 5分钟超时
  })
}

// ==================== 元数据查询 ====================

// 执行元数据查询
export function executeMetadataQueryReq(projectId: any, connectionId: any, data: any, { signal }: any = {}) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/execute-metadata-query`,
    method: 'post',
    data,
    timeout: 60000,
    signal
  })
}
