// 迁移自 backend/yiw_kernel/semantic_catalogs/business/metric_view_query_tool.py
//
// MetricViewQueryTool — 业务视图召回工具（SuperAgent 直接调用，继承 BaseTool）。
// 把用户问题映射到团队预设的「业务视图」（含表/字段/过滤/聚合的 SQL 骨架），命中后用确定模板出 SQL。
//
// 迁移要点：
//  - 对外接口与 Python 1:1：class MetricViewQueryTool extends BaseTool；name/inputs/output_type/execute 同名。
//  - Result 用已迁 base_tool.js 的 Result.create / Result.createError（对应 Python Result.create / create_error）。
//  - DB 访问：Python 用 async_session_factory() 取 db 喂 MetricViewService.search；桌面版无 ORM/Session，
//    改为从 context 注入的 ctx（{query, queryOne}）取，回落中央 db.js 的 query/queryOne，绝不直连库。
//    MetricViewService.search(ctx, {...}) 第一个参数为 ctx（与本波 metric_view_service.js 迁移约定一致）。
//  - view_metric_runtime 的常量与 prioritize_metric_view_matches 等纯文本打分函数（无 DB）直接内联到本文件，
//    避免跨模块依赖一个不在本次迁移范围的 runtime 文件，保持工具自包含；语义与 Python 1:1。
//  - ViewMetricAgent / CLARIFICATION 协议：ViewMetricAgent 未迁移时 _resolve_view_metric_agent 返回 null,
//    _execute_or_clarify 据此降级到 candidates 清单(标 TODO)。扁平化后不再经 AgentRegistry。
//    CLARIFICATION_KEY 与 ParamClarificationRequest / ClarificationField 协议内联（对应 tool_types.py）。
//  - logging → console；f-string → 模板串；pydantic / dataclass → 普通对象。
//  - TODO(embedding)：MetricViewService.search 在桌面版退化为关键词/名称/描述召回（见 metric_view_service.js），
//    本工具不感知召回实现，保持对外接口与返回形状不变。

import { BaseTool, Result } from '../core/base_tool.js';
import { runAgent } from '../core/base_agent.js';
import * as defaultDb from '../../db.js';

// 轻量 logger（对应 Python logging.getLogger）
const logger = {
  error: (...args) => console.error('[MetricViewQueryTool]', ...args),
  warn: (...args) => console.warn('[MetricViewQueryTool]', ...args),
  info: (...args) => console.info('[MetricViewQueryTool]', ...args),
};

// ============================================================
// 求参协议常量（对应 core/agentic_flow/tools/tool_types.py:CLARIFICATION_KEY）
// 工具把 ParamClarificationRequest dict 放到 Result.metadata[CLARIFICATION_KEY]，SuperAgent 拦截派发。
// ============================================================
const CLARIFICATION_KEY = 'clarification_request';

// ============================================================
// view_metric_runtime 常量（对应 view_metric_runtime.py 顶部常量）
// ============================================================
const METRIC_VIEW_SEARCH_LIMIT = 5;
const METRIC_VIEW_SEARCH_MIN_SIMILARITY = 0.72;
// 语义锚点由中文 n-gram 自动抽取，避免长期维护业务词典。
const METRIC_VIEW_ANCHOR_NGRAM_MIN = 3;
const METRIC_VIEW_ANCHOR_NGRAM_MAX = 8;

// top1 显著优于 top2 时,视为"单一显著命中"自动执行 SQL(避免多候选时回退兜底,
// Q01/Q05 实测:top1 sim 0.86-0.90, top1-top2 gap 0.10-0.14,显著优于阈值)
const METRIC_VIEW_AUTO_EXECUTE_TOP1_MIN_SIMILARITY = 0.80;
const METRIC_VIEW_AUTO_EXECUTE_TOP1_MIN_GAP = 0.05;

// {extract_type: [range_hint, single_hint]} —— 与 ClarificationField docstring 同步
const _TIME_HINT_BY_EXTRACT = {
  day: ['date-range', 'date-single'],
  month: ['month-range', 'month-single'],
  year: ['year-range', 'year-single'],
};

const EXPLICIT_TIME_KEYWORDS = [
  '年', '月', '日', '季度', 'q1', 'q2', 'q3', 'q4', '本月', '上月', '近', '最近', '同比', '环比',
];

