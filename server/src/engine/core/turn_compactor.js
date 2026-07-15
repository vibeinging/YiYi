// 迁移自 core/agentic_flow/core/turn_compactor.py

/**
 * Turn 内压缩：折叠当前任务里"已完成 task 的过程性 tool_history"为一条摘要。
 *
 * 设计原则：
 * - 按"语义角色"决定保留 / 压缩，不按"最近 N 条"机械窗口
 * - 保留：当前 task 全部 raw + 旧 task 的"产出工具成功调用" + 所有用户消息
 * - 压缩：旧 task 的多轮思考、grep 探索、失败重试、被 replan 替换掉的旧 task 全部
 * - 兜底：summarize 失败/为空 → 不压缩 + 推送 compaction_failed 事件 + 调用方决定是否截断
 */

import { t } from '../utils/i18n.js';
import { ContextBudget, countMessageTokens } from './context_budget.js';
import { SummarizerError, SummarySpec, summarize } from './summarizer.js';

export {
  SEMANTIC_PRESERVE_TOOLS,
  TurnCompactor,
  TurnCompactionResult,
  build_default_turn_compactor,
};

// ============================================================
// 常量
// ============================================================

/**
 * 产出"事实/数据"的工具，旧 task 的这些成功调用必须保留原文。
 * @type {Set<string>}
 */
const SEMANTIC_PRESERVE_TOOLS = new Set([
  // 中间数据产出
  'sql_scan_operator',
  'rag_operator',
  'semantic_scan_operator',
  'semantic_filter_operator',
  'semantic_extract_operator',
  'semantic_join_operator',
  'web_search_operator',
  'python_code_analysis_tool',
  // 最终产出
  'format_result',
]);

// ============================================================
// TurnCompactionResult
// ============================================================

/**
 * 压缩执行的可观察结果。
 */
class TurnCompactionResult {
  /**
   * @param {object} opts
   * @param {boolean}     opts.compacted
   * @param {string}      [opts.summaryText='']
   * @param {number}      [opts.tokensBefore=0]
   * @param {number}      [opts.tokensAfter=0]
   * @param {number}      [opts.foldedEntryCount=0]
   * @param {number}      [opts.preservedEntryCount=0]
   * @param {string|null} [opts.error=null]
   */
  constructor({
    compacted,
    summaryText = '',
    tokensBefore = 0,
    tokensAfter = 0,
    foldedEntryCount = 0,
    preservedEntryCount = 0,
    error = null,
  }) {
    this.compacted = compacted;
    this.summary_text = summaryText;
    this.tokens_before = tokensBefore;
    this.tokens_after = tokensAfter;
    this.folded_entry_count = foldedEntryCount;
    this.preserved_entry_count = preservedEntryCount;
    this.error = error;
  }
}

// ============================================================
// TurnCompactor
// ============================================================

/**
 * Turn 内压缩器。无状态，可在 reasoning 入口每次实例化使用。
 *
 * 对标 Python @dataclass TurnCompactor，字段名保持一致。
 */
class TurnCompactor {
  /**
   * @param {object}       opts
   * @param {ContextBudget} opts.budget
   * @param {Set<string>}  [opts.preserve_tools=SEMANTIC_PRESERVE_TOOLS]
   * @param {boolean}      [opts.preserve_current_task=true]
   * @param {boolean}      [opts.preserve_user_messages=true]
   * @param {number}       [opts.min_compact_count=3]
   * @param {string|null}  [opts.model_id=null]
   * @param {Function|null} [opts._summarize]  可注入的 summarize 函数（测试用）
   */
  constructor({
    budget,
    preserve_tools = SEMANTIC_PRESERVE_TOOLS,
    preserve_current_task = true,
    preserve_user_messages = true,
    min_compact_count = 3,
    model_id = null,
    _summarize = null,
  } = {}) {
    this.budget = budget;
    this.preserve_tools = preserve_tools;
    this.preserve_current_task = preserve_current_task;
    this.preserve_user_messages = preserve_user_messages;
    this.min_compact_count = min_compact_count;
    this.model_id = model_id;
    // 可注入 summarize 函数（用于测试或真实接入）
    this._summarize = _summarize ?? summarize;
  }

