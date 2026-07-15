// 迁移自 core/agentic_flow/core/streaming_chat.py

/**
 * Reasoning 阶段的流式 LLM 调用辅助。
 *
 * 让 agent 把 `await chat(kwargs)` 换成 `await stream_reasoning(...)` 即可获得：
 * - thought 字段边生成边推给前端（同一 content_id + replace_content=True，整段覆盖打字）
 * - 失败回退到非流式时，把整段 thought 作为普通块一次推给前端，保证 UI 不空白
 * - 当 LLM 决定调 complete 工具时，params.content（终答）也按打字机效果推送
 *
 * 约定：response_model 至少要有一个名为 thought 的字段，否则 thought 推送被跳过，
 * 但 final 返回值仍然正确。这样 helper 对调用方零侵入。
 *
 * TODO: chat() 在 Node 侧尚未实现；stream_reasoning 保留完整接口，
 *       调用方接入时替换 _chat 为实际 LLM 调用函数。
 */

import { t } from '../utils/i18n.js';

// ---- 常量 ----

/** Reasoning 阶段流式 thought 块的 cid 槽位 */
export const STREAMING_THOUGHT_CID_KEY = '_streaming_thought_cid';

/** Reasoning 阶段流式 final answer 块的 cid 槽位 */
export const STREAMING_FINAL_ANSWER_CID_KEY = '_streaming_final_answer_cid';

/** 触发 final answer 流式的工具名 */
const _COMPLETE_TOOL_NAMES = new Set(['complete']);

// ---- 内部辅助 ----

/**
 * 从 partial 模型里提取 complete 工具的终答文本。
 *
 * params 既可能是普通对象（partial JSON 早期阶段）也可能是 class 实例（后期）；
 * 统一兼容。取 answer → content → message，第一个非空为准。
 *
 * @param {object} partial
 * @returns {string}
 */
function _extractCompleteAnswer(partial) {
  const params = partial?.params ?? null;
  if (params == null) return '';

  const _get = (key) => {
    if (params !== null && typeof params === 'object') {
      return params[key] ?? '';
    }
    return '';
  };

  return _get('answer') || _get('content') || _get('message') || '';
}

// ---- 主入口 ----

/**
 * 流式调用 chat()，同时推送 thought 与（tool=complete 时）终答。
 *
 * @param {object}   chatKwargs          传给 chat() 的参数；本函数强制注入 stream=true
 * @param {object}   agentContext        AgentContext 实例
 * @param {Function} streamCallback      推送回调，签名见 StreamCallback
 * @param {object}   [opts]
 * @param {string|null} [opts.thoughtTitle]      thought 块标题（默认"思考"）
 * @param {string}      [opts.thoughtMsgCategory='thought']  thought 类目
 * @param {string|null} [opts.answerTitle]       answer 块标题（默认"回答"）
 * @param {string}      [opts.answerMsgCategory='final_result'] answer 类目
 * @param {boolean}     [opts.streamFinalAnswer=true]  是否流式推 complete 工具的答案
 * @param {string|null} [opts.callSite]          透传给 chat() 的 call_site
 * @param {Function}    [opts._chat]             可注入的 chat 函数（测试 / 接入用）
 *
 * @returns {Promise<object|null>}  final partial（流式最后一帧；非流式回退时为 chat 返回值）
 */
