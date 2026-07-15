// 迁移自 core/agentic_flow/core/agent_context.py

import { randomUUID } from 'crypto';

/**
 * 生成 UUID（对标 Python uuid7()，此处用 uuid4 实现）
 * @returns {string}
 */
function uuid7() {
  return randomUUID();
}

/**
 * 深拷贝普通数据,但**按引用保留类实例**(BusinessDataSources / DataSource / IntermediateDataSource 等),
 * 避免 structuredClone 把它们剥成无方法的普通对象(对标 Python copy.deepcopy 保留对象类型的意图)。
 * 普通对象/数组/Date 深拷贝;类实例、Map、Set、函数按引用保留。
 */
export function safeClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(safeClone);
  if (v instanceof Date) return new Date(v);
  const proto = Object.getPrototypeOf(v);
  if (proto === Object.prototype || proto === null) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = safeClone(v[k]);
    return out;
  }
  return v; // 类实例 / Map / Set / 其它:保留引用,保住方法
}

// ============================================================
// ExecutionRecord
// ============================================================

export class ExecutionRecord {
  /**
   * @param {object} opts
   * @param {string} opts.agent_name
   * @param {string} opts.phase
   * @param {object} [opts.input_data]
   * @param {object} [opts.action]
   * @param {object} [opts.observation]
   * @param {boolean} [opts.success]
   * @param {string|null} [opts.error]
   * @param {number} [opts.execution_time]
   * @param {Date} [opts.timestamp]
   */
  constructor({
    agent_name,
    phase,
    input_data = {},
    action = {},
    observation = {},
    success = true,
    error = null,
    execution_time = 0.0,
    timestamp = new Date(),
  } = {}) {
    this.agent_name = agent_name;
    this.phase = phase;
    this.input_data = input_data;
    this.action = action;
    this.observation = observation;
    this.success = success;
    this.error = error;
    this.execution_time = execution_time;
    this.timestamp = timestamp instanceof Date ? timestamp : new Date(timestamp);
  }

  /** @returns {object} */
  to_dict() {
    return {
      agent_name: this.agent_name,
      phase: this.phase,
      input_data: this.input_data,
      action: this.action,
      observation: this.observation,
      success: this.success,
      error: this.error,
      execution_time: this.execution_time,
      timestamp: this.timestamp.toISOString(),
    };
  }

  /**
   * 从普通对象构造 ExecutionRecord
   * @param {object} data
   * @returns {ExecutionRecord}
   */
  static from_dict(data) {
    return new ExecutionRecord({
      agent_name: data.agent_name ?? 'unknown',
      phase: data.phase ?? 'unknown',
      input_data: data.input_data ?? {},
      action: data.action ?? {},
      observation: data.observation ?? {},
      success: data.success ?? true,
      error: data.error ?? null,
      execution_time: data.execution_time ?? 0.0,
      timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
    });
  }
}

// ============================================================
// AgentContext
// ============================================================

/**
 * 父 Agent 的任务管理状态，子上下文不应继承。
 * @type {ReadonlyArray<string>}
 */
const NON_INHERITABLE_KEYS = Object.freeze([
  '_task_plan',
  '_current_task_idx',
  // nl2sql 子任务瞬态键
  '_intermediate_initialized',
  'schema_info',
  '_intermediate_table_names',
  'attempt_count',
  'consecutive_empty_count',
  'retry_feedback',
  '_unknown_goal_retry',
]);

export class AgentContext {
  /**
   * @param {object} opts
   * @param {string} opts.task_id
   * @param {string} [opts.user_id]
   * @param {string} [opts.project_id]
   * @param {string} [opts.session_id]
   * @param {object} [opts.input_data]
   * @param {string|null} [opts.current_agent]
   * @param {string} [opts.current_goal]
   * @param {object} [opts.data]
   * @param {ExecutionRecord[]} [opts.history]
   * @param {boolean} [opts.success]
   * @param {string|null} [opts.error]
   * @param {Date} [opts.created_at]
   */
  constructor({
    task_id,
    user_id = '',
    project_id = '',
    session_id = '',
    input_data = {},
    current_agent = null,
    current_goal = 'initialize',
    data = {},
    history = [],
    success = false,
    error = null,
    created_at = new Date(),
  } = {}) {
    this.task_id = task_id || uuid7();
    this.user_id = user_id;
    this.project_id = project_id;
    this.session_id = session_id;
    this.input_data = input_data;
    this.current_agent = current_agent;
    this.current_goal = current_goal;
    this.data = data;
    this.history = history;
    this.success = success;
    this.error = error;
    this.created_at = created_at instanceof Date ? created_at : new Date(created_at);
  }