// ============================================================
// view_metric_runtime 纯文本打分工具函数（无 DB；内联，语义对应 view_metric_runtime.py）
// ============================================================

/** 归一化文本：去空白/标点/「的」并转小写（对应 normalize_metric_view_text）。 */
function normalize_metric_view_text(text) {
  const lowered = (text || '').toLowerCase();
  // 对应 Python 正则 [\s\-_.,，。；;:：/\\()（）\[\]{}]+
  const normalized = lowered.replace(/[\s\-_.,，。；;:：/\\()（）\[\]{}]+/g, '');
  return normalized.replace(/的/g, '');
}

/** 别名/名称是否作为子串精确命中问题（对应 has_metric_view_alias_exact_match）。 */
function has_metric_view_alias_exact_match(question, match) {
  const normalizedQuestion = normalize_metric_view_text(question);
  if (!normalizedQuestion) return false;

  const candidates = [match.name || ''];
  candidates.push(...(match.aliases || []));
  for (const candidate of candidates) {
    const normalizedCandidate = normalize_metric_view_text(candidate);
    if (normalizedCandidate && normalizedQuestion.includes(normalizedCandidate)) {
      return true;
    }
  }
  return false;
}

/** definition 取值：兼容 dict / pydantic 对象（对应 Python isinstance(definition, dict) 分支）。 */
function _defGet(definition, key, fallback = null) {
  if (definition == null) return fallback;
  if (typeof definition === 'object' && !Array.isArray(definition)) {
    if (Object.prototype.hasOwnProperty.call(definition, key)) {
      const v = definition[key];
      return v === undefined ? fallback : v;
    }
  }
  const v = definition[key];
  return v === undefined || v === null ? fallback : v;
}

/** discrete 维度的 allowed_values 是否子串命中问题（对应 has_metric_view_dimension_value_match）。 */
function has_metric_view_dimension_value_match(question, match) {
  const normalizedQuestion = normalize_metric_view_text(question);
  if (!normalizedQuestion) return false;

  const definition = match.definition;
  const queryDimensions = _defGet(definition, 'query_dimensions', []) || [];

  for (const dimension of queryDimensions) {
    const allowedValues = _defGet(dimension, 'allowed_values', []) || [];
    const paramType = _defGet(dimension, 'param_type', null);
    if (paramType !== 'discrete') continue;
    for (const candidate of allowedValues) {
      const normalizedCandidate = normalize_metric_view_text(String(candidate));
      if (normalizedCandidate && normalizedQuestion.includes(normalizedCandidate)) {
        return true;
      }
    }
  }
  return false;
}

/** 从文本抽取中文语义锚点 n-gram，跳过纯数字/字母片段（对应 extract_semantic_anchor_ngrams）。 */
function extract_semantic_anchor_ngrams(text) {
  const normalizedText = normalize_metric_view_text(text);
  const anchors = new Set();
  if (!normalizedText) return anchors;

  const textLength = normalizedText.length;
  const maxNgram = Math.min(METRIC_VIEW_ANCHOR_NGRAM_MAX, textLength);
  for (let size = METRIC_VIEW_ANCHOR_NGRAM_MIN; size <= maxNgram; size++) {
    for (let start = 0; start <= textLength - size; start++) {
      const fragment = normalizedText.slice(start, start + size);
      if (/^[0-9a-z]+$/.test(fragment)) continue;
      anchors.add(fragment);
    }
  }
  return anchors;
}

/** 拼接候选可用于锚点匹配的文本（name/description/aliases）（对应 build_match_semantic_anchor_text）。 */
function build_match_semantic_anchor_text(match) {
  const textParts = [match.name || '', match.description || ''];
  textParts.push(...(match.aliases || []));
  return textParts.filter((part) => part).join(' ');
}

/** 共享锚点的加权得分：长度平方 / 文档频率（对应 score_semantic_anchor_overlap）。 */
function score_semantic_anchor_overlap(sharedAnchors, anchorDocumentFrequency) {
  let score = 0.0;
  for (const anchor of sharedAnchors) {
    const documentFrequency = anchorDocumentFrequency.get(anchor) ?? 1;
    score += (anchor.length ** 2) / documentFrequency;
  }
  return score;
}

