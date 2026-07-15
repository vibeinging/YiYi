// 迁移自 core/agentic_flow/utils/fail_fast.py
//
// Fail-fast 双闸 + 错误签名标准化（从 SuperAgent 提取的共享 utility）。
//
// 防止 agent 在"同一硬错误反复打转" / "累计 churn 失控"两种病态场景下空转到
// max_iterations(50)步 ≈ 超时。两个闸门覆盖两类失败模式:
// - 同签名 N 次: 同质错误反复出现(eg "table X does not exist")
// - 累计 M 次: 每轮错误文本漂移导致签名永不达阈,但 churn 已失控
//
// 任意一闸触发即写入 `_fail_fast_reason`,agent reasoning 前检查该字段强制收尾。
//
// 迁移说明：
// - Python re.compile → JS RegExp（注意 sub 全局替换需 /g 标志）。
// - dict.setdefault → ??= / 读后回写；dict.pop(k, d) → 读后 delete。
// - logging.warning → console.warn（保留 emoji 日志行）。

/** 轻量 logger（对应 Python logging.getLogger(__name__)） */
const logger = {
  warning: (...args) => console.warn('[fail_fast]', ...args),
  warn: (...args) => console.warn('[fail_fast]', ...args),
};

const _RANDOM_TABLE_PATTERN = /\br_[0-9a-f]{2,}\b/g;
const _NUMBER_PATTERN = /\d+/g;
const _WHITESPACE_PATTERN = /\s+/g;

/**
 * 把错误原因归一化成稳定签名,用于识别"同一错误反复打转"。
 *
 * 去掉行号/计数等易变数字 + 折叠空白,使「table xxx does not exist」这类同质
 * 错误在不同步数下落到同一签名,从而被复发计数捕获。
 *
 * 中间结果表名是随机 hex(r_xxxx),先归一成占位符,否则「表 r_6abc 不存在」与
 * 「表 r_9c2e 不存在」会落到不同签名,导致同质错误每轮漂移、fail-fast 永不触发。
 *
 * @param {string} reason
 * @returns {string}
 */
export function error_signature(reason) {
  let s = (reason || '').toLowerCase();
  s = s.replace(_RANDOM_TABLE_PATTERN, 'r_<id>');
  s = s.replace(_NUMBER_PATTERN, '');
  s = s.replace(_WHITESPACE_PATTERN, ' ').trim();
  return s.slice(0, 200);
}

/**
 * 累计同一错误签名的复发次数,达上限即记录 fail-fast 原因供 reasoning 强制收尾。
 *
 * @param {import('../core/agent_context.js').AgentContext} agent_context
 *   agent_context.data 用于存计数(`_replan_signature_counts` / `_fail_fast_reason`)
 * @param {string} reason 错误原因文本
 * @param {number} [max_signature_count=3] 同签名复发上限(默认 3,SuperAgent 用同此默认)
 * @returns {void}
 */
export function bump_fail_fast(agent_context, reason, max_signature_count = 3) {
  if (!reason) {
    return;
  }
  const signature = error_signature(reason);
  // 状态键名沿用 SuperAgent / base_agent.py 既有约定,避免破坏现有清理逻辑
  if (!agent_context.data['_replan_signature_counts']) {
    agent_context.data['_replan_signature_counts'] = {};
  }
  const counts = agent_context.data['_replan_signature_counts'];
  counts[signature] = (counts[signature] || 0) + 1;
  if (counts[signature] >= max_signature_count) {
    agent_context.data['_fail_fast_reason'] = reason;
    logger.warning(
      `⛔ [fail-fast] 同一错误签名连续出现 ${counts[signature]} 次,将强制收尾: ${signature}`,
    );
  }
}

/**
 * 与签名无关的失败/重编排总计数,达 max_total 即 fail-fast 收尾。
 *
 * 覆盖"每轮错误文本都不同(signature 漂移)导致 bump_fail_fast 永不达阈"的非
 * 收敛场景:如 LLM 反复换数据源/换表名都失败,单看任一签名都不到阈值,但累计
 * churn 已失控。
 *
 * @param {import('../core/agent_context.js').AgentContext} agent_context
 *   agent_context.data 存累计数(`_total_replans` / `_fail_fast_reason`)
 * @param {string} reason 失败原因(写入 `_fail_fast_reason` 供 reasoning 收尾用)
 * @param {number} [max_total=6] 累计上限(默认 6,SuperAgent 同此默认)
 * @returns {void}
 */
export function bump_total_replans(agent_context, reason, max_total = 6) {
  if (!reason) {
    return;
  }
  const n = (agent_context.data['_total_replans'] || 0) + 1;
  agent_context.data['_total_replans'] = n;
  if (n >= max_total) {
    agent_context.data['_fail_fast_reason'] = reason;
    logger.warning(`⛔ [fail-fast] 累计失败/重编排 ${n} 次达上限,强制收尾`);
  }
}

/**
 * 检查是否已触发 fail-fast(任一闸门写过 `_fail_fast_reason` 即为 True)。
 * @param {import('../core/agent_context.js').AgentContext} agent_context
 * @returns {boolean}
 */
export function should_fail_fast(agent_context) {
  return Boolean(agent_context.data['_fail_fast_reason']);
}

/**
 * 读取 fail-fast 原因(给 LLM/用户的失败解释用)。
 * @param {import('../core/agent_context.js').AgentContext} agent_context
 * @returns {string|null|undefined}
 */
export function get_fail_fast_reason(agent_context) {
  return agent_context.data['_fail_fast_reason'];
}

/**
 * 清空 fail-fast 状态(用户消歧/手动重试后调用,让 agent 重新开始计数)。
 * @param {import('../core/agent_context.js').AgentContext} agent_context
 * @returns {void}
 */
export function clear_fail_fast_state(agent_context) {
  delete agent_context.data['_replan_signature_counts'];
  delete agent_context.data['_total_replans'];
  delete agent_context.data['_fail_fast_reason'];
}

export default {
  error_signature,
  bump_fail_fast,
  bump_total_replans,
  should_fail_fast,
  get_fail_fast_reason,
  clear_fail_fast_state,
};
