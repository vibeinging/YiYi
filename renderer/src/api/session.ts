import request from '@/utils/axios-req'
import { apiStreamFetch } from '@/utils/api-stream'
import { createAPIURL } from '@/utils/url-helper'
import { useBasicStore } from '@/store/basic'
import { t } from '@/lang'
import { useConfigStore } from '@/store/config'

const getLangHeader = () => {
  try {
    const configStore = useConfigStore.getState()
    const langMap: any = { zh: 'zh-CN', en: 'en-US' }
    return langMap[configStore.language] || 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

// 创建会话
export const createSession = (projectId: any, data: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions`,
    method: 'post',
    data
  })
}

// 获取会话详情
export const getSession = (projectId: any, sessionId: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}`,
    method: 'get'
  })
}

// 删除会话
export const deleteSession = (projectId: any, sessionId: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}`,
    method: 'delete'
  })
}

// 获取会话列表
export const getSessionList = (projectId: any, params: any) => {
  if (!projectId) {
    return Promise.resolve({ success: false, data: { items: [] }, message: t('common.noProjectSelected') })
  }
  return request({
    url: `/api/projects/${projectId}/sessions`,
    method: 'get',
    params
  })
}

// 获取会话消息
export const getSessionMessages = (projectId: any, sessionId: any, params: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/messages`,
    method: 'get',
    params
  })
}

// 删除会话消息
export const deleteMessage = (projectId: any, sessionId: any, messageId: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/messages/${messageId}`,
    method: 'delete'
  })
}

export const startSessionReport = (projectId: any, sessionId: any, data: any) => {
  const basicStore = useBasicStore.getState()
  const token = basicStore.token || ''

  const url = createAPIURL(`/api/projects/${projectId}/sessions/${sessionId}/start-report`)
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept-Language': getLangHeader()
  }

  return apiStreamFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(data)
  })
}

// 执行 SQL
export const executeSql = (projectId: any, sessionId: any, data: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/execute-sql`,
    method: 'post',
    data
  })
}

// 更新会话
export const updateSession = (projectId: any, sessionId: any, data: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}`,
    method: 'put',
    data
  })
}

// 发送消息到会话（返回 fetch Response 对象用于流式处理）
export const sendMessageToSession = (projectId: any, sessionId: any, message: any, options: any = {}) => {
  const basicStore = useBasicStore.getState()
  const token = basicStore.token || ''

  const url = createAPIURL(`/api/agent/projects/${projectId}/sessions/${sessionId}/chat`)
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept-Language': getLangHeader()
  }

  const body = {
    message: message,
    template_format: options.template_format || null,
    max_results: options.max_results || null,
    // stateless WorkflowAgent 协议(2026-05-31 后端协议改动):
    // chip 答复时透传 _workflow_checkpoint,后端用它续跑 fb_search,免死循环再出 chip
    input_data: options.input_data || undefined,
  }

  return apiStreamFetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body)
  })
}

// 智能聊天接口（支持新建会话或继续现有会话）
export const chatWithSession = (projectId: any, message: any, options: any = {}) => {
  const basicStore = useBasicStore.getState()
  const token = basicStore.token || ''

  // 如果有 session_id，使用现有会话；否则创建新会话
  const sessionId = options.session_id
  const url = sessionId
    ? createAPIURL(`/api/agent/projects/${projectId}/sessions/${sessionId}/chat`)
    : createAPIURL(`/api/projects/${projectId}/sessions`)

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept-Language': getLangHeader()
  }

  const body = sessionId
    ? { message: message }
    : { message: message, title: options.title }

  return apiStreamFetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body)
  })
}

// 停止会话任务
export const stopSessionTask = (projectId: any, sessionId: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/stop-task`,
    method: 'post'
  })
}

// 获取会话任务状态
export const getSessionTaskStatus = (projectId: any, sessionId: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/task-status`,
    method: 'get'
  })
}

// 继续会话流式输出（返回 fetch Response 对象用于流式处理）
// 后端会自动获取会话最后一个运行中的任务
export const continueSessionStream = (projectId: any, sessionId: any) => {
  const basicStore = useBasicStore.getState()
  const token = basicStore.token || ''

  const url = createAPIURL(`/api/projects/${projectId}/sessions/${sessionId}/chat-continue`)
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept-Language': getLangHeader()
  }

  return apiStreamFetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({})
  })
}


// 获取会话中间结果表列表
export const getIntermediateTables = (projectId: any, sessionId: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/intermediate-tables`,
    method: 'get'
  })
}

// AI 生成中间结果描述
export const generateIntermediateDescription = (projectId: any, sessionId: any, selectedTables: any = null) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/intermediate-generate-description`,
    method: 'post',
    data: selectedTables ? { selected_tables: selectedTables } : {}
  })
}

// 持久化中间结果为业务数据源
export const persistIntermediate = (projectId: any, sessionId: any, data: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/persist-intermediate`,
    method: 'post',
    data
  })
}
