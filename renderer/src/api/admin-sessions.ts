import request from '@/utils/axios-req'

// 获取所有会话列表（管理员）
export const getAdminSessionsReq = (params: any) => {
  return request({
    url: '/api/admin/sessions',
    method: 'get',
    params
  })
}

// 获取会话消息（管理员）
export const getAdminSessionMessagesReq = (sessionId: any, params: any) => {
  return request({
    url: `/api/admin/sessions/${sessionId}/messages`,
    method: 'get',
    params
  })
}
