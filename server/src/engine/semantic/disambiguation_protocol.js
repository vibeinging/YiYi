// 迁移自 backend/yiw_kernel/semantic_catalogs/business/disambiguation_protocol.py
//
// 消歧协议的纯数据 helper（无 DB、无 session_factory）。
//
// 职责：把"扫 agent_context.tool_history 抽 align_value/memory 相关数据"的纯函数集中。
// 被两边消费：
// - SuperAgent 在 reasoning loop 里 emit ask_user / complete 时调（无副作用，只产出对象）
// - api/services/conversation_lifecycle 在 task 终结后调（拿到数据后做 DB 写）
//
// 纯函数易测：传 fake agent_context 即可，无 mock。
//
// 对外接口（与 Python 1:1）：
//   iter_align_value_entries(agent_context) -> Iterable<[idx, result]>
//   build_disambiguation_context(agent_context) -> object|null
//   collect_memory_reuse_hits(agent_context) -> Array<object>
//   extract_pending_resolution_from_content_items(content_items) -> object|null
//
// 另外导出一个 class DisambiguationProtocol，把上述纯函数挂为静态方法，
// 供 data_grep 的 GrepEntitiesTool（目前 stub）按 import 名接回。

/**
 * 读 agent_context 的 tool_history 数组（统一容错：data 缺失 / 非数组 → []）。
 * @param {object} agent_context
 * @returns {Array<object>}
 */
function _toolHistory(agent_context) {
  const hist = agent_context?.data?.tool_history;
  return Array.isArray(hist) ? hist : [];
}

/**
 * 遍历 tool_history 中所有成功的 align_value 调用，yield [idx, result]。
 *
 * 对应 Python 的 generator iter_align_value_entries。返回一个数组（[idx, result] 元组），
 * 调用方按下标 / 顺序消费，语义与原 generator 一致（一次性遍历快照）。
 *
 * @param {object} agent_context
 * @returns {Array<[number, object]>}
 */
export function iter_align_value_entries(agent_context) {
  const out = [];
  const entries = _toolHistory(agent_context);
  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx] || {};
    if (entry.tool !== 'align_value' || !entry.success) continue;
    const result = entry.result || {};
    if (result.table_name && result.column_name) {
      out.push([idx, result]);
    }
  }
  return out;
}

/**
 * ask_user 截获时 stash 给前端协议块。
 *
 * candidates 只取 vector/like 召回的实际库存值（**不含 source=memory**），
 * 避免历史候选被原样塞回 SessionMessage.content_items 引发 LLM context 膨胀。
 *
 * memory_values 独立列出，仅含历史候选的 value + 轻量元数据
 * （value/memory_id/hit_count），让前端识别哪些 chip 是历史选过的 + 渲染倒计时 UX。
 *
 * @param {object} agent_context
 * @returns {{source_table:string, source_column:string, keyword:string,
 *            candidates:string[], memory_values:Array<object>}|null}
 */
export function build_disambiguation_context(agent_context) {
  let last = null;
  const entries = _toolHistory(agent_context);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] || {};
    if (entry.tool !== 'align_value' || !entry.success) continue;
    const result = entry.result || {};
    if (result.table_name && result.column_name) {
      last = result;
      break;
    }
  }
  if (!last) return null;

  /** @type {string[]} */
  const candidates = [];
  /** @type {Array<object>} */
  const memory_values = [];
  for (const v of last.values || []) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const val = v.value;
    if (!val) continue;
    if (v.source === 'memory') {
      const meta = v.memory_meta || {};
      memory_values.push({
        value: val,
        memory_id: v.memory_id ?? null,
        hit_count: meta.hit_count ?? null,
      });
    } else if (!candidates.includes(val)) {
      candidates.push(val);
    }
  }
  return {
    source_table: last.table_name,
    source_column: last.column_name,
    keyword: last.keyword || '',
    candidates,
    memory_values,
  };
}

