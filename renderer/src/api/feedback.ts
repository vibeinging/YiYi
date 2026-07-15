import request from '@/utils/axios-req'

// 提交消息反馈（点赞/反对）
export const submitFeedback = (projectId: any, sessionId: any, messageId: any, data: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/messages/${messageId}/feedback`,
    method: 'post',
    data
  })
}

// 批量获取会话中的反馈状态
export const getSessionFeedbacks = (projectId: any, sessionId: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/feedback-status`,
    method: 'get'
  })
}

// 管理员：获取反馈列表
export const getAdminFeedbacks = (params: any) => {
  return request({
    url: '/api/admin/feedbacks',
    method: 'get',
    params
  })
}

// 管理员：获取消息上下文（用户问题+AI原始消息）
export const getAdminFeedbackContext = (messageId: any, sessionId: any) => {
  return request({
    url: `/api/admin/feedbacks/${messageId}/context`,
    method: 'get',
    params: { session_id: sessionId }
  })
}

// 管理员：批量删除反馈
export const deleteAdminFeedbacks = (ids: any) => {
  return request({
    url: '/api/admin/feedbacks/delete',
    method: 'post',
    data: { ids }
  })
}
