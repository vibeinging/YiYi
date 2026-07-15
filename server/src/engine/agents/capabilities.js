// 项目能力探测(从 SuperAgent.probe_capabilities 提取,去 BaseAgent 依赖)。
// bds 部分纯内存读取;ctx=null 时跳过 metric 检查。
import { MetricService } from '../semantic/metric_service.js';
import { MetricViewService } from '../semantic/metric_view_service.js';

/**
 * 业务能力快照——决定 QueryAgent 在 buildQueryTools 中暴露哪些工具。
 *
 * 探测来源：
 * - has_structured / has_unstructured / has_web_search：BusinessDataSources
 *   内存对象 O(1) 读取（task_service 已加载，无 db round-trip）
 * - has_metrics：MetricService.has_business_metrics（Redis 缓存 120s，mutation 主动失效）
 *
 * 注册门控 = prompt 门控（buildQueryTools 只输出真实注册的工具），单一变更点。
 *
 * （原 superagent_models.js 已随 SuperAgent 框架删除；本类是唯一存活者，内联到此。）
 */
export class BusinessCapabilities {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.has_structured=false]
   * @param {boolean} [opts.has_unstructured=false]
   * @param {boolean} [opts.has_web_search=false]
   * @param {boolean} [opts.has_metrics=false]
   * @param {boolean} [opts.has_metric_views=false]
   * @param {boolean} [opts.has_any=false]
   */
  constructor({
    has_structured = false,
    has_unstructured = false,
    has_web_search = false,
    has_metrics = false,
    has_metric_views = false,
    has_any = false,
  } = {}) {
    this.has_structured = has_structured;
    this.has_unstructured = has_unstructured;
    this.has_web_search = has_web_search;
    this.has_metrics = has_metrics;
    this.has_metric_views = has_metric_views;
    this.has_any = has_any;

    // 模拟 frozen=True：防止意外写入（开发期友好提示）
    if (process.env.NODE_ENV !== 'production') {
      Object.freeze(this);
    }
  }

  /** 对应 Python classmethod empty() */
  static empty() {
    return new BusinessCapabilities();
  }
}

/**
 * @param {import('../datasources/business_data_sources.js').BusinessDataSources|null} bds
 * @param {string|null} project_id
 * @param {object|null} [ctx=null]
 * @returns {Promise<BusinessCapabilities>}
 */
export async function probeCapabilities(bds, project_id, ctx = null) {
  let has_structured = false;
  let has_unstructured = false;
  let has_web_search = false;
  let has_mcp = false;
  if (bds != null) {
    has_structured = Boolean(
      (bds.get_database_sources()?.length || 0) ||
        (bds.get_temp_file_sources()?.length || 0),
    );
    has_unstructured = Boolean(bds.get_unstructured_sources()?.length || 0);
    has_web_search = Boolean(bds.web_search_configs && bds.web_search_configs.size > 0);
    has_mcp = Boolean(bds.get_mcp_sources()?.length || 0);
  }

  let has_metrics = false;
  let has_metric_views = false;
  if (project_id && ctx != null) {
    has_metrics = await MetricService.has_business_metrics(ctx, { project_id });
    has_metric_views = await MetricViewService.has_active_views(ctx, project_id);
  }

  const has_any =
    has_structured || has_unstructured || has_web_search || has_mcp || has_metrics || has_metric_views;
  return new BusinessCapabilities({
    has_structured, has_unstructured, has_web_search, has_metrics, has_metric_views, has_any,
  });
}