  /**
   * 检查 tool_history 是否需要压缩；需要则原地修改 agentContext.data["tool_history"]。
   *
   * @param {object}        agentContext
   * @param {object}        [opts]
   * @param {Function|null} [opts.stream_callback]    可选，推送流式事件
   * @param {number|null}   [opts.upstream_usage_total] 上一次 chat() 回传的 totalTokens
   * @returns {Promise<TurnCompactionResult>}
   */
  async maybe_compact(
    agentContext,
    { stream_callback = null, upstream_usage_total = null } = {},
  ) {
    const toolHistory = agentContext.data?.tool_history ?? [];
    if (!toolHistory.length) {
      return new TurnCompactionResult({ compacted: false });
    }

    const tokensBefore = countMessageTokens(toolHistory, {
      upstreamUsageTotal: upstream_usage_total,
    });
    if (!this.budget.shouldCompact(tokensBefore)) {
      return new TurnCompactionResult({
        compacted: false,
        tokensBefore,
        tokensAfter: tokensBefore,
      });
    }

    const currentTaskIdx = agentContext.data?._current_task_idx ?? null;

    // 切分：可压 vs 必留
    const toCompact = [];
    const toKeep = [];
    for (const entry of toolHistory) {
      if (this._shouldPreserve(entry, currentTaskIdx)) {
        toKeep.push(entry);
      } else {
        toCompact.push(entry);
      }
    }

    if (toCompact.length < this.min_compact_count) {
      console.info(
        `[TurnCompactor] 可压条目仅 ${toCompact.length} 条 < ${this.min_compact_count}，跳过`,
      );
      return new TurnCompactionResult({
        compacted: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        preservedEntryCount: toKeep.length,
      });
    }

    await this._pushEvent(
      stream_callback,
      'compaction_start',
      t('正在压缩历史以继续（{} 条折叠 → 摘要）', toCompact.length),
    );

    const spec = this._buildSpec(agentContext, toCompact);
    let summaryText;
    try {
      summaryText = await this._summarize(spec, { model_id: this.model_id });
    } catch (e) {
      const errMsg = e instanceof SummarizerError ? e.message : String(e);
      console.warn(`[TurnCompactor] 摘要失败，退回原 tool_history: ${errMsg}`);
      await this._pushEvent(
        stream_callback,
        'compaction_failed',
        t('压缩失败，继续使用原历史: {}', errMsg),
      );
      return new TurnCompactionResult({
        compacted: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        preservedEntryCount: toKeep.length,
        foldedEntryCount: 0,
        error: errMsg,
      });
    }

    // 装配新的 tool_history：[summary 伪 entry] + 原样保留条目
    const compactedHistory = [
      this._makeSummaryEntry(summaryText, toCompact.length),
      ...toKeep,
    ];
    agentContext.data['tool_history'] = compactedHistory;

    const tokensAfter = countMessageTokens(compactedHistory);
    await this._pushEvent(
      stream_callback,
      'compaction_done',
      t('已压缩 {} 条历史（{} → {} tokens）', toCompact.length, tokensBefore, tokensAfter),
    );

    return new TurnCompactionResult({
      compacted: true,
      summaryText,
      tokensBefore,
      tokensAfter,
      foldedEntryCount: toCompact.length,
      preservedEntryCount: toKeep.length,
    });
  }

  // ============== 内部辅助 ==============

  /**
   * 按语义角色判断该条 tool_history 是否原样保留。
   *
   * 规则：
   * - _task_idx 缺失（旧数据 / 无 task_plan 场景）→ 保守保留
   * - 当前 task 的所有条目（含失败重试）→ 保留
   * - 旧 task 的失败条目 → 不保留
   * - 旧 task 的"产出工具"成功调用 → 保留
   * - 其余（旧 task 的探索/思考）→ 不保留
   *
   * @param {object}   entry
   * @param {number|null} currentTaskIdx
   * @returns {boolean}
   */
  _shouldPreserve(entry, currentTaskIdx) {
    const entryTaskIdx = entry._task_idx ?? null;
    if (entryTaskIdx === null) return true;
    if (
      this.preserve_current_task &&
      currentTaskIdx !== null &&
      entryTaskIdx === currentTaskIdx
    ) {
      return true;
    }
    if (!entry.success) return false;
    return this.preserve_tools.has(entry.tool);
  }

