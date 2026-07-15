// yiw / yiw-agent 前端 API 接缝。命中新增的 /api/agent 路由,
// 镜像 api/session.ts 的鉴权与 SSE 取流方式,但不碰问数的 api/session.ts。
import request from '@/utils/axios-req'
import type { StreamReq } from '@/utils/api-stream'
import { createAPIURL } from '@/utils/url-helper'
import { useBasicStore } from '@/store/basic'
import { useConfigStore } from '@/store/config'

export interface AgentSession {
  id: string
  title: string
  status?: string
  latest_run_status?: string | null
  message_count?: number
  created_at?: string
  updated_at?: string
}

// pid 可能是 sentinel(__chat__ / folder:base64url),编码进 URL 路径段
const pe = (s: string) => encodeURIComponent(s)

// 创建一个 agent 会话(复用问数的 /sessions 创建端点,用 action_type='agentic_chat' 命名空间隔离)
export const createAgentSession = (projectId: string, title: string) =>
  request({
    url: `/api/projects/${pe(projectId)}/sessions`,
    method: 'post',
    data: { title: title?.slice(0, 60) || '新对话', source_type: 'agent', source_id: projectId, action_type: 'agentic_chat' }
  })

// 列出本项目工作区历史:统一 agent 会话
export const listAgentSessions = (projectId: string, params?: { archived?: boolean }) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/sessions`,
    method: 'get',
    params: params?.archived ? { archived: 1 } : undefined
  })

export interface AgentTraceSpan {
  id: string
  parentId?: string | null
  externalTraceId?: string | null
  externalSpanId?: string | null
  externalParentSpanId?: string | null
  externalSessionId?: string | null
  kind: string
  name: string
  status: string
  depth: number
  order?: number | null
  startMs?: number
  durMs: number
  cost?: number
  inTok?: number
  outTok?: number
  model?: string | null
  input?: string
  output?: string
  logs?: string[]
  attrs?: Record<string, unknown>
}

export interface AgentTraceDetail {
  traceId: string
  externalTraceId?: string | null
  name: string
  status: string
  durMs: number
  cost: number
  spanCount: number
  spans: AgentTraceSpan[]
}

export interface AgentTraceRun {
  runId: string
  sessionId: string
  projectId?: string | null
  userId?: string | null
  status?: string | null
  skill?: string | null
  mode?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  finishedAt?: string | null
  question?: {
    questionNo: number
    questionMessageId?: string | null
    questionText: string
    sequenceNumber?: number
    createdAt?: string | null
  } | null
  trace?: AgentTraceDetail | null
}

export interface AgentSessionTraceResponse {
  enabled: boolean
  dataDir?: string
  session?: any
  traceResolveDeferred?: boolean
  traceReadTimeout?: boolean
  traceWarmupPending?: boolean
  items: AgentTraceRun[]
}

export const getAgentSessionTraces = (
  projectId: string,
  sessionId: string,
  options: number | { limit?: number; resolveTrace?: boolean } = 20
) => {
  const limit = typeof options === 'number' ? options : options.limit ?? 20
  const resolveTrace = typeof options === 'number' ? false : Boolean(options.resolveTrace)
  return request({
    url: `/api/agent/projects/${pe(projectId)}/sessions/${pe(sessionId)}/traces`,
    method: 'get',
    params: { limit, ...(resolveTrace ? { resolve_trace: 1 } : {}) },
    ignoreMsg: true
  })
}

export * from './traceOptimization'

// 读取某 agent 会话的历史消息(复用问数的 messages 端点)
export const getAgentMessages = (projectId: string, sessionId: string) =>
  request({ url: `/api/projects/${pe(projectId)}/sessions/${pe(sessionId)}/messages`, method: 'get' })

// 重命名 agent 会话(复用问数的 PUT /sessions/:sid)
export const renameAgentSession = (projectId: string, sessionId: string, title: string) =>
  request({ url: `/api/projects/${pe(projectId)}/sessions/${pe(sessionId)}`, method: 'put', data: { title } })

export const updateAgentSessionStatus = (projectId: string, sessionId: string, status: 'active' | 'archived') =>
  request({ url: `/api/projects/${pe(projectId)}/sessions/${pe(sessionId)}`, method: 'put', data: { status } })

export const moveAgentSession = (fromProjectId: string, sessionId: string, targetProjectId: string) =>
  request({
    url: `/api/projects/${pe(fromProjectId)}/sessions/${pe(sessionId)}/move`,
    method: 'post',
    data: { target_project_id: targetProjectId }
  })

// 删除 agent 会话(软删除;复用问数的 DELETE /sessions/:sid)
export const deleteAgentSession = (projectId: string, sessionId: string) =>
  request({ url: `/api/projects/${pe(projectId)}/sessions/${pe(sessionId)}`, method: 'delete' })

// 治理确认:用户对写/执行类工具的批准/拒绝(resolve 后端 beforeToolCall 的等待)
export const sendToolDecision = (toolCallId: string, approved: boolean) =>
  request({ url: `/api/agent/tool-decision`, method: 'post', data: { toolCallId, approved } })

// 手动压缩会话上下文(/compact):只动模型上下文,前端显示不变
export const compactAgentSession = (projectId: string, sessionId: string) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/sessions/${pe(sessionId)}/compact`, method: 'post' })

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  children?: FileNode[]
}

// 工作区文件树。纯聊天工作区按 session_id 隔离到 __chat__/<session_id>/。
export const listAgentFiles = (projectId: string, sessionId?: string | null) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/files`,
    method: 'get',
    params: sessionId ? { session_id: sessionId } : undefined
  })

// 读取工作区单个文件内容(预览)
export const getAgentFile = (projectId: string, path: string, sessionId?: string | null) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/file`,
    method: 'get',
    params: { path, ...(sessionId ? { session_id: sessionId } : {}) }
  })

// 当前生效模型名(PRIMARY)——供输入条胶囊展示真实模型
export const getAgentModel = (projectId: string) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/model`, method: 'get' })

const langHeader = () => {
  try {
    const map: Record<string, string> = { zh: 'zh-CN', en: 'en-US' }
    return map[useConfigStore.getState().language] || 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

/**
 * 向 yiw-agent 发送消息,返回 fetch Response(SSE 流,由调用方读 body)。
 * 事件契约:Agent Stream v1 events → "data: [DONE]"
 */
export const sendMessageToAgent = (
  projectId: string,
  sessionId: string,
  message: string,
  signal?: AbortSignal,
  extra?: Record<string, unknown>
) => {
  const token = useBasicStore.getState().token || ''
  const url = createAPIURL(`/api/agent/projects/${pe(projectId)}/sessions/${pe(sessionId)}/chat`)
  const req: StreamReq = {
    url,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Language': langHeader()
    },
    body: JSON.stringify({ message, ...(extra || {}) }),
    signal
  }
  return req
}

export const resolveAgentPendingAction = (
  projectId: string,
  sessionId: string,
  requestId: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal
) => {
  const token = useBasicStore.getState().token || ''
  const url = createAPIURL(`/api/agent/projects/${pe(projectId)}/sessions/${pe(sessionId)}/pending-actions/${pe(requestId)}/resolve`)
  const req: StreamReq = {
    url,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Language': langHeader()
    },
    body: JSON.stringify(payload || {}),
    signal
  }
  return req
}
