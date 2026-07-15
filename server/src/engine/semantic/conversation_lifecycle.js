// 迁移自 backend/api/services/conversation_lifecycle.py
//
// 会话级 lifecycle 编排:协调"会话状态读写"与"领域服务调用"。
// 跨领域协调("用户上一轮在歧义里选了什么 → 写进消歧记忆")必须比领域服务(DisambiguationService
// 只管自己的表)高一层,故独立成模块。
//
// 调用契约(caller 是 chat 路由 / 请求编排层):
//   - on_round_start(ctx, {...})    在 SuperAgent.execute() 之前
//   - on_task_complete(ctx, {...})  在问数 agent 正常完成之后
//
// 桌面版用全局 db.js 的 {query, queryOne} 作 ctx(替代 Python 的 session_factory)。
// 全包 try/catch:telemetry 性写,失败只 warn 不中断主流程——丢一次可接受,下次同关键词
// 重新走 align_value 还会再问一遍,业务自愈。

import {
  collect_memory_reuse_hits,
  extract_pending_resolution_from_content_items,
} from './disambiguation_protocol.js';
import { DisambiguationService } from './disambiguation_service.js';

const _SESSION_MESSAGES_TABLE = 'session_messages';

/**
 * 新一轮 reasoning 开始前调。读上一条 assistant SessionMessage 的 content_items,
 * 抽 disambiguation_context stash,配对当前 user_message 写消歧记忆。
 *
 * Short-circuit:缺关键字段 / 无上一条 assistant 消息 / 无 disambig stash /
 * user_message 不在 stash 的 candidates 内(避免把"用户改主意问新问题"当 chosen_value 污染记忆)。
 *
 * @param {{query:Function, queryOne:Function}} ctx
 * @param {{session_id:string, user_message:string, project_id:string, user_id?:string}} opts
 */
export async function on_round_start(ctx, {
  session_id, user_message, project_id, user_id = null,
} = {}) {
  const msg = (user_message || '').trim();
  if (!(msg && session_id && project_id)) return { recorded: false };

  try {
    const row = await ctx.queryOne(
      `SELECT content_items FROM ${_SESSION_MESSAGES_TABLE}
        WHERE session_id = $1 AND role = 'assistant' AND deleted_at IS NULL
        ORDER BY sequence_number DESC LIMIT 1`,
      [session_id],
    );
    if (!row) return { recorded: false };

    let content_items = row.content_items;
    if (typeof content_items === 'string') {
      try { content_items = JSON.parse(content_items); } catch { return { recorded: false }; }
    }
    if (!Array.isArray(content_items)) return { recorded: false };

    const disambig = extract_pending_resolution_from_content_items(content_items);
    if (!disambig) return { recorded: false };

    const candidates = Array.isArray(disambig.candidates) ? disambig.candidates : [];
    const memoryValues = (Array.isArray(disambig.memory_values) ? disambig.memory_values : [])
      .map((v) => (v && typeof v === 'object' && !Array.isArray(v) ? v.value : v))
      .filter(Boolean);
    const allowed = [...new Set([...candidates, ...memoryValues])];
    if (!allowed.includes(msg)) return { recorded: false };

    const rowId = await DisambiguationService.record_resolution(ctx, {
      project_id,
      source_table: disambig.source_table || '',
      source_column: disambig.source_column || '',
      keyword: disambig.keyword || '',
      chosen_value: msg,
      candidates: allowed.map((v) => ({ value: v })),
      created_by: user_id,
    });
    if (!rowId) return { recorded: false };
    return {
      recorded: true,
      chosen_value: msg,
      source_table: disambig.source_table || '',
      source_column: disambig.source_column || '',
      keyword: disambig.keyword || '',
      row_id: rowId,
    };
  } catch (e) {
    console.warn(`[conversation_lifecycle] on_round_start 失败(继续主流程): ${e?.message ?? e}`);
    return { recorded: false, error: e?.message || String(e) };
  }
}

/**
 * 问数 agent 正常完成后调。扫 tool_history 找出本轮复用了哪些 memory 候选 → 批量 hit_count++。
 *
 * caller 须先确认本轮是正常完成,例如 _completed_by_natural_answer;失败 / 超限停止不应记 hit++。
 *
 * @param {{query:Function, queryOne:Function}} ctx
 * @param {{agent_context:object, project_id:string}} opts
 */
export async function on_task_complete(ctx, { agent_context, project_id } = {}) {
  if (!project_id) return;
  try {
    const hits = collect_memory_reuse_hits(agent_context);
    if (!hits || !hits.length) return;
    await DisambiguationService.update_hit_on_reuse(ctx, { project_id, hits });
  } catch (e) {
    console.warn(`[conversation_lifecycle] on_task_complete 失败(继续主流程): ${e?.message ?? e}`);
  }
}

export default { on_round_start, on_task_complete };
