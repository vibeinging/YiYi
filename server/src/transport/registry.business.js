// 项目语义域路由表(去业务层:资源直接挂 /api/projects/:pid,不再有 :bid 中间段)。
// 抽自原 routes/business_crud.js,53 端点收敛为项目级端点。
// 一域一 registry,避免多 agent 扇出冲突。
//
// 顺序与源文件 register() 内逐行一致 —— 具体路径必须在通配 :param 之前注册(metrics/metric-views)。
//
// 涉及 LLM/向量/外部 DB 提取/Excel 解析的端点在 Node 层仅做 501 stub(共 15 个),
// 不写 usecase 函数,registry 直接挂 stub helper(沿用源 [Node stub] … 请通过 Python 后端调用 文案)。
import { ApiError } from "../errors.js";
import * as business from "../app/business/business.js";
import * as metrics from "../app/business/metrics.js";
import * as examples from "../app/business/examples.js";
import * as entityConfigs from "../app/business/entity_configs.js";
import * as metricViews from "../app/business/metric_views.js";
import * as memory from "../app/business/memory.js";
import * as workflows from "../app/business/workflows.js";

// 501 stub:该端点需要 LLM/向量/外部 DB/Excel 服务,Node 层暂未实现。沿用源文案。
const stub = (description) => () => {
  throw new ApiError(`[Node stub] ${description} — 请通过 Python 后端调用`, 501);
};

