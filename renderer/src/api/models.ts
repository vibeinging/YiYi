import axiosReq from '@/utils/axios-req'

// 获取所有的embed模型
export const embeddingModelsReq = () => {
  return axiosReq({
    url: '/api/llm_model/llm_models',
    method: 'get',
    params: {
      // 后端使用大写分类（参考 LLMModelCategory.EMBEDDING）
      category: 'EMBEDDING'
    },
  })
}

// 获取所有的LLM模型
export function llmModelsReq(params: any) {
  return axiosReq({
    url: '/api/llm_model/llm_models',
    method: 'get',
    params
  })
}

// 创建LLM模型
export function createLLMModelReq(data: any) {
  return axiosReq({
    url: '/api/llm_model/create',
    method: 'post',
    data,
  })
}

// 更新LLM模型
export function updateLLMModelReq(data: any) {
  return axiosReq({
    url: '/api/llm_model/update',
    method: 'post',
    data,
  })
}

// 删除LLM模型
export function deleteLLMModelReq(id: any) {
  return axiosReq({
    url: '/api/llm_model/delete',
    method: 'post',
    data: { model_id: id },
  })
}

// 获取模型详情（需要管理员权限，返回完整api_key）
export function getLLMModelDetailReq(id: any) {
  return axiosReq({
    url: '/api/llm_model/detail',
    method: 'get',
    params: { model_id: id },
  })
}

// 测试模型配置（临时测试，无需保存）- 统一接口
export function testModelConfigReq(data: any) {
  return axiosReq({
    url: '/api/llm_model/test-config',
    method: 'post',
    data,
  })
}

// 获取激活模型（单槽下即该 category 的唯一模型）
export function getActiveLLMModelReq(category: any) {
  return axiosReq({
    url: '/api/llm_model/active',
    method: 'get',
    params: { category }
  })
}
