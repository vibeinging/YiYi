// reads 域路由表(批 4:index.js 内所有 GET 列表/读取端点,抽自 index.js)。
// 一域一 registry,避免多 agent 扇出改同一文件冲突。
//
// 全部为只读 GET。按聚合拆 4 个用例文件:index(项目级 misc)/ reads_business / reads_session / reads_datasource。
//
// 路由顺序:字面量段必须排在同前缀的 :param 通配之前(router.js 首匹配命中);
// 不同段数的路径无冲突,但仍按「具体在前」原则排列以防回归。
//
// 注:report-templates-v1/:tid/usage-businesses 已在 registry.reports.js 迁移,本表不重复。
import * as reads from "../app/reads/index.js";
import * as rb from "../app/reads/reads_business.js";
import * as rs from "../app/reads/reads_session.js";
import * as rd from "../app/reads/reads_datasource.js";

export const readsRoutes = [
  // ── 会话(列表/详情/消息/反馈/中间表)──
  { m: "GET", p: "/api/projects/:pid/sessions", fn: rs.listSessions, auth: true },
  { m: "GET", p: "/api/projects/:pid/sessions/:sid/messages", fn: rs.listSessionMessages, auth: true },
  { m: "GET", p: "/api/projects/:pid/sessions/:sid/intermediate-tables", fn: rs.listIntermediateTables, auth: true },
  { m: "GET", p: "/api/projects/:pid/sessions/:sid/feedback-status", fn: rs.getSessionFeedbackStatus, auth: true },
  { m: "GET", p: "/api/projects/:pid/sessions/:sid", fn: rs.getSession, auth: true },

  // ── 项目语义:数据源 / 指标 / 实体 / 指标视图 / 示例(去业务层:资源直接挂项目)──
  // 注:listBusinesses/getBusiness 仍指向 businesses 表(过渡保留,见阶段 6)。
  { m: "GET", p: "/api/projects/:pid/businesses", fn: rb.listBusinesses, auth: true },
  { m: "GET", p: "/api/projects/:pid/data-sources", fn: rb.getBusinessDataSources, auth: true },
  // 指标 / 实体 / 指标视图 / 示例(具体路径在 :mvid 通配之前)
  { m: "GET", p: "/api/projects/:pid/metrics/embedding_pending_count", fn: rb.getMetricsEmbeddingPendingCount, auth: true },
  { m: "GET", p: "/api/projects/:pid/metrics", fn: rb.listMetrics, auth: true },
  { m: "GET", p: "/api/projects/:pid/entity_configs", fn: rb.listEntityConfigs, auth: true },
  { m: "GET", p: "/api/projects/:pid/entities", fn: rb.listEntities, auth: true },
  { m: "GET", p: "/api/projects/:pid/metric-views/:mvid", fn: rb.getMetricView, auth: true },
  { m: "GET", p: "/api/projects/:pid/metric-views", fn: rb.listMetricViews, auth: true },
  { m: "GET", p: "/api/projects/:pid/examples/stats", fn: rb.getExamplesStats, auth: true },
  { m: "GET", p: "/api/projects/:pid/examples", fn: rb.listExamples, auth: true },
  { m: "GET", p: "/api/projects/:pid/business", fn: rb.getBusiness, auth: true },

  // ── 数据库连接 / 表 / 字段 / 关系 / 待同步 ──
  { m: "GET", p: "/api/projects/:pid/databases/meta/supported-types", fn: rd.listSupportedDbTypes, auth: true },
  { m: "GET", p: "/api/projects/:pid/databases/:cid/tables/:tid/columns", fn: rd.listColumns, auth: true },
  { m: "GET", p: "/api/projects/:pid/databases/:cid/tables", fn: rd.listTables, auth: true },
  { m: "GET", p: "/api/projects/:pid/databases/:cid/relationships", fn: rd.listRelationships, auth: true },
  { m: "GET", p: "/api/projects/:pid/databases/:cid/sync_pending", fn: rd.getSyncPending, auth: true },
  { m: "GET", p: "/api/projects/:pid/databases/:cid", fn: rd.getDatabase, auth: true },
  { m: "GET", p: "/api/projects/:pid/databases", fn: rd.listDatabases, auth: true },

  // ── 结构化 / 非结构化数据源(连字符 & 无连字符两套路径,前端历史并存)──
  { m: "GET", p: "/api/projects/:pid/structured-data-sources", fn: rd.listStructuredDataSourcesHyphen, auth: true },
  { m: "GET", p: "/api/projects/:pid/unstructured-data-sources", fn: rd.listUnstructuredDataSourcesHyphen, auth: true },
  { m: "GET", p: "/api/projects/:pid/structured-datasources", fn: rd.listStructuredDatasources, auth: true },
  { m: "GET", p: "/api/projects/:pid/unstructured-datasources", fn: rd.listUnstructuredDatasources, auth: true },

  // ── 成员 / 邀请链接 ──
  { m: "GET", p: "/api/projects/:pid/members", fn: reads.listMembers, auth: true },
  { m: "GET", p: "/api/projects/:pid/invite-links", fn: reads.listInviteLinks, auth: true },

  // ── 报告 / 报告模板(usage-businesses 已在 reports 域迁移,不重复)──
  { m: "GET", p: "/api/projects/:pid/report-templates-v1/:tid", fn: reads.getReportTemplate, auth: true },
  { m: "GET", p: "/api/projects/:pid/report-templates-v1", fn: reads.listReportTemplates, auth: true },
  { m: "GET", p: "/api/projects/:pid/reports-v1/:rid", fn: reads.getReport, auth: true },
  { m: "GET", p: "/api/projects/:pid/reports-v1", fn: reads.listReports, auth: true },

  // ── 看板 / Panel ──
  { m: "GET", p: "/api/projects/:pid/dashboards/:did/panels", fn: reads.listDashboardPanels, auth: true },
  { m: "GET", p: "/api/projects/:pid/dashboards", fn: reads.listDashboards, auth: true },
  { m: "GET", p: "/api/projects/:pid/panels/:panelId", fn: reads.getPanel, auth: true },
  { m: "GET", p: "/api/projects/:pid/panels", fn: reads.listPanels, auth: true },

  // ── MCP Provider ──
  { m: "GET", p: "/api/projects/:pid/mcp_providers", fn: reads.listMcpProviders, auth: true },
];
