// Agent 辅助函数 —— 供脱离 BaseAgent 的单步 agent(普通 class)复用。
//
// 扁平化后只剩 pushInPlaceStatus 一个消费者(FormatAgent 进度推送用)。
// 原 buildChildContext(子 agent 隔离上下文)随 NL2SQLAgent/SupervisorAgent 状态机
// 删除而失去消费者,已移除。
//
// 抽离动机:Step 2 把 Format agent 改为普通 class(不再 extends BaseAgent),它原先
// 继承到的 _push_in_place_status 是唯一有用成员,抽成自由函数集中维护。

/**
 * 同一 cid_key 多次推送会原地刷新(replace_content=true),避免堆叠出新块。
 *
 * 1:1 提取自 BaseAgent._push_in_place_status。chat() 非流式且单轮耗时长,
 * "思考中" / "任务进展" / "格式化进度" 等都需要在前端原地更新,否则会出现
 * N 条 [Agent] 任务进展 串联或 StreamParser 拼接脏文本。
 *
 * @param {object} agent_context
 * @param {Function} stream_callback
 * @param {object} opts
 * @param {string} opts.cid_key - 写入 agent_context.data 的 content_id 槽位,首次推送后回写复用。
 * @param {string} opts.content
 * @param {string|null} [opts.title=null]
 * @param {string} [opts.content_type='text']
 * @param {string} [opts.msg_category='status']
 * @param {boolean} [opts.use_current_task_group=true] - true 时自动挂当前 _current_task_id;全局提示传 false。
 * @param {boolean} [opts.display=true]
 * @param {boolean} [opts.recall=false]
 * @param {boolean} [opts.replace_content=true]
 * @param {object} [opts.extra={}] - 透传到 stream_callback 的剩余 kwarg(如 task_plan / tool_name);
 *   不要再放 content_type / display / recall / replace_content / msg_category,
 *   那些与上面显式参数冲突会出错。
 * @returns {Promise<string|null>}
 */
export async function pushInPlaceStatus(
  agent_context,
  stream_callback,
  {
    cid_key,
    content,
    title = null,
    content_type = 'text',
    msg_category = 'status',
    use_current_task_group = true,
    display = true,
    recall = false,
    replace_content = true,
    extra = {},
  } = {},
) {
  if (!stream_callback) {
    return null;
  }
  const cid = agent_context.data[cid_key];
  // use_current_task_group=true 时让 StreamCallback 走 streaming_context 自动注入;
  // false 时显式传 task_group=null 阻断("全部任务完成"等全局提示不该挂任何 task)。
  const extra_kwargs = { ...extra };
  if (!use_current_task_group) {
    extra_kwargs.task_group = null;
  }
  const used_cid = await stream_callback(content, {
    content_id: cid,
    content_type,
    title,
    recall,
    display,
    msg_category,
    replace_content,
    ...extra_kwargs,
  });
  if (used_cid && !cid) {
    agent_context.data[cid_key] = used_cid;
  }
  return used_cid;
}