/** 为每个候选计算语义锚点得分（对应 build_match_semantic_anchor_scores）。 */
function build_match_semantic_anchor_scores(question, matches) {
  const questionAnchors = extract_semantic_anchor_ngrams(question);
  if (questionAnchors.size === 0 || !matches.length) {
    const empty = {};
    matches.forEach((_m, index) => { empty[index] = 0.0; });
    return empty;
  }

  const sharedAnchorSets = {};
  const anchorDocumentFrequency = new Map();

  matches.forEach((match, index) => {
    const candidateAnchors = extract_semantic_anchor_ngrams(build_match_semantic_anchor_text(match));
    const sharedAnchors = new Set();
    for (const anchor of questionAnchors) {
      if (candidateAnchors.has(anchor)) sharedAnchors.add(anchor);
    }
    sharedAnchorSets[index] = sharedAnchors;
    for (const anchor of sharedAnchors) {
      anchorDocumentFrequency.set(anchor, (anchorDocumentFrequency.get(anchor) ?? 0) + 1);
    }
  });

  const scores = {};
  matches.forEach((_match, index) => {
    scores[index] = score_semantic_anchor_overlap(
      sharedAnchorSets[index] ?? new Set(),
      anchorDocumentFrequency,
    );
  });
  return scores;
}

/** 固定谓词（comparison/set）值是否子串命中问题（对应 has_metric_view_fixed_value_match）。 */
function has_metric_view_fixed_value_match(question, match) {
  const normalizedQuestion = normalize_metric_view_text(question);
  if (!normalizedQuestion) return false;

  const definition = match.definition;
  const fixedPredicates = _defGet(definition, 'fixed_predicates', []) || [];

  for (const predicate of fixedPredicates) {
    const kind = _defGet(predicate, 'kind', null);
    const value = _defGet(predicate, 'value', null);
    const values = _defGet(predicate, 'values', []) || [];

    if (kind === 'comparison' && value !== null && value !== undefined) {
      const normalizedCandidate = normalize_metric_view_text(String(value));
      if (normalizedCandidate && normalizedQuestion.includes(normalizedCandidate)) {
        return true;
      }
    }
    if (kind === 'set') {
      for (const candidate of values) {
        const normalizedCandidate = normalize_metric_view_text(String(candidate));
        if (normalizedCandidate && normalizedQuestion.includes(normalizedCandidate)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** 问题是否含显式时间约束词（对应 question_has_explicit_time_constraint）。 */
function question_has_explicit_time_constraint(question) {
  const normalizedQuestion = normalize_metric_view_text(question);
  if (!normalizedQuestion) return false;
  return EXPLICIT_TIME_KEYWORDS.some(
    (keyword) => normalizedQuestion.includes(normalize_metric_view_text(keyword)),
  );
}

/** 问题有显式时间约束 且 视图有 time_dimension（对应 has_metric_view_time_dimension_match）。 */
function has_metric_view_time_dimension_match(question, match) {
  if (!question_has_explicit_time_constraint(question)) return false;
  const definition = match.definition;
  const timeDimension = _defGet(definition, 'time_dimension', null);
  return Boolean(timeDimension);
}

/**
 * 多维排序：别名精确 > 语义锚点 > 时间维度 > 维度值 > 固定值 > similarity > 稳定序
 * （对应 view_metric_runtime.py:prioritize_metric_view_matches）。
 * @param {string} question
 * @param {Array<object>} matches
 * @returns {Array<object>}
 */
export function prioritize_metric_view_matches(question, matches) {
  if (!matches || !matches.length) return [];

  const semanticAnchorScores = build_match_semantic_anchor_scores(question, matches);
  const indexedMatches = matches.map((match, index) => ({ index, match }));

  // 对应 Python sort(key=(...), reverse=True)：构造可逐项比较的元组并降序。
  const keyOf = ({ index, match }) => [
    has_metric_view_alias_exact_match(question, match) ? 1 : 0,
    semanticAnchorScores[index] ?? 0.0,
    has_metric_view_time_dimension_match(question, match) ? 1 : 0,
    has_metric_view_dimension_value_match(question, match) ? 1 : 0,
    has_metric_view_fixed_value_match(question, match) ? 1 : 0,
    Number(match.similarity ?? 0.0),
    -index,
  ];

  indexedMatches.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] > kb[i]) return -1; // reverse=True → 大的排前
      if (ka[i] < kb[i]) return 1;
    }
    return 0;
  });

  return indexedMatches.map(({ match }) => match);
}

