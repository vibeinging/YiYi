import axiosReq from '@/utils/axios-req'

/**
 * 获取 LLM 成本聚合数据
 * @param {Object} params
 * @param {string} params.start - ISO datetime, required
 * @param {string} params.end - ISO datetime, required
 * @param {string} [params.group_by] - 逗号分隔，可选值 call_site / model / project，默认 call_site
 * @param {string} [params.project_id]
 * @param {string} [params.model_id]
 * @param {string} [params.call_site] - 前缀匹配
 * @param {string} [params.format] - json / csv，默认 json
 */
export const getLLMCostReq = (params: any) => {
  return axiosReq({
    url: '/api/admin/llm-cost',
    method: 'get',
    params,
  })
}

/**
 * 构造 CSV 导出 URL（用于 fetch 直接拉取 blob）
 * @param {Object} params
 */
export const buildLLMCostCSVURL = (params: any) => {
  const search = new URLSearchParams()
  Object.entries(params || {}).forEach(([k, v]: [string, any]) => {
    if (v === undefined || v === null || v === '') return
    search.set(k, v)
  })
  search.set('format', 'csv')
  return `/api/admin/llm-cost?${search.toString()}`
}
