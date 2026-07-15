// 迁移自 backend/yiw_kernel/data_analyze/planner/dbagents/tools/sql_validation_tool.py
//
// SQL 验证工具 - 专门负责 SQL 的 explain 验证
//
// 职责：
// 1. 执行 explain 验证 SQL
// 2. 分析验证结果
// 3. 分类错误类型
// 4. 提供验证统计
//
// 设计原则：
// - 单一职责：只负责 SQL 验证
// - 纯工具：不涉及业务逻辑
// - 可复用：可被其他 Agent 使用
//
// 迁移说明（1:1，对外接口名 100% 保持一致，供下游 1:1 import）：
// - class SQLValidationResult / SQLValidationErrorClassifier / SQLValidationTool 与方法名逐一对齐。
// - SQLValidationTool 继承 BaseTool（契约要求）；其余两类是纯数据/工具类，不继承。
// - Python `from ..models import SQLCandidate` 的 SQLCandidate 仅含 {sql, reasoning}，Node
//   侧 models.py 未单独迁移，这里就地内联同名轻量类（from_dict / fromDict / to_dict / toDict），
//   契约 1:1。
// - explain 验证：Python 走 core.database.database_plugin_service.explain_query(host/port/...)
//   直连目标库。Node 数据访问层「不直连库」，改为走注入的数据源 / duck.js：
//     * 优先用注入的 explain 回调（this.explainFn 或 db_connection.explain(sql)）；
//     * 否则若 db_connection 暴露 async query(sql) → 用 EXPLAIN <sql> 试跑；
//     * 否则若有 intermediate_db_path（DuckDB 文件）→ duck.js 本地 EXPLAIN。
//   统一返回 {status: bool, data: any}，与 Python explain_query 的返回契约 1:1。
// - asyncio.gather(return_exceptions=True) → Promise.allSettled；async with → try/finally（本文件无）。
// - logging → console（保留 emoji 行）；f-string → 模板串；.format("{}") 仍走 i18n t()。
// - List[Dict] / Dict[str, Any] → 普通数组 / 对象；Optional → 默认参数。

import { BaseTool } from '../core/base_tool.js';
import { t } from '../utils/i18n.js';
import { duckRun } from '../datasources/duck.js';

/** 轻量 logger（对应 Python logging.getLogger(__name__)，保留 emoji 日志行） */
const logger = {
  error: (...args) => console.error('[sql_validation_tool]', ...args),
  warn: (...args) => console.warn('[sql_validation_tool]', ...args),
  warning: (...args) => console.warn('[sql_validation_tool]', ...args),
  info: (...args) => console.info('[sql_validation_tool]', ...args),
  debug: (...args) => console.debug('[sql_validation_tool]', ...args),
};

// ============================================================
// SQLCandidate — 统一的 SQL 候选数据结构
// （对应 Python dbagents/models.py SQLCandidate；Node 侧未单独迁移，就地内联）
// ============================================================

/**
 * 统一的 SQL 候选数据结构（对应 pydantic SQLCandidate）。
 */
export class SQLCandidate {
  /**
   * @param {object} [opts]
   * @param {string} [opts.sql='']
   * @param {string} [opts.reasoning='']
   */
  constructor({ sql = '', reasoning = '' } = {}) {
    this.sql = sql;
    this.reasoning = reasoning ?? '';
  }

  /**
   * 转换为字典格式，用于 Agent 间传递（对应 to_dict）。
   * @returns {{sql: string, reasoning: string}}
   */
  to_dict() {
    return { sql: this.sql, reasoning: this.reasoning };
  }

  /** @alias to_dict */
  toDict() {
    return this.to_dict();
  }

  /**
   * 从字典创建实例（对应 classmethod from_dict）。
   * @param {object} [data={}]
   * @returns {SQLCandidate}
   */
  static from_dict(data = {}) {
    const d = data || {};
    return new SQLCandidate({ sql: d.sql ?? '', reasoning: d.reasoning ?? '' });
  }

  /** @alias from_dict */
  static fromDict(data = {}) {
    return SQLCandidate.from_dict(data);
  }
}

// ============================================================
// SQLValidationResult — SQL 验证结果
// ============================================================

/**
 * SQL 验证结果（对应 Python class SQLValidationResult）。
 */