  // ========== 基础方法 ==========

  /**
   * 追加执行记录
   * @param {ExecutionRecord} record
   */
  add_record(record) {
    this.history.push(record);
    this.current_agent = record.agent_name;
    if (!record.success && record.error) {
      this.error = `${record.agent_name}.${record.phase}: ${record.error}`;
    }
  }

  /**
   * 标记成功
   * @param {object|null} [final_result]
   */
  mark_success(final_result = null) {
    this.success = true;
    this.current_goal = 'complete';
    if (final_result) {
      this.data['final_result'] = final_result;
    }
  }

  /**
   * 标记失败
   * @param {string} error
   */
  mark_failed(error) {
    this.success = false;
    this.current_goal = 'complete';
    this.error = error;
  }

  /**
   * 设置当前目标
   * @param {string} goal
   */
  set_goal(goal) {
    this.current_goal = goal;
  }

  /**
   * 是否应继续执行
   * @param {number} [max_steps=50]
   * @returns {boolean}
   */
  should_continue(max_steps = 50) {
    return this.current_goal !== 'complete' && this.history.length < max_steps;
  }

  /**
   * 创建深拷贝（不继承父 Agent 任务管理状态）
   * @returns {AgentContext}
   */
  copy() {
    const child_data = safeClone(this.data);
    for (const key of NON_INHERITABLE_KEYS) {
      delete child_data[key];
    }

    return new AgentContext({
      task_id: this.task_id,
      user_id: this.user_id,
      project_id: this.project_id,
      session_id: this.session_id,
      input_data: safeClone(this.input_data),
      current_agent: this.current_agent,
      current_goal: this.current_goal,
      data: child_data,
      history: this.history.map((r) => ExecutionRecord.from_dict(r.to_dict())),
      success: this.success,
      error: this.error,
      created_at: new Date(this.created_at),
    });
  }

  // ========== 子 Agent 管理 ==========

  /**
   * 存储子 Agent 的执行信息
   * @param {string} agent_name
   * @param {AgentContext} child_context
   * @param {object} result
   * @param {string|null} [parent_agent_id]
   * @param {string|null} [agent_id]
   * @param {object|null} [call_params]
   * @param {string|null} [agent_class]
   */
  store_sub_agent_execution(
    agent_name,
    child_context,
    result,
    parent_agent_id = null,
    agent_id = null,
    call_params = null,
    agent_class = null,
  ) {
    const now = Date.now();
    const start = child_context.created_at instanceof Date
      ? child_context.created_at.getTime()
      : Number(child_context.created_at);
    const execution_time = (now - start) / 1000;

    if (!this.data['_sub_agents']) {
      this.data['_sub_agents'] = {};
    }

    // 保留已有的 checkpoint
    const existing_checkpoint =
      this.data['_sub_agents'][agent_name]?.checkpoint ?? null;

    const sub_agent_data = {
      agent_id,
      agent_name,
      agent_class: agent_class ?? child_context.current_agent ?? agent_name,
      parent_agent_id,
      call_params: call_params ?? {},
      final_state: {
        data: { ...child_context.data },
        current_goal: child_context.current_goal,
      },
      result: typeof result?.to_dict === 'function' ? result.to_dict() : result,
      checkpoint: existing_checkpoint,
    };

    this.data['_sub_agents'][agent_name] = sub_agent_data;
  }

  /**
   * 获取子 Agent 信息
   * @param {string} agent_name
   * @returns {object|undefined}
   */
  get_sub_agent_info(agent_name) {
    return this.data['_sub_agents']?.[agent_name];
  }

  /**
   * 列出所有子 Agent 名称
   * @returns {string[]}
   */
  list_sub_agents() {
    return Object.keys(this.data['_sub_agents'] ?? {});
  }

  // ========== 序列化 ==========

  /**
   * 序列化为普通对象
   * @param {boolean} [include_history=false]
   * @returns {object}
   */
  to_dict(include_history = false) {
    const result = {
      task_id: this.task_id,
      user_id: this.user_id,
      project_id: this.project_id,
      session_id: this.session_id,
      input_data: this.input_data,
      current_agent: this.current_agent,
      current_goal: this.current_goal,
      data: this.data,
      success: this.success,
      error: this.error,
      created_at: this.created_at.toISOString(),
    };
    if (include_history) {
      result.history = this.history.map((r) => r.to_dict());
    }
    return result;
  }