// ============================================================
// 自动执行判定（对应 _is_top1_significantly_better）
// ============================================================

/** top1 sim ≥ 高阈值 且 top1-top2 gap ≥ 显著差距 → 视为单一显著命中。 */
function _is_top1_significantly_better(matches) {
  if (!matches || !matches.length) return false;
  const top1Sim = Number(matches[0].similarity ?? 0.0);
  if (top1Sim < METRIC_VIEW_AUTO_EXECUTE_TOP1_MIN_SIMILARITY) return false;
  if (matches.length === 1) return true;
  const top2Sim = Number(matches[1].similarity ?? 0.0);
  return (top1Sim - top2Sim) >= METRIC_VIEW_AUTO_EXECUTE_TOP1_MIN_GAP;
}

// ============================================================
// 候选/维度序列化（对应 _serialize_candidate / _summarize_query_dimensions / _summarize_time_dimension）
// ============================================================

/** 取值兼容 dict / pydantic 对象（对应 Python `_get`/`get` 鸭子取值）。 */
function _objGet(obj, key, fallback = null) {
  if (obj == null) return fallback;
  const v = obj[key];
  return v === undefined || v === null ? fallback : v;
}

/**
 * match → LLM 可读候选 dict。definition 可能是对象或 dict。
 * 不暴露 similarity：让 LLM 按 name/description/aliases 文本判断匹配度。
 * （对应 _serialize_candidate）
 */
function _serialize_candidate(match) {
  const d = match.definition;
  if (!d) return null;

  const tables = _objGet(d, 'tables', []) || [];
  const projections = _objGet(d, 'projections', []) || [];
  const aliases = _objGet(d, 'aliases', []) || [];
  return {
    view_id: _objGet(d, 'metric_id', ''),
    name: _objGet(d, 'name', ''),
    description: _objGet(d, 'description', ''),
    aliases: [...aliases],
    source_id: match.business_source_id ?? match.source_id ?? null,
    source_name: match.source_name ?? null,
    tables: [...tables],
    projections: [...projections],
    // 暴露维度元信息让 LLM 知道这个视图支持哪些 deferred 参数 + 用户答复时按什么 schema 填
    query_dimensions: _summarize_query_dimensions(_objGet(d, 'query_dimensions', []) || []),
    time_dimension: _summarize_time_dimension(_objGet(d, 'time_dimension', null)),
  };
}

/** field 兼容 dict / 对象，统一抽 table_key/column_name（对应 Python field_dict 分支）。 */
function _fieldDict(field) {
  const f = field || {};
  return {
    table_key: _objGet(f, 'table_key', ''),
    column_name: _objGet(f, 'column_name', ''),
  };
}

/** 精简 query_dimensions：仅暴露 LLM/前端需要字段，去掉 SQL 模板等内部信息（对应 _summarize_query_dimensions）。 */
function _summarize_query_dimensions(dims) {
  const result = [];
  for (const dim of dims || []) {
    result.push({
      name: _objGet(dim, 'name', ''),
      param_type: _objGet(dim, 'param_type', 'discrete'),
      required: Boolean(_objGet(dim, 'required', false)),
      op: _objGet(dim, 'op', '='),
      field: _fieldDict(_objGet(dim, 'field', {}) || {}),
      allowed_values: [...(_objGet(dim, 'allowed_values', []) || [])],
    });
  }
  return result;
}

/** 精简 time_dimension：仅暴露 LLM/前端需要字段（对应 _summarize_time_dimension）。 */
function _summarize_time_dimension(timeDim) {
  if (!timeDim) return null;
  return {
    field: _fieldDict(_objGet(timeDim, 'field', {}) || {}),
    extract_type: _objGet(timeDim, 'extract_type', 'day'),
    required: Boolean(_objGet(timeDim, 'required', false)),
  };
}

// ============================================================
// workflow 场景判定 + 求参协议（对应 _is_workflow_context / _build_clarification_if_needed）
// ============================================================

