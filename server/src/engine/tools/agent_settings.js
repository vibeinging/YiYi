// 迁移自 yiw_kernel/data_analyze/planner/dbagents/agent_settings.py
import { get_default_agent_configs as _defaultAgentConfigs } from '../../config/prompt_templates.js';
import { queryOne } from '../../db.js';

const QUERY_AGENT_TYPE = 'query_agent';
const LEGACY_QUERY_AGENT_TYPE = 'pi_query_agent';

function normalizeAgentType(agentType) {
  return agentType === LEGACY_QUERY_AGENT_TYPE ? QUERY_AGENT_TYPE : agentType;
}

function agentTypeCandidates(agentType) {
  const normalized = normalizeAgentType(agentType);
  return normalized === QUERY_AGENT_TYPE ? [QUERY_AGENT_TYPE, LEGACY_QUERY_AGENT_TYPE] : [normalized];
}

function defaultAgentConfig(configs = {}, agentType) {
  const allConfigs = configs || {};
  const normalized = normalizeAgentType(agentType);
  return allConfigs[normalized] || (normalized === QUERY_AGENT_TYPE ? allConfigs[LEGACY_QUERY_AGENT_TYPE] : null) || {};
}

/**
 * 默认 agentService:查询期读 agents 表的业务自定义配置(含 knowledge.md 注入的 rules)。
 * 迁移补全 —— 此前默认 null 导致 getSettings 永远降级到空 rules,knowledge/约束从不进 prompt。
 * SQL 与 routes/agents.js GET 配置一致。
 * @param {string} projectId
 * @param {string} agentType
 * @param {string} businessId
 * @returns {Promise<object|null>} agentRow|null
 */
async function _defaultAgentService(projectId, agentType /*, businessId */) {
  if (!projectId || !agentType) return null;
  const normalized = normalizeAgentType(agentType);
  const candidates = agentTypeCandidates(agentType);
  try {
    // 去业务层:agent 配置按 project_id + agent_type 取(忽略 business_id),取最近一条
    return await queryOne(
      `SELECT id, agent_type, model_id, system_prompt, user_prompt_template, rules, is_active
         FROM agents
        WHERE project_id=$1 AND agent_type = ANY($2::text[]) AND deleted_at IS NULL
        ORDER BY CASE WHEN agent_type=$3 THEN 0 ELSE 1 END, updated_at DESC
        LIMIT 1`,
      [projectId, candidates, normalized],
    );
  } catch (e) {
    console.warn('[AgentSettings] 读 agents 配置失败(降级默认):', e?.message ?? e);
    return null;
  }
}

/**
 * 默认 getProjectDefaultModel:取项目下指定 category 的启用模型 id。
 * 取不到返回 null(下游 llm.js 自带 PRIMARY 兜底)。
 * @param {string} projectId
 * @param {string} category  PRIMARY|SECONDARY|EMBEDDING
 * @returns {Promise<string|null>}
 */
