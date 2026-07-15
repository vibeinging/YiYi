// 迁移自 core/agentic_flow/extensions/observability.py

/**
 * Observability — 扩展层内置可观测性
 *
 * 每次 Hook 调用产生一条结构化的 HookTrace（hook 名称、handler 链快照、
 * 跳过/命中 handler 及其 canHandle/handle 延迟、抛错信息）。
 *
 * 默认 sink 走 console；可通过 HOOK_METRICS.addSink(...) 接入 Prometheus / OTel / 自定义指标系统。
 */

// ============================================================
// HookTrace — 单次 hook 调用的结构化记录
// ============================================================

export class HookTrace {
  /**
   * @param {Object} opts
   * @param {string}   opts.hook  - hook 类名，如 "PreDecomposeHandler"
   * @param {string[]} opts.chain - 注册到该 hook 的 handler 名称列表（按 priority 排序的快照）
   */
  constructor({ hook, chain }) {
    /** @type {string} */
    this.hook = hook;
    /** @type {string[]} */
    this.chain = chain;
    /** @type {Array<[string, number]>} can_handle 返回 false 的 handler [(name, ms), ...] */
    this.skipped = [];
    /** @type {string|null} 命中并完成 handle 的 handler 名；null 表示无 handler 命中 */
    this.winner = null;
    /** @type {number} winner 的 canHandle 延迟（毫秒） */
    this.winnerCanHandleMs = 0.0;
    /** @type {number} winner 的 handle 延迟（毫秒） */
    this.winnerHandleMs = 0.0;
    /** @type {Array<[string, string]>} 抛错的 handler [(name, error_message), ...] */
    this.errors = [];
  }

  /**
   * @param {string} name
   * @param {number} canHandleMs
   */
  addSkip(name, canHandleMs) {
    this.skipped.push([name, canHandleMs]);
  }

  /**
   * @param {string} name
   * @param {Object} opts
   * @param {number} opts.canHandleMs
   * @param {number} opts.handleMs
   */
  setWinner(name, { canHandleMs, handleMs }) {
    this.winner = name;
    this.winnerCanHandleMs = canHandleMs;
    this.winnerHandleMs = handleMs;
  }

  /**
   * @param {string} name
   * @param {string} error
   */
  addError(name, error) {
    this.errors.push([name, error]);
  }

  /** @returns {Object} */
  toLogDict() {
    return {
      hook: this.hook,
      chain: this.chain,
      winner: this.winner,
      latency_ms: {
        can_handle: Math.round(this.winnerCanHandleMs * 1000) / 1000,
        handle: Math.round(this.winnerHandleMs * 1000) / 1000,
      },
      skipped: this.skipped.map(([n, ms]) => [n, Math.round(ms * 1000) / 1000]),
      errors: this.errors,
    };
  }
}

// ============================================================
// _HookMetrics — 进程级 sink 注册表
// ============================================================

class _HookMetrics {
  constructor() {
    /** @type {Array<(trace: HookTrace) => void>} */
    this._sinks = [];
  }

  /**
   * 注册一个 sink。
   * @param {(trace: HookTrace) => void} sink
   */
  addSink(sink) {
    this._sinks.push(sink);
  }

  /**
   * 移除一个 sink。不存在时无操作。
   * @param {(trace: HookTrace) => void} sink
   */
  removeSink(sink) {
    const idx = this._sinks.indexOf(sink);
    if (idx !== -1) this._sinks.splice(idx, 1);
  }

  /**
   * 清空所有 sink。仅供测试使用。
   */
  clearSinks() {
    this._sinks = [];
  }

  /**
   * 发射一次 trace 到所有 sink + 默认 logger。
   *
   * 日志格式为 logfmt 风格：
   *   hook_trace hook=<name> chain=<n1,n2|-> winner=<name|->
   *   can_ms=<f> handle_ms=<f> [skipped=<n@ms/...>] [errors=<n:e/...>]
   *
   * chain 为空时降级为 debug；非空才是 info 级排障线索。
   * @param {HookTrace} trace
   */
  emit(trace) {
    const msg = _HookMetrics._formatLogfmt(trace);
    if (trace.chain.length > 0) {
      console.info(msg);
    } else {
      console.debug(msg);
    }
    for (const sink of this._sinks) {
      try {
        sink(trace);
      } catch (e) {
        console.error(`HookMetrics sink failed; trace=${trace.hook}`, e);
      }
    }
  }

  /**
   * 把 HookTrace 序列化为 logfmt 单行字符串。
   * @param {HookTrace} trace
   * @returns {string}
   */
  static _formatLogfmt(trace) {
    const chainStr = trace.chain.length > 0 ? trace.chain.join(',') : '-';
    const parts = [
      `hook_trace hook=${trace.hook}`,
      `chain=${chainStr}`,
      `winner=${trace.winner ?? '-'}`,
      `can_ms=${Math.round(trace.winnerCanHandleMs * 1000) / 1000}`,
      `handle_ms=${Math.round(trace.winnerHandleMs * 1000) / 1000}`,
    ];
    if (trace.skipped.length > 0) {
      parts.push(
        'skipped=' + trace.skipped
          .map(([name, ms]) => `${name}@${Math.round(ms * 1000) / 1000}`)
          .join('/')
      );
    }
    if (trace.errors.length > 0) {
      parts.push(
        'errors=' + trace.errors.map(([name, err]) => `${name}:${err}`).join('/')
      );
    }
    return parts.join(' ');
  }
}

/** 进程级单例。 */
export const HOOK_METRICS = new _HookMetrics();

export default { HookTrace, HOOK_METRICS };
