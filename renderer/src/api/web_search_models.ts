import request from '@/utils/axios-req'

// 获取网络搜索模型配置列表
export function listWebSearchModelsReq(projectId: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models`,
        method: 'get'
    })
}

// 创建 网络搜索模型配置
export function createWebSearchModelReq(projectId: any, data: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models`,
        method: 'post',
        data
    })
}

// 获取指定的网络搜索模型配置
export function getWebSearchModelReq(projectId: any, modelId: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models/${modelId}`,
        method: 'get'
    })
}

// 更新 网络搜索模型配置
export function updateWebSearchModelReq(projectId: any, modelId: any, data: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models/${modelId}`,
        method: 'put',
        data
    })
}

// 测试网络搜索模型
export function testWebSearchModelReq(projectId: any, data: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models/test-connection`,
        method: 'post',
        data
    })
}

// 删除网络搜索模型配置
export function deleteWebSearchModelReq(projectId: any, modelId: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models/${modelId}`,
        method: 'delete'
    })
}

// 获取支持的网络搜索模型类型列表
export function getWebSearchModelTypesReq() {
    return request({
        url: '/api/web-search-models/support',
        method: 'get'
    })
}

// 问答测试网络搜索模型
export function qaTestWebSearchModelReq(projectId: any, data: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models/qa-test`,
        method: 'post',
        data
    })
}

// 根据原始响应推断响应解析（LLM）
export function inferWebSearchResponseMappingsReq(projectId: any, data: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models/infer-response-mappings`,
        method: 'post',
        data
    })
}
