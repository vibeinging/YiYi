// 迁移自 core/agentic_flow/core/summarizer.py

/**
 * 上下文压缩用的 LLM 摘要器。
 *
 * 设计原则：
 * - 结构化 markdown 输出
 * - 强制保留中间表引用、消歧映射、用户硬约束
 * - 失败时抛 SummarizerError，由调用方决定兜底
 *
 * TODO: summarize() 内部的 chat() 调用在 Node 侧尚未接入真实 LLM；
 *       接入时替换 _chat 参数或直接实现 chat 函数。
 */

export class SummarizerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SummarizerError';
  }
}

/**
 * 喂给 Summarizer 的"哪些原文要压、哪些事实必须保留"清单。
 */
export class SummarySpec {
  /**
   * @param {object} opts
   * @param {Array<object>} [opts.messages_to_compact=[]]
   * @param {string}        [opts.current_user_question='']
   * @param {Array<object>} [opts.intermediate_tables=[]]
   * @param {Array<object>} [opts.resolved_entities=[]]
   * @param {Array<object>} [opts.resolved_metrics=[]]
   * @param {Array<string>} [opts.completed_task_titles=[]]
   * @param {Array<string>} [opts.user_constraints=[]]
   * @param {string|null}   [opts.previous_summary=null]
   */
  constructor({
    messages_to_compact = [],
    current_user_question = '',
    intermediate_tables = [],
    resolved_entities = [],
    resolved_metrics = [],
    completed_task_titles = [],
    user_constraints = [],
    previous_summary = null,
  } = {}) {
    this.messages_to_compact = messages_to_compact;
    this.current_user_question = current_user_question;
    this.intermediate_tables = intermediate_tables;
    this.resolved_entities = resolved_entities;
    this.resolved_metrics = resolved_metrics;
    this.completed_task_titles = completed_task_titles;
    this.user_constraints = user_constraints;
    this.previous_summary = previous_summary;
  }
}

// ---- Prompt templates ----

const _INITIAL_TEMPLATE = `以下是一段需要折叠的对话历史。请按下面的固定格式生成 markdown 结构化摘要，
另一个 LLM 会读这份摘要继续工作，**关键事实如果丢失会导致后续推理失败**。

## 当前问题
{current_user_question}

## 已完成的步骤
{completed_tasks_block}

## 必须原样保留的事实
{must_preserve_block}

## 待折叠的对话原文
{conversation_block}

---

请严格按以下 markdown 输出（每个章节都要在，缺信息写"(无)"）。**所有"必须原样保留的事实"
里列出的中间表完整名（如 \`intermediate_xxx.r_abcd\`）、实体/指标映射，都必须原文出现在
"## 关键事实"段，不得改写、缩写、合并。**

## 目标
[用户在做什么；可多条]

## 约束
- [用户提出的硬约束，比如"只看 2024 年"、"按部门分组"]
- [无则写 "(无)"]

## 进展
### 已完成
- [x] [简述每个已完成步骤的产出]

### 待继续
- [ ] [当前正在做、尚未完成的事]

## 关键决策
- **决策**: 理由

## 关键事实（不要省略）
- 中间表 \`intermediate_xxx.r_*\`: <列名> <行数> <来源子问题>
- 实体消歧: "<原文片段>" → <实体名> (来源)
- 指标消歧: ...

## 下一步建议
1. [基于现状，下一步应该做什么]
`;

const _UPDATE_TEMPLATE = `这是已有的对话历史摘要，以及一批新发生的对话原文。
请把新内容**合并进**已有摘要，更新进展、补充新事实，**绝不删除旧摘要中的关键事实**（中间表、消歧映射）。

## 已有摘要
<previous-summary>
{previous_summary}
</previous-summary>

## 当前问题
{current_user_question}

## 新发生的对话原文
{conversation_block}

## 新增的必须保留事实
{must_preserve_block}

---

请按"## 目标 / ## 约束 / ## 进展 / ## 关键决策 / ## 关键事实 / ## 下一步建议"格式输出更新后的完整摘要。
合并规则：
- ## 目标 / ## 约束：保留旧的，必要时追加新的
- ## 进展：把旧的"待继续"在新内容里完成的转到"已完成"
- ## 关键事实：旧事实 **全部保留** + 追加新事实
`;

/**
 * 组装首次生成摘要的 prompt。
 * @param {SummarySpec} spec
 * @returns {string}
 */
export function build_initial_summary_prompt(spec) {
  const completedTasksBlock = spec.completed_task_titles.length
    ? spec.completed_task_titles.map((t) => `- ${t}`).join('\n')
    : '(无)';
  const mustPreserveBlock = _renderMustPreserve(spec);
  const conversationBlock = _renderConversation(spec.messages_to_compact);
  return _INITIAL_TEMPLATE
    .replace('{current_user_question}', spec.current_user_question || '(未指定)')
    .replace('{completed_tasks_block}', completedTasksBlock)
    .replace('{must_preserve_block}', mustPreserveBlock)
    .replace('{conversation_block}', conversationBlock);
}

/**
 * 组装增量更新摘要的 prompt（previous_summary 必须非空）。
 * @param {SummarySpec} spec
 * @returns {string}
 */
export function build_update_summary_prompt(spec) {
  if (!spec.previous_summary) {
    throw new Error('build_update_summary_prompt requires spec.previous_summary');
  }
  const mustPreserveBlock = _renderMustPreserve(spec);
  const conversationBlock = _renderConversation(spec.messages_to_compact);
  return _UPDATE_TEMPLATE
    .replace('{previous_summary}', spec.previous_summary)
    .replace('{current_user_question}', spec.current_user_question || '(未指定)')
    .replace('{conversation_block}', conversationBlock)
    .replace('{must_preserve_block}', mustPreserveBlock);
}

