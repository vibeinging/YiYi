import request from '@/utils/axios-req'

// Dashboard管理API
export const dashboardApi = {
  // 获取Dashboard列表
  getDashboardList: (projectId: any, params: any) => {
    return request({
      url: `/api/projects/${projectId}/dashboards`,
      method: 'get',
      params
    })
  },

  // 创建Dashboard
  createDashboard: (projectId: any, data: any) => {
    return request({
      url: `/api/projects/${projectId}/dashboards`,
      method: 'post',
      data: {
        title: data.title,
        description: data.description
      }
    })
  },

  // 更新Dashboard
  updateDashboard: (projectId: any, data: any) => {
    return request({
      url: `/api/projects/${projectId}/dashboards/${data.dashboard_id}`,
      method: 'put',
      data: {
        description: data.description,
        title: data.title,
        layout: data.layout,
        refresh_interval: data.refresh_interval
      }
    })
  },

  // 删除Dashboard
  deleteDashboard: (projectId: any, dashboardId: any) => {
    return request({
      url: `/api/projects/${projectId}/dashboards/${dashboardId}`,
      method: 'delete'
    })
  },

  // 刷新Dashboard数据
  refreshDashboard: (projectId: any, dashboardId: any) => {
    return request({
      url: `/api/projects/${projectId}/dashboards/${dashboardId}/refresh`,
      method: 'post',
      data: { dashboard_id: dashboardId }
    })
  },

  // 创建Panel
  createPanel: (projectId: any, dashboardId: any, data: any) => {
    return request({
      url: `/api/projects/${projectId}/dashboards/${dashboardId}/panels`,
      method: 'post',
      data: {
        title: data.title,
        content_type: data.content_type || data.form_type,
        content: data.content || data.fields,
        display_type: data.display_type || data.chart_option,
        execute_type: data.execute_type,
        execute: data.execute,
        source_type: data.source_type || "",
        source_id: data.source_id || "",
        tags: data.tags || [],
        x: data.x || 0,
        y: data.y || 0,
        w: data.w || 6,
        h: data.h || 4
      }
    })
  },

  // 查询Panel详情
  getPanelDetail: (projectId: any, panelId: any) => {
    return request({
      url: `/api/projects/${projectId}/panels/${panelId}`,
      method: 'get'
    })
  },

  // 更新Panel
  updatePanel: (projectId: any, data: any) => {
    return request({
      url: `/api/projects/${projectId}/panels/${data.panel_id}`,
      method: 'put',
      data: {
        title: data.title,
        content_type: data.content_type || data.form_type,
        content: data.content || data.fields,
        display_type: data.display_type || data.chart_option,
        display_config: data.display_config,
        execute_type: data.execute_type,
        execute: data.execute,
        source_type: data.source_type,
        source_id: data.source_id,
        tags: data.tags,
        x: data.x,
        y: data.y,
        w: data.w,
        h: data.h
      }
    })
  },

  // 删除Panel
  deletePanel: (projectId: any, panelId: any) => {
    return request({
      url: `/api/projects/${projectId}/dashboards/panels/${panelId}`,
      method: 'delete'
    })
  },

  // 列出Dashboard的Panel
  getPanelList: (projectId: any, dashboardId: any) => {
    return request({
      url: `/api/projects/${projectId}/dashboards/${dashboardId}/panels`,
      method: 'get'
    })
  },

  // 生成推荐Panel
  generatePanel: (projectId: any, data: any) => {
    return request({
      url: `/api/projects/${projectId}/panels/generate`,
      method: 'post',
      data: {
        question: data.question,
        sql_query: data.sql_query,
        session_id: data.session_id
      }
    })
  },

  // 刷新单个Panel数据
  refreshPanel: (projectId: any, dashboardId: any, panelId: any) => {
    return request({
      url: `/api/projects/${projectId}/dashboards/${dashboardId}/panels/${panelId}/refresh`,
      method: 'post',
      data: { panel_id: panelId }
    })
  },

  // 批量更新Panel布局
  batchUpdateLayout: (projectId: any, dashboardId: any, layouts: any) => {
    return request({
      url: `/api/projects/${projectId}/dashboards/${dashboardId}/panels/layout`,
      method: 'put',
      data: { layouts: layouts }
    })
  }
}

// Panel库管理API (保留向后兼容)
export const panelApi = {
  // 获取Panel列表
  getPanelList: (projectId: any, params: any) => {
    return request({
      url: `/api/projects/${projectId}/panels`,
      method: 'get',
      params
    })
  },

  // 获取Panel详情
  getPanel: (projectId: any, panelId: any) => {
    return request({
      url: `/api/projects/${projectId}/panels/${panelId}`,
      method: 'get'
    })
  },

  // 创建Panel
  createPanel: (projectId: any, data: any) => {
    return request({
      url: `/api/projects/${projectId}/panels`,
      method: 'post',
      data
    })
  },

  // 更新Panel
  updatePanel: (projectId: any, data: any) => {
    return request({
      url: `/api/projects/${projectId}/panels/${data.panel_id}`,
      method: 'put',
      data
    })
  },

  // 删除Panel
  deletePanel: (projectId: any, panelId: any) => {
    return request({
      url: `/api/projects/${projectId}/panels/${panelId}`,
      method: 'delete'
    })
  },

  // 复制Panel到Dashboard
  copyToDashboard: (projectId: any, panelId: any, dashboardId: any) => {
    return request({
      url: `/api/projects/${projectId}/dashboards/${dashboardId}/panels`,
      method: 'post',
      data: { panel_id: panelId }
    })
  }
}
