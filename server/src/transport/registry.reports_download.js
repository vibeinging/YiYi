// reports 域 — 二进制下载路由表(批 1 跳过、批 4 例外补迁)。
// GET /api/projects/:pid/reports-v1/:rid/download:用例返回 _binary 形状,transport 走 base64。
import * as download from '../app/reports/download.js';

export const reportsDownloadRoutes = [
  { m: 'GET', p: '/api/projects/:pid/reports-v1/:rid/download', fn: download.downloadReport, auth: true },
];
