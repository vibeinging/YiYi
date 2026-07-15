import axiosReq from '@/utils/axios-req'

// 获取日志文件列表
export function getLogFilesReq() {
  return axiosReq({
    url: '/api/admin/logs',
    method: 'get'
  })
}

// 获取指定日志内容（结构化、过滤、分页）
export function getLogContentReq(logType: any, params: any = {}) {
  return axiosReq({
    url: `/api/admin/logs/${logType}`,
    method: 'get',
    params: {
      page: params.page || 1,
      page_size: params.pageSize || 100,
      keyword: params.keyword || '',
      level: params.level || '',
      module: params.module || '',
      start_time: params.startTime || '',
      end_time: params.endTime || '',
      include_history: params.includeHistory || false,
    }
  })
}
