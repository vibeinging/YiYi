// 迁移自 backend/yiw_kernel/semantic_catalogs/business/grep_metrics_tool.py
//
// GrepMetricsTool - 业务指标召回工具（SuperAgent 直接调用，继承 BaseTool）。
//
// 通过 MetricService.search_metrics 从 business 域的预定义指标库（含 sql_template、口径、别名、
// related_tables/columns、code_knowledge 等）按关键词召回，供 SuperAgent 在生成 SQL 前显式取用，
// 避免 LLM 自拼 COUNT/SUM 时口径不对、漏过滤、与业务定义不一致。
//
// 迁移要点：
//  - 对外接口与 Python 1:1：class GrepMetricsTool extends BaseTool；name='align_metric'；inputs/output_type/execute 同名。
//  - Result 用已迁 base_tool.js 的 Result.create / Result.createError（对应 Python Result.create / create_error）。
//  - DB 访问：Python 用 async_session_factory() 取 db 喂 MetricService.search_metrics；桌面版无 ORM/Session，
//    改为从 context 注入的 ctx（{query, queryOne}）取，回落中央 db.js，绝不直连库。
//    MetricService.search_metrics(ctx, {...}) 第一个参数为 ctx（与本波 metric_service.js 迁移约定一致）。
//  - EmbedServiceUnavailable：从 metric_service.js 取类引用做 instanceof 区分（embedding 基础设施故障 vs 无匹配）。
//    TODO(embedding)：桌面版 llm.js 无 embed，MetricService.search_metrics 退化为关键词/名称/描述召回
//    （见 metric_service.js）；本工具保留 EmbedServiceUnavailable 分支语义，仅当服务真不可用时命中。
//  - logging → console；f-string → 模板串；延迟 import 避免启动期循环依赖。

import { BaseTool, Result } from '../core/base_tool.js';
import * as defaultDb from '../../db.js';

// 轻量 logger（对应 Python logging.getLogger）
const logger = {
  error: (...args) => console.error('[grep_metrics]', ...args),
  warn: (...args) => console.warn('[grep_metrics]', ...args),
  info: (...args) => console.info('[grep_metrics]', ...args),
};

const _DESCRIPTION = `**SQL 查询前的指标口径对齐工具**——把用户口中的指标/聚合词
（GMV/DAU/营业额/转化率/复购/客单价/总/平均/排名/同比/环比 等）映射到业务定义的
预定义口径。

为什么需要：业务指标口径（name / description / aliases / sql_template / related_tables /
related_columns / code_knowledge）**不在 schema_info 里**，本工具是唯一入口。
自拼 COUNT/SUM 容易选错列、漏过滤条件、口径与业务定义不一致——这是用户最难
发觉的静默错误。

返回 \`{metrics: [...]}\` 按相似度排序的候选列表。多候选口径接近但不同时（如"GMV"
可能指已支付/下单/净 GMV）配合 ask_user 让用户精确选一个。

参数：
- keyword：用户原文中的指标词（不要预处理）
- business_id：可选，默认当前会话
- limit：默认 5

\`\`\`json
{"tool": "align_metric", "params": {"keyword": "活跃用户数"}}
\`\`\``;

export class GrepMetricsTool extends BaseTool {
  constructor(kwargs = {}) {
    super('align_metric', _DESCRIPTION, kwargs);

    // 对外暴露 inputs / output_type（对应 Python 类属性 inputs）
    this.inputs = {
      keyword: {
        type: 'string',
        description: "指标关键词（必填），例如 'GMV'、'活跃用户数'、'转化率'",
      },
      business_id: {
        type: 'string',
        description: '业务 ID（可选，默认取当前会话的 business_id）',
        optional: true,
        default: '',
      },
      limit: {
        type: 'integer',
        description: '返回数量（默认 5）',
        optional: true,
        default: 5,
      },
    };
    this.output_type = 'object';
  }