export class SQLValidationResult {
  constructor() {
    /** @type {Array<object>} */
    this.valid_candidates = [];
    /** @type {Array<object>} */
    this.failed_results = [];
    /** @type {number} */
    this.total_candidates = 0;
    /** @type {Object<string, any>} */
    this.validation_stats = {};
  }

  /**
   * 添加验证成功的候选。
   * @param {object} candidate
   */
  add_success(candidate) {
    this.valid_candidates.push(candidate);
  }

  /**
   * 添加验证失败的候选。
   * @param {object} candidate
   * @param {string} error_result
   */
  add_failure(candidate, error_result) {
    this.failed_results.push({
      candidate,
      explain_result: error_result,
      explain_passed: false,
    });
  }

  /**
   * 获取验证摘要。
   * @returns {string}
   */
  get_summary() {
    return t('通过验证: {}/{} 个候选', this.valid_candidates.length, this.total_candidates);
  }
}

// ============================================================
// SQLValidationErrorClassifier — SQL 验证错误分类器
// ============================================================

/**
 * SQL 验证错误分类器（对应 Python class SQLValidationErrorClassifier）。
 */
export class SQLValidationErrorClassifier {
  /**
   * 分类错误类型（对应 @staticmethod classify_error）。
   * @param {string} error_msg
   * @returns {string}
   */
  static classify_error(error_msg) {
    const error_msg_lower = String(error_msg ?? '').toLowerCase();

    if (
      error_msg_lower.includes('table') &&
      (error_msg_lower.includes('not exist') || error_msg_lower.includes('does not exist'))
    ) {
      return '🗂️ 表不存在错误';
    } else if (
      error_msg_lower.includes('column') &&
      (error_msg_lower.includes('not found') || error_msg_lower.includes('does not exist'))
    ) {
      return '📋 列不存在错误';
    } else if (error_msg_lower.includes('syntax') || error_msg_lower.includes('parse')) {
      return '📝 SQL语法错误';
    } else if (error_msg_lower.includes('permission') || error_msg_lower.includes('access')) {
      return '🔒 权限错误';
    } else if (error_msg_lower.includes('connection') || error_msg_lower.includes('timeout')) {
      return '🌐 连接错误';
    } else if (error_msg_lower.includes('function') && error_msg_lower.includes('not exist')) {
      return '⚙️ 函数不存在错误';
    } else {
      return '❓ 其他错误';
    }
  }
}

// ============================================================
// SQLValidationTool — SQL 验证工具
// ============================================================

/**
 * SQL 验证工具（对应 Python class SQLValidationTool）。
 *
 * 契约要求继承 BaseTool。Python 原版是纯类（无 name/inputs/output_type/run），
 * 这里保留其全部公有方法 1:1，并补齐 BaseTool 抽象方法 execute()（委托 validate_candidates）。
 */
export class SQLValidationTool extends BaseTool {
  /**
   * @param {object} [opts]
   * @param {Function|null} [opts.explainFn]  注入的 explain 回调：
   *   async (sql, { db_connection, intermediate_db_path, timeout }) => {status: bool, data: any}。
   *   未注入时走 _default_explain（db_connection.explain / db_connection.query / duck.js）。
   */
  constructor({ explainFn = null } = {}) {
    super('SQLValidationTool', 'SQL 验证工具');
    this.classifier = SQLValidationErrorClassifier;
    this.timeout = 10; // 默认超时时间
    // 数据访问层不直连库：explain 走注入回调或注入数据源/ctx（详见 _default_explain）
    this.explainFn = explainFn;
  }

  /**
   * BaseTool 抽象方法实现：委托到 validate_candidates。
   *
   * @param {object} context - AgentContext（透传，便于注入数据源/ctx）
   * @param {object} [kwargs]
   * @param {Array<object>} [kwargs.candidates=[]]
   * @param {any} [kwargs.db_connection=null]
   * @param {Function|null} [kwargs.stream_callback=null]
   * @param {string|null} [kwargs.intermediate_db_path=null]
   * @returns {Promise<SQLValidationResult>}
   */
  async execute(context, kwargs = {}) {
    const {
      candidates = [],
      db_connection = null,
      stream_callback = null,
      intermediate_db_path = null,
    } = kwargs || {};
    return this.validate_candidates(candidates, db_connection, stream_callback, intermediate_db_path);
  }

