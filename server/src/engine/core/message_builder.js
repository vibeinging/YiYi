// 迁移自 core/agentic_flow/core/message_builder.py

/**
 * 统一的 LLM 消息装配：把 SuperAgent / DSAgent 重复的 _build_messages 抽出来。
 *
 * 结构（设计文档阶段 2.2）：
 *
 * - pinned:     当前轮的 user_prompt。永不压缩。
 * - sliding:    跨轮 session_context。超 budget 时由 SessionCompactor 折叠（外部完成）。
 * - tool_trace: 本轮 tool_history 展开后的 assistant/user 交替对。超 budget 时由
 *               TurnCompactor 在 reasoning 入口前折叠（外部完成）。
 *
 * 最终送 LLM 的顺序为 [*sliding, *pinned, *tool_trace]，与原始扁平拼装等价。
 *
 * 阶段 2.2.4：tool_history entry 若带 result_ref 字段（中间表落地元数据），
 * 渲染时输出 schema-only 引用文本，不再 dump 数据 JSON。
 */

import { t } from '../utils/i18n.js';
import { jsonReplacer } from '../utils/serialization.js';

export const DEFAULT_HISTORY_CHAR_LIMIT = 2000;
export const DEFAULT_DUMP_CHAR_LIMIT = 3000;
export const DEFAULT_REF_COLUMN_LIMIT = 20;

// ============== BuiltMessages ==============

/**
 * 按语义分段的对话消息容器。
 *
 * - pinned:     当前轮 user_prompt（始终保留）
 * - sliding:    历史轮 session_context（可被 SessionCompactor 折叠）
 * - tool_trace: 本轮 tool_history 展开（可被 TurnCompactor 折叠）
 *
 * 送 LLM 时通过 toLlm() 拍平。容器同时实现 Iterable 协议：
 * [...messages] 与 for..of messages 等价于 toLlm()，让现有调用方零迁移。
 */
export class BuiltMessages {
  /**
   * @param {object} opts
   * @param {Array<object>} [opts.pinned=[]]
   * @param {Array<object>} [opts.sliding=[]]
   * @param {Array<object>} [opts.toolTrace=[]]
   */
  constructor({ pinned = [], sliding = [], toolTrace = [] } = {}) {
    this.pinned = pinned;
    this.sliding = sliding;
    // 对外保持 tool_trace 字段名（与 Python 版一致）
    this.tool_trace = toolTrace;
  }

  /**
   * 拍平为最终送 LLM 的 messages 列表。
   * 顺序：sliding（历史轮） → pinned（当前轮 user） → tool_trace（ReAct 步）
   * @returns {Array<object>}
   */
  toLlm() {
    return [...this.sliding, ...this.pinned, ...this.tool_trace];
  }

  // ---- Iterable 协议（[...builtMessages] / for..of 等价于 toLlm()） ----

  [Symbol.iterator]() {
    return this.toLlm()[Symbol.iterator]();
  }

  get length() {
    return this.sliding.length + this.pinned.length + this.tool_trace.length;
  }

  /** @param {number} idx */
  at(idx) {
    return this.toLlm()[idx];
  }

  /** truthy 当任何段非空 */
  get isEmpty() {
    return !this.pinned.length && !this.sliding.length && !this.tool_trace.length;
  }
}

// ============== 顶层装配 ==============

/**
 * 从 agent_context 各片段装配 BuiltMessages。
 *
 * @param {object} opts
 * @param {Array<object>|null}  [opts.session_context]       跨轮历史（DB 取出的 user/assistant 列表）
 * @param {string}              [opts.enhanced_user_query='']当前问题原文，仅用于和 session_context 末尾去重
 * @param {string}              [opts.current_user_content='']当前轮 user_prompt 最终内容
 * @param {Array<object>|null}  [opts.tool_history]          本轮 ReAct 已经发生的工具调用历史
 * @param {string|null}         [opts.trailing_user_message] 尾部追加的 user 消息
 * @param {number}              [opts.history_char_limit]    session_context 单条字符上限（保留兼容，不再使用）
 * @param {number}              [opts.dump_char_limit]       tool_history 结果 JSON dump 字符上限
 * @returns {BuiltMessages}
 */
export function build_messages({
  session_context = null,
  enhanced_user_query = '',
  current_user_content = '',
  tool_history = null,
  trailing_user_message = null,
  history_char_limit = DEFAULT_HISTORY_CHAR_LIMIT,
  dump_char_limit = DEFAULT_DUMP_CHAR_LIMIT,
} = {}) {
  const sliding = _buildSliding(
    session_context ?? [],
    enhanced_user_query,
    history_char_limit,
  );

  const pinned = [];
  if (current_user_content && current_user_content.trim()) {
    pinned.push({ role: 'user', content: current_user_content.trim() });
  }

  const toolTrace = _buildToolTrace(tool_history ?? [], dump_char_limit);
  if (trailing_user_message) {
    toolTrace.push({ role: 'user', content: trailing_user_message });
  }

  return new BuiltMessages({ pinned, sliding, toolTrace });
}

// ============== 内部装配 ==============

/**
 * 构造 sliding 段：去掉与当前问题重复的尾部 user 消息。
 *
 * 历史思考不再硬截断（流式 UX 下，截断会让下一轮 LLM 失去上下文）。
 * history_char_limit 参数保留只为兼容调用方签名。
 *
 * @param {Array<object>} sessionContext
 * @param {string}        enhancedUserQuery
 * @param {number}        _charLimit  兼容签名，不再使用
 * @returns {Array<object>}
 */