/**
 * workflow 场景判定：WorkflowContext 带 first-class workflow_id（裸 AgentContext 无）。
 * workflow 场景没有 ask_user 消费 clarification 的能力，故跳过 SuperAgent 专用的 required 维度预检。
 * 用鸭子判定避免 import WorkflowContext（跨边界，防循环依赖）。
 * （对应 _is_workflow_context）
 */
function _is_workflow_context(context) {
  return Boolean((context && context.workflow_id) || '');
}

/**
 * 按 (param_type, op, allowed_values) 三元组路由到具体 ui_hint。
 * 返回 [ui_hint, allow_multiple]；ui_hint 为空字符串表示该字段不让用户手填（如 subquery）。
 * （对应 _pick_query_dim_ui_hint）
 */
function _pick_query_dim_ui_hint(paramType, op, allowedValues) {
  const pt = (paramType || 'discrete').toLowerCase();
  const opLower = (op || '=').toLowerCase();
  if (pt === 'discrete') {
    if (!allowedValues || !allowedValues.length) {
      // discrete 但无 allowed_values（数据异常）退化为自由输入，否则用户卡死无法选
      return ['entity-typeahead', opLower === 'in'];
    }
    return ['chip-multiselect', opLower === 'in'];
  }
  if (pt === 'range') {
    return [opLower === 'between' ? 'number-range' : 'number-input', false];
  }
  if (pt === 'entity') {
    return ['entity-typeahead', opLower === 'in'];
  }
  return ['', false];
}

/**
 * 已知 extract_type 走对应 range/single 控件；未知粒度（quarter/week/hour 等）返回空串让上层跳过求参，
 * 避免错配 UI（用户填日级，SQL 却按 quarter 聚合）。（对应 _pick_time_ui_hint）
 */
function _pick_time_ui_hint(extractType, op) {
  const key = (extractType || 'day').toLowerCase();
  const pair = _TIME_HINT_BY_EXTRACT[key];
  if (pair === undefined) return '';
  return (op || 'between').toLowerCase() === 'between' ? pair[0] : pair[1];
}

/**
 * 检查视图的 required 维度是否在 dimension_values / time_range 中已补全。
 * 缺值 → 构造 ParamClarificationRequest dict（对应 to_dict 形状）让 SuperAgent 派发 ask_user；
 * 全齐 → 返回 null 表示可以直接执行。（对应 _build_clarification_if_needed）
 */
function _build_clarification_if_needed({ match, question, dimensionValues, timeRange, originalParams }) {
  const metricDef = match.definition;
  if (!metricDef) return null;

  const fields = [];

  for (const dim of _objGet(metricDef, 'query_dimensions', []) || []) {
    const name = _objGet(dim, 'name', '');
    if (!name || !_objGet(dim, 'required', false)) continue;
    if (Object.prototype.hasOwnProperty.call(dimensionValues, name)) continue;
    const allowed = (_objGet(dim, 'allowed_values', []) || [])
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v));
    const paramType = _objGet(dim, 'param_type', 'discrete');
    const op = _objGet(dim, 'op', '=');
    const [uiHint, allowMulti] = _pick_query_dim_ui_hint(paramType, op, allowed);
    if (!uiHint) {
      // subquery 或未知 param_type：不让用户手填，跳过求参
      continue;
    }
    fields.push({
      name,
      label: name,
      ui_hint: uiHint,
      description: '',
      required: true,
      options: allowed.map((v) => ({ label: v })),
      allow_multiple: allowMulti,
      current_value: null,
    });
  }

  const timeDim = _objGet(metricDef, 'time_dimension', null);
  if (timeDim !== null && timeDim !== undefined) {
    if (_objGet(timeDim, 'required', false)) {
      const tOp = (_objGet(timeDim, 'op', 'between') || 'between').toLowerCase();
      // between 必须两端都有；单边算子（>=、<=、=）允许只填一端
      let timeComplete;
      if (tOp === 'between') {
        timeComplete = Boolean(timeRange.start) && Boolean(timeRange.end);
      } else {
        timeComplete = Boolean(timeRange.start) || Boolean(timeRange.end);
      }
      const extractType = _objGet(timeDim, 'extract_type', 'day');
      const tUiHint = _pick_time_ui_hint(extractType, tOp);
      if (!timeComplete && tUiHint) {
        fields.push({
          name: '__time_range__',
          label: '时间范围',
          ui_hint: tUiHint,
          description: `时间维度（${extractType} 粒度）`,
          required: true,
          options: [],
          allow_multiple: false,
          current_value: null,
        });
      }
    }
  }

  if (!fields.length) return null;

  const viewName = _objGet(metricDef, 'name', '');
  // 对应 ParamClarificationRequest(...).to_dict()：直接构造等价 dict（label 缺省回落 name）
  return {
    tool_name: 'metric_view_query',
    prompt: `视图「${viewName}」需要以下查询参数：`,
    fields: fields.map((f) => ({
      name: f.name,
      label: f.label || f.name,
      ui_hint: f.ui_hint,
      description: f.description,
      required: f.required,
      options: [...f.options],
      allow_multiple: f.allow_multiple,
      current_value: f.current_value,
    })),
    partial_resolved: {
      dimension_values: dimensionValues,
      time_range: timeRange,
    },
    original_params: { ...originalParams },
  };
}

