// 迁移自 backend/yiw_kernel/data_analyze/planner/dbagents/agents/format_agent.py
//
// Format Agent - 数据可视化展示 Agent
//
// - 输入：format_context（统一的子任务数据上下文）
// - 输出：CompoundResponse（blocks 列表），一套逻辑处理所有场景
// - 单步/多步查询统一处理，不区分
//
// 迁移说明：
// - Step 2 起 class FormatAgent 不再 extends BaseAgent，改为普通 class；
//   对外暴露 async run(agent_context, stream_callback) 直接返回 params dict（原
//   reasoning() 返回 {type:'complete', params} 的 params 部分），出错抛异常。
//   register_agent('format')(FormatAgent) 注册名不变。原继承的 _push_in_place_status
//   改用 agent_helpers.js 的 pushInPlaceStatus 自由函数。
// - class FormatAgent extends BaseAgent；@register_agent('format') → register_agent('format')(FormatAgent)。
// - pydantic BaseModel（FormatBlock / CompoundResponse）→ 普通 class，保留 fromJSON（供
//   llm.js response_model 约定）、model_dump()（供 _build_compound_action 序列化）。
// - chat(messages=..., system_message=..., response_model=..., stream=...) →
//   chat(messages, {system_message, response_model, stream, ...})。
// - 流式 typed chat 的 partial 是「普通 JS 对象」（llm.js _chatTypedStream yield 的是
//   JSON.parse 结果，非类实例）；这里统一 CompoundResponse.fromJSON 包一层，保证
//   partial.blocks 是 FormatBlock 实例（block.display_type / block.content 访问一致）。
// - StreamCallback：以 (content, optionsObject) 形式调用（BaseAgent 港注约定），
//   Python 的 content_type=... title=... 等 kwarg → JS 第二参数对象字段。
// - f-string → 模板串；datetime.now().isoformat() → new Date().toISOString()
//   （被迁移产物运行时可用 new Date，仅 workflow 脚本禁用）；logging → console（保留 emoji）。
// - 图表类型选择 / 格式化输出结构是前端展示质量关键，逐字迁移、未简化。

import {
  buildKeywordMap,
  buildDisplayOptions,
  getVisualChartTypeIds,
  getChartLabel,
  getAllChartTypeIds,
} from '../tools/chart_types.js';
import { AgentSettings } from '../tools/agent_settings.js';
import { AgentContext } from '../core/agent_context.js'; // eslint-disable-line no-unused-vars
import { chat } from '../core/llm.js';
import { BaseAgent } from '../core/base_agent.js';
import { t } from '../utils/i18n.js';
import { pushInPlaceStatus } from './agent_helpers.js';

/** 轻量 logger（对应 Python logging.getLogger(__name__)，保留 emoji 日志行） */
const logger = {
  error: (...args) => console.error('[format_agent]', ...args),
  warn: (...args) => console.warn('[format_agent]', ...args),
  warning: (...args) => console.warn('[format_agent]', ...args),
  info: (...args) => console.info('[format_agent]', ...args),
  debug: (...args) => console.debug('[format_agent]', ...args),
};

// LLMConfig 常量（对应 backend/config/constants.py LLMConfig；Node 侧尚未迁移
// 该枚举，按 Python 原值就地定义，下游接入统一 config 后可替换）。
const LLMConfig = {
  TEMPERATURE_NORMAL: 0.3, // 正常温度（格式化、描述生成）
  MAX_TOKENS_VERY_LONG: 4000, // 很长输出（格式化、计算）
};

