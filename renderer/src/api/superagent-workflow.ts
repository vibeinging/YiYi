import request from '@/utils/axios-req'

// workflow CRUD（business 级资源）

export function createWorkflowReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/superagent-workflows`,
    method: 'post',
    data
  })
}

export function listWorkflowsReq(projectId: any, page = 1, pageSize = 20) {
  return request({
    url: `/api/projects/${projectId}/superagent-workflows`,
    method: 'get',
    params: { page, page_size: pageSize }
  })
}

export function getWorkflowReq(projectId: any, workflowId: any) {
  return request({
    url: `/api/projects/${projectId}/superagent-workflows/${workflowId}`,
    method: 'get'
  })
}

export function updateWorkflowReq(projectId: any, workflowId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/superagent-workflows/${workflowId}`,
    method: 'put',
    data
  })
}

export function deleteWorkflowReq(projectId: any, workflowId: any) {
  return request({
    url: `/api/projects/${projectId}/superagent-workflows/${workflowId}`,
    method: 'delete'
  })
}

// run 触发 + 查询

export function triggerWorkflowRunReq(projectId: any, workflowId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/superagent-workflows/${workflowId}/runs`,
    method: 'post',
    data
  })
}

export function listWorkflowRunsReq(projectId: any, workflowId: any, page = 1, pageSize = 20) {
  return request({
    url: `/api/projects/${projectId}/superagent-workflows/${workflowId}/runs`,
    method: 'get',
    params: { page, page_size: pageSize }
  })
}

// run 详情(跨 business 端点,返回 graph_snapshot + node_runs 完整明细)
// 后端用 get_current_active_user + 内部反查 project_id 校验,前端只需 runId
export function getWorkflowRunReq(runId: any) {
  return request({
    url: `/api/superagent-workflow-runs/${runId}`,
    method: 'get'
  })
}

// 可编排工具元信息（用于编辑器属性面板的工具下拉）

export function getOrchestrableToolsReq() {
  return request({
    url: `/api/superagent-orchestrable-tools`,
    method: 'get'
  })
}
