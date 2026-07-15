import request from '@/utils/axios-req'

// 获取会话当前分享状态（所有者）
export const getShareStatus = (projectId: any, sessionId: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/share`,
    method: 'get'
  })
}

// 创建分享链接（所有者）
// options.refresh=true 刷新已存在分享的快照；options.messageIds 指定只分享部分消息（不传则全部）
export const createShareLink = (projectId: any, sessionId: any, { refresh = false, messageIds = null }: any = {}) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/share`,
    method: 'post',
    params: { refresh },
    data: messageIds ? { message_ids: messageIds } : {}
  })
}

// 撤销分享（所有者）
export const revokeShareLink = (projectId: any, sessionId: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/share`,
    method: 'delete'
  })
}

// 获取分享会话只读快照（公开，免登录）
// ignoreMsg 避免失效链接弹全局错误提示，由分享页自行处理失效态
export const getSharedSession = (shareToken: any) => {
  return request({
    url: `/api/public/v1/shared-sessions/${shareToken}`,
    method: 'get',
    ignoreMsg: true
  })
}
