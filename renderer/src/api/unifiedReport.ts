import request from '@/utils/axios-req'
import axios from 'axios'
import { useProjectStore } from '@/store/project'
import { useBasicStore } from '@/store/basic'
import { useConfigStore } from '@/store/config'
import { createAPIURL } from '@/utils/url-helper'

const getProjectId = () => {
  return useProjectStore.getState().currentProject?.id
}

export const listUnifiedReportTemplates = (params: any = {}) => request({
  url: `/api/projects/${getProjectId()}/report-templates-v1`,
  method: 'get',
  params
})

export const getUnifiedReportTemplate = (templateId: any) => request({
  url: `/api/projects/${getProjectId()}/report-templates-v1/${templateId}`,
  method: 'get'
})

export const createUnifiedReportTemplate = (data: any) => request({
  url: `/api/projects/${getProjectId()}/report-templates-v1`,
  method: 'post',
  data
})

export const updateUnifiedReportTemplate = (templateId: any, data: any) => request({
  url: `/api/projects/${getProjectId()}/report-templates-v1/${templateId}`,
  method: 'put',
  data
})

export const validateUnifiedReportTemplate = (data: any) => request({
  url: `/api/projects/${getProjectId()}/report-templates-v1/validate`,
  method: 'post',
  data
})

export const previewUnifiedReportTemplate = (data: any) => request({
  url: `/api/projects/${getProjectId()}/report-templates-v1/preview`,
  method: 'post',
  data
})

export const setDefaultUnifiedReportTemplate = (templateId: any) => request({
  url: `/api/projects/${getProjectId()}/report-templates-v1/${templateId}/set-default`,
  method: 'post'
})

export const toggleUnifiedReportTemplateStatus = (templateId: any, status: any) => request({
  url: `/api/projects/${getProjectId()}/report-templates-v1/${templateId}/toggle-status`,
  method: 'post',
  data: { status }
})

export const getUnifiedReportTemplateUsageBusinesses = (templateId: any) => request({
  url: `/api/projects/${getProjectId()}/report-templates-v1/${templateId}/usage-businesses`,
  method: 'get'
})

export const listUnifiedReports = (params: any = {}) => request({
  url: `/api/projects/${getProjectId()}/reports-v1`,
  method: 'get',
  params
})

export const getUnifiedReport = (reportId: any) => request({
  url: `/api/projects/${getProjectId()}/reports-v1/${reportId}`,
  method: 'get'
})

export const getUnifiedReportDownloadUrl = (reportId: any) => `/api/projects/${getProjectId()}/reports-v1/${reportId}/download`

export const downloadUnifiedReport = (reportId: any) => {
  const basicStore = useBasicStore.getState()
  const configStore = useConfigStore.getState()
  const langMap: any = { zh: 'zh-CN', en: 'en-US' }

  return axios.get(createAPIURL(getUnifiedReportDownloadUrl(reportId)), {
    responseType: 'blob',
    headers: {
      ...(basicStore.token ? { Authorization: `Bearer ${basicStore.token}` } : {}),
      'Accept-Language': langMap[configStore.language] || 'zh-CN'
    }
  })
}
