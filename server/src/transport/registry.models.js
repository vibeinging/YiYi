// models 域路由表(LLM 模型 CRUD / 测试连接 / 项目模型 / 项目网络搜索模型,抽自 index.js)。
// 一域一文件,避免多 agent 扇出冲突。
import * as models from '../app/models/index.js';

export const modelsRoutes = [
  // ── 系统级模型 CRUD（/api/llm_model/*，全字面路径）──
  { m: 'GET', p: '/api/llm_model/llm_models', fn: models.listModels, auth: true },
  { m: 'GET', p: '/api/llm_model/active', fn: models.listActiveModels, auth: true },
  { m: 'GET', p: '/api/llm_model/detail', fn: models.getModelDetail, auth: true },
  {
    m: 'POST', p: '/api/llm_model/create', fn: models.createModel, auth: true,
    capability: {
      title: '创建模型配置', domain: 'models', safety: 'write',
      input_schema: {
        body: {
          type: 'object', required: ['model_name', 'api_base'], additionalProperties: true,
          properties: {
            model_name: { type: 'string', minLength: 1 },
            api_base: { type: 'string', minLength: 1 },
            category: { type: 'string', enum: ['PRIMARY', 'SECONDARY', 'EMBEDDING'] },
            api_key: { type: 'string' },
            api_format: { type: 'string' },
          },
        },
      },
    },
  },
  { m: 'POST', p: '/api/llm_model/update', fn: models.updateModel, auth: true },
  { m: 'POST', p: '/api/llm_model/delete', fn: models.deleteModel, auth: true },
  { m: 'POST', p: '/api/llm_model/test-config', fn: models.testModelConfig, auth: true },

  // ── 项目模型 / 项目网络搜索模型 ──
  { m: 'GET', p: '/api/projects/:pid/models', fn: models.listProjectModels, auth: true },
  { m: 'POST', p: '/api/projects/:pid/models', fn: models.createProjectModel, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/models', fn: models.updateProjectModel, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/models/:modelId', fn: models.deleteProjectModel, auth: true },
  { m: 'GET', p: '/api/projects/:pid/web-search-models', fn: models.listProjectWebSearchModels, auth: true },
];
