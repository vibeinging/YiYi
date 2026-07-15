// 迁移自 core/agentic_flow/extensions/result_propagation.py

/**
 * 扩展层 Result 字段透传 — 主线工具调用，扩展按需注册 propagator
 *
 * 主线工具（nl2sql 等）调用下游 Agent 后，通过 propagate(source, target)
 * 把 agentResult.data 中扩展私有字段透传到工具即将返回的 Result。
 * 未注册时 propagate(...) 是无副作用 no-op。
 *
 * 与 Continuation.stepOutputPropagator 切点不同:
 * - 本模块: agentResult → toolResult（主线工具内部）
 * - stepOutputPropagator: toolResult → stepOutput / subTaskRecord（SuperAgent.observation）
 */

/** @type {Array<(sourceData: Object, targetResult: any) => void>} */
const _PROPAGATORS = [];

/**
 * 注册一个 result propagator。
 *
 * fn 签名: (sourceData: Object, targetResult: any) -> void
 *   - sourceData: 下游 agent 返回的 result.data 对象
 *   - targetResult: 工具即将返回的 Result 对象；fn 直接修改其 .data / .metadata
 *
 * 幂等：同一函数引用重复注册被忽略。
 *
 * @param {(sourceData: Object, targetResult: any) => void} fn
 */
export function registerPropagator(fn) {
  if (!_PROPAGATORS.includes(fn)) {
    _PROPAGATORS.push(fn);
  }
}

/**
 * 对 sourceData 调用所有已注册的 propagator，把扩展私有字段透传到 targetResult。
 *
 * 返回 targetResult 以便链式使用。无注册 propagator 或入参非法时安静 no-op。
 *
 * @param {any} sourceData
 * @param {any} targetResult
 * @returns {any} targetResult
 */
export function propagate(sourceData, targetResult) {
  if (typeof sourceData !== 'object' || sourceData === null || targetResult == null) {
    return targetResult;
  }
  for (const fn of _PROPAGATORS) {
    try {
      fn(sourceData, targetResult);
    } catch (e) {
      // propagator 不应破坏主流程
      console.error(`result propagator ${fn.name || String(fn)} failed`, e);
    }
  }
  return targetResult;
}

/**
 * 供测试 fixture 重置注册表；生产代码不应调用。
 */
export function _resetForTest() {
  _PROPAGATORS.length = 0;
}

export default { registerPropagator, propagate, _resetForTest };
