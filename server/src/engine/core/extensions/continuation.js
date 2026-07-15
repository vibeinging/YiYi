// 迁移自 core/agentic_flow/extensions/continuation.py

/**
 * Continuation — handler short-circuit 时如何接管后续主流程的契约对象
 *
 * 把扩展状态机封装为函数式接口。主线只感知 `_pre_handler_continuation` 一个
 * 通用 key，不读写任何扩展私有 key。
 *
 * 约定:
 * - handler short-circuit 时构造 Continuation 实例，通过
 *   Continuation.attach(agentContext) 写入 agentContext.data
 * - 主线在固定切点调 Continuation.fromContext(agentContext) 取出后调对应字段
 * - Continuation.clear 在轮询完成时清理自身 + 它声明的 cleanupKeys
 */

export const CONTINUATION_KEY = '_pre_handler_continuation';
/** agentContext.data 中存储 Continuation 实例的通用 key。 */

export const CONTINUATION_REBUILDER_KEY = '_pre_handler_continuation_extension';
/** agentContext.data 中存储 Continuation 的扩展名 (string)，用于序列化丢失后重建。 */

/** @type {Map<string, () => Continuation>} */
const _REBUILDERS = new Map();

/**
 * 注册一个 Continuation 重建函数，在 session resume 后 callable 字段
 * 被序列化丢失时，主线可以通过扩展名查表重建出完整 Continuation。
 *
 * 幂等：重复注册覆盖。
 *
 * 注意: 扩展名是写进 db 的"对外标识"，一旦上线被持久化会话引用，改名会让
 * 旧 session 找不到 rebuilder。**修改 extensionName 需要数据迁移或者
 * 同时保留旧名 alias 注册一段时间**。
 *
 * @param {string} extensionName
 * @param {() => Continuation} builder
 */
export function registerContinuationRebuilder(extensionName, builder) {
  _REBUILDERS.set(extensionName, builder);
  console.info(
    `[continuation.register] extension=${extensionName} rebuilder=${builder.name || String(builder)} (registered=${_REBUILDERS.size})`
  );
}

/**
 * 列出当前已注册的扩展名（供健康检查 / 调试）。
 * @returns {string[]}
 */
export function listRegisteredContinuationExtensions() {
  return [..._REBUILDERS.keys()].sort();
}

// ============================================================
// Continuation
// ============================================================

/**
 * handler short-circuit 时返回的"如何接管后续主流程"声明。
 *
 * 主线根据 Continuation 字段决定后续行为，不需要知道是 metric_view 还是其他扩展。
 * 所有字段都是可选回调，null 表示主线走默认逻辑。
 */
export class Continuation {
  /**
   * @param {Object} [opts]
   * @param {Object|null}   [opts.action]
   *   主线立即返回的 ActionDict；null 表示无短路 action（仅注入持续性回调）。
   * @param {((agentContext: any, streamCallback: any) => Promise<void>)|null} [opts.onContinueStage]
   *   current_goal=='continue' 阶段的额外推送。null 表示无需额外推送。
   * @param {((agentContext: any, data: Object) => Object[]|null|undefined)|null} [opts.taskPlanOverride]
   *   从 tool result data 中提取替换的 task_plan。
   * @param {((agentContext: any, currentData: Object) => number)|null} [opts.advancePolicy]
   *   自定义任务推进 (agentContext, currentData) -> completedTaskIdx。
   * @param {((target: Object, source: Object) => void)|null} [opts.stepOutputPropagator]
   *   把 result.data 中扩展私有字段透传到 step_output / sub_task_record。
   * @param {((streamCallback: any, data: Object, completedTaskIdx: number) => Promise<void>)|null} [opts.statusPush]
   *   评估阶段的状态推送。
   * @param {string[]} [opts.cleanupKeys]
   *   轮询完成时需要从 agentContext.data 清理的 key 列表。
   * @param {boolean} [opts.suppressDefaultStatusPush]
   *   true 时主线不再调用任何默认 status_push 链。
   * @param {string} [opts.extensionName]
   *   构造此 Continuation 的扩展名（如 'metric_view'）。
   */
  constructor({
    action = null,
    onContinueStage = null,
    taskPlanOverride = null,
    advancePolicy = null,
    stepOutputPropagator = null,
    statusPush = null,
    cleanupKeys = [],
    suppressDefaultStatusPush = false,
    extensionName = '',
  } = {}) {
    /** @type {Object|null} */
    this.action = action;
    /** @type {Function|null} */
    this.onContinueStage = onContinueStage;
    /** @type {Function|null} */
    this.taskPlanOverride = taskPlanOverride;
    /** @type {Function|null} */
    this.advancePolicy = advancePolicy;
    /** @type {Function|null} */
    this.stepOutputPropagator = stepOutputPropagator;
    /** @type {Function|null} */
    this.statusPush = statusPush;
    /** @type {string[]} */
    this.cleanupKeys = cleanupKeys;
    /** @type {boolean} */
    this.suppressDefaultStatusPush = suppressDefaultStatusPush;
    /** @type {string} */
    this.extensionName = extensionName;
  }

