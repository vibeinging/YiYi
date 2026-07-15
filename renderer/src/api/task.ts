import request from '@/utils/axios-req'
import { apiStreamFetch } from '@/utils/api-stream'
import { useBasicStore } from '@/store/basic'
import { createAPIURL } from '@/utils/url-helper'
import { useConfigStore } from '@/store/config'

const getLangHeader = () => {
  try {
    const configStore = useConfigStore.getState()
    const langMap: Record<string, string> = { zh: 'zh-CN', en: 'en-US' }
    return langMap[configStore.language] || 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

// 任务管理API
export const taskApi = {
  // 创建任务
  createTask: (projectId: any, data: any) =>
    request({ url: `/api/projects/${projectId}/tasks/create`, method: 'post', data }),

  // 获取任务详情
  getTask: (projectId: any, taskId: any) =>
    request({ url: `/api/projects/${projectId}/tasks/${taskId}`, method: 'get' }),

  // 获取任务事件
  getTaskEvents: (projectId: any, taskId: any, params: any) =>
    request({ url: `/api/projects/${projectId}/tasks/${taskId}/events`, method: 'get', params }),

  // 取消任务
  cancelTask: (projectId: any, taskId: any) =>
    request({ url: `/api/projects/${projectId}/tasks/${taskId}/cancel`, method: 'post' }),

  // 获取任务状态
  getTaskStatus: (projectId: any, taskId: any) =>
    request({ url: `/api/projects/${projectId}/tasks/${taskId}/status`, method: 'get' }),

  // 执行任务（流式）
  executeTaskStream: (projectId: any, taskId: any, data: any) => {
    const token = useBasicStore.getState().token
    return apiStreamFetch(createAPIURL(`/api/projects/${projectId}/tasks/execute`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Accept-Language': getLangHeader()
      },
      body: JSON.stringify({ task_id: taskId, ...data })
    })
  },

  // 获取会话的活跃任务
  getSessionActiveTasks: (projectId: any, sessionId: any) =>
    request({ url: `/api/projects/${projectId}/tasks/sessions/${sessionId}/active`, method: 'get', ignoreMsg: true })
}
