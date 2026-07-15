import axiosReq from '@/utils/axios-req'

/**
 * 结构化数据源实体管理 API
 * 路径前缀: /api/projects/{projectId}/structured-tables
 */

const TABLES_PATH = '/api/projects'

export const getEntityMappingConfigsReq = (projectId: any, dataSourceId: any, tableName: any = null) => {
  const params = tableName ? { table_name: tableName } : {}
  return axiosReq({
    url: `${TABLES_PATH}/${projectId}/datasources/${dataSourceId}/entity-mapping-configs`,
    method: 'get',
    params
  })
}

export const createEntityMappingsReq = (
  projectId: any,
  dataSourceId: any,
  tableId: any,
  columnName: any,
  metadataFields: any = null
) =>
  axiosReq({
    url: `${TABLES_PATH}/${projectId}/datasources/${dataSourceId}/entity-mapping-configs`,
    method: 'post',
    data: { table_id: tableId, column_name: columnName, metadata_fields: metadataFields },
    timeout: 300000
  })

export const deleteEntityMappingConfigReq = (
  projectId: any,
  dataSourceId: any,
  tableName: any,
  columnName: any,
  confirmation: any
) =>
  axiosReq({
    url: `${TABLES_PATH}/${projectId}/datasources/${dataSourceId}/entity-mapping-configs`,
    method: 'delete',
    data: { table_name: tableName, column_name: columnName, confirmation }
  })

export const searchSimilarEntitiesReq = (projectId: any, dataSourceId: any, entityName: any, limit = 10) =>
  axiosReq({
    url: `${TABLES_PATH}/${projectId}/datasources/${dataSourceId}/entity-mappings/search`,
    method: 'post',
    data: { entity_name: entityName, limit }
  })

// 复用接口
export { getDataSourceTablesReq } from './document'
export { getTableColumnsReq } from '@/api/database'