export async function stream_reasoning(
  chatKwargs,
  agentContext,
  streamCallback,
  {
    thoughtTitle = null,
    thoughtMsgCategory = 'thought',
    answerTitle = null,
    answerMsgCategory = 'final_result',
    streamFinalAnswer = true,
    callSite = null,
    _chat = null,
  } = {},
) {
  if (!chatKwargs?.response_model) {
    throw new Error('stream_reasoning requires response_model in chatKwargs');
  }

  // TODO: 接入真实 chat 函数（与 Python core/llm.chat 对等）
  const chatFn = _chat;
  if (!chatFn) {
    throw new Error(
      'stream_reasoning: _chat 未注入。请在 opts._chat 传入实际的 LLM chat 函数。',
    );
  }

  const kwargs = { ...chatKwargs, stream: true };
  if (callSite && !kwargs.call_site) {
    kwargs.call_site = callSite;
  }

  let thoughtCid = null;
  let answerCid = null;
  let lastThought = '';
  let lastAnswer = '';
  let final = null;

  const tTitle = thoughtTitle !== null ? thoughtTitle : t('思考');
  const aTitle = answerTitle !== null ? answerTitle : t('回答');

  try {
    const streamGen = await chatFn(kwargs);

    // 支持 AsyncIterable（async generator）或普通 iterable
    for await (const partial of streamGen) {
      final = partial;

      // ---- thought 增量推送 ----
      const thought = (partial?.thought ?? '').toString().trim();
      if (thought && thought !== lastThought) {
        const usedCid = await streamCallback(thought, {
          content_id: thoughtCid,
          content_type: 'markdown',
          title: tTitle,
          recall: false,
          msg_category: thoughtMsgCategory,
          replace_content: true,
        });
        if (thoughtCid === null && usedCid) {
          thoughtCid = usedCid;
        }
        lastThought = thought;
      }

      // ---- complete 工具的 params.content 增量推送（终答打字机） ----
      if (!streamFinalAnswer) continue;
      const toolName = (partial?.tool ?? '').toString();
      if (!_COMPLETE_TOOL_NAMES.has(toolName)) continue;

      const answer = _extractCompleteAnswer(partial).trim();
      if (answer && answer !== lastAnswer) {
        const usedCid = await streamCallback(answer, {
          content_id: answerCid,
          content_type: 'markdown',
          title: aTitle,
          recall: true, // 终答需入会话历史
          msg_category: answerMsgCategory,
          replace_content: true,
        });
        if (answerCid === null && usedCid) {
          answerCid = usedCid;
        }
        lastAnswer = answer;
      }
    }
  } catch (err) {
    // 流式失败往上抛，与原 await chat 异常路径一致
    throw err;
  }

  // 非流式回退场景：thought 一次到位没有走流式推送，补一条普通块
  if (!lastThought && final !== null) {
    const thought = (final?.thought ?? '').toString().trim();
    if (thought) {
      const usedCid = await streamCallback(thought, {
        content_type: 'markdown',
        title: tTitle,
        recall: false,
        msg_category: thoughtMsgCategory,
      });
      if (usedCid) {
        thoughtCid = usedCid;
      }
    }
  }

  // 把流式块的 cid 暴露给上层
  if (thoughtCid) {
    agentContext.data[STREAMING_THOUGHT_CID_KEY] = thoughtCid;
  }
  if (answerCid) {
    agentContext.data[STREAMING_FINAL_ANSWER_CID_KEY] = answerCid;
  }

  return final;
}

/**
 * 读取并清除本轮流式 thought 块的 cid 槽位。
 *
 * 上层在 reasoning 末尾根据是否首次问题分解决定是否复用这个 cid 做 replace；
 * 无论是否使用，都应在 reasoning 结束前调用此函数清理槽位，避免泄露给下一轮。
 *
 * @param {object} agentContext
 * @returns {string|null}
 */
export function consume_streaming_thought_cid(agentContext) {
  const cid = agentContext.data[STREAMING_THOUGHT_CID_KEY] ?? null;
  delete agentContext.data[STREAMING_THOUGHT_CID_KEY];
  return cid;
}

/**
 * 读取并清除本轮流式 final answer 块的 cid 槽位。
 *
 * complete 分支在 reasoning 末尾用这个判断是否需要补推完整答案：
 * - 有 cid → 已经流式推过，跳过末尾的 dump-once 路径（或用同 cid replace 一次封口）
 * - 无 cid → 走老路径，一次性 dump 完整答案
 *
 * @param {object} agentContext
 * @returns {string|null}
 */
export function consume_streaming_final_answer_cid(agentContext) {
  const cid = agentContext.data[STREAMING_FINAL_ANSWER_CID_KEY] ?? null;
  delete agentContext.data[STREAMING_FINAL_ANSWER_CID_KEY];
  return cid;
}