  // ------------------------------------------------------------
  // 主线侧 helper（避免主线感知 CONTINUATION_KEY 字符串）
  // ------------------------------------------------------------

  /**
   * 把本 Continuation 写入 agentContext.data，同时记录扩展名以便丢失后重建。
   * @param {any} agentContext
   */
  attach(agentContext) {
    agentContext.data[CONTINUATION_KEY] = this;
    if (this.extensionName) {
      agentContext.data[CONTINUATION_REBUILDER_KEY] = this.extensionName;
    }
  }

  /**
   * 从 agentContext.data 取出当前 Continuation。
   *
   * 如果对象本身已丢失（session resume 后 callable 字段被序列化清除），
   * 尝试通过 CONTINUATION_REBUILDER_KEY 记录的扩展名重建出完整实例。
   *
   * @param {any} agentContext
   * @returns {Continuation|null}
   */
  static fromContext(agentContext) {
    const cont = agentContext.data[CONTINUATION_KEY];
    if (cont instanceof Continuation) {
      return cont;
    }
    return Continuation._tryRebuild(agentContext);
  }

  /**
   * session resume 路径：用扩展名查表重建 Continuation。
   *
   * 三种失败情况均返回 null，让主线降级到 LLM reasoning（不抛异常）：
   * - 无扩展名记录（非短路场景，静默返回）
   * - 扩展名存在但 rebuilder 未注册（启动顺序/扩展禁用/改名，warning）
   * - builder 返回非 Continuation 类型（实现 bug，warning）
   *
   * @param {any} agentContext
   * @returns {Continuation|null}
   */
  static _tryRebuild(agentContext) {
    const extName = agentContext.data[CONTINUATION_REBUILDER_KEY];
    if (!extName) return null;

    if (!_REBUILDERS.has(extName)) {
      console.warn(
        `[continuation.rebuild] no rebuilder for extension=${JSON.stringify(extName)} ` +
        `registered=${JSON.stringify([..._REBUILDERS.keys()].sort())}`
      );
      return null;
    }

    const rebuilt = _REBUILDERS.get(extName)();
    if (!(rebuilt instanceof Continuation)) {
      console.warn(
        `[continuation.rebuild] builder for ${JSON.stringify(extName)} returned non-Continuation: ` +
        rebuilt?.constructor?.name
      );
      return null;
    }

    agentContext.data[CONTINUATION_KEY] = rebuilt;
    console.info(
      `[continuation.rebuild] rebuilt from extension=${extName} (session resume path)`
    );
    return rebuilt;
  }

  /**
   * 轮询结束时清理 Continuation 自身 + 它声明的 cleanupKeys。
   * @param {any} agentContext
   */
  static clear(agentContext) {
    const cont = agentContext.data[CONTINUATION_KEY];
    delete agentContext.data[CONTINUATION_KEY];
    delete agentContext.data[CONTINUATION_REBUILDER_KEY];
    if (cont instanceof Continuation) {
      for (const key of cont.cleanupKeys) {
        delete agentContext.data[key];
      }
    }
  }
}

export default {
  Continuation,
  CONTINUATION_KEY,
  CONTINUATION_REBUILDER_KEY,
  registerContinuationRebuilder,
  listRegisteredContinuationExtensions,
};
