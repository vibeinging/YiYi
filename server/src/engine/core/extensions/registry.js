// 迁移自 core/agentic_flow/extensions/registry.py

/**
 * PreHandlerRegistry — 扩展层 chain-based 注册表
 *
 * 每个 hook 类型对应一条按 priority 升序排序的 handler 链:
 * - first_hit: 第一个 canHandle=true 的 handle 结果即返回
 * - classifiers: 返回该 hook 全部 handler，由调用方聚合判断
 *
 * 内置失败隔离（单个 handler 抛错被吞、记录到 HookTrace.errors 后继续）
 * 与可观测性（每次调用通过 HOOK_METRICS 发射 HookTrace）。
 */

import { HOOK_METRICS, HookTrace } from './observability.js';

// ============================================================
// PreHandlerRegistry
// ============================================================

export class PreHandlerRegistry {
  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.strictMode=false]
   *   strictMode=true 时 handler 抛错向上传播；默认 false 吞错记录后继续。
   *   仅供测试使用。
   */
  constructor({ strictMode = false } = {}) {
    /** @type {Map<Function|string, import('./pre_handler.js').PreHandler[]>} */
    this._chains = new Map();
    this._strict = strictMode;
  }

  // ------------------------------------------------------------
  // 注册 / 注销
  // ------------------------------------------------------------

  /**
   * 注册一个 handler 到指定 hook 类型。
   *
   * @param {Function|string} hookCls  hook 类（或类名字符串，用作 key）
   * @param {import('./pre_handler.js').PreHandler} handler
   * @throws {TypeError}  handler 没有声明 name
   * @throws {Error}      同 hook 类型下已存在同名 handler，或与已注册 handler 互斥
   */
  register(hookCls, handler) {
    if (!handler.name) {
      throw new TypeError(
        `Handler ${handler.constructor.name} must declare a non-empty \`name\``
      );
    }

    if (!this._chains.has(hookCls)) {
      this._chains.set(hookCls, []);
    }
    const chain = this._chains.get(hookCls);

    // 同名重复检查
    if (chain.some(h => h.name === handler.name)) {
      const hookName = typeof hookCls === 'string' ? hookCls : hookCls.name;
      throw new Error(
        `Handler ${JSON.stringify(handler.name)} already registered for hook ${hookName}`
      );
    }

    // conflicts_with 双向检查
    const conflicts = handler.conflictsWith ?? [];
    for (const existing of chain) {
      const existingConflicts = existing.conflictsWith ?? [];
      if (conflicts.includes(existing.name) || existingConflicts.includes(handler.name)) {
        const hookName = typeof hookCls === 'string' ? hookCls : hookCls.name;
        throw new Error(
          `Handler ${JSON.stringify(handler.name)} conflicts with already-registered ` +
          `${JSON.stringify(existing.name)} on hook ${hookName}`
        );
      }
    }

    chain.push(handler);
    chain.sort((a, b) => a.priority - b.priority);

    const hookName = typeof hookCls === 'string' ? hookCls : hookCls.name;
    console.info(
      `PreHandler registered: hook=${hookName} name=${handler.name} priority=${handler.priority}`
    );
  }

  /**
   * 按 name 注销 handler；不存在时无操作。
   * @param {Function|string} hookCls
   * @param {string} name
   */
  unregister(hookCls, name) {
    const chain = this._chains.get(hookCls);
    if (!chain) return;
    this._chains.set(hookCls, chain.filter(h => h.name !== name));
  }

  /**
   * 清空所有 chain。仅供测试使用。
   */
  clear() {
    this._chains.clear();
  }

  // ------------------------------------------------------------
  // 调用 — firstHit
  // ------------------------------------------------------------

  /**
   * FIRST_HIT 语义调用。
   *
   * 按 priority 顺序遍历 chain：
   * 1. 调 canHandle(ctx)；false 则跳过，记录到 trace.skipped
   * 2. 调 handle(ctx)；返回值即作为本次 hook 调用的结果
   * 3. 任一 handler 抛错：吞错记录到 trace.errors 继续下一个；strictMode 时向上抛
   * 4. 全部 handler 都未命中：返回 null
   *
   * 每次调用结束发射一次 HookTrace 到 HOOK_METRICS。
   *
   * @param {Function|string} hookCls
   * @param {any} ctx
   * @returns {Promise<any|null>}
   */
  async firstHit(hookCls, ctx) {
    const chain = this._chains.get(hookCls) ?? [];
    const hookName = typeof hookCls === 'string' ? hookCls : hookCls.name;
    const trace = new HookTrace({ hook: hookName, chain: chain.map(h => h.name) });

    for (const h of chain) {
      const t0 = performance.now();
      try {
        const canHandle = await h.canHandle(ctx);
        if (!canHandle) {
          trace.addSkip(h.name, performance.now() - t0);
          continue;
        }
        const t1 = performance.now();
        const result = await h.handle(ctx);
        trace.setWinner(h.name, {
          canHandleMs: t1 - t0,
          handleMs: performance.now() - t1,
        });
        HOOK_METRICS.emit(trace);
        return result;
      } catch (exc) {
        trace.addError(h.name, String(exc));
        console.error(
          `PreHandler ${h.name} failed at hook ${hookName}; skipped`,
          exc
        );
        if (this._strict) {
          HOOK_METRICS.emit(trace);
          throw exc;
        }
      }
    }

    HOOK_METRICS.emit(trace);
    return null;
  }

  // ------------------------------------------------------------
  // 调用 — classifiers
  // ------------------------------------------------------------

  /**
   * CLASSIFIER 语义调用。返回该 hook 类型全部 handler，由调用方聚合判断。
   * @param {Function|string} hookCls
   * @returns {import('./pre_handler.js').PreHandler[]}
   */
  classifiers(hookCls) {
    return [...(this._chains.get(hookCls) ?? [])];
  }

  // ------------------------------------------------------------
  // 内省（仅供测试与调试）
  // ------------------------------------------------------------

  /**
   * 返回该 hook 类型已注册的 handler 名称列表（按 priority 排序）。
   * @param {Function|string} hookCls
   * @returns {string[]}
   */
  names(hookCls) {
    return (this._chains.get(hookCls) ?? []).map(h => h.name);
  }
}

// ============================================================
// 进程级单例
// ============================================================

/** 进程级 PreHandlerRegistry 单例。各扩展通过 registerAll(PRE_HANDLERS) 注册。 */
export const PRE_HANDLERS = new PreHandlerRegistry();

export default { PreHandlerRegistry, PRE_HANDLERS };