  /**
   * 验证 SQL 候选列表（对应 Python async validate_candidates）。
   *
   * @param {Array<object>} candidates - SQL 候选列表
   * @param {any} db_connection - 数据库连接信息（注入数据源/连接对象）
   * @param {Function|null} [stream_callback=null] - 流式回调函数
   * @param {string|null} [intermediate_db_path=null] - 中间表 DuckDB 文件路径（用于 ATTACH 中间表）
   * @returns {Promise<SQLValidationResult>} 验证结果
   */
  async validate_candidates(candidates, db_connection, stream_callback = null, intermediate_db_path = null) {
    const result = new SQLValidationResult();
    result.total_candidates = (candidates ?? []).length;

    if (!candidates || !candidates.length) {
      logger.warning('⚠️ [SQLValidationTool] 没有候选需要验证');
      return result;
    }

    logger.info(`🔍 [SQLValidationTool] 开始验证 ${candidates.length} 个候选SQL`);

    // 并发验证所有候选（对应 asyncio.gather(..., return_exceptions=True)）
    const tasks = candidates.map((candidate, i) =>
      this._validate_single_candidate(candidate, i, db_connection, intermediate_db_path),
    );

    const settled = await Promise.allSettled(tasks);

    // 处理验证结果
    for (const item of settled) {
      if (item.status === 'fulfilled') {
        const validation_result = item.value;
        if (validation_result && typeof validation_result === 'object' && !Array.isArray(validation_result)) {
          if (validation_result.explain_passed ?? false) {
            result.add_success(validation_result.candidate);
          } else {
            result.add_failure(
              validation_result.candidate,
              validation_result.explain_result ?? '未知错误',
            );
          }
        } else {
          logger.error(`💥 [SQLValidationTool] 验证异常: ${validation_result}`);
        }
      } else {
        logger.error(`💥 [SQLValidationTool] 验证异常: ${item.reason?.message ?? item.reason}`);
      }
    }

    // 生成统计信息
    result.validation_stats = this._generate_stats(result);

    logger.info(
      `🎯 [SQLValidationTool] 验证完成，有效候选: ${result.valid_candidates.length}/${result.total_candidates}`,
    );

    return result;
  }

  /**
   * 验证单个候选（对应 Python async _validate_single_candidate）。
   *
   * @param {object} candidate - SQL 候选
   * @param {number} index - 候选索引
   * @param {any} db_connection - 数据库连接信息
   * @param {string|null} [intermediate_db_path=null] - 中间表 DuckDB 文件路径
   * @returns {Promise<Object<string, any>>}
   */
  async _validate_single_candidate(candidate, index, db_connection, intermediate_db_path = null) {
    try {
      const sql_candidate = SQLCandidate.from_dict(candidate);

      const explain_result = await this._explain_query(sql_candidate.sql, {
        db_connection,
        intermediate_db_path,
        timeout: this.timeout,
      });

      return {
        candidate,
        explain_passed: explain_result.status ?? false,
        explain_result: explain_result.data,
        candidate_index: index + 1,
      };
    } catch (e) {
      logger.error(`候选 ${index + 1} explain 验证失败: ${e?.message ?? e}`);
      return {
        candidate,
        explain_passed: false,
        explain_result: String(e?.message ?? e),
        candidate_index: index + 1,
      };
    }
  }