// ============================================================
// 执行或求参（对应 _execute_or_clarify）
// ============================================================

/** ViewMetricAgent 解析（扁平化:AgentRegistry 已删,ViewMetricAgent 未迁移时返回 null 降级）。 */
function _resolve_view_metric_agent() {
  // TODO: ViewMetricAgent（及 view_metric_runtime / 其 LLM 抽参链）尚未在 Node 迁移。
  //   迁好后在此直接 `new ViewMetricAgent()`(当前架构下应是扁平工具/普通 class,
  //   不再经 AgentRegistry)。未迁移时返回 null,_execute_or_clarify 据此降级到候选清单。
  return null;
}

/**
 * 单一显著命中时尝试执行；required 维度未填则返回 clarification 让框架求用户。
 *
 * 返回 [executedResult | null, clarificationDict | null]：
 *  - [result, null]：执行成功
 *  - [null, clarification]：required 维度未补全，要求用户提供
 *  - null：未命中 / 执行失败，调用方降级到 candidates 清单
 * （对应 _execute_or_clarify）
 */
async function _execute_or_clarify({
  context, question, match, dimensionValues, timeRange, originalParams,
}) {
  const metricDef = match.definition;
  if (!metricDef) return null;

  // required 维度预检：SuperAgent 场景有 ask_user 派发能力,缺 required 维度时构造 ParamClarificationRequest 让用户补;
  // workflow 场景无 ask_user 消费（clarification 成死信）,且 ViewMetricAgent 自带 LLM 抽参,故跳过预检。
  if (!_is_workflow_context(context)) {
    const clarification = _build_clarification_if_needed({
      match,
      question,
      dimensionValues,
      timeRange,
      originalParams,
    });
    if (clarification !== null) {
      return [null, clarification];
    }
  }

  const viewMetricAgent = _resolve_view_metric_agent();
  if (!viewMetricAgent) {
    // ViewMetricAgent 未迁/未注册：无法内部执行 SQL → 降级到 candidates 清单（与 Python 执行失败兜底等价）。
    logger.warn('ViewMetricAgent 尚未注册（viewmetric），跳过自动执行，降级到候选清单');
    return null;
  }

  // metric_def → 普通 dict（对应 model_dump() / dict()）
  const metricDefDict = typeof metricDef.model_dump === 'function'
    ? metricDef.model_dump()
    : { ...metricDef };

  const viewContext = context.copy();
  Object.assign(viewContext.input_data, {
    query: question,
    metric_definition: metricDefDict,
  });
  if (dimensionValues && Object.keys(dimensionValues).length) {
    viewContext.input_data.dimension_values = { ...dimensionValues };
  }
  if (timeRange && Object.keys(timeRange).length) {
    viewContext.input_data.time_range = { ...timeRange };
  }
  viewContext.current_goal = 'process_question';

  const _noop = async () => null;

  let agentResult;
  try {
    agentResult = await runAgent(viewMetricAgent, viewContext, _noop, { method: 'execute' });
  } catch (e) {
    logger.warn(`ViewMetricAgent 执行失败: ${e?.message ?? e}`);
    return null;
  }

  if (!(agentResult && agentResult.success)) {
    return null;
  }

  const sql = (agentResult.data || {}).sql;
  if (!sql) return null;

  const businessDataSources = ((context.input_data?.data_sources_info) || {}).business_data_sources;
  const sourceName = match.source_name ?? match.datasource_name ?? null;
  if (!businessDataSources || !sourceName) {
    logger.warn('缺 data_sources/source_name，回退 sql_scan_operator');
    return null;
  }

  let queryResult;
  try {
    queryResult = await businessDataSources.query(sourceName, sql, {
      project_id: context.project_id,
      session_id: context.session_id,
    });
  } catch (e) {
    logger.warn(`SQL 执行失败 (${sourceName}): ${e?.message ?? e}`);
    return null;
  }

  if (!queryResult.success) {
    logger.warn(`SQL 执行失败：${queryResult.message} (sql=${String(sql).slice(0, 120)})`);
    return null;
  }

  const viewId = _objGet(metricDef, 'metric_id', '');
  const viewName = _objGet(metricDef, 'name', '');

  return [{
    matched: true,
    executed: true,
    view_id: viewId,
    view_name: viewName,
    sql,
    columns: [...(queryResult.columns || [])],
    data: [...(queryResult.data || [])],
    row_count: Number(queryResult.row_count || 0),
  }, null];
}