  /**
   * 从 agentContext 提取必须保留的事实，组装成 SummarySpec。
   *
   * @param {object}        agentContext
   * @param {Array<object>} toCompact
   * @returns {SummarySpec}
   */
  _buildSpec(agentContext, toCompact) {
    const data = agentContext?.data ?? {};
    const inputData = agentContext?.input_data ?? {};

    // 中间表：从 format_context.sub_tasks 抽（_observation 写入的元数据）
    const intermediateTables = [];
    const formatCtx = data.format_context ?? {};
    for (const st of formatCtx.sub_tasks ?? []) {
      const interName = st.intermediate_table;
      if (!interName) continue;
      intermediateTables.push({
        name: interName,
        sub_query: st.sub_question ?? '',
        columns: st.columns ?? [],
        row_count: st.row_count ?? null,
      });
    }

    // 消歧缓存
    const cache = data.session_resolved_cache ?? {};
    const resolvedEntities = cache.entities ?? [];
    const resolvedMetrics = cache.metrics ?? [];

    // 已完成 task 标题
    const completedTaskTitles = [];
    for (const task of data._task_plan ?? []) {
      if (task.status === 'completed' && task.title) {
        completedTaskTitles.push(task.title);
      }
    }

    return new SummarySpec({
      messages_to_compact: toCompact,
      current_user_question:
        inputData.enhanced_user_query ?? inputData.user_message ?? '',
      intermediate_tables: intermediateTables,
      resolved_entities: resolvedEntities,
      resolved_metrics: resolvedMetrics,
      completed_task_titles: completedTaskTitles,
      user_constraints: [], // 当前 SuperAgent 没有结构化提取，留空
      previous_summary: null, // Turn 内永远是首次
    });
  }

  /**
   * 把 summary 包装成 tool_history 一条 entry，与原结构同形。
   *
   * @param {string} summaryText
   * @param {number} foldedCount
   * @returns {object}
   */
  _makeSummaryEntry(summaryText, foldedCount) {
    return {
      tool: '_compaction_summary',
      thought: '',
      success: true,
      result: {
        summary: summaryText,
        folded_entry_count: foldedCount,
        note: '以上是已折叠历史的结构化摘要；关键事实（中间表、消歧映射）必须遵循。',
      },
      _task_idx: null, // 摘要不属于任何具体 task
    };
  }

  /**
   * 推送流式事件（失败静默忽略）。
   *
   * @param {Function|null} streamCallback
   * @param {string}        eventType
   * @param {string}        message
   */
  async _pushEvent(streamCallback, eventType, message) {
    if (!streamCallback) return;
    try {
      await streamCallback(message, {
        content_type: 'text',
        title: null,
        recall: false,
        display: true,
        msg_category: eventType,
        task_group: null, // 压缩是 turn 级动作，不挂任何 task
      });
    } catch (e) {
      console.warn(`[TurnCompactor] 推送 ${eventType} 事件失败: ${e?.message}`);
    }
  }
}

// ============================================================
// 工厂函数
// ============================================================

/**
 * 工厂：第一版返回硬编码默认值；后续可接 ProjectConfig 让运营按项目调。
 *
 * @param {object}   [opts]
 * @param {number}   [opts.model_window=128_000]
 * @param {number}   [opts.threshold_pct=0.70]
 * @param {number}   [opts.reserve_tokens=4096]
 * @param {string|null} [opts.model_id=null]
 * @param {Function|null} [opts._summarize]  可注入的 summarize 函数（测试用）
 * @returns {TurnCompactor}
 */
function build_default_turn_compactor({
  model_window = 128_000,
  threshold_pct = 0.70,
  reserve_tokens = 4096,
  model_id = null,
  _summarize = null,
} = {}) {
  return new TurnCompactor({
    budget: new ContextBudget({
      modelWindow: model_window,
      thresholdPct: threshold_pct,
      reserveTokens: reserve_tokens,
    }),
    model_id,
    _summarize: _summarize ?? undefined,
  });
}
