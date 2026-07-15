// reports 域路由表(批 1:报告模板/报告实例 变更与操作)。一域一文件,避免多 agent 扇出改同一文件冲突。
// 二进制下载端点 GET /api/projects/:pid/reports-v1/:rid/download 本批跳过(留批 4)。
import * as reports from '../app/reports/index.js';

export const reportsRoutes = [
  { m: 'POST', p: '/api/projects/:pid/report-templates-v1/validate', fn: reports.validateTemplate, auth: true },
  { m: 'POST', p: '/api/projects/:pid/report-templates-v1/preview', fn: reports.previewTemplate, auth: true },
  { m: 'POST', p: '/api/projects/:pid/report-templates-v1', fn: reports.createTemplate, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/report-templates-v1/:tid', fn: reports.updateTemplate, auth: true },
  { m: 'POST', p: '/api/projects/:pid/report-templates-v1/:tid/set-default', fn: reports.setDefaultTemplate, auth: true },
  { m: 'POST', p: '/api/projects/:pid/report-templates-v1/:tid/toggle-status', fn: reports.toggleTemplateStatus, auth: true },
  { m: 'GET', p: '/api/projects/:pid/report-templates-v1/:tid/usage-projects', fn: reports.getTemplateUsageBusinesses, auth: true },
  { m: 'GET', p: '/api/projects/:pid/reports/:taskId', fn: reports.getDeepResearchReport, auth: true },
  { m: 'GET', p: '/api/projects/:pid/reports/:taskId/info', fn: reports.getDeepResearchReportInfo, auth: true },
];