async function _defaultGetProjectDefaultModel(projectId, category = 'PRIMARY') {
  if (!projectId) return null;
  try {
    const row = await queryOne(
      `SELECT id FROM llm_models
        WHERE category=$1 AND is_enabled=1 AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
      [category],
    );
    return row?.id || null;
  } catch {
    return null;
  }
}

/**
 * Agent Settings - 获取 Agent 配置（prompt 模板、规则等）
 *
 * 职责：
 * - 获取用户自定义的 Agent 配置
 * - 降级到默认配置（YAML）
 * - 渲染模板变量
 *
 * 设计原则：
 * - 与 AgentService 分离，AgentService 只负责 CRUD
 * - 这里负责获取配置并构建 prompt
 *
 * TODO（下游波次接入）：
 * - getSettings() 中的 AgentService / LLMModelService / async_session_factory
 *   需由 Node 侧对应服务替换，当前以可注入的 deps 参数占位。
 * - get_default_agent_configs() / load_prompt_template() 需对应 Node 版 prompt loader。
 * - appendLanguageInstruction() 依赖 Node i18n 模块，当前仅追加中文指令（桌面版）。
 */

const logger = {
  info: (...args) => console.info('[AgentSettings]', ...args),
  warning: (...args) => console.warn('[AgentSettings]', ...args),
  warn: (...args) => console.warn('[AgentSettings]', ...args),
};

// ==================== 常量定义 ====================
// 实体匹配相关常量

// 召回参数
export const RECALL_LIMIT_PER_FRAGMENT = 30;           // 每个 fragment 召回实体数
export const RECALL_METRICS_LIMIT_PER_FRAGMENT = 10;   // 每个 fragment 召回指标数
export const METRIC_MIN_SIMILARITY = 0.35;             // 指标召回最低相似度阈值

// LLM 匹配参数
// 注意：不再进行全局数量截取，召回时已限制，LLM 按类型分别处理
export const LLM_RANK_MAX_OUTPUT_PER_TYPE = 10;       // 每种类型最多输出 10 个候选

// Rerank 参数
export const PERFECT_MATCH_THRESHOLD = 0.99;           // 完美匹配阈值（>=此值自动选择）
export const GAP_THRESHOLD = 0.10;                     // 断崖检测阈值（规则2：差距超过此值截断）
export const MAX_USER_OPTIONS = 10;                    // 最多给用户选择的数量（规则3）

// 去重参数
export const FALLBACK_SIMILARITY_THRESHOLD = 0.8;      // 低于此阈值触发托底召回
export const PREFIX_DEDUP_GAP = 0.05;                  // 前缀去重的相似度差距阈值

// 类型常量
export const COLUMN_VALUE_TYPE = 'column_value';       // 列值类型（数据名词）
export const FIELD_TYPE = 'column_name';               // 字段类型（字段名词）
export const METRIC_TYPE = 'metric';                   // 指标类型


export class AgentSettings {
  // dbagents 支持的 Agent 类型列表
  // 2026-05-29: 移除 5 个废弃 Tab(query_preprocessor / entity_extract /
  // entity_match / data_analyst / attribution)，对应的子 agent 与独立 agent
  // 已删除。前端 AgentSettings.vue 通过本 list 渲染 Tab，变更自动生效。
  static agent_types = [
    {
      agent_type: 'nl2sql',
      name: 'SQL生成 Agent',
      description: '将自然语言转换为SQL查询语句',
      rules_hint: '定义 SQL 生成约束，例如：\n• 时间范围默认查询最近7天\n• "销售额"需要排除退款订单\n• 金额字段保留2位小数',
    },
    {
      agent_type: 'failure_analysis',
      name: '失败分析 Agent',
      description: '分析SQL失败原因并生成修复指导',
      rules_hint: '定义错误分析规则，例如：\n• SQL语法错误时提供修复建议\n• 表不存在时推荐相似表名\n• 权限不足时说明所需权限',
    },
    {
      agent_type: 'supervisor',
      name: '规则审核 Agent',
      description: '审核SQL候选并选择最佳方案',
      rules_hint: '定义审核规则，例如：\n• SQL 必须包含 LIMIT 限制\n• 禁止 DELETE/UPDATE 操作\n• 跨表查询需要明确 JOIN 条件',
    },
    {
      agent_type: 'format',
      name: '格式化 Agent',
      description: '将查询结果进行可视化展示',
      rules_hint: '定义结果格式化规则，例如：\n• 金额显示千分位和货币符号\n• 日期格式为 YYYY-MM-DD\n• 超过10条数据时显示图表',
    },
    {
      agent_type: 'super_agent',
      name: 'SuperAgent',
      description: '统一数据分析Agent，自主决策工具调用，支持多轮对话和复杂数据探索',
      rules_hint: '定义SuperAgent行为规则，例如：\n• 工具调用策略和优先级\n• 问题分解的粒度控制\n• 数据探索的深度限制\n• 结果格式化的偏好',
    },
    {
      agent_type: QUERY_AGENT_TYPE,
      name: 'QueryAgent',
      description: '当前问数主引擎，编排 SQL、语义过滤、格式化等工具完成多轮数据分析',
      rules_hint: '定义问数主引擎规则，例如：\n• 数据集业务术语映射\n• 交易日/快照等口径约束\n• 工具调用策略和最终答案格式',
    },
    {
      agent_type: 'ds_agent',
      name: 'DSAgent',
      description: '数据科学Agent，支持数据查询、Python代码分析、机器学习建模和预测',
      rules_hint: '定义DSAgent行为规则，例如：\n• 数据科学任务的工具选择策略\n• Python分析的约束和偏好\n• 建模和预测的方法论指导\n• 结果展示的格式要求',
    },
    {
      agent_type: 'workflow_selection',
      name: 'WorkflowAgent',
      description: 'DAG 入口对应的 Agent。内嵌 selection LLM：在本业务可用 workflow 中选最匹配的；无匹配返 null 走兜底',
      rules_hint: '定义 selection 策略，例如：\n• 优先匹配 trigger 描述完全一致的 workflow\n• 关键词重合不算匹配，需语义高度对齐\n• 无匹配时主动返 null 走兜底，不要硬选',
    },
    {
      agent_type: 'agentic_search',
      name: 'AgenticSearch',
      description: 'DAG 专用 schema/实体/指标对齐 Agent。自然语言 query → Decomposer 拆解 '
        + '(维度/指标/时间/过滤/意图 + 本轮工具清单)→ 代码校验执行 → Judge 仲裁 → '
        + '拆成 NL2SQL 入参。失败带 __route__ 短路下游 + LLM 总结失败原因。',
      rules_hint: '定义 Decomposer 拆解与召回策略，例如：\n'
        + '• 实体短词(天津分行/招商银行)优先 align_entity(自动跨表跨列)；仅 align_entity 返空才降级 align_value\n'
        + '• 指标词(不良率/余额)用 align_metric；keyword 用短词，禁止整段透传\n'
        + '• next_actions 用 Lazy 模式：本轮只调必要的下一步，别 eager 全列\n'
        + '• completeness 严格：至少 1 表 + 1 实体 + 关键列才算 sufficient\n'
        + '• failure 总结 ≤ 3 句，人话，不要 markdown',
    },
  ];

  // ==================== 日期上下文 ====================

  /** 获取当前日期上下文，用于注入 system prompt */
  static getDateContext() {
    const now = new Date();
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return `当前日期：${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${weekdays[now.getDay()]}）`;
  }

  /**
   * 获取 Agent 配置（通用方法）
   *
   * 优先级：业务自定义配置 > 默认配置
   * 返回原始模板，由调用方自行编译占位符
   *
   * TODO: deps.agentService、deps.llmModelService、deps.getDefaultAgentConfigs
   *   由 Node 侧依赖注入（下游波次），当前无实现时返回空字符串降级。
   *
   * @param {string} projectId
   * @param {string} businessId
   * @param {string} agentType
   * @param {object} [deps]  依赖注入，下游波次替换
   * @param {Function} [deps.agentService]          async (projectId, agentType, businessId) => agentRow|null
   * @param {Function} [deps.getProjectDefaultModel] async (projectId, category) => modelId|null
   * @param {Function} [deps.getDefaultAgentConfigs] () => { [agentType]: {...} }
   * @returns {Promise<{system_prompt: string, user_prompt_template: string, rules: string, model_id: string|null}>}
   */
  static async getSettings(projectId, businessId, agentType, deps = {}) {
    const {
      agentService = _defaultAgentService,           // 迁移补全:默认读 agents 表(业务 rules/knowledge)
      getProjectDefaultModel = _defaultGetProjectDefaultModel,
      getDefaultAgentConfigs = _defaultAgentConfigs, // 默认从内置 prompt 模板 JSON 加载
    } = deps;

    const normalizedAgentType = normalizeAgentType(agentType);

    // 查业务自定义配置
    if (agentService) {
      const agent = await agentService(projectId, agentType, businessId);
      if (agent) {
        let modelId = agent.model_id || null;
        if (!modelId && projectId && getProjectDefaultModel) {
          modelId = await getProjectDefaultModel(projectId, 'PRIMARY');
        }
        // 合并:业务行字段为空时回退默认 prompt(常见于「只注入 rules、未自定义 prompt」的行,
        // 如 eval 把 knowledge.md 写进 rules 但 system_prompt 留空 —— 不能用空串覆盖默认 prompt)。
        const defaultConfigs = getDefaultAgentConfigs ? getDefaultAgentConfigs() : {};
        const dc = defaultAgentConfig(defaultConfigs, agentType);
        logger.info(`获取到Agent配置: agent_type=${normalizedAgentType}, model_id=${modelId}, has_rules=${!!agent.rules}`);
        return {
          system_prompt: agent.system_prompt || dc.system_prompt || '',
          user_prompt_template: agent.user_prompt_template || dc.user_prompt_template || '',
          rules: agent.rules || dc.rules || '',
          model_id: modelId,
        };
      }
    }

    // 降级到默认配置
    logger.info(`未找到Agent配置，使用默认配置: agent_type=${normalizedAgentType}`);
    const defaultConfigs = getDefaultAgentConfigs ? getDefaultAgentConfigs() : {};
    const defaultConfig = defaultAgentConfig(defaultConfigs, agentType);

    let modelId = null;
    if (projectId && getProjectDefaultModel) {
      modelId = await getProjectDefaultModel(projectId, 'PRIMARY');
    }

    return {
      system_prompt: defaultConfig.system_prompt || '',
      user_prompt_template: defaultConfig.user_prompt_template || '',
      rules: defaultConfig.rules || '',
      model_id: modelId,
    };
  }

  /**
   * 通用的 Agent 配置获取方法
   *
   * 统一处理：
   * 1. 获取用户配置或默认配置
   * 2. 渲染 system_prompt 和 user_prompt 模板
   * 3. 自动注入 rules 到 system_vars
   *
   * @param {string} projectId
   * @param {string} agentType
   * @param {object} [opts]
   * @param {string}  [opts.businessId]
   * @param {object}  [opts.systemVars]
   * @param {object}  [opts.userVars]
   * @param {object}  [opts.deps]        同 getSettings deps
   * @returns {Promise<{system_prompt: string, user_prompt: string, model_id: string|null, rules: string}>}
   */
  static async getAgentConfig(projectId, agentType, {
    businessId = null,
    systemVars = null,
    userVars = null,
    deps = {},
  } = {}) {
    logger.info(`getAgentConfig called: agent_type=${agentType}`);

    const settings = await AgentSettings.getSettings(projectId, businessId, agentType, deps);

    // 默认将 rules 注入到 system_vars
    const _systemVars = { rules: settings.rules || '', ...(systemVars || {}) };

    // 渲染模板
    let systemPrompt = AgentSettings.renderTemplate(settings.system_prompt, _systemVars);
    const userPrompt = AgentSettings.renderTemplate(settings.user_prompt_template || '', userVars || {});

    // 校验关键占位符是否被渲染
    for (const [varName, value] of Object.entries(systemVars || {})) {
      if (value && String(value).trim()) {
        const placeholder = `{${varName}}`;
        if (!settings.system_prompt.includes(placeholder)) {
          logger.warning(`agent_type=${agentType}: system_prompt 中缺少 ${placeholder} 占位符，该变量未注入`);
        }
      }
    }

    systemPrompt = AgentSettings._appendLanguageInstruction(systemPrompt);

    return {
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
      model_id: settings.model_id || null,
      rules: settings.rules || '',
    };
  }

  // ==================== 辅助函数 ====================

  /**
   * 按优先级选择实体：user_selected > auto_selected > null
   * @param {Array<object>} entities
   * @returns {object|null}
   */
  static _selectEntityByPriority(entities) {
    return (
      entities.find(e => e._user_selected) ||
      entities.find(e => e._auto_selected) ||
      null
    );
  }

  // ==================== 主函数 ====================

  /**
   * 统一的注解生成函数（按 original_text 分组输出）
   *
   * 优先级规则：
   * 1. user_selected > auto_selected > other candidates
   * 2. 只显示有优先级标记的实体（用户选择或精确匹配）
   * 3. 无优先级标记的候选实体不参与注解生成
   *
   * @param {Array<object>|null} entities
   * @param {Array<object>|null} metrics
   * @returns {string}
   */
  static _generateAnnotations(entities = null, metrics = null) {
    if (!entities?.length && !metrics?.length) {
      return '无实体或指标识别';
    }

    const lines = [];

    // 按 original_text 分组实体
    /** @type {Map<string, Array<object>>} */
    const groupedEntities = new Map();
    /** @type {Map<string, string>} */
    const customInputsByFragment = {};

    for (const entity of (entities || [])) {
      if (entity._user_custom || entity.entity_type === 'custom') {
        const entityValue = entity.entity_value || '';
        const originalText = entity.original_text || '';
        if (entityValue && originalText) {
          customInputsByFragment[originalText] = entityValue;
        }
        continue;
      }
      const originalText = entity.original_text || '';
      if (!groupedEntities.has(originalText)) groupedEntities.set(originalText, []);
      groupedEntities.get(originalText).push(entity);
    }

    // 处理分组后的实体
    for (const [originalText, group] of groupedEntities.entries()) {
      if (!originalText) continue;

      const columnNameEntities = group.filter(e => e.entity_type === 'column_name');
      const valueEntities = group.filter(e => e.entity_type !== 'column_name');

      // 处理列名实体
      if (columnNameEntities.length) {
        const selectedEntity = AgentSettings._selectEntityByPriority(columnNameEntities);
        if (selectedEntity) {
          const table = selectedEntity.table_name || '';
          const column = selectedEntity.column_name || '';
          const description = selectedEntity.description || '';

          let columnInfo = `${table}.${column}`;
          if (description) columnInfo += ` 描述: ${description}`;

          if (selectedEntity._user_selected) {
            lines.push(`- 问题中的"${originalText}"，用户选择了以下列，必须使用`);
          } else {
            lines.push(`- 问题中的"${originalText}"，精确匹配以下列，必须使用`);
          }
          lines.push(`  - ${columnInfo}`);
        }
      }

      // 处理列值实体
      if (valueEntities.length) {
        const selectedEntity = AgentSettings._selectEntityByPriority(valueEntities);
        if (selectedEntity) {
          const entityValue = selectedEntity.entity_value || '';
          const table = selectedEntity.table_name || '';
          const column = selectedEntity.column_name || '';
          const metadata = selectedEntity.meta_data || {};

          let rowDataStr = '';
          if (metadata && typeof metadata === 'object') {
            const excludeKeys = new Set(['table_name', 'column_name', 'source_value', 'source_type', 'description']);
            const rowData = Object.entries(metadata)
              .filter(([k, v]) => !excludeKeys.has(k) && v != null && String(v).trim())
              .map(([k, v]) => `${k}: ${v}`);
            if (rowData.length) {
              rowDataStr = `，该名词的其他相关数据: ${rowData.join(', ')}`;
            }
          }

          if (selectedEntity._user_selected) {
            lines.push(`- 问题中的"${originalText}"，用户选择了以下数据，必须使用`);
          } else {
            lines.push(`- 问题中的"${originalText}"，精确匹配以下数据，必须使用`);
          }
          lines.push(`  - "${entityValue}", 路径: from ${table} where ${column} = '${entityValue}'${rowDataStr}`);
        }
      }
    }

    // 处理指标（按 matched_fragment 分组）
    if (metrics?.length) {
      /** @type {Map<string, Array<object>>} */
      const groupedMetrics = new Map();
      for (const metric of metrics) {
        const matched = (metric.matched_fragment || metric.name || '').trim();
        if (!matched) continue;
        if (!groupedMetrics.has(matched)) groupedMetrics.set(matched, []);
        groupedMetrics.get(matched).push(metric);
      }

      for (const [matched, group] of groupedMetrics.entries()) {
        if (!matched.trim()) continue;

        const selectedMetric = AgentSettings._selectEntityByPriority(group);
        if (!selectedMetric) continue;

        const name = (selectedMetric.name || '').trim();
        if (!name) continue;

        const template = selectedMetric.sql_template || '';
        const description = selectedMetric.description || '';

        if (selectedMetric._user_selected) {
          lines.push(`- 问题中的"${matched}"，用户选择了以下指标，必须使用`);
          let metricInfo = `  - 指标"${name}"（用户选择）`;
          if (description) metricInfo += `，描述: ${description}`;
          lines.push(metricInfo);
        } else {
          lines.push(`- 问题中的"${matched}"，精确匹配以下指标，必须使用`);
          let metricInfo = `  - 指标"${name}"（精确匹配）`;
          if (description) metricInfo += `，描述: ${description}`;
          lines.push(metricInfo);
        }

        if (template) lines.push(`    - SQL模板: ${template}`);

        // 表列信息（兼容 JSON 字符串和 JS 对象）
        let relatedTables = selectedMetric.related_tables || [];
        let relatedColumns = selectedMetric.related_columns || {};

        if (typeof relatedTables === 'string') {
          try { relatedTables = JSON.parse(relatedTables); } catch { relatedTables = []; }
        }
        if (typeof relatedColumns === 'string') {
          try { relatedColumns = JSON.parse(relatedColumns); } catch { relatedColumns = {}; }
        }

        if (relatedTables.length) lines.push(`    - 涉及表: ${relatedTables.join(', ')}`);

        if (relatedColumns && typeof relatedColumns === 'object') {
          for (const [table, cols] of Object.entries(relatedColumns)) {
            lines.push(`    - ${table}表字段: ${cols.join(', ')}`);
          }
        }

        // WHERE过滤条件的注解
        const codeKnowledge = selectedMetric.code_knowledge || {};
        if (codeKnowledge) {
          const conditions = codeKnowledge.conditions || [];
          if (conditions.length) {
            lines.push('    - WHERE过滤条件（必须使用以下配置）：');
            for (const cond of conditions) {
              const condLines = AgentSettings._formatCondition(cond, entities);
              lines.push(...condLines);
            }
          }
        }
      }
    }

    // 添加自定义输入注解
    for (const [fragment, customInput] of Object.entries(customInputsByFragment)) {
      lines.push(`- 问题中的"${fragment}"，用户补充说明：${customInput}`);
    }

    return lines.join('\n');
  }

  /**
   * 格式化单个 condition 为注解文本
   * @param {object} cond
   * @param {Array<object>|null} entities
   * @returns {string[]}
   */
  static _formatCondition(cond, entities = null) {
    const condType = cond.type || '';
    const field = cond.field || '';
    if (!field) return [];

    const formatters = {
      field_condition: AgentSettings._formatFieldCondition,
      sql_fragment: AgentSettings._formatSqlFragment,
      entity_mapping: AgentSettings._formatEntityMapping,
      dynamic_inference: AgentSettings._formatDynamicInference,
    };

    const formatter = formatters[condType];
    if (formatter) return formatter(cond, entities);
    return [`      - 未知类型: ${condType}`];
  }

  /**
   * 格式化 field_condition 类型
   * @param {object} cond
   * @returns {string[]}
   */
  static _formatFieldCondition(cond) {
    const field = cond.field || '';
    const values = cond.values || [];
    const description = cond.description || '';

    const validValues = values.filter(v => v != null && String(v).trim());
    if (!validValues.length) return [];

    let sqlCondition;
    if (validValues.length === 1) {
      sqlCondition = `${field} = '${validValues[0]}'`;
    } else {
      sqlCondition = `${field} IN ('${validValues.join("', '")}')`;
    }

    const lines = [`      - ${sqlCondition}`];
    if (description) lines.push(`        -- ${description}`);
    return lines;
  }

  /**
   * 格式化 sql_fragment 类型
   * @param {object} cond
   * @returns {string[]}
   */
  static _formatSqlFragment(cond) {
    const field = cond.field || '';
    const values = cond.values || [];
    const description = cond.description || '';

    if (!values.length || !values[0]) return [];
    const sqlExpr = values[0].trim();
    const lines = [`      - ${field} ${sqlExpr}`];
    if (description) lines.push(`        -- ${description}`);
    return lines;
  }

  /**
   * 格式化 entity_mapping 类型
   * @param {object} cond
   * @param {Array<object>|null} entities
   * @returns {string[]}
   */
  static _formatEntityMapping(cond, entities = null) {
    const field = cond.field || '';
    const values = cond.values || [];
    const description = cond.description || '';

    if (!values.length || !values[0]) return [];
    const boundField = values[0].trim();

    let exampleValue = null;
    if (entities) {
      for (const entity of entities) {
        if (entity.entity_type === 'column_value') {
          const metadata = entity.meta_data || {};
          if (metadata && typeof metadata === 'object' && boundField in metadata) {
            exampleValue = metadata[boundField];
            break;
          }
        }
      }
    }

    let line;
    if (exampleValue != null) {
      line = `      - ${field} = <从问题注解中的 ${boundField} 字段获取值，如: ${exampleValue}>`;
    } else {
      line = `      - ${field} = <从问题注解中的 ${boundField} 字段获取值>`;
    }

    const lines = [line];
    if (description) lines.push(`        -- ${description}`);
    return lines;
  }

  /**
   * 格式化 dynamic_inference 类型
   * @param {object} cond
   * @returns {string[]}
   */
  static _formatDynamicInference(cond) {
    const field = cond.field || '';
    const operator = cond.operator || '';
    const values = cond.values || [];
    const description = cond.description || '';

    if (!values.length || !values[0]) return [];
    const ruleName = values[0].trim();
    const sqlCondition = `${field} ${operator} <${ruleName}>`;

    const lines = [`      - ${sqlCondition}`];
    if (description) lines.push(`        -- ${description}`);
    return lines;
  }

  /**
   * 安全渲染模板，只替换 variables 中存在的变量。
   * 其他 {xxx} 保持原样。
   *
   * @param {string} template
   * @param {object} variables
   * @returns {string}
   */
  static renderTemplate(template, variables) {
    if (!template) return '';
    let result = template;
    for (const [varName, value] of Object.entries(variables)) {
      const placeholder = `{${varName}}`;
      // 全量替换所有出现位置
      result = result.split(placeholder).join(value != null ? String(value) : '');
    }
    return result;
  }

  /**
   * 根据当前语言在 prompt 末尾追加输出语言指令。
   * 桌面版只需中文，直接追加中文指令。
   * TODO: 接入 Node i18n 模块后按 getCurrentLanguage() 分支。
   *
   * @param {string} prompt
   * @returns {string}
   */
  static _appendLanguageInstruction(prompt) {
    if (!prompt) return prompt;
    const instruction = '\n\n请使用中文回复。';
    if (prompt.endsWith(instruction.trim())) return prompt;
    return prompt + instruction;
  }

  /**
   * 当用户自定义 prompt 漏掉关键占位符时，将内容补回到最终 prompt。
   *
   * @param {string} renderedPrompt
   * @param {string} template
   * @param {Array<[string, string]>} sections   [[varName, content], ...]
   * @param {string} [agentType]
   * @returns {string}
   */
  static _ensurePromptSections(renderedPrompt, template, sections, agentType = '') {
    let prompt = renderedPrompt || '';
    const missingChunks = [];

    for (const [varName, content] of sections) {
      if (!content || !String(content).trim()) continue;
      const placeholder = `{${varName}}`;
      if (!template.includes(placeholder)) {
        logger.warning(
          `agent_type=${agentType || 'unknown'}: user_prompt_template 中缺少 ${placeholder} 占位符，已自动补齐到最终 prompt`
        );
        missingChunks.push(String(content).trim());
      }
    }

    if (!missingChunks.length) return prompt;

    const parts = [...missingChunks, prompt].filter(c => c && String(c).trim());
    return parts.join('\n\n').trim();
  }

  // ==================== 各 Agent 配置快捷方法 ====================

  /**
   * 获取 NL2SQL Agent 配置
   *
   * @param {string} projectId
   * @param {string} businessId
   * @param {object} [opts]
   * @param {string}  [opts.schemaInfo]
   * @param {string}  [opts.question]
   * @param {string|null} [opts.businessRules]
   * @param {string}  [opts.examples]
   * @param {string|null} [opts.retryFeedback]
   * @param {object|null} [opts.dbConnection]
   * @param {Array<object>|null} [opts.entities]
   * @param {Array<object>|null} [opts.metrics]
   * @param {string}  [opts.currentDate]
   * @param {object}  [opts.deps]
   * @returns {Promise<{system_prompt: string, user_prompt: string, model_id: string|null}>}
   */
  static async getNl2sqlConfig(projectId, businessId, {
    schemaInfo = '',
    question = '',
    businessRules = null,
    examples = '',
    retryFeedback = null,
    dbConnection = null,
    entities = null,
    metrics = null,
    currentDate = '',
    deps = {},
  } = {}) {
    // TODO: AgentType.NL2SQL → 'nl2sql'（下游波次接入 AgentType 枚举后替换）
    const settings = await AgentSettings.getSettings(projectId, businessId, 'nl2sql', deps);

    const errorSection = retryFeedback ? `## 重试反馈\n${retryFeedback}` : '';

    // 获取数据库信息
    let dbType = '未知';
    let dbVersion = '未知';
    if (dbConnection) {
      dbType = dbConnection.db_type || '未知';
      const extraConfig = dbConnection.extra_config_dict || {};
      if (typeof extraConfig === 'object') {
        dbVersion = extraConfig.version || '未知';
      }
    }

    // 渲染 system_prompt
    const rulesText = businessRules || settings.rules || '';
    const systemPromptRaw = AgentSettings.renderTemplate(settings.system_prompt, { rules: rulesText });

    // 生成带注解的问题
    const annotationsText = AgentSettings._generateAnnotations(entities, metrics);
    const questionWithAnnotations =
      annotationsText && annotationsText !== '无实体或指标识别'
        ? `${question}\n\n## **问题注解**:\n${annotationsText}`
        : question;

    const userPrompt = AgentSettings.renderTemplate(settings.user_prompt_template, {
      db_type: dbType,
      db_version: dbVersion,
      schema_info: schemaInfo,
      question: questionWithAnnotations,
      error_section: errorSection,
      examples,
      current_date: currentDate || '',
    });

    const systemPrompt = AgentSettings._appendLanguageInstruction(systemPromptRaw);

    logger.info(`[getNl2sqlConfig] 返回配置: model_id=${settings.model_id}`);
    return { system_prompt: systemPrompt, user_prompt: userPrompt, model_id: settings.model_id || null };
  }

  /**
   * 构建 Supervisor 审核 prompt
   *
   * @param {string} userQuestion
   * @param {Array<{sql: string, reasoning: string}>} sqlCandidates
   * @param {string} schemaInfo
   * @param {object} [opts]
   * @param {string}  [opts.examplesText]
   * @param {Array<object>|null} [opts.entities]
   * @param {Array<object>|null} [opts.metrics]
   * @param {string}  [opts.rules]
   * @param {object|null} [opts.dbConnection]
   * @param {string}  [opts.currentDate]
   * @param {Function} [opts.loadPromptTemplate]  async (name: string) => string|null
   * @returns {Promise<string>}
   */
  static async buildSupervisorAuditPrompt(userQuestion, sqlCandidates, schemaInfo, {
    examplesText = '',
    entities = null,
    metrics = null,
    rules = '',
    dbConnection = null,
    currentDate = '',
    loadPromptTemplate = null,
  } = {}) {
    const annotationsText = AgentSettings._generateAnnotations(entities, metrics);
    const questionWithAnnotations =
      annotationsText && annotationsText !== '无实体或指标识别'
        ? `${userQuestion}\n\n## **问题注解**:\n${annotationsText}`
        : userQuestion;

    const candidatesInfo = sqlCandidates.map((c, i) =>
      `### 候选 ${i + 1}:\n\`\`\`sql\n${c.sql}\n\`\`\`\n思考逻辑: ${c.reasoning}`
    ).join('\n\n');

    let dbType = '未知';
    let dbVersion = '未知';
    if (dbConnection) {
      dbType = dbConnection.db_type || '未知';
      const extraConfig = dbConnection.extra_config_dict || {};
      if (typeof extraConfig === 'object') dbVersion = extraConfig.version || '未知';
    }

    // TODO: load_prompt_template("supervisor_audit") — 由 loadPromptTemplate 注入
    if (!loadPromptTemplate) {
      throw new Error('buildSupervisorAuditPrompt: loadPromptTemplate 未注入');
    }
    const templateContent = await loadPromptTemplate('supervisor_audit');
    if (!templateContent) {
      throw new Error('未找到 supervisor_audit 模板');
    }

    const prompt = AgentSettings.renderTemplate(templateContent, {
      rules: rules || '',
      user_question: questionWithAnnotations,
      examples_text: examplesText || '',
      schema_info: schemaInfo,
      candidates_info: candidatesInfo,
      db_type: dbType,
      db_version: dbVersion,
      current_date: currentDate || '',
    });

    return AgentSettings._appendLanguageInstruction(prompt);
  }

  /**
   * 获取格式化 Agent 配置
   *
   * @param {string} projectId
   * @param {object} [opts]
   * @param {string}  [opts.businessId]
   * @param {string}  [opts.question]
   * @param {string}  [opts.tasksDescription]
   * @param {number}  [opts.subTaskCount]
   * @param {object}  [opts.deps]
   * @returns {Promise<{system_prompt: string, user_prompt: string, model_id: string|null}>}
   */
  static async getFormatConfig(projectId, {
    businessId = null,
    question = '',
    tasksDescription = '',
    subTaskCount = 1,
    deps = {},
  } = {}) {
    // TODO: AgentType.FORMAT → 'format'
    return AgentSettings.getAgentConfig(projectId, 'format', {
      businessId,
      userVars: {
        question,
        tasks_description: tasksDescription,
        sub_task_count: String(subTaskCount),
      },
      deps,
    });
  }

  /**
   * 获取失败分析 Agent 配置
   *
   * @param {string} projectId
   * @param {string} businessId
   * @param {object} [opts]
   * @param {string}  [opts.userQuestion]
   * @param {string}  [opts.schemaInfo]
   * @param {string}  [opts.failureDetails]
   * @param {object}  [opts.deps]
   * @returns {Promise<{system_prompt: string, user_prompt: string, model_id: string|null}>}
   */
  static async getFailureAnalysisConfig(projectId, businessId, {
    userQuestion = '',
    schemaInfo = '',
    failureDetails = '',
    deps = {},
  } = {}) {
    // TODO: AgentType.FAILURE_ANALYSIS → 'failure_analysis'
    return AgentSettings.getAgentConfig(projectId, 'failure_analysis', {
      businessId,
      userVars: {
        user_question: userQuestion,
        schema_info: schemaInfo,
        failure_details: failureDetails,
      },
      deps,
    });
  }

  /**
   * 获取 SuperAgent 配置
   *
   * @param {string} projectId
   * @param {string} businessId
   * @param {object} [opts]
   * @param {string}  [opts.intermediateName]
   * @param {string}  [opts.dataProfiles]
   * @param {string}  [opts.orchestration]
   * @param {string}  [opts.question]
   * @param {object}  [opts.deps]
   * @returns {Promise<{system_prompt: string, user_prompt: string, rules: string, model_id: string|null}>}
   */
  static async getSuperAgentConfig(projectId, businessId, {
    intermediateName = 'intermediate_<session_id>',
    dataProfiles = '',
    orchestration = '',
    question = '',
    deps = {},
  } = {}) {
    if (!businessId) throw new Error('getSuperAgentConfig: business_id 不能为空');

    const userVars = {
      data_profiles: dataProfiles ? `## 可用数据\n${dataProfiles}` : '',
      orchestration: orchestration ? `## 当前编排状态\n${orchestration}` : '',
      question,
      intermediate_name: intermediateName,
      current_date: AgentSettings.getDateContext(),
    };

    const config = await AgentSettings.getAgentConfig(projectId, 'super_agent', {
      businessId,
      systemVars: {},
      userVars,
      deps,
    });

    // 兜底：如果用户自定义的 user_prompt_template 漏掉关键占位符，仍保证可用
    const settings = await AgentSettings.getSettings(projectId, businessId, 'super_agent', deps);
    const template = settings.user_prompt_template || '';
    config.user_prompt = AgentSettings._ensurePromptSections(
      config.user_prompt || '',
      template,
      [
        ['data_profiles', userVars.data_profiles],
        ['orchestration', userVars.orchestration],
        ['question', userVars.question],
      ],
      'super_agent',
    );
    return config;
  }

  /**
   * 获取 DSAgent 配置
   *
   * @param {string} projectId
   * @param {string} businessId
   * @param {object} [opts]
   * @param {string}  [opts.orchestration]
   * @param {string}  [opts.intermediateName]
   * @param {object}  [opts.deps]
   * @returns {Promise<{system_prompt: string, user_prompt: string, rules: string, model_id: string|null}>}
   */
  static async getDsAgentConfig(projectId, businessId, {
    orchestration = '',
    intermediateName = 'intermediate_<session_id>',
    deps = {},
  } = {}) {
    if (!businessId) throw new Error('getDsAgentConfig: business_id 不能为空');

    return AgentSettings.getAgentConfig(projectId, 'ds_agent', {
      businessId,
      systemVars: {
        orchestration,
        intermediate_name: intermediateName,
      },
      deps,
    });
  }
}