/**
 * 扫 tool_history：每个 align_value 调用的 memory 候选，与"该 align 到下一个 align
 * 之前"窗口内的非 align 工具的 thought + result 文本做字面匹配。
 *
 * 窗口切片避免把 align#2 的 result 当 align#1 的 reuse 证据；过滤 align_value
 * entry 本身避免 memory 候选自我匹配。
 *
 * @param {object} agent_context
 * @returns {Array<{table:string, column:string, value:string, keyword:string,
 *                  memory_id:any, hit_count:any}>}
 */
export function collect_memory_reuse_hits(agent_context) {
  const entries = _toolHistory(agent_context);
  if (!entries.length) return [];
  const align_data = iter_align_value_entries(agent_context);
  if (!align_data.length) return [];
  const align_indexes = align_data.map(([idx]) => idx);

  /** @type {Array<object>} */
  const hits = [];
  for (let i = 0; i < align_data.length; i++) {
    const [idx, result] = align_data[i];
    /** @type {Map<string, object>} */
    const memory_value_meta = new Map();
    for (const v of result.values || []) {
      if (v && typeof v === 'object' && !Array.isArray(v) && v.source === 'memory' && v.value) {
        memory_value_meta.set(v.value, v);
      }
    }
    if (memory_value_meta.size === 0) continue;

    const end_idx = i + 1 < align_indexes.length ? align_indexes[i + 1] : entries.length;

    /** @type {string[]} */
    const parts = [];
    for (const downstream of entries.slice(idx + 1, end_idx)) {
      if (!downstream || downstream.tool === 'align_value') continue;
      if (downstream.thought) parts.push(downstream.thought);
      const res = downstream.result || {};
      if (res && typeof res === 'object' && !Array.isArray(res)) {
        try {
          parts.push(JSON.stringify(res));
        } catch (_) {
          // 不可序列化 → 跳过
        }
      }
    }
    if (!parts.length) continue;
    const downstream_text = parts.join('\n');

    const table = result.table_name;
    const column = result.column_name;
    const keyword = result.keyword || '';
    for (const [val, meta] of memory_value_meta) {
      if (downstream_text.includes(val)) {
        const mmeta = meta.memory_meta || {};
        hits.push({
          table,
          column,
          value: val,
          keyword,
          memory_id: meta.memory_id ?? null,
          hit_count: mmeta.hit_count ?? null,
        });
      }
    }
  }
  return hits;
}

/**
 * 从 assistant SessionMessage.content_items 里抽最新的 disambiguation_context stash。
 *
 * content_items 里 block 字段名是 'type'。disambig stash 在 user_input 块的 content
 * JSON 字段下的 disambiguation_context。
 *
 * 用 reversed()：取最后一个 user_input 块——最新的歧义才是用户当前在答的。
 *
 * @param {Array<object>} content_items
 * @returns {object|null}
 */
export function extract_pending_resolution_from_content_items(content_items) {
  if (!Array.isArray(content_items)) return null;
  for (let i = content_items.length - 1; i >= 0; i--) {
    const item = content_items[i];
    if (!item || typeof item !== 'object' || item.type !== 'user_input') continue;
    const raw = item.content;
    if (typeof raw !== 'string') continue;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      continue;
    }
    const ctx = payload?.disambiguation_context;
    if (ctx) return ctx;
  }
  return null;
}

/**
 * 消歧协议（把上述纯函数聚合为静态方法，供按 class 名 import 的下游接回）。
 * 纯数据 helper，无状态、无副作用。
 */
export class DisambiguationProtocol {
  static iter_align_value_entries = iter_align_value_entries;

  static build_disambiguation_context = build_disambiguation_context;

  static collect_memory_reuse_hits = collect_memory_reuse_hits;

  static extract_pending_resolution_from_content_items = extract_pending_resolution_from_content_items;
}

export default DisambiguationProtocol;