/**
 * 调一次 chat 模型生成结构化摘要。
 *
 * @param {SummarySpec} spec
 * @param {object}      [opts]
 * @param {string|null} [opts.model_id]
 * @param {string|null} [opts.project_id]
 * @param {string|null} [opts.user_id]
 * @param {number}      [opts.max_tokens=4096]
 * @param {Function}    [opts._chat]  可注入的 chat 函数（测试 / 接入用）
 * @returns {Promise<string>}
 * @throws {SummarizerError}
 */
export async function summarize(
  spec,
  {
    model_id = null,
    project_id = null,
    user_id = null,
    max_tokens = 4096,
    _chat = null,
  } = {},
) {
  const prompt = spec.previous_summary
    ? build_update_summary_prompt(spec)
    : build_initial_summary_prompt(spec);

  // TODO: 接入真实 chat 函数（与 Python core/llm.chat 对等）
  const chatFn = _chat;
  if (!chatFn) {
    throw new SummarizerError(
      'summarize: _chat 未注入。请在 opts._chat 传入实际的 LLM chat 函数。',
    );
  }

  const chatKwargs = {
    messages: prompt,
    temperature: 0.2,
    max_tokens,
    clean_thinking_tags: true,
    call_site: 'summarizer',
  };
  if (model_id) chatKwargs.model_id = model_id;
  if (project_id) chatKwargs.project_id = project_id;
  if (user_id) chatKwargs.user_id = user_id;

  let result;
  try {
    result = await chatFn(chatKwargs);
  } catch (e) {
    console.error(`[Summarizer] LLM 调用失败: ${e?.message}`);
    throw new SummarizerError(`摘要 LLM 调用失败: ${e?.message}`);
  }

  if (typeof result !== 'string') {
    throw new SummarizerError(
      `摘要返回类型异常（期望 string，得到 ${typeof result}）`,
    );
  }
  const text = result.trim();
  if (!text) {
    throw new SummarizerError('摘要返回为空');
  }
  if (!text.includes('##')) {
    console.warn(`[Summarizer] 摘要未包含章节标记，可能格式异常: ${text.slice(0, 200)}`);
  }
  return text;
}

// ============== 内部辅助 ==============

/**
 * 把 must_preserve 系列字段渲染成事实清单。
 * @param {SummarySpec} spec
 * @returns {string}
 */
function _renderMustPreserve(spec) {
  const lines = [];

  if (spec.intermediate_tables.length) {
    lines.push('### 中间表（保留完整名称、列、来源子问题）');
    for (const tbl of spec.intermediate_tables) {
      const name = tbl.name ?? '?';
      const subQ = tbl.sub_query ?? '';
      const cols = tbl.columns ?? [];
      const rows = tbl.row_count;
      const colStr = cols.length ? `列: ${cols.map(String).join(', ')}` : '';
      const rowStr = rows != null ? `${rows} 行` : '';
      const meta = [colStr, rowStr].filter(Boolean).join(' | ');
      lines.push(`- \`${name}\` ← "${subQ}"` + (meta ? `（${meta}）` : ''));
    }
  }

  if (spec.resolved_entities.length) {
    lines.push('\n### 已解决的实体消歧');
    for (const e of spec.resolved_entities) {
      const frag = e.matched_fragment ?? e.original_text ?? '';
      const name = e.entity_name ?? e.entity_value ?? '?';
      lines.push(`- "${frag}" → ${name}`);
    }
  }

  if (spec.resolved_metrics.length) {
    lines.push('\n### 已解决的指标消歧');
    for (const m of spec.resolved_metrics) {
      const frag = m.matched_fragment ?? '';
      const name = m.name ?? '?';
      lines.push(`- "${frag}" → ${name}`);
    }
  }

  if (spec.user_constraints.length) {
    lines.push('\n### 用户硬约束');
    for (const c of spec.user_constraints) {
      lines.push(`- ${c}`);
    }
  }

  return lines.length ? lines.join('\n') : '(无)';
}

/**
 * 把要折叠的原文渲染成简洁可读的形式，喂给 LLM。
 * @param {Array<object>} messages
 * @returns {string}
 */
function _renderConversation(messages) {
  const lines = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      lines.push(String(m));
      continue;
    }
    // tool_history 形态
    if ('tool' in m && 'result' in m) {
      const tool = m.tool ?? '?';
      const success = m.success ? '✅' : '❌';
      const thought = m.thought ?? '';
      const resultStr = _truncate(String(m.result), 800);
      let line = `[${success} ${tool}]`;
      if (thought) line += ` 思考: ${_truncate(thought, 200)}`;
      line += `\n  结果: ${resultStr}`;
      lines.push(line);
      continue;
    }
    // 标准 message 形态
    const role = m.role ?? '?';
    let content = m.content ?? '';
    if (Array.isArray(content)) {
      content = content
        .map((b) => {
          if (b && typeof b === 'object') return b.text ?? b.content ?? '';
          return String(b);
        })
        .join(' ');
    }
    lines.push(`[${role}] ${_truncate(String(content), 1200)}`);
  }
  return lines.join('\n\n');
}

/** @param {string} s @param {number} limit */
function _truncate(s, limit) {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '...(截断)';
}