// ============================================================
// MetricViewQueryTool（对应 Python class MetricViewQueryTool）
// ============================================================

const _DESCRIPTION = `\`metric_view_query\`：把用户问题映射到团队预设的"业务视图"（含表/字段/过滤/聚合的 SQL 骨架），命中后用确定模板出 SQL。

用法：业务有结构化数据源的 SQL 类查询，**先调本工具探一下**；命中即用，未命中再回退 \`sql_scan_operator\`。
预设视图已做过表关系/聚合口径/典型筛选校验，比即兴拼 SQL 稳。

返回两种形态：
- 单一显著命中（\`executed=true\`）：工具已内部完成 SQL 执行，data/sql 字段即查询结果。
  不要再调 sql_scan_operator 重跑，直接 complete 或 format_result 展示数据
- 多候选 / 未命中（\`executed\` 不为 true）：candidates 清单交回；多候选时根据 candidates 文本
  自决，完全未命中再回退 \`sql_scan_operator\`。若命中视图但 required 维度未填，框架会自动
  推 user_input 求参，工具调用方无需手动调 ask_user

参数：question（用户原文）/ limit（默认 5）。`;

export class MetricViewQueryTool extends BaseTool {
  constructor(kwargs = {}) {
    super('metric_view_query', _DESCRIPTION, kwargs);

    // 对外暴露 inputs / output_type（对应 Python 类属性 inputs）
    this.inputs = {
      question: {
        type: 'string',
        description: '用户问题原文（必填），用来跟业务视图的描述/示例做语义匹配',
      },
      limit: {
        type: 'integer',
        description: '返回候选数量（默认 5）',
        optional: true,
        default: 5,
      },
      // deferred 参数：第一次调时通常缺，工具命中视图后由框架求用户/LLM 补全
      dimension_values: {
        type: 'object',
        description: "视图 query_dimensions 的运行时取值，如 {'类别': '硬件', '信用评分下限': 80}。"
          + '通常由 LLM 从用户问题原文抽取或用户在 ask_user 中选择填入。',
        optional: true,
        default: {},
        'x-deferred': true,
        'x-resolve-strategy': 'llm-then-ask',
        'x-ui-hint': 'chip-multiselect',
      },
      time_range: {
        type: 'object',
        description: "视图 time_dimension 的运行时取值，如 {'start': '2024-01-01', 'end': '2024-12-31'}。",
        optional: true,
        default: {},
        'x-deferred': true,
        'x-resolve-strategy': 'llm-then-ask',
        'x-ui-hint': 'date-range',
      },
    };
    this.output_type = 'object';
  }

  /**
   * 解析查库 ctx（{query, queryOne}）：优先 context 注入（context.db_ctx / context.dbCtx），
   * 回落中央 db.js。对应 Python 的 async_session_factory()（桌面版无 ORM/Session）。
   * @param {object} context
   * @returns {{query:Function, queryOne:Function}}
   */
  static _resolve_db_ctx(context) {
    const injected = context && (context.db_ctx || context.dbCtx);
    if (injected && typeof injected.query === 'function') return injected;
    const fromInput = context && context.input_data && context.input_data.db_ctx;
    if (fromInput && typeof fromInput.query === 'function') return fromInput;
    return { query: defaultDb.query, queryOne: defaultDb.queryOne };
  }

