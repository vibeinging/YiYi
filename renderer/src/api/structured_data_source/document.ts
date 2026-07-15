import axiosReq from '@/utils/axios-req'

/**
 * 结构化文档管理 API
 * 路径: /api/projects/{projectId}/structured-documents
 */

const BASE_PATH = '/api/projects'

const formDataToObject = (data: any) => {
  if (typeof FormData === 'undefined' || !(data instanceof FormData)) return data
  const out: Record<string, any> = {}
  data.forEach((value, key) => {
    out[key] = value
  })
  return out
}

const isAbsoluteLocalPath = (value: any) => {
  if (typeof value !== 'string' || !value.trim()) return false
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value)
}

const getLocalFilePath = async (file: any) => {
  const directPath = file?.path
  if (isAbsoluteLocalPath(directPath)) return directPath

  const electronAPI = typeof window !== 'undefined' ? (window as any).electronAPI : null
  if (typeof electronAPI?.getPathForFile === 'function') {
    const electronPath = await electronAPI.getPathForFile(file)
    if (isAbsoluteLocalPath(electronPath)) return electronPath
  }

  const relativePath = file?.webkitRelativePath
  return isAbsoluteLocalPath(relativePath) ? relativePath : ''
}

const localFilePathsFromForm = async (data: any) => {
  if (typeof FormData === 'undefined' || !(data instanceof FormData)) return []
  const files = data.getAll('files')
  const paths = await Promise.all(files.map(getLocalFilePath))
  return paths.filter(Boolean)
}

export const listDocumentsReq = (projectId: any, dataSourceId: any, page: any, pageSize: any) =>
  axiosReq({
    url: `${BASE_PATH}/${projectId}/structured-documents/list`,
    params: { data_source_id: dataSourceId, page, page_size: pageSize },
    method: 'get'
  })

export const getDataSourceItemsReq = (kbName: any, page: any, pageSize: any) =>
  axiosReq({ url: '/api/data_sources/structured/items', params: { name: kbName, page, page_size: pageSize }, method: 'get' })

export const uploadDocumentsReq = async (_projectId: any, formData: any) => {
  const localPaths = await localFilePathsFromForm(formData)
  if (localPaths.length) {
    return Promise.resolve({
      success: true,
      data: { uploaded_files: localPaths },
      message: '已选择本地文件'
    })
  }
  return Promise.resolve({
    success: false,
    data: { uploaded_files: [] },
    message: '当前环境无法读取本地文件路径，请在桌面端选择文件'
  })
}

export const createDocumentsReq = (projectId: any, formData: any) =>
  axiosReq({ url: `${BASE_PATH}/${projectId}/structured-documents/create`, method: 'post', data: formDataToObject(formData) })

export const processDocumentsReq = (projectId: any, formData: any) =>
  axiosReq({ url: `${BASE_PATH}/${projectId}/structured-documents/process`, method: 'post', data: formDataToObject(formData) })

export const deleteDocumentReq = (projectId: any, formData: any) =>
  axiosReq({ url: `${BASE_PATH}/${projectId}/structured-documents/delete`, method: 'post', data: formDataToObject(formData) })

export const deleteDocumentsBatchReq = (projectId: any, formData: any) =>
  axiosReq({ url: `${BASE_PATH}/${projectId}/structured-documents/delete_batch`, method: 'post', data: formDataToObject(formData) })

export const cancelDocumentProcessingReq = (projectId: any, formData: any) =>
  axiosReq({ url: `${BASE_PATH}/${projectId}/structured-documents/cancel`, method: 'post', data: formDataToObject(formData) })

export const deleteUploadedFilesReq = (kbName: any, relativePaths: any) =>
  axiosReq({
    url: `${BASE_PATH}/uploaded/delete`,
    method: 'post',
    data: { name: kbName || '', relative_paths: Array.isArray(relativePaths) ? relativePaths : [] },
    headers: { 'Content-Type': 'application/json' }
  })

export const deleteDocumentByPathReq = (kbName: any, relativePath: any) =>
  axiosReq({
    url: `${BASE_PATH}/delete_by_path`,
    method: 'post',
    data: { name: kbName || '', relative_path: relativePath || '' },
    headers: { 'Content-Type': 'application/json' }
  })

// 以下为旧接口（待废弃）
export const addDataSourceItemsReq = (kbName: any, items: any) =>
  axiosReq({ url: '/api/data_sources/structured/add_items', data: { name: kbName, items }, method: 'post' })

export const deleteDataSourceItemsReq = (kbName: any, itemIds: any) =>
  axiosReq({ url: '/api/data_sources/structured/delete_items', data: { name: kbName, item_ids: itemIds }, method: 'post' })

export const vectorizeDataSourceItemsReq = (kbName: any, itemIds: any) =>
  axiosReq({ url: '/api/data_sources/structured/vectorize_items', data: { name: kbName, item_ids: itemIds }, method: 'post' })

// ==================== 表入口查询 API ====================
const TABLES_PATH = '/api/projects'

export const getDocumentTablesReq = (projectId: any, documentId: any) =>
  axiosReq({
    url: `${TABLES_PATH}/${projectId}/structured-tables/by-document`,
    params: { document_id: documentId },
    method: 'get'
  })

export const getDataSourceTablesReq = (projectId: any, dataSourceId: any) =>
  axiosReq({
    url: `${TABLES_PATH}/${projectId}/structured-tables`,
    params: { data_source_id: dataSourceId },
    method: 'get'
  })

export const searchRelevantTablesReq = (
  projectId: any,
  dataSourceId: any,
  question: any,
  strategy: any = 'column_first',
  topK: any = 5
) => {
  const resolvedStrategy = typeof strategy === 'string' ? strategy : 'column_first'
  const resolvedTopK = typeof strategy === 'number' ? strategy : topK
  return axiosReq({
    url: `${TABLES_PATH}/${projectId}/structured-datasources/${dataSourceId}/semantic-retrieval`,
    method: 'post',
    data: { question, strategy: resolvedStrategy, top_k: resolvedTopK }
  })
}
