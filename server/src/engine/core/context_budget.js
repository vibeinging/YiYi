// 迁移自 core/llm/context_budget.py

/**
 * LLM 上下文预算：token 估算 + 阈值判定。
 *
 * 设计原则：
 * - LLM 回传的 usage.totalTokens 是权威值，优先用
 * - 没有 usage 时按 chars/4 估算（中文偏保守即偏高 → 提前压缩，对准确率更友好）
 * - 计数 / 阈值判定都是纯函数，无副作用，便于测试和复用
 */

/**
 * 模型上下文预算定义。
 *
 * 用法：
 *   const budget = new ContextBudget({ modelWindow: 128_000 });
 *   if (budget.shouldCompact(95_000)) { ... }
 */
export class ContextBudget {
  /**
   * @param {object} opts
   * @param {number} opts.modelWindow     模型上下文上限（如 32768 / 128000）
   * @param {number} [opts.thresholdPct=0.70]  触发压缩的占比
   * @param {number} [opts.reserveTokens=4096] 给 system_prompt + 输出留出的余量
   */
  constructor({ modelWindow, thresholdPct = 0.70, reserveTokens = 4096 } = {}) {
    if (thresholdPct <= 0 || thresholdPct >= 1) {
      throw new Error(`thresholdPct 必须在 (0, 1) 之间: ${thresholdPct}`);
    }
    if (!modelWindow || modelWindow <= 0) {
      throw new Error(`modelWindow 必须为正: ${modelWindow}`);
    }
    if (reserveTokens < 0) {
      throw new Error(`reserveTokens 不能为负: ${reserveTokens}`);
    }

    this.modelWindow = modelWindow;
    this.thresholdPct = thresholdPct;
    this.reserveTokens = reserveTokens;
  }

  /** 超过此值则触发压缩。 */
  get softLimit() {
    return Math.floor(this.modelWindow * this.thresholdPct) - this.reserveTokens;
  }

  /** @param {number} usedTokens */
  shouldCompact(usedTokens) {
    return usedTokens >= this.softLimit;
  }

  /**
   * 剩余多少 token 余量（可能为负）。
   * @param {number} usedTokens
   */
  headroom(usedTokens) {
    return this.softLimit - usedTokens;
  }
}

/** 默认预算：按主流 32K 模型保守取值；接入时由调用方按实际模型覆盖 */
export const DEFAULT_BUDGET = new ContextBudget({
  modelWindow: 32_000,
  thresholdPct: 0.70,
  reserveTokens: 4096,
});

/**
 * 单条 message 的 token 估算（chars/4）。
 *
 * 支持的形态：
 *   - { role: "user/assistant/system", content: string | Array<object> }
 *   - tool_history entry: { tool: string, thought: string, success: bool, result: object }
 *
 * 所有未识别字段一律转字符串后参与字符计数（保守倾向，宁可多算不漏算）。
 *
 * @param {*} msg
 * @returns {number}
 */
export function estimateMessageTokens(msg) {
  if (msg === null || typeof msg !== 'object') {
    return charsToTokens(String(msg).length);
  }

  let chars = 0;
  const content = msg.content;

  if (typeof content === 'string') {
    chars += content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block !== null && typeof block === 'object') {
        const text = block.text ?? block.content;
        if (typeof text === 'string') {
          chars += text.length;
        } else {
          chars += JSON.stringify(block).length;
        }
      } else {
        chars += String(block).length;
      }
    }
  } else if (content != null) {
    chars += JSON.stringify(content).length;
  }

  // tool_history entry: 把 tool/thought/result 也算上
  for (const key of ['tool', 'thought']) {
    const val = msg[key];
    if (typeof val === 'string') {
      chars += val.length;
    }
  }
  const result = msg.result;
  if (result != null) {
    chars += JSON.stringify(result).length;
  }

  return charsToTokens(chars);
}

/**
 * 统计一组 messages 的总 token。
 *
 * @param {Array<object>} messages          待估算的消息列表
 * @param {object}        [opts]
 * @param {number|null}   [opts.upstreamUsageTotal]
 *   如果上游 LLM 已经回传了 usage.totalTokens，直接用该精确值
 *   （仅当 messages 与该 usage 同源时）。
 * @returns {number}
 */
export function countMessageTokens(messages, { upstreamUsageTotal = null } = {}) {
  if (upstreamUsageTotal != null && upstreamUsageTotal > 0) {
    return upstreamUsageTotal;
  }
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// ---- 内部工具 ----

/** chars/4 的保守估算（向上取整）。 */
function charsToTokens(chars) {
  if (chars <= 0) return 0;
  return Math.ceil(chars / 4);
}
