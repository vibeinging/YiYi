// 迁移自 core/agentic_flow/core/streaming_context.py

/**
 * Reasoning / 工具调用链路的隐式 streaming 上下文。
 *
 * 只承载 task_group：用 AsyncLocalStorage（Node 版的 contextvars 对等物）把
 * "当前内容块归属哪个任务步骤"做成协程级隐式状态，避免每个 stream_callback
 * 调用点都显式传一遍。
 *
 * 约定：
 * - StreamCallback 构造 metadata 时，如果调用方没有显式传 task_group，
 *   自动从这里读取并注入；显式传值（包括 null）会被尊重。
 * - 上层（SuperAgent / DSAgent）在每轮 reasoning 确定本轮 task_id 后调用
 *   set_task_group(task_id) 即可，后续工具/子 agent 推送自动继承。
 * - AsyncLocalStorage 是 async-scope 隔离，不会跨请求泄漏。
 *
 * Python contextvars → Node AsyncLocalStorage 映射：
 *   ContextVar.get()   → getStore()
 *   ContextVar.set()   → 通过 _current_value 变量保存（模拟 set/reset 语义）
 *   contextmanager     → task_group_scope()（接受回调，在 run() 内执行）
 *
 * 注意：AsyncLocalStorage.run() 会创建新的子 store，而 Python contextvars.set()
 * 是"当前 context 原地更新"。为了保持"set 一次全局生效"的语义，
 * set_task_group / reset_task_group 直接操作模块级变量 _current_value，
 * 与 Python Token 模式对应。task_group_scope 则用 AsyncLocalStorage.run 做局部隔离。
 */

import { AsyncLocalStorage } from 'async_hooks';

/** 用于 task_group_scope 的局部隔离存储 */
const _SCOPED_STORAGE = new AsyncLocalStorage();

/** 模块级当前值（对标 Python ContextVar 的 set/get/reset 语义） */
let _current_value = null;

// ============================================================
// get_task_group
// ============================================================

/**
 * 读取当前 task_group。
 *
 * 优先读取 AsyncLocalStorage 内的作用域值（由 task_group_scope 设置），
 * 否则返回模块级 _current_value（由 set_task_group 设置）。
 *
 * @returns {string|null}
 */
export function get_task_group() {
  const scoped = _SCOPED_STORAGE.getStore();
  // getStore() 返回 undefined 表示不在 run() 内，返回对象则取 value 字段
  if (scoped !== undefined) {
    return scoped.value ?? null;
  }
  return _current_value;
}

// ============================================================
// set_task_group / reset_task_group
// ============================================================

/**
 * Token 类型，对标 Python contextvars.Token
 * @typedef {{ prev_value: string|null }} Token
 */

/**
 * 设置当前 task_group，返回 token 供 reset_task_group 用。
 * 传 null 表示"清除"（后续推送不挂任何 task）。
 *
 * @param {string|null} task_id
 * @returns {{ prev_value: string|null }}
 */
export function set_task_group(task_id) {
  const token = { prev_value: _current_value };
  _current_value = task_id ?? null;
  return token;
}

/**
 * 配合 set_task_group 返回的 token 恢复上一个值。
 *
 * @param {{ prev_value: string|null }} token
 */
export function reset_task_group(token) {
  _current_value = token.prev_value;
}

// ============================================================
// task_group_scope
// ============================================================

/**
 * 在回调内临时切换 task_group，离开时自动恢复。
 *
 * 用于工具/子 agent 内部"局部切到不同 task"的场景。
 * 多数情况下上层用 set_task_group 持续覆盖即可，不需要 scope。
 *
 * 对标 Python @contextmanager task_group_scope(task_id)，
 * Node 版通过 AsyncLocalStorage.run 实现协程级隔离。
 *
 * 使用方式（async）：
 *   await task_group_scope('step-1', async () => {
 *     // 此处 get_task_group() === 'step-1'
 *   });
 *
 * @param {string|null} task_id
 * @param {() => Promise<*>|*} fn - 在作用域内执行的函数
 * @returns {Promise<*>}
 */
export async function task_group_scope(task_id, fn) {
  return _SCOPED_STORAGE.run({ value: task_id ?? null }, fn);
}