function _buildSliding(sessionContext, enhancedUserQuery, _charLimit) {
  if (!sessionContext.length) return [];

  let ctxToAdd = [...sessionContext];
  const enhancedStripped = (enhancedUserQuery ?? '').trim();
  if (
    ctxToAdd.length > 0 &&
    ctxToAdd[ctxToAdd.length - 1]?.role === 'user' &&
    enhancedStripped &&
    (ctxToAdd[ctxToAdd.length - 1]?.content ?? '').trim() === enhancedStripped
  ) {
    ctxToAdd = ctxToAdd.slice(0, -1);
  }

  const out = [];
  for (const ctx of ctxToAdd) {
    const role = ctx.role ?? 'user';
    const content = ctx.content ?? '';
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

/**
 * tool_history → assistant(调用 X) + user(结果) 交替对。
 *
 * @param {Array<object>} toolHistory
 * @param {number}        dumpCharLimit
 * @returns {Array<object>}
 */
function _buildToolTrace(toolHistory, dumpCharLimit) {
  const out = [];
  for (const entry of toolHistory) {
    const toolName = entry.tool ?? '';

    // _compaction_summary 是 TurnCompactor 产出的合成 entry，单独渲染
    if (toolName === '_compaction_summary') {
      const summaryText = _renderCompactionSummary(entry);
      if (summaryText) {
        out.push({ role: 'user', content: summaryText });
      }
      continue;
    }

    out.push({ role: 'assistant', content: `调用 ${toolName}` });
    const resultStr = render_tool_result(entry, { dump_char_limit: dumpCharLimit });
    const prefix = entry.success ? '✅' : '❌';
    out.push({ role: 'user', content: `${prefix} 结果：\n${resultStr}` });
  }
  return out;
}

/**
 * 把 TurnCompactor 写入的合成 entry 渲染为单条 user 消息。
 *
 * 与 turn_compactor._makeSummaryEntry() 的 result 结构对齐：
 *   {summary: text, folded_entry_count: N, note: ...}
 *
 * @param {object} entry
 * @returns {string}
 */
function _renderCompactionSummary(entry) {
  const result = entry.result ?? {};
  const summary = (result.summary ?? '').trim();
  const note = (result.note ?? '').trim();
  if (!summary) return '';

  const folded = result.folded_entry_count;
  const header = folded ? t('[历史摘要 · 已折叠 {} 条]', folded) : t('[历史摘要]');
  const chunks = [header, summary];
  if (note) chunks.push(note);
  return chunks.join('\n\n');
}

// ============== Tool result rendering（2.2.4 引用化在此） ==============

/**
 * 把 tool_history 一条 entry 的结果渲染成 LLM 可读字符串。
 *
 * - 若 entry 带 result_ref（中间表落地元数据），输出 schema-only 引用文本，
 *   不再 dump 原始数据。让 LLM 用"看 schema"代替"看数据"，省 token + 减幻觉。
 * - 否则走老路径：JSON dump，超 dump_char_limit 截断。
 *
 * 注意：tool_history entry 在内存里仍保留 result 原文，内部 reader 不受影响——
 * 只是送 LLM 时改用引用版本。
 *
 * @param {object} entry
 * @param {object} [opts]
 * @param {number} [opts.dump_char_limit=DEFAULT_DUMP_CHAR_LIMIT]
 * @param {number} [opts.ref_column_limit=DEFAULT_REF_COLUMN_LIMIT]
 * @returns {string}
 */
export function render_tool_result(
  entry,
  {
    dump_char_limit = DEFAULT_DUMP_CHAR_LIMIT,
    ref_column_limit = DEFAULT_REF_COLUMN_LIMIT,
  } = {},
) {
  const ref = entry.result_ref ?? null;
  if (ref) {
    return _formatResultRef(ref, ref_column_limit);
  }

  const result = entry.result ?? {};
  let s;
  try {
    s = JSON.stringify(result, jsonReplacer);
  } catch (e) {
    // 极端 case：fallback 到 String(result)
    s = String(result);
  }
  if (s.length > dump_char_limit) {
    s = s.slice(0, dump_char_limit) + t('...(截断)');
  }
  return s;
}

/**
 * 格式化 result_ref → 引用文本。
 *
 * 输入 ref 字段约定：
 *   intermediate_table: 表全名（如 'intermediate_xxx.r_ab12'）
 *   row_count:          行数
 *   columns:            列名列表
 *   sub_query:          子问题原文（可选）
 *
 * @param {object} ref
 * @param {number} columnLimit
 * @returns {string}
 */
function _formatResultRef(ref, columnLimit) {
  const table = ref.intermediate_table ?? '';
  const rowCount = ref.row_count ?? 0;
  const cols = ref.columns ?? [];
  const subQuery = (ref.sub_query ?? '').trim();

  const colsVisible = cols.slice(0, columnLimit);
  let colsStr = colsVisible.map(String).join(', ');
  if (cols.length > columnLimit) {
    colsStr += t('，...(+{} 列)', cols.length - columnLimit);
  }

  const parts = [];
  if (subQuery) {
    parts.push(t('子问题「{}」', subQuery));
  }
  parts.push(t('结果已存入 `{}`（{} 行，列：{}）', table, rowCount, colsStr));
  parts.push(
    t('注：后续步骤如需访问该结果，应通过 SQL 引用该表，而非把数据复制到 prompt。'),
  );
  return parts.join('\n');
}