  /**
   * 执行 EXPLAIN 验证（对应 Python core.database...explain_query，Node 不直连库）。
   *
   * 解析顺序：
   *   1. this.explainFn / db_connection.explain(sql) — 注入回调，返回 {status, data}；
   *   2. db_connection.query(sql) — 注入数据源，用 EXPLAIN 试跑（QueryResult.success → status）；
   *   3. intermediate_db_path（DuckDB 文件）— duck.js 本地 EXPLAIN；
   *   4. 都不可用 → status:false + 提示（与 Python explain_query 异常分支同形）。
   *
   * 统一返回 {status: bool, data: any}，与 Python explain_query 返回契约 1:1。
   *
   * @param {string} sql
   * @param {object} [opts]
   * @param {any} [opts.db_connection=null]
   * @param {string|null} [opts.intermediate_db_path=null]
   * @param {number} [opts.timeout=10]
   * @returns {Promise<{status: boolean, data: any}>}
   */
  async _explain_query(sql, { db_connection = null, intermediate_db_path = null, timeout = 10 } = {}) {
    try {
      // 1. 注入的 explain 回调（优先）
      const explainFn =
        this.explainFn ||
        (db_connection && typeof db_connection.explain === 'function'
          ? (s) => db_connection.explain(s, { timeout, intermediate_db_path })
          : null);
      if (explainFn) {
        const r = await explainFn(sql, { db_connection, intermediate_db_path, timeout });
        // 容忍回调直接返回 {status,data}；否则按真值包装
        if (r && typeof r === 'object' && 'status' in r) {
          return { status: Boolean(r.status), data: r.data };
        }
        return { status: true, data: r };
      }

      // 2. 注入数据源的 query()：用 EXPLAIN 试跑
      if (db_connection && typeof db_connection.query === 'function') {
        const qr = await db_connection.query(`EXPLAIN ${sql}`, { intermediate_db_path });
        const ok = qr?.success ?? false;
        return { status: ok, data: ok ? qr.data : qr?.message ?? '未知错误' };
      }

      // 3. DuckDB 本地 EXPLAIN（中间表文件）
      if (intermediate_db_path) {
        const out = await duckRun(intermediate_db_path, `EXPLAIN ${sql}`, 1);
        return { status: true, data: out };
      }

      // 4. 无可用校验通道
      return {
        status: false,
        data: t('解释失败') + ': ' + t('未提供可用的数据源/连接（db_connection / intermediate_db_path）'),
      };
    } catch (e) {
      // 对齐 Python explain_query 的异常分支：{status: False, data: "解释失败: ..."}
      logger.error(`SQL解释失败: ${e?.message ?? e}`);
      return { status: false, data: `${t('解释失败')}: ${String(e?.message ?? e)}` };
    }
  }

  /**
   * 生成验证统计信息（对应 Python _generate_stats）。
   * @param {SQLValidationResult} result
   * @returns {Object<string, any>}
   */
  _generate_stats(result) {
    return {
      total_candidates: result.total_candidates,
      valid_count: result.valid_candidates.length,
      failed_count: result.failed_results.length,
      success_rate:
        result.total_candidates > 0
          ? result.valid_candidates.length / result.total_candidates
          : 0,
      error_patterns: this._extract_error_patterns(result.failed_results),
    };
  }

  /**
   * 提取错误模式统计（对应 Python _extract_error_patterns）。
   * @param {Array<object>} failed_results
   * @returns {Object<string, number>}
   */
  _extract_error_patterns(failed_results) {
    const error_counts = {};
    for (const result of failed_results) {
      const error_msg = result.explain_result ?? '未知错误';
      const error_type = this.classifier.classify_error(error_msg);

      if (!(error_type in error_counts)) {
        error_counts[error_type] = 0;
      }
      error_counts[error_type] += 1;
    }
    return error_counts;
  }

  /**
   * 显示验证结果（对应 Python async _display_validation_result）。
   * @param {SQLValidationResult} result
   * @param {Function} stream_callback
   * @returns {Promise<void>}
   */
  async _display_validation_result(result, stream_callback) {
    // 基本统计
    const success_rate = `${(result.validation_stats.success_rate * 100).toFixed(1)}%`;
    let summary = t('SQL验证') + '\n';
    summary += t('通过验证: {}/{} 个候选', result.valid_candidates.length, result.total_candidates);
    summary += t('成功率: {}', success_rate) + '\n\n';

    // 失败统计（如果有）
    if (result.failed_results.length) {
      summary += `### ${t('失败分析')}\n\n`;
      const patterns = Object.entries(result.validation_stats.error_patterns).sort(
        (a, b) => b[1] - a[1],
      );
      for (const [error_type, count] of patterns) {
        summary += `- **${error_type}**: ${count} ${t('次')}\n`;
      }
      summary += '\n';
    }

    await stream_callback(summary, {
      content_type: 'markdown',
      title: t('SQL 验证结果'),
    });
  }

  /**
   * 设置验证超时时间（对应 Python set_timeout）。
   * @param {number} timeout
   */
  set_timeout(timeout) {
    this.timeout = timeout;
  }
}

export default SQLValidationTool;