// Markdown 块级前缀（标题/引用/列表/代码围栏/表格）正则：单行纯文本加粗时用于规避破坏 md。
const MARKDOWN_BLOCK_PREFIX_RE = /^\s*(?:#{1,6}\s|>\s|[-*+]\s|\d+[.)]\s|```|~~~|\|)/;

/**
 * 判断列名是否为 ID 类字段（不适合作为图表轴）。
 * @param {string} col_name
 * @returns {boolean}
 */
function _is_id_like(col_name) {
  const lower = String(col_name).toLowerCase().trim();
  return ['id', 'pk', 'index', 'row_number'].includes(lower) || lower.endsWith('_id');
}

// ============== 数据模型 ==============

/**
 * FormatBlock - 单个展示块（对应 Python pydantic FormatBlock）。
 */
export class FormatBlock {
  /**
   * @param {object} opts
   * @param {string} opts.display_type        展示类型: line/bar/pie/table/text/...
   * @param {string} opts.title               标题
   * @param {string} [opts.content='']        文本内容（display_type=text 时必填）
   * @param {string|null} [opts.x_axis_field=null]    X 轴字段（类别轴）
   * @param {string[]|null} [opts.y_axis_fields=null] Y 轴字段（数值轴，可多个）
   * @param {string|null} [opts.group_field=null]     分组字段（堆叠图/分组图）
   * @param {string} [opts.data_source='sub_task_0']  数据来源索引
   */
  constructor({
    display_type,
    title,
    content = '',
    x_axis_field = null,
    y_axis_fields = null,
    group_field = null,
    data_source = 'sub_task_0',
  } = {}) {
    this.display_type = display_type;
    this.title = title;
    this.content = content ?? '';
    this.x_axis_field = x_axis_field ?? null;
    this.y_axis_fields = y_axis_fields ?? null;
    this.group_field = group_field ?? null;
    this.data_source = data_source ?? 'sub_task_0';
  }

  /**
   * 从普通对象构造 FormatBlock（容忍缺省字段，对齐 pydantic 默认值）。
   * @param {object} [obj={}]
   * @returns {FormatBlock}
   */
  static fromJSON(obj = {}) {
    if (obj instanceof FormatBlock) return obj;
    const o = obj || {};
    return new FormatBlock({
      display_type: o.display_type,
      title: o.title,
      content: o.content ?? '',
      x_axis_field: o.x_axis_field ?? null,
      y_axis_fields: o.y_axis_fields ?? null,
      group_field: o.group_field ?? null,
      data_source: o.data_source ?? 'sub_task_0',
    });
  }

  /**
   * 序列化为普通对象（对应 pydantic model_dump）。
   * @returns {object}
   */
  model_dump() {
    return {
      display_type: this.display_type,
      title: this.title,
      content: this.content,
      x_axis_field: this.x_axis_field,
      y_axis_fields: this.y_axis_fields,
      group_field: this.group_field,
      data_source: this.data_source,
    };
  }
}

/**
 * CompoundResponse - FormatAgent 统一输出模型（对应 Python pydantic CompoundResponse）。
 */
export class CompoundResponse {
  /**
   * @param {object} opts
   * @param {Array<FormatBlock|object>} [opts.blocks=[]] 展示块列表，按展示顺序排列
   */
  constructor({ blocks = [] } = {}) {
    this.blocks = (blocks || []).map((b) => FormatBlock.fromJSON(b));
  }

  /** llm.js response_model 约定：类名（用于 schema hint）。 */
  static get name() {
    return 'CompoundResponse';
  }

  /** llm.js response_model 约定：JSON Schema 提示。 */
  static get schema() {
    return {
      properties: {
        blocks: {
          type: 'array',
          description: '展示块列表，按展示顺序排列',
        },
      },
      required: ['blocks'],
    };
  }

  /**
   * 从普通对象构造（llm.js typed chat 用此把 JSON → 模型实例）。
   * @param {object} [parsed={}]
   * @returns {CompoundResponse}
   */
  static fromJSON(parsed = {}) {
    if (parsed instanceof CompoundResponse) return parsed;
    const p = parsed || {};
    return new CompoundResponse({ blocks: Array.isArray(p.blocks) ? p.blocks : [] });
  }
}

/**
 * 格式化 Agent - 统一上下文 + 复合输出
 *
 * 逻辑：
 * 1. 用户明确要求某种格式 → 关键词匹配，直接构建单块 CompoundResponse
 * 2. 用户没明确要求 → LLM 决策，返回 CompoundResponse（可能多个块）
 * 3. LLM 返回空 blocks → 询问用户选择展示类型
 */
export class FormatAgent extends BaseAgent {
  static _FORMAT_PROGRESS_CID_KEY = '_format_display_progress_content_id';

  constructor() {
    super({ name: 'FormatAgent', description: '将查询结果进行可视化展示' });
  }

  // 展示类型选项（ask_user 时使用）
  // 注意：不能在类级别调用 t()，因为此时请求语言上下文 ContextVar 尚未设置
  // 改为 getter，在请求处理时动态生成，确保翻译正确
  get DISPLAY_TYPE_OPTIONS() {
    return buildDisplayOptions(t);
  }

  // 展示类型关键词映射（从 chart_types 注册表生成，扩展类型优先匹配）
  get DISPLAY_TYPE_KEYWORDS() {
    return FormatAgent._DISPLAY_TYPE_KEYWORDS;
  }

  /**
   * @param {AgentContext} agent_context
   * @param {Function|null} stream_callback
   * @param {string} body
   * @param {string} title
   * @returns {Promise<void>}
   */
  async _push_format_progress_status(agent_context, stream_callback, body, title) {
    await pushInPlaceStatus(agent_context, stream_callback, {
      cid_key: FormatAgent._FORMAT_PROGRESS_CID_KEY,
      content: body,
      title,
    });
  }

  /**
   * 收尾：把同一个 cid 的最后状态改成完成态，并清理上下文键（释放 cid 槽位，
   * 下一轮 ask_user 不会复用旧块）。
   *
   * @param {AgentContext} agent_context
   * @param {Function|null} stream_callback
   * @param {string|null} [done_message=null]
   * @returns {Promise<void>}
   */
  async _finalize_format_progress_status(agent_context, stream_callback, done_message = null) {
    if (!stream_callback || !(FormatAgent._FORMAT_PROGRESS_CID_KEY in agent_context.data)) {
      return;
    }
    await pushInPlaceStatus(agent_context, stream_callback, {
      cid_key: FormatAgent._FORMAT_PROGRESS_CID_KEY,
      content: done_message || t('展示方式已确定'),
      title: t('格式化展示'),
    });
    delete agent_context.data[FormatAgent._FORMAT_PROGRESS_CID_KEY];
  }

  /**
   * 判断采样行里是否存在数值列（int/float，排除 bool）。
   * @param {object} sample_row
   * @returns {boolean}
   */
  static _has_numeric_column(sample_row) {
    if (!sample_row || typeof sample_row !== 'object' || Array.isArray(sample_row)) {
      return false;
    }
    for (const v of Object.values(sample_row)) {
      if (typeof v === 'boolean') continue;
      if (typeof v === 'number') return true;
    }
    return false;
  }

  /**
   * 规则判断：是否应该直接走 table/text，跳过 LLM 决策。
   *
   * 命中以下条件之一 → 不画图（"data + 意图"明确不适合可视化）：
   * - 用户消息含"列出/给我/有哪些/名单/明细"等列表意图关键词 → table
   * - 数据是单值/单行单列 → text
   * - 数据全文本无数值列 → table（图没东西可画）
   * - 数据 > 50 行 → table（chart 太挤反而看不清）
   *
   * 否则返回 null，交由后续 LLM 决策（chart 类型选择 / table+text 复合）。
   *
   * @param {string} user_message
   * @param {Array<object>} sub_tasks
   * @returns {string|null}
   */
  _should_skip_chart_llm(user_message, sub_tasks) {
    if (!sub_tasks || !sub_tasks.length) {
      return null;
    }

    // (1) 用户意图：明确要"列出/明细" → 直接 table
    const msg_lower = (user_message || '').toLowerCase();
    if (FormatAgent._LIST_INTENT_KEYWORDS.some((kw) => msg_lower.includes(kw))) {
      logger.info('[Format] 规则命中：用户明确要列表/明细 → table（跳过 LLM）');
      return 'table';
    }

    // (2) 看主数据集（最后一个 sub_task，跟现有路径一致）形态
    const main_task = sub_tasks[sub_tasks.length - 1];
    const rows = main_task.row_count || 0;
    const columns = main_task.columns || [];
    const sample = main_task.sample || main_task.data || [];

    // 单值答案（如"banks 多少张表" → 11）
    if (rows <= 1 && columns.length <= 1) {
      logger.info(`[Format] 规则命中：单值答案 rows=${rows} cols=${columns.length} → text（跳过 LLM）`);
      return 'text';
    }

    // 数据采样：判断是否存在数值列
    if (sample && Array.isArray(sample) && sample[0] && typeof sample[0] === 'object' && !Array.isArray(sample[0])) {
      if (!FormatAgent._has_numeric_column(sample[0])) {
        logger.info('[Format] 规则命中：无数值列，无法构图 → table（跳过 LLM）');
        return 'table';
      }
    }

    // 数据量大：图太挤，不如直接表格分页查看
    if (rows > 50) {
      logger.info(`[Format] 规则命中：行数 ${rows} > 50 → table（跳过 LLM）`);
      return 'table';
    }

    // 模糊场景：交给 LLM 决策
    return null;
  }

  /**
   * 副模型兜底：非流式 + 低 token，失败返回 null（调用方降级 table）。
   *
   * @param {string} question
   * @param {object} format_context
   * @param {AgentContext} agent_context
   * @returns {Promise<CompoundResponse|null>}
   */
  async _decide_by_sub_model(question, format_context, agent_context) {
    try {
      const config = await this._build_format_config(question, format_context, agent_context);
      const result = await chat(config.user_prompt, {
        system_message: config.system_prompt,
        project_id: agent_context.project_id,
        model_role: 'secondary',
        response_model: CompoundResponse,
        stream: false,
        temperature: 0.0,
        max_tokens: LLMConfig.MAX_TOKENS_VERY_LONG,
        call_site: 'format_sub_model',
      });
      return CompoundResponse.fromJSON(result);
    } catch (e) {
      logger.warning(`[Format] 副模型判断失败: ${e?.message ?? e}，降级为 table`);
      return null;
    }
  }

  /**
   * 通过关键词快速检测一个或多个展示类型，按在问题中的出现顺序返回。
   * @param {string} question
   * @returns {string[]}
   */
  _detect_display_types_by_keyword(question) {
    if (!question) {
      return [];
    }

    const question_lower = question.toLowerCase();
    const matched_positions = [];
    for (const [display_type, keywords] of Object.entries(this.DISPLAY_TYPE_KEYWORDS)) {
      let first_pos = null;
      for (const keyword of keywords) {
        const pos = question_lower.indexOf(keyword.toLowerCase());
        if (pos >= 0 && (first_pos === null || pos < first_pos)) {
          first_pos = pos;
        }
      }
      if (first_pos !== null) {
        matched_positions.push([first_pos, display_type]);
      }
    }

    matched_positions.sort((a, b) => a[0] - b[0]);
    const detected_types = matched_positions.map(([, display_type]) => display_type);
    if (detected_types.length) {
      logger.info(`[Format] 关键词匹配到展示类型: ${JSON.stringify(detected_types)}`);
      if (detected_types.length > 1) {
        logger.info(`[Format] 检测到多个展示类型，按问题出现顺序生成多个 block: ${JSON.stringify(detected_types)}`);
      }
    }
    return detected_types;
  }

  // ============== 核心方法 ==============

  /**
   * 统一处理 format_context，输出 CompoundResponse（原 reasoning，改为纯函数返回）。
   *
   * 决策分三层（依次命中即短路）：
   *   Step 1  关键词匹配 — 用户明确说了图类型（折线图/柱状图…）→ 直接用
   *   Step 2  跳过规则   — 单值/全文本/列表意图/50+行 → table/text
   *   Step 3  副模型决策 — 其余场景交副模型（结合用户问题语义选图类型 + 轴字段，
   *                      非流式，失败降级 table）。副模型是小模型、延迟低，
   *                      比纯规则更能贴合用户意图（"对比"→bar / "趋势"→line）。
   *
   * @param {AgentContext} agent_context
   * @param {Function|null} stream_callback
   * @returns {Promise<{blocks: Array<object>, metadata: object}>}
   * @throws {Error} 缺少 format_context 或无 sub_tasks
   */
  async run(agent_context, stream_callback) {
    logger.info('[Format] 开始生成可视化展示');

    const format_context = agent_context.input_data.format_context;
    const user_message = agent_context.input_data.user_message ?? '';

    if (!format_context) {
      throw new Error('缺少 format_context');
    }

    const sub_tasks = format_context.sub_tasks ?? [];
    if (!sub_tasks.length) {
      throw new Error('format_context 中没有 sub_tasks');
    }

    const metric_view_summary = FormatAgent._summarize_metric_view_usage(format_context);

    // 直接交副模型决策（小模型、延迟低）：一次调用同时产出
    //   display_type + 轴字段绑定（x/y/group）+ 贴合用户问题语义。
    // 不走"关键词匹配"——它只能给出 display_type，给不了"图表与数据列的绑定"：
    // 用户说"折线图"，但哪列做 x 轴、哪些列做 y 轴仍必须看数据才能定。只有副模型
    // 能把（用户意图 + 数据样本）一次映射成（display_type + 轴字段）的完整结果。
    if (stream_callback && !FormatAgent._isNonEmpty(metric_view_summary)) {
      const total_rows = sub_tasks.reduce((acc, task) => acc + task.row_count, 0);
      await this._push_format_progress_status(
        agent_context,
        stream_callback,
        t('查询到 {} 条数据，正在分析展示方式...', total_rows),
        t('结果展示'),
      );
    }

    const sub_response = await this._decide_by_sub_model(user_message, format_context, agent_context);
    let response;
    if (sub_response && sub_response.blocks && sub_response.blocks.length) {
      response = sub_response;
    } else {
      logger.info('[Format] 副模型未返回有效 blocks，降级为 table');
      response = this._build_detected_response('table', user_message, sub_tasks);
    }

    // 检测「用户明确要求的图类型」是否被系统替换（如要饼图但数据是时间序列→折线图）。
    // 若替换，给对应展示块附黄色提示（前端 content-hint 用 fallback_hint 字段渲染黄色警示）。
    const [substitution_hint, substituted_block] = this._detect_chart_substitution(user_message, response);

    // 统一推送路径（所有决策分支共用）
    const metric_view_metadata = FormatAgent._build_metric_view_metadata(metric_view_summary);

    if (stream_callback && !FormatAgent._isNonEmpty(metric_view_summary)) {
      await this._finalize_format_progress_status(agent_context, stream_callback);
    }

    await this._push_question_header(user_message, metric_view_metadata, stream_callback);
    for (const block of response.blocks) {
      const block_data = this._resolve_block_data(block, format_context);
      const hint = block === substituted_block ? substitution_hint : null;
      await this._push_block_to_frontend(block, block_data, metric_view_metadata, stream_callback, {
        substitution_hint: hint,
      });
    }

    return this._build_compound_action(response, format_context, user_message, metric_view_summary);
  }

  /**
   * 检测用户明确要求的图类型是否被系统替换为其它形态。
   *
   * 返回 [提示文案, 被替换的展示块]；未发生替换则 [null, null]。
   * 仅在用户问题里明确指定了某一图类型（关键词命中）、且实际展示块的类型
   * 与之不同时触发——这是"系统没完全听用户的"的可解释场景，前端渲染黄色警示。
   *
   * @param {string} user_message
   * @param {CompoundResponse} response
   * @returns {[string|null, FormatBlock|null]}
   */
  _detect_chart_substitution(user_message, response) {
    if (!response || !response.blocks || !response.blocks.length) {
      return [null, null];
    }
    const requested = this._detect_display_types_by_keyword(user_message);
    if (!requested.length) {
      return [null, null];
    }
    const req_type = requested[0];
    // 取第一个非文本展示块（chart / table）作为对比对象
    const target = response.blocks.find((b) => b.display_type !== 'text') ?? null;
    if (!target || target.display_type === req_type) {
      return [null, null];
    }
    const hint = t(
      '您要求的「{}」不适合当前数据形态，已自动改用「{}」展示。',
      t(getChartLabel(req_type)),
      t(getChartLabel(target.display_type)),
    );
    return [hint, target];
  }

  // ============== 核心生成方法 ==============

  /**
   * 一次 LLM 调用，返回 CompoundResponse（非流式，备用路径）。
   *
   * @param {string} question
   * @param {object} format_context
   * @param {AgentContext} agent_context
   * @returns {Promise<CompoundResponse>}
   */
  async _generate_compound_feedback(question, format_context, agent_context) {
    const config = await this._build_format_config(question, format_context, agent_context);
    const response = await chat(config.user_prompt, {
      system_message: config.system_prompt,
      project_id: agent_context.project_id,
      model_id: config.model_id,
      response_model: CompoundResponse,
      temperature: LLMConfig.TEMPERATURE_NORMAL,
      max_tokens: LLMConfig.MAX_TOKENS_VERY_LONG,
      call_site: 'format_compound',
    });
    return CompoundResponse.fromJSON(response);
  }

  /**
   * 构建 format LLM 的 prompt config（流式/非流式共用）。
   *
   * @param {string} question
   * @param {object} format_context
   * @param {AgentContext} agent_context
   * @returns {Promise<{system_prompt: string, user_prompt: string, model_id: string|null}>}
   */
  async _build_format_config(question, format_context, agent_context) {
    const sub_tasks = format_context.sub_tasks;
    let tasks_desc = '';
    for (let i = 0; i < sub_tasks.length; i++) {
      const task = sub_tasks[i];
      const col_names = task.columns.map((c) =>
        typeof c === 'string' ? c : c.column_name ?? String(c),
      );
      const sample_str = this._serialize_data_for_llm((task.sample || []).slice(0, 10));
      tasks_desc += `### sub_task_${i}: ${task.sub_question}\n`;
      tasks_desc += `- 列: ${col_names.join(', ')}\n`;
      tasks_desc += `- 行数: ${task.row_count}\n`;
      tasks_desc += `- 数据来源类型: ${task.source_type ?? 'database_connection'}\n`;
      tasks_desc += `- 数据样本:\n${sample_str}\n\n`;
    }

    return AgentSettings.getFormatConfig(agent_context.project_id, {
      businessId: agent_context.input_data.business_id,
      question,
      tasksDescription: tasks_desc,
      subTaskCount: sub_tasks.length,
    });
  }

  /**
   * 流式生成 CompoundResponse 并实时推送 block 到前端。
   *
   * 策略：
   * - 图表/表格类（display_type 非 text）：等下一个 block 出现或流结束时整块一次推送。
   * - 文本类（display_type == text）：用同一 content_id + replace_content 打字机式流式更新。
   *
   * Note: 与 _generate_compound_feedback 的关键差异是：本方法同时承担"推送 blocks"
   * 和"推送 question_header"职责；调用方在 LLM 路径下不应再重复推送。
   *
   * @param {string} question
   * @param {object} format_context
   * @param {AgentContext} agent_context
   * @param {Function|null} stream_callback
   * @param {object} metric_view_metadata
   * @param {object} metric_view_summary
   * @param {string} user_message
   * @returns {Promise<CompoundResponse>}
   */
  async _stream_compound_feedback_and_push(
    question,
    format_context,
    agent_context,
    stream_callback,
    metric_view_metadata,
    metric_view_summary,
    user_message,
  ) {
    const config = await this._build_format_config(question, format_context, agent_context);

    // 每个 block 的流式状态：
    //   index -> {content_id, is_text, finalized, last_block}
    // last_block 保留"最近一次见到的 block 实例"，用于 partial 中途 regress
    // （blocks 数组变短）时收尾——final_blocks 不再包含该 idx 也能 finalize。
    /** @type {Object<number, {content_id: string|null, is_text: boolean, finalized: boolean, last_block: FormatBlock|null}>} */
    const block_states = {};
    let header_pushed = false;
    let progress_finalized = false;
    /** @type {CompoundResponse|null} */
    let last_partial = null;

    const ensure_header = async () => {
      if (header_pushed) {
        return;
      }
      if (stream_callback && !FormatAgent._isNonEmpty(metric_view_summary) && !progress_finalized) {
        await this._finalize_format_progress_status(agent_context, stream_callback);
        progress_finalized = true;
      }
      await this._push_question_header(user_message, metric_view_metadata, stream_callback);
      header_pushed = true;
    };

    const push_text_partial = async (idx, block) => {
      // 文本块的中间态：复用 content_id + replace_content 持续覆盖
      let state = block_states[idx];
      if (state === undefined) {
        // 预生成 content_id：避免 stream_callback 异常返回 None 导致后续
        // update 用不上稳定 ID（每次都自动生成新 ID → 文本碎成多块）
        const cid = stream_callback ? stream_callback.create_content_id() : null;
        block_states[idx] = {
          content_id: cid,
          is_text: true,
          finalized: false,
          last_block: block,
        };
        state = block_states[idx];
      } else {
        state.last_block = block;
      }
      const block_data = this._resolve_block_data(block, format_context);
      await this._push_block_to_frontend(block, block_data, metric_view_metadata, stream_callback, {
        content_id: state.content_id,
        replace_content: true,
        is_partial: true,
      });
    };

    const finalize_block = async (idx, block) => {
      // block 最终态推送（含截断提示、加粗等）
      const state = block_states[idx];
      if (state && state.finalized) {
        return;
      }
      const block_data = this._resolve_block_data(block, format_context);
      if (state && state.is_text) {
        // 文本：复用 content_id 做最后一次完整 replace
        await this._push_block_to_frontend(block, block_data, metric_view_metadata, stream_callback, {
          content_id: state.content_id,
          replace_content: true,
          is_partial: false,
        });
      } else {
        // 图表/表格：第一次也是最后一次推送
        const cid = await this._push_block_to_frontend(block, block_data, metric_view_metadata, stream_callback, {
          is_partial: false,
        });
        block_states[idx] = {
          content_id: cid,
          is_text: false,
          finalized: true,
          last_block: block,
        };
      }
      if (idx in block_states) {
        block_states[idx].finalized = true;
        block_states[idx].last_block = block;
      }
    };

    // chat() 是 async function，stream=true + response_model 分支 return 一个
    // AsyncGenerator；必须先 await 拿到 AsyncGenerator 才能 for await。
    const stream_gen = await chat(config.user_prompt, {
      system_message: config.system_prompt,
      project_id: agent_context.project_id,
      model_id: config.model_id,
      response_model: CompoundResponse,
      stream: true,
      temperature: LLMConfig.TEMPERATURE_NORMAL,
      max_tokens: LLMConfig.MAX_TOKENS_VERY_LONG,
      call_site: 'format_compound_stream',
    });

    for await (const partial_raw of stream_gen) {
      // llm.js typed-stream yield 的是普通对象，统一包成 CompoundResponse，
      // 保证 partial.blocks 是 FormatBlock 实例。
      const partial = CompoundResponse.fromJSON(partial_raw);
      last_partial = partial;
      const blocks = [...(partial.blocks || [])];
      if (!blocks.length) {
        continue;
      }
      await ensure_header();

      // 1) 倒数第二之前的 block 一定 done（后面已经出现了新 block）
      for (let i = 0; i < blocks.length - 1; i++) {
        if (!(block_states[i] && block_states[i].finalized)) {
          await finalize_block(i, blocks[i]);
        }
      }

      // 2) 最后一个 block：仅文本类做打字机增量推送，图表等流结束
      const last_idx = blocks.length - 1;
      const last_block = blocks[last_idx];
      if (last_block.display_type === 'text' && (last_block.content || '')) {
        if (!(block_states[last_idx] && block_states[last_idx].finalized)) {
          await push_text_partial(last_idx, last_block);
        }
      }
    }

    // 流结束：收尾所有"曾经出现过"的 block index（不只 final_blocks），
    // 防止 partial 中途 regress（blocks 变短）导致某个已 partial 推送的块永远停在 is_partial 态。
    const final_blocks = last_partial ? [...(last_partial.blocks || [])] : [];
    const index_set = new Set();
    for (const k of Object.keys(block_states)) {
      index_set.add(Number(k));
    }
    for (let i = 0; i < final_blocks.length; i++) {
      index_set.add(i);
    }
    const all_indices = [...index_set].sort((a, b) => a - b);
    if (all_indices.length) {
      await ensure_header();
    }
    for (const i of all_indices) {
      if (block_states[i] && block_states[i].finalized) {
        continue;
      }
      // 优先用 final_blocks 里的版本（信息最全）；否则 fallback 到 state.last_block
      const block =
        i < final_blocks.length ? final_blocks[i] : (block_states[i] && block_states[i].last_block) || null;
      if (block === null || block === undefined) {
        continue;
      }
      await finalize_block(i, block);
    }

    return last_partial || new CompoundResponse({ blocks: [] });
  }

  /**
   * 用户明确指定展示类型时，不调 LLM，直接构建 CompoundResponse。
   *
   * @param {string|string[]} detected_type
   * @param {string} user_message
   * @param {Array<object>} sub_tasks
   * @returns {CompoundResponse}
   */
  _build_detected_response(detected_type, user_message, sub_tasks) {
    const title = user_message.length > 50 ? `${user_message.slice(0, 50)}...` : user_message;
    const detected_types = Array.isArray(detected_type) ? detected_type : [detected_type];
    const title_map = {
      line: t('趋势图'),
      bar: t('柱状图'),
      pie: t('占比图'),
      table: t('详细数据表'),
      text: t('分析总结'),
    };
    const blocks = detected_types.map(
      (item) =>
        new FormatBlock({
          display_type: item,
          title: detected_types.length === 1 ? title : title_map[item] ?? title,
          data_source: `sub_task_${sub_tasks.length - 1}`,
        }),
    );
    return new CompoundResponse({ blocks });
  }

  // ============== 数据解析与推送 ==============

  /**
   * 根据 block.data_source 获取对应的数据（最多 500 行）。
   *
   * @param {FormatBlock} block
   * @param {object} format_context
   * @returns {object}
   */
  _resolve_block_data(block, format_context) {
    const sub_tasks = format_context.sub_tasks;
    if (block.data_source.startsWith('sub_task_')) {
      let idx;
      const last_sep = block.data_source.lastIndexOf('_');
      const parsed = parseInt(block.data_source.slice(last_sep + 1), 10);
      idx = Number.isNaN(parsed) ? -1 : parsed;
      if (idx >= 0 && idx < sub_tasks.length) {
        const task = sub_tasks[idx];
        return {
          data: task.data,
          columns: task.columns,
          row_count: task.row_count,
          truncated: task.truncated ?? false,
          source_type: task.source_type ?? 'database_connection',
        };
      }
    }
    // 默认返回最后一个子任务
    const last = sub_tasks[sub_tasks.length - 1];
    return {
      data: last.data,
      columns: last.columns,
      row_count: last.row_count,
      truncated: last.truncated ?? false,
      source_type: last.source_type ?? 'database_connection',
    };
  }

  /**
   * 推送问题作为答案的上下文头。
   *
   * @param {string} user_message
   * @param {object} metric_view_metadata
   * @param {Function|null} stream_callback
   * @returns {Promise<void>}
   */
  async _push_question_header(user_message, metric_view_metadata, stream_callback) {
    if (!stream_callback || !user_message) {
      return;
    }
    await stream_callback(`**${user_message}**`, {
      content_type: 'markdown',
      title: t('问题'),
      savable_to_panel: false,
      recall: false,
      msg_category: 'final_result',
      ...metric_view_metadata,
    });
  }

  /**
   * @param {object} format_context
   * @returns {object}
   */
  static _summarize_metric_view_usage(format_context) {
    const sub_tasks =
      format_context && typeof format_context === 'object' && !Array.isArray(format_context)
        ? format_context.sub_tasks ?? []
        : [];
    const hits = [];
    const fallbacks = [];

    for (const task of sub_tasks) {
      const query_mode = task.query_mode ?? '';
      const status = task.metric_view_status ?? '';
      const metric_view = task.metric_view || {};
      const decision = task.metric_view_decision || {};
      const fallback_to = task.fallback_to;

      if (
        query_mode === 'metric_view' &&
        ['confirmed_hit', 'need_param_clarification'].includes(status) &&
        FormatAgent._isNonEmpty(metric_view)
      ) {
        hits.push({
          query_mode,
          metric_view_status: status,
          metric_view,
          metric_view_decision: decision,
          fallback_to,
        });
      } else if (status === 'fallback' && FormatAgent._isNonEmpty(metric_view)) {
        fallbacks.push({
          query_mode: query_mode || 'nl2sql',
          metric_view_status: status,
          metric_view,
          metric_view_decision: decision,
          fallback_to: fallback_to || 'nl2sql',
        });
      }
    }

    if (hits.length) {
      const first = hits[0];
      return {
        query_mode: 'metric_view',
        metric_view_status: first.metric_view_status ?? 'confirmed_hit',
        metric_view: first.metric_view,
        metric_view_decision: first.metric_view_decision,
        fallback_to: null,
      };
    }

    if (fallbacks.length) {
      const first = fallbacks[0];
      return {
        query_mode: first.query_mode ?? 'nl2sql',
        metric_view_status: 'fallback',
        metric_view: first.metric_view,
        metric_view_decision: first.metric_view_decision,
        fallback_to: first.fallback_to ?? 'nl2sql',
      };
    }

    return {};
  }

  /**
   * @param {object} summary
   * @returns {object}
   */
  static _build_metric_view_metadata(summary) {
    if (!FormatAgent._isNonEmpty(summary)) {
      return {};
    }

    const metadata = {};
    for (const key of ['query_mode', 'metric_view_status', 'metric_view', 'metric_view_decision', 'fallback_to']) {
      if (key in summary && summary[key] !== null && summary[key] !== undefined) {
        metadata[key] = summary[key];
      }
    }
    return metadata;
  }

  /**
   * 按值识别时间列：date/datetime 类型，或日期格式（含纯数字 20241201）。
   *
   * 比列名关键词可靠——能认出 ds / stat_dt 等不含时间词、值却是日期的列；更重要的是
   * 能把"被当成数值的数字日期（20241201 是 int）"从 y 轴度量里摘出来、改做 x 轴。
   * 列名 token 仅作值不明确时的辅助信号。
   *
   * @param {string} col_name
   * @param {Array<any>} sample_values
   * @returns {boolean}
   */
  static _is_time_column(col_name, sample_values) {
    const vals = sample_values.filter((v) => v !== null && v !== undefined).slice(0, 5);
    if (vals.length) {
      if (vals.every((v) => v instanceof Date)) {
        return true;
      }
      if (vals.every((v) => FormatAgent._DATE_VALUE_RE.test(String(v)))) {
        return true;
      }
    }
    return FormatAgent._TIME_AXIS_TOKENS.some((tok) => String(col_name).toLowerCase().includes(tok));
  }

  /**
   * 把图表块的「数据形态」对齐成可直接渲染的配置（纯确定性，不调模型）。
   *
   * 集中处理所有"图配置 vs 数据形态匹配"逻辑，让 _push_block_to_frontend 回归纯渲染：
   *   1. 校验副模型给的轴字段是否真实存在 → 臆造的丢弃（小模型常编不存在的列名）
   *   2. 缺轴时按列类型推断（时间/类别列→x，数值列→y）
   *   3. 单行宽表 melt 成长表（指标名→类别, 值→数值），避免宽表画出空图
   *   4. stacked 图推断 group_field
   *   5. 无数值列→降级 table；饼图含负值→降级 bar（占比语义不接受负值）
   *
   * 分工原则：模型负责语义决策（选什么图/标题），数据形态变换是确定性工程、交代码。
   * 返回 {display_type, data, fields(null=沿用默认), x_axis_field, y_axis_fields, group_field, fallback_hint}。
   *
   * @param {FormatBlock} block
   * @param {Array<object>} serialized
   * @param {Array<any>} columns
   * @returns {object}
   */
  static _resolve_chart_fields(block, serialized, columns) {
    let display_type = block.display_type;
    let x_field = block.x_axis_field || '';
    let y_fields = [...(block.y_axis_fields || [])];
    let group_field = block.group_field || '';
    let fields = null;
    let fallback_hint = null;
    const row0 = serialized.length ? serialized[0] : {};

    // 1. 校验副模型轴字段真实存在，臆造的（不在数据列里）丢弃
    if (x_field && !(x_field in row0)) {
      x_field = '';
    }
    if (y_fields.length) {
      y_fields = y_fields.filter((yf) => yf in row0);
    }

    // 2. 缺轴时按列类型推断。时间列按"值"识别——数字日期 20241201 也是 int，
    //    必须先认出来、从数值度量里排除，否则会被当 y 轴画歪。
    if (serialized.length && (!x_field || !y_fields.length)) {
      const time_cols = Object.keys(row0).filter((k) =>
        FormatAgent._is_time_column(
          k,
          serialized.slice(0, 5).map((r) => r[k]),
        ),
      );
      if (!y_fields.length) {
        y_fields = Object.keys(row0).filter(
          (k) => typeof row0[k] === 'number' && !_is_id_like(k) && !time_cols.includes(k),
        );
      }
      if (!x_field) {
        if (time_cols.length) {
          x_field = time_cols[0];
        } else {
          x_field =
            Object.keys(row0).find((k) => typeof row0[k] !== 'number' && !_is_id_like(k)) ?? '';
        }
      }
    }

    // 3. 单行宽表透视成长表（每个数值列 melt 成一行）
    if (serialized.length && serialized.length === 1 && y_fields.length >= 2 && !x_field) {
      const r0 = serialized[0];
      const metric_key = t('指标');
      const value_key = t('数值');
      serialized = y_fields.map((yf) => ({ [metric_key]: yf, [value_key]: r0[yf] }));
      fields = [
        { expression: metric_key, alias: metric_key },
        { expression: value_key, alias: value_key },
      ];
      x_field = metric_key;
      y_fields = [value_key];
    }

    // 4. stacked 图推断 group_field（1 个 y + 多 string 列 + 行数 > x 去重数）
    if (
      !group_field &&
      ['stacked_bar', 'stacked_line'].includes(display_type) &&
      serialized.length &&
      y_fields.length === 1 &&
      x_field
    ) {
      const str_cols = Object.keys(serialized[0]).filter(
        (k) =>
          k !== x_field &&
          !y_fields.includes(k) &&
          typeof serialized[0][k] !== 'number' &&
          !_is_id_like(k),
      );
      const x_unique = new Set(serialized.map((r) => r[x_field])).size;
      if (str_cols.length && serialized.length > x_unique) {
        group_field = str_cols[0];
      }
    }

    // 5. 降级判断
    if (!y_fields.length) {
      display_type = 'table';
      fallback_hint =
        `当前数据中没有数值类型的列（现有列：${columns.map((c) => String(c)).join(', ')}），` +
        `无法生成${getChartLabel(block.display_type)}，已自动切换为表格展示。`;
    } else if (['pie', 'rose'].includes(display_type)) {
      const has_negative = serialized.some((r) =>
        y_fields.some((yf) => typeof r[yf] === 'number' && r[yf] < 0),
      );
      if (has_negative) {
        display_type = 'bar';
        fallback_hint = t('数据包含负值，饼图无法完整展示全部数据，已自动改用柱状图。');
      }
    }

    return {
      display_type,
      data: serialized,
      fields,
      x_axis_field: x_field,
      y_axis_fields: y_fields,
      group_field,
      fallback_hint,
    };
  }

  /**
   * 推送单个展示块到前端。
   *
   * content_id / replace_content 用于流式打字机更新（同一 block 多次推送，
   * 前端用 content_id 合并、replace_content 覆盖）。返回实际使用的 content_id。
   *
   * substitution_hint：用户要求的图类型被系统替换时的说明，写入 content.fallback_hint，
   * 前端 content-hint 渲染为黄色警示条。
   *
   * @param {FormatBlock} block
   * @param {object} block_data
   * @param {object} metric_view_metadata
   * @param {Function|null} stream_callback
   * @param {object} [opts]
   * @param {string|null} [opts.content_id=null]
   * @param {boolean} [opts.replace_content=false]
   * @param {boolean} [opts.is_partial=false]
   * @param {string|null} [opts.substitution_hint=null]
   * @returns {Promise<string|null>}
   */
  async _push_block_to_frontend(
    block,
    block_data,
    metric_view_metadata,
    stream_callback,
    { content_id = null, replace_content = false, is_partial = false, substitution_hint = null } = {},
  ) {
    if (!stream_callback) {
      return null;
    }

    const truncated = block_data.truncated ?? false;
    const total_rows = block_data.row_count ?? 0;
    const source_type = block_data.source_type ?? 'database_connection';

    if (block.display_type === 'text') {
      let content_text = block.content || '';
      // 仅对单行纯文本数据库答案做轻量加粗，避免破坏多行 markdown/list 格式。
      // 流式中间态不做加粗（避免半截字符串触发误判）
      if (source_type !== 'unstructured_data_source' && !is_partial) {
        content_text = FormatAgent._format_database_text_for_markdown(content_text);
      }
      // 截断提示追加到文本末尾（小字提示），仅最终态附加
      if (truncated && !is_partial) {
        content_text += `\n\n<small>${t('数据量较大（共 {} 行），当前仅展示前 500 行。如需查看更多数据，请缩小查询范围或添加筛选条件。', total_rows)}</small>`;
      }
      return await stream_callback(content_text, {
        content_id,
        content_type: 'markdown',
        title: block.title,
        savable_to_panel: false,
        recall: true,
        msg_category: 'final_result',
        replace_content,
        ...metric_view_metadata,
      });
    }

    const serialized = this._serialize_data_list(block_data.data);
    const fields = this._get_fields(block_data.columns, serialized.length ? serialized[0] : null);
    const content = {
      display_type: block.display_type,
      title: block.title,
      data: serialized,
      fields,
      total_row_count: total_rows,
      truncated,
    };
    if (getVisualChartTypeIds().has(block.display_type)) {
      // 图配置与数据形态的对齐（轴绑定/透视/降级）统一交确定性代码处理，
      // 副模型只负责选 display_type/title。详见 _resolve_chart_fields。
      const resolved = FormatAgent._resolve_chart_fields(block, serialized, block_data.columns ?? []);
      content.display_type = resolved.display_type;
      content.data = resolved.data;
      if (resolved.fields !== null) {
        content.fields = resolved.fields;
      }
      if (resolved.fallback_hint) {
        content.fallback_hint = resolved.fallback_hint;
      }
      // 仍是图（未降级 table）且有数值轴时才写轴字段
      if (getVisualChartTypeIds().has(resolved.display_type) && resolved.y_axis_fields.length) {
        content.x_axis_field = resolved.x_axis_field;
        content.y_axis_fields = resolved.y_axis_fields;
        if (resolved.group_field) {
          content.group_field = resolved.group_field;
        }
      }
    }
    if (block.content) {
      content.content = block.content;
    }
    // 图类型替换提示（用户要求 X 但系统改用 Y）→ 写入 fallback_hint，前端黄色警示。
    // 不覆盖已有 fallback_hint（"无数值列降级表格"提示优先级更高）。
    if (substitution_hint && !content.fallback_hint) {
      content.fallback_hint = substitution_hint;
    }
    // 截断提示嵌入 JSON 内容（前端用小字渲染）
    if (truncated) {
      content.truncate_hint = t('数据量较大（共 {} 行），当前仅展示前 500 行。如需查看更多数据，请缩小查询范围或添加筛选条件。', total_rows);
    }
    return await stream_callback(JSON.stringify(content), {
      content_id,
      content_type: 'json',
      title: block.title,
      savable_to_panel: true,
      recall: true,
      msg_category: 'final_result',
      replace_content,
      ...metric_view_metadata,
    });
  }

  /**
   * @param {string} content_text
   * @returns {string}
   */
  static _format_database_text_for_markdown(content_text) {
    if (!content_text) {
      return content_text;
    }

    const stripped = content_text.trim();
    if (!stripped) {
      return content_text;
    }

    if (!FormatAgent._should_wrap_database_text_as_strong(stripped)) {
      return content_text;
    }

    return `**${stripped}**`;
  }

  /**
   * @param {string} content_text
   * @returns {boolean}
   */
  static _should_wrap_database_text_as_strong(content_text) {
    if (content_text.includes('\n') || content_text.includes('\r')) {
      return false;
    }
    if (MARKDOWN_BLOCK_PREFIX_RE.test(content_text)) {
      return false;
    }
    if (['**', '__', '`', '<small>', '</small>'].some((token) => content_text.includes(token))) {
      return false;
    }
    return true;
  }

  // ============== 返回构建 ==============

  /**
   * 构建返回给调用方的 params dict（run() 直接返回）。
   *
   * @param {CompoundResponse} response
   * @param {object} format_context
   * @param {string} user_message
   * @param {object|null} [metric_view_summary=null]
   * @returns {object} params dict（{blocks, metadata}），run() 直接返回。
   *   原 BaseAgent 时代包了一层 {type:'complete', params:{...}} 的 ActionDict，
   *   Step 2 去掉继承后 run 直接返回 params，故这里去掉外壳。
   */
  _build_compound_action(response, format_context, user_message, metric_view_summary = null) {
    return this._serialize_response({
      blocks: response.blocks.map((b) => b.model_dump()),
      metadata: {
        sub_task_count: format_context.sub_tasks.length,
        block_count: response.blocks.length,
        question: user_message,
        generated_at: new Date().toISOString(),
        ...(metric_view_summary || {}),
      },
    });
  }

  // ============ 工具方法 ============

  /**
   * 转换特殊类型为 JSON 可序列化的类型。
   * @param {any} val
   * @returns {any}
   */
  _serialize_value(val) {
    if (val instanceof Date) {
      return val.toISOString();
    }
    if (val instanceof Uint8Array) {
      return Buffer.from(val).toString('utf-8');
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(val)) {
      return val.toString('utf-8');
    }
    return val;
  }

  /**
   * 深度序列化响应对象。
   * @param {any} obj
   * @returns {any}
   */
  _serialize_response(obj) {
    if (obj instanceof Date) {
      return obj.toISOString();
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(obj)) {
      return obj.toString('utf-8');
    }
    if (obj instanceof Uint8Array) {
      return Buffer.from(obj).toString('utf-8');
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this._serialize_response(item));
    }
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = this._serialize_response(v);
      }
      return out;
    }
    return obj;
  }

  /**
   * 序列化数据列表。
   * @param {Array<object>} data
   * @returns {Array<object>}
   */
  _serialize_data_list(data) {
    return (data || []).map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = this._serialize_value(v);
      }
      return out;
    });
  }

  /**
   * 序列化数据供 LLM 处理。
   * @param {Array<object>} data
   * @returns {string}
   */
  _serialize_data_for_llm(data) {
    const serialized_data = this._serialize_data_list(data);
    return JSON.stringify(serialized_data, null, 2);
  }

  /**
   * 获取字段列表。
   * @param {Array<any>} columns
   * @param {object|null} [sample_row=null]
   * @returns {Array<{expression: string, alias: string}>}
   */
  _get_fields(columns, sample_row = null) {
    let fields = (columns || []).map((col) => {
      const name =
        col && typeof col === 'object' && !Array.isArray(col) ? col.column_name : String(col);
      return { expression: name, alias: name };
    });
    if (!fields.length && sample_row) {
      fields = Object.keys(sample_row).map((key) => ({ expression: key, alias: key }));
    }
    return fields.length ? fields : [];
  }

  /**
   * 判断 dict 非空（对应 Python `if some_dict:`，空对象/null 为 falsy）。
   * @param {any} obj
   * @returns {boolean}
   */
  static _isNonEmpty(obj) {
    return Boolean(obj && typeof obj === 'object' && Object.keys(obj).length > 0);
  }
}

// 用户问题里的"列出/给我"类强信号关键词——意图明确是要看数据本身，不要图。
FormatAgent._LIST_INTENT_KEYWORDS = [
  '列出',
  '给我',
  '有哪些',
  '名单',
  '明细',
  'list ',
  'show me',
  'give me', // 英文前后留空格避免误匹配
];

// 时间列名辅助词（仅在"按值"判断不明确时辅助；主判据是值的日期格式）。
FormatAgent._TIME_AXIS_TOKENS = [
  '日期',
  '月份',
  '时间',
  '年份',
  '季度',
  '周',
  'date',
  'month',
  'time',
  'year',
  'quarter',
  'week',
  'period',
];

// 日期值格式：2024-12-01 / 2024/12/1 / 2024-12 / 20241201
FormatAgent._DATE_VALUE_RE = /^(\d{4}[-/]\d{1,2}([-/]\d{1,2})?|\d{8})$/;

// 展示类型关键词映射（从 chart_types 注册表生成，扩展类型优先匹配）。
FormatAgent._DISPLAY_TYPE_KEYWORDS = buildKeywordMap();

export default FormatAgent;