  /**
   * 执行 metric_view_query（对应 async execute）。
   * @param {import('../core/agent_context.js').AgentContext} context
   * @param {object} [kwargs]
   * @returns {Promise<Result>}
   */
  async execute(context, kwargs = {}) {
    const question = (kwargs.question || '').trim();
    if (!question) {
      return Result.createError('question 必填');
    }

    const projectId = context.input_data?.project_id || context.project_id || null;
    if (!projectId) {
      return Result.create(
        {
          matched: false,
          total: 0,
          candidates: [],
          hint: '缺少 project_id 上下文',
        },
        '',
        { metadata: { hint: '缺少项目上下文,跳过预设视图查询' } },
      );
    }

    // 延迟 import MetricViewService（对应 Python 延迟 import view_metric_runtime/MetricViewService，避免启动期循环）。
    // 本波产出 metric_view_service.js（导出 MetricViewService），DB ctx 由本工具注入。
    let MetricViewService;
    try {
      ({ MetricViewService } = await import('../semantic/metric_view_service.js'));
    } catch (e) {
      logger.warn(`[MetricViewQueryTool] 加载 MetricViewService 失败: ${e?.message ?? e}`);
      return Result.createError(`metric_view 召回失败: ${e?.message ?? e}`);
    }

    const limit = Number(kwargs.limit) || METRIC_VIEW_SEARCH_LIMIT;
    const ctx = MetricViewQueryTool._resolve_db_ctx(context);

    let matches;
    try {
      matches = await MetricViewService.search(ctx, {
        query_text: question,
        project_id: projectId,
        limit,
        min_similarity: METRIC_VIEW_SEARCH_MIN_SIMILARITY,
      });
    } catch (e) {
      logger.warn(`[MetricViewQueryTool] search 失败: ${e?.message ?? e}`);
      return Result.createError(`metric_view 召回失败: ${e?.message ?? e}`);
    }

    matches = prioritize_metric_view_matches(question, matches || []);
    if (!matches.length) {
      // L1-6:工具自报 hint,触发前端步骤旁黄色 chip
      return Result.create(
        { matched: false, total: 0, candidates: [] },
        '',
        { metadata: { hint: '未匹配预设视图,改走智能搜索' } },
      );
    }

    const candidates = matches.map((m) => _serialize_candidate(m)).filter((c) => c);

    // 收用户/LLM 已经提供的 deferred 参数（第一次调时通常为空，二次调由 SuperAgent 框架塞回）
    const dimensionValues = kwargs.dimension_values || {};
    const timeRange = kwargs.time_range || {};

    // 单一显著命中:len==1 或 top1 显著优于 top2(防多候选时全回退兜底)
    if (_is_top1_significantly_better(matches)) {
      if (matches.length > 1) {
        const gap = Number(matches[0].similarity ?? 0.0) - Number(matches[1].similarity ?? 0.0);
        logger.info(
          `[MetricViewQueryTool] top1 显著命中 sim=${Number(matches[0].similarity ?? 0.0).toFixed(4)} `
          + `gap=${gap.toFixed(4)} → 自动执行 top1`,
        );
      }
      const executedOrClarification = await _execute_or_clarify({
        context,
        question,
        match: matches[0],
        dimensionValues,
        timeRange,
        originalParams: { ...kwargs },
      });
      if (executedOrClarification !== null) {
        const [result, clarification] = executedOrClarification;
        if (clarification !== null) {
          // 工具命中视图但 required 维度未填 → 让 SuperAgent 派发 ask_user
          return Result.create(
            {
              matched: true,
              needs_clarification: true,
              candidates,
            },
            '',
            { metadata: { [CLARIFICATION_KEY]: clarification } },
          );
        }
        if (result !== null) {
          result.candidates = candidates;
          return Result.create(result);
        }
      }
    }

    // 命中视图但未自动执行(多候选/top1 不显著/执行失败兜底)→ 下游 agent_condition 会判 executed=null 走 false 分支回退。
    return Result.create(
      {
        matched: true,
        total: candidates.length,
        candidates,
      },
      '',
      { metadata: { hint: '命中预设视图但未自动执行,改走智能搜索' } },
    );
  }
}

export default MetricViewQueryTool;
