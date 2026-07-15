// 迁移自 core/agentic_flow/extensions/pre_handler.py

/**
 * PreHandler — 扩展层抽象基类
 *
 * Hook 切点（按调用顺序）:
 * - Hook 1: PreDecomposeHandler       (FIRST_HIT) — SuperAgent 首轮 reasoning 之前
 * - Hook 2: PreNl2sqlExecuteHandler   (FIRST_HIT) — NL2SQLTool.execute 入口
 * - Hook 4: CompleteMetadataHandler   (FIRST_HIT) — final_result 推流前 metadata 注入
 *
 * 历史 Hook 3 (PauseGroupClassifier) 已废弃删除。
 */

// ============================================================
// HookType
// ============================================================

export const HookType = Object.freeze({
  FIRST_HIT: 'first_hit',
  /**
   * 第一个 can_handle 命中即返回（默认；Hook 1/2/4）。
   */

  CLASSIFIER: 'classifier',
  /**
   * 聚合判定，多个 classifier 共同参与；当前无使用方但语义保留。
   */
});

// ============================================================
// PreHandler — 抽象基类
// ============================================================

/**
 * 所有 PreHandler 的抽象基类。
 *
 * 子类必须声明 `name`，可覆盖 `priority` / `hookType`，
 * 并实现 `canHandle` / `handle` 两个异步方法。
 */
export class PreHandler {
  /** @type {string} handler 唯一名称；同 hook 类型下不允许重名。 */
  name = '';

  /** @type {number} 优先级；越小越先执行。 */
  priority = 100;

  /** @type {string} Hook 调用语义，取 HookType 值。 */
  hookType = HookType.FIRST_HIT;

  /** @type {string[]} 与之互斥的 handler 名；Registry.register 时检查冲突。 */
  conflictsWith = [];

  /**
   * 判断是否处理当前上下文。返回 false 时 Registry 跳过本 handler。
   * @param {any} ctx
   * @returns {Promise<boolean>}
   */
  async canHandle(ctx) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}.canHandle() must be implemented`);
  }

  /**
   * 执行处理逻辑。返回值类型由具体 hook 子类约束。
   * @param {any} ctx
   * @returns {Promise<any>}
   */
  async handle(ctx) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}.handle() must be implemented`);
  }
}

// ============================================================
// Hook 1 — PreDecomposeHandler（首轮 reasoning 短路）
// ============================================================

/**
 * SuperAgent 首轮 reasoning (stepCount == 0) 之前的拦截 hook 上下文。
 *
 * @typedef {Object} PreDecomposeContext
 * @property {any}      agentContext         - AgentContext 实例
 * @property {Function} streamCallback       - 推流回调
 * @property {string}   question
 * @property {any[]}    businessDataSources
 */

/**
 * PreDecomposeHandler — SuperAgent 首轮 reasoning 短路 hook。
 *
 * handle 返回 ActionDict 即视为短路；返回 null/undefined 表示不短路。
 * 需要接管后续 ReAct 主流程时，handler 通过 Continuation.attach(agentContext) 写入。
 */
export class PreDecomposeHandler extends PreHandler {
  hookType = HookType.FIRST_HIT;
}

// ============================================================
// Hook 2 — PreNl2sqlExecuteHandler（NL2SQL 执行短路）
// ============================================================

/**
 * @typedef {Object} PreNl2sqlExecuteContext
 * @property {string}    question
 * @property {any}       context
 * @property {any}       datasource
 * @property {any}       dataSources       - BusinessDataSources（聚合 + lookup），非 list
 * @property {Function|null} streamCallback
 * @property {Object}    toolUserInputs
 */

/**
 * PreNl2sqlExecuteResult — NL2SQL hook 返回值。
 */
export class PreNl2sqlExecuteResult {
  /**
   * @param {Object} opts
   * @param {Object}  opts.decision      - 用于日志/观测的决策摘要
   * @param {any}     opts.result        - ToolResult 替代主流程的返回
   * @param {boolean} opts.shortCircuit  - true 时主线 return result，跳过 NL2SQL 默认实现
   * @param {any}     [opts.continuation] - 如需接管后续主流程，提供 Continuation 对象
   */
  constructor({ decision, result, shortCircuit, continuation = null } = {}) {
    /** @type {Object} */
    this.decision = decision;
    /** @type {any} */
    this.result = result;
    /** @type {boolean} */
    this.shortCircuit = shortCircuit;
    /** @type {any|null} */
    this.continuation = continuation;
  }
}

/**
 * PreNl2sqlExecuteHandler — NL2SQLTool.execute 入口的拦截 hook。
 *
 * handle 返回 PreNl2sqlExecuteResult；shortCircuit=true 时主线立即返回 .result。
 */
export class PreNl2sqlExecuteHandler extends PreHandler {
  hookType = HookType.FIRST_HIT;
}

// ============================================================
// Hook 4 — CompleteMetadataHandler（完成阶段 metadata 注入）
// ============================================================

/**
 * @typedef {Object} CompleteMetadataContext
 * @property {any}    agentContext
 * @property {Object} params
 */

/**
 * CompleteMetadataHandler — final_result 推流前 metadata 注入的拦截 hook。
 *
 * handle 返回 stream_callback 的 extra kwargs 对象
 * （如 `{ metricViewMetadata: {...} }`）。返回 null 或空对象表示不注入。
 */
export class CompleteMetadataHandler extends PreHandler {
  hookType = HookType.FIRST_HIT;
}

export default {
  HookType,
  PreHandler,
  PreDecomposeHandler,
  PreNl2sqlExecuteContext: /** @type {Object} */ ({}), // typedef only
  PreNl2sqlExecuteResult,
  PreNl2sqlExecuteHandler,
  CompleteMetadataHandler,
};