  /**
   * 从普通对象构造 AgentContext
   * @param {object} data
   * @returns {AgentContext}
   */
  static from_dict(data) {
    const context = new AgentContext({
      task_id: data.task_id,
      user_id: data.user_id ?? '',
      project_id: data.project_id ?? '',
      session_id: data.session_id ?? '',
      input_data: data.input_data ?? {},
    });
    context.current_agent = data.current_agent ?? null;
    context.current_goal = data.current_goal ?? 'initialize';
    context.data = data.data ?? {};
    context.success = data.success ?? false;
    context.error = data.error ?? null;

    for (const record_data of (data.history ?? [])) {
      try {
        context.history.push(ExecutionRecord.from_dict(record_data));
      } catch (e) {
        console.warn(`[AgentContext] 解析历史记录失败: ${e}`);
      }
    }

    if (data.created_at) {
      context.created_at = new Date(data.created_at);
    }

    return context;
  }

  // ========== freeze / thaw ==========

  /**
   * 递归转换对象为 JSON 可序列化格式
   * 处理: BigInt → Number, Set → Array, Map → Object, 递归处理嵌套
   * @param {*} obj
   * @returns {*}
   */
  static _make_json_serializable(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'bigint') return Number(obj);
    if (obj instanceof Set) return AgentContext._make_json_serializable([...obj]);
    if (obj instanceof Map) {
      const out = {};
      for (const [k, v] of obj) {
        out[String(k)] = AgentContext._make_json_serializable(v);
      }
      return out;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => AgentContext._make_json_serializable(item));
    }
    if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = AgentContext._make_json_serializable(v);
      }
      return out;
    }
    return obj;
  }

  /**
   * 冻结当前状态为可序列化的 dict
   * @returns {object}
   */
  freeze() {
    let paused_agent_id = this.data['_paused_agent_id'] ?? null;
    if (!paused_agent_id) {
      // 向后兼容：从 _sub_agents 查找
      const sub_agents = this.data['_sub_agents'] ?? {};
      for (const [, agent_info] of Object.entries(sub_agents)) {
        if (agent_info.checkpoint) {
          paused_agent_id = agent_info.agent_id ?? null;
          break;
        }
      }
    }

    return {
      task_id: this.task_id,
      user_id: this.user_id,
      project_id: this.project_id,
      session_id: this.session_id,
      input_data: AgentContext._make_json_serializable(this.input_data),
      current_goal: this.current_goal,
      data: AgentContext._make_json_serializable(this.data),
      history: this.history.map((r) => r.to_dict()),
      current_agent: this.current_agent,
      success: this.success,
      error: this.error,
      timestamp: new Date().toISOString(),
      paused_agent_id,
    };
  }

  /**
   * 从冻结状态恢复（原地修改）
   * @param {object} frozen - freeze() 返回的字典
   * @param {object|null} [new_input] - 新的输入数据（覆盖 input_data 中的同名键）
   */
  thaw(frozen, new_input = null) {
    this.input_data = { ...(frozen.input_data ?? {}) };
    if (new_input) {
      Object.assign(this.input_data, new_input);
    }

    this.current_goal = frozen.current_goal ?? 'initialize';
    this.data = { ...(frozen.data ?? {}) };
    this.current_agent = frozen.current_agent ?? null;
    this.success = frozen.success ?? false;
    this.error = frozen.error ?? null;

    this.history = [];
    for (const record_data of (frozen.history ?? [])) {
      try {
        this.history.push(ExecutionRecord.from_dict(record_data));
      } catch (e) {
        console.warn(`[AgentContext] 恢复历史记录失败: ${e}`);
      }
    }
  }

  /**
   * 从冻结状态创建新的 AgentContext
   * @param {object} frozen - freeze() 返回的字典
   * @param {object|null} [new_input] - 新的输入数据
   * @returns {AgentContext}
   */
  static from_thaw(frozen, new_input = null) {
    const input_data = { ...(frozen.input_data ?? {}) };

    const context = new AgentContext({
      task_id: frozen.task_id ?? '',
      user_id: frozen.user_id ?? '',
      project_id: frozen.project_id ?? '',
      session_id: frozen.session_id ?? '',
      input_data,
    });

    context.thaw(frozen, new_input);
    return context;
  }
}