export const businessRoutes = [
  // ── 消歧记忆(团队映射记忆)CRUD ──
  { m: "GET", p: "/api/projects/:pid/memory", fn: memory.listMemory, auth: true },
  { m: "POST", p: "/api/projects/:pid/memory", fn: memory.createMemory, auth: true },
  { m: "PUT", p: "/api/projects/:pid/memory/:rid", fn: memory.updateMemory, auth: true },
  { m: "POST", p: "/api/projects/:pid/memory/bulk_import", fn: memory.bulkImportMemory, auth: true },
  { m: "POST", p: "/api/projects/:pid/memory/bulk_delete", fn: memory.bulkDeleteMemory, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/memory/:rid", fn: memory.deleteMemory, auth: true },

  // ── Business CRUD(去业务层:项目即业务,不再创建/更新/删除 business 实体)──
  // 原 POST/PUT/DELETE /businesses 端点已废弃(businesses 表保留作过渡,见阶段 6)。

  // ── Data Sources binding(数据源绑定直接挂项目)──
  { m: "POST", p: "/api/projects/:pid/data-sources", fn: business.bindDataSource, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/data-sources", fn: business.unbindDataSource, auth: true },

  // ── Entity Refs (business_entity_configs) ──
  { m: "GET", p: "/api/projects/:pid/entity_refs", fn: entityConfigs.listEntityRefs, auth: true },
  { m: "GET", p: "/api/projects/:pid/entity_refs/available", fn: entityConfigs.listAvailableEntityRefs, auth: true },
  { m: "POST", p: "/api/projects/:pid/entity_refs", fn: entityConfigs.addEntityRefs, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/entity_refs/:refId", fn: entityConfigs.removeEntityRef, auth: true },
  { m: "PATCH", p: "/api/projects/:pid/entity_refs/:refId/active", fn: entityConfigs.toggleEntityRefActive, auth: true },

  // ── Metrics CRUD(具体路径在 :mid 通配之前)──
  { m: "POST", p: "/api/projects/:pid/metrics/generate_embeddings", fn: metrics.generateMetricEmbeddings, auth: true },
  { m: "POST", p: "/api/projects/:pid/metrics/bulk_import", fn: stub("bulk_import_metrics 需要 Excel 解析"), auth: true },
  { m: "GET", p: "/api/projects/:pid/metrics/search", fn: stub("search_metrics 需要向量服务"), auth: true },
  { m: "POST", p: "/api/projects/:pid/metrics/code_values/import", fn: stub("import_code_values 需要 Excel 解析"), auth: true },
  { m: "GET", p: "/api/projects/:pid/metrics/code_values/export", fn: stub("export_code_values 需要 Excel/JSON 生成"), auth: true },
  { m: "PATCH", p: "/api/projects/:pid/metrics/batch_update_status", fn: metrics.batchUpdateMetricStatus, auth: true },
  { m: "PATCH", p: "/api/projects/:pid/metrics/:mid/status", fn: metrics.updateMetricStatus, auth: true },
  { m: "POST", p: "/api/projects/:pid/metrics", fn: metrics.createMetric, auth: true },
  { m: "PUT", p: "/api/projects/:pid/metrics/:mid", fn: metrics.updateMetric, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/metrics/:mid", fn: metrics.deleteMetric, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/metrics", fn: metrics.deleteMetrics, auth: true },

  // ── Examples CRUD ──
  { m: "POST", p: "/api/projects/:pid/examples/search", fn: examples.searchExamplesUseCase, auth: true },
  { m: "POST", p: "/api/projects/:pid/examples/generate_embeddings", fn: examples.generateExampleEmbeddings, auth: true },
  { m: "POST", p: "/api/projects/:pid/examples", fn: examples.createExamples, auth: true },
  { m: "PUT", p: "/api/projects/:pid/examples/:eid", fn: examples.updateExample, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/examples", fn: examples.deleteExamples, auth: true },

  // ── Entity Configs (entity_mapping_configs) ──
  { m: "POST", p: "/api/projects/:pid/entity_configs/generate_embeddings", fn: entityConfigs.generateEntityConfigEmbeddings, auth: true },
  { m: "POST", p: "/api/projects/:pid/entity_configs", fn: stub("create_entity_config 需要外部数据库连接提取实体"), auth: true },
  { m: "PUT", p: "/api/projects/:pid/entity_configs/:cid", fn: entityConfigs.updateEntityConfig, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/entity_configs/:cid", fn: entityConfigs.deleteEntityConfig, auth: true },

  // ── Entity Mappings (entities) ──
  { m: "POST", p: "/api/projects/:pid/entity_mappings/column_names", fn: stub("create_column_name_entities 需要外部数据库连接"), auth: true },
  { m: "POST", p: "/api/projects/:pid/entity_mappings/test_agent", fn: stub("test_entity_agent 需要 LLM 服务"), auth: true },
  { m: "POST", p: "/api/projects/:pid/entity_mappings/revert_auto_promoted", fn: stub("revert_auto_promoted 功能开发中"), auth: true },
  { m: "DELETE", p: "/api/projects/:pid/entities", fn: entityConfigs.deleteEntities, auth: true },
  { m: "POST", p: "/api/projects/:pid/entities/search", fn: stub("search_entities 需要向量服务"), auth: true },
  { m: "POST", p: "/api/projects/:pid/entities/import_excel", fn: stub("import_entities_from_excel 需要 Excel 解析"), auth: true },

  // ── Metric Views CRUD(具体路径在 :mvid 通配之前)──
  { m: "POST", p: "/api/projects/:pid/metric-views/preview", fn: stub("preview_metric_view 需要外部数据库连接"), auth: true },
  { m: "POST", p: "/api/projects/:pid/metric-views/embeddings", fn: metricViews.generateMetricViewEmbeddings, auth: true },
  { m: "POST", p: "/api/projects/:pid/metric-views/column-distinct-values", fn: stub("get_column_distinct_values 需要外部数据库连接"), auth: true },
  { m: "POST", p: "/api/projects/:pid/metric-views/recommendations", fn: stub("run_metric_view_recommendation 需要 LLM 服务"), auth: true },
  { m: "GET", p: "/api/projects/:pid/metric-views/recommendations/latest", fn: metricViews.getLatestMetricViewRecommendation, auth: true },
  { m: "GET", p: "/api/projects/:pid/metric-views/recommendations/:taskId", fn: stub("get_metric_view_recommendation_task 需要 LLM 服务"), auth: true },
  { m: "POST", p: "/api/projects/:pid/metric-views/recommendations/:taskId/apply", fn: stub("apply_metric_view_recommendation 需要 LLM 服务"), auth: true },
  { m: "PATCH", p: "/api/projects/:pid/metric-views/:mvid/status", fn: metricViews.updateMetricViewStatus, auth: true },
  { m: "POST", p: "/api/projects/:pid/metric-views", fn: metricViews.createMetricView, auth: true },
  { m: "PUT", p: "/api/projects/:pid/metric-views/:mvid", fn: metricViews.updateMetricView, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/metric-views/:mvid", fn: metricViews.deleteMetricView, auth: true },

  // ── SuperAgent Workflow(项目级;business_id 兼容列写 pid)──
  { m: "POST", p: "/api/projects/:pid/superagent-workflows", fn: workflows.createWorkflow, auth: true },
  { m: "GET", p: "/api/projects/:pid/superagent-workflows", fn: workflows.listWorkflows, auth: true },
  { m: "GET", p: "/api/projects/:pid/superagent-workflows/:workflowId", fn: workflows.getWorkflow, auth: true },
  { m: "PUT", p: "/api/projects/:pid/superagent-workflows/:workflowId", fn: workflows.updateWorkflow, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/superagent-workflows/:workflowId", fn: workflows.deleteWorkflow, auth: true },
  { m: "POST", p: "/api/projects/:pid/superagent-workflows/:workflowId/runs", fn: workflows.triggerWorkflowRun, auth: true },
  { m: "GET", p: "/api/projects/:pid/superagent-workflows/:workflowId/runs", fn: workflows.listWorkflowRuns, auth: true },
  { m: "GET", p: "/api/superagent-workflow-runs/:runId", fn: workflows.getWorkflowRun, auth: true },
];