  /**
   * 解析查库 ctx（{query, queryOne}）：优先 context 注入，回落中央 db.js。
   * 对应 Python 的 async_session_factory()（桌面版无 ORM/Session）。
   * @param {object} context
   * @returns {{query:Function, queryOne:Function}}
   */
  static _resolve_db_ctx(context) {
    const injected = context && (context.db_ctx || context.dbCtx);
    if (injected && typeof injected.query === 'function') return injected;
    const fromInput = context && context.input_data && context.input_data.db_ctx;
    if (fromInput && typeof fromInput.query === 'function') return fromInput;
    return { query: defaultDb.query, queryOne: defaultDb.queryOne };
  }

  /**
   * 执行 align_metric（对应 async execute）。
   * @param {import('../core/agent_context.js').AgentContext} context
   * @param {object} [kwargs]
   * @returns {Promise<Result>}
   */
  async execute(context, kwargs = {}) {
    const keyword = (kwargs.keyword || '').trim();
    if (!keyword) {
      return Result.createError('缺少必填参数 keyword');
    }

    const projectId = context.project_id || context.input_data?.project_id || '';
    if (!projectId) {
      return Result.createError('缺少 project_id');
    }

    let limit = parseInt(kwargs.limit, 10);
    if (!Number.isFinite(limit) || Number.isNaN(limit)) limit = 5;
    limit = limit || 5;
    limit = Math.max(1, Math.min(limit, 20));

    // 延迟 import MetricService / EmbedServiceUnavailable（对应 Python 模块顶部 import，
    // 这里延迟以避免启动期循环依赖；本波产出 metric_service.js）。
    let MetricService;
    let EmbedServiceUnavailable;
    try {
      ({ MetricService, EmbedServiceUnavailable } = await import('../semantic/metric_service.js'));
    } catch (e) {
      logger.error(`[grep_metrics] 加载 MetricService 失败: ${e?.message ?? e}`);
      return Result.createError(`指标召回失败: ${e?.message ?? e}`);
    }

    const ctx = GrepMetricsTool._resolve_db_ctx(context);

    let metrics;
    try {
      metrics = await MetricService.search_metrics(ctx, {
        query_text: keyword,
        project_id: projectId,
        limit,
      });
    } catch (e) {
      // embedding 服务不可用——明确告知 LLM 这是基础设施故障，不是"没有指标"，
      // 避免 LLM 自拼聚合 SQL 走错口径（对应 except EmbedServiceUnavailable 分支）。
      if (EmbedServiceUnavailable && e instanceof EmbedServiceUnavailable) {
        logger.error(`[grep_metrics] embedding 服务不可用: ${e?.message ?? e}`);
        return Result.createError(
          `指标召回服务暂不可用（embedding 失败）: ${e?.message ?? e}。`
          + '请勿自行拼装 SUM/COUNT 等聚合 SQL——重试本工具或用 ask_user 让用户确认口径。',
        );
      }
      logger.error(`[grep_metrics] 召回失败: ${e?.message ?? e}`);
      return Result.createError(`指标召回失败: ${e?.message ?? e}`);
    }

    if (!metrics || !metrics.length) {
      return Result.create(
        { keyword, metrics: [], total: 0 },
        `未找到匹配 '${keyword}' 的业务指标`,
      );
    }

    const slim = [];
    for (const m of metrics) {
      slim.push({
        id: m.id ?? null,
        name: m.name ?? null,
        description: m.description ?? m.rule ?? null,
        aliases: m.aliases ?? [],
        sql_template: m.sql_template ?? null,
        related_tables: m.related_tables ?? [],
        related_columns: m.related_columns ?? {},
        code_knowledge: m.code_knowledge ?? null,
        // round(float(x), 4)：四舍五入到 4 位小数
        similarity: Math.round(Number(m.similarity ?? 0.0) * 1e4) / 1e4,
      });
    }

    return Result.create(
      {
        keyword,
        metrics: slim,
        total: slim.length,
      },
      `召回 ${slim.length} 个候选指标`,
    );
  }
}

export default GrepMetricsTool;
