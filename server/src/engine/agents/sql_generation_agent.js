// 迁移自 yiw_kernel/data_analyze/planner/dbagents/agents/sql_generation_agent.py
//
// SQL Generation Agent - SQL查询生成
//
// 基于 LLM 生成准确的 SQL 查询语句。
// 新增：Self-consistency 多候选 SQL 投票机制。
//
// 迁移说明：
// - 1:1 迁移，对外接口名（class / method / 字段）与 Python 版 100% 一致。
// - Step 2 起 class SQLGenerationAgent 不再 extends BaseAgent，改为普通 class；
//   对外暴露 async run(agent_context, stream_callback) 直接返回 params dict（原
//   reasoning() 返回 {type:'complete', params} 的 params 部分），出错抛异常。
//   register_agent('sql_generation')(SQLGenerationAgent) 注册名不变。
// - pydantic SQLGenerationResult → class（带静态 name/schema/fromJSON，作 chat 的 response_model）。
// - f-string → 模板串；logging → console；asyncio.gather/await → Promise/await。
// - Python LLMConfig / get_config / SelfConsistencyConfig 在 Node 侧分别用内联常量、
//   内联配置读取、core/llm.js 的 SelfConsistencyConfig 对应。
// - AgentSettings.get_nl2sql_config / get_date_context → Node getNl2sqlConfig / getDateContext。
// - DB/样例/中间表等 Python 强依赖后端 DB 服务的私有方法，在 Node 侧尚无对应服务，
//   保留方法签名与控制流，依赖未迁移时优雅降级（与 Python 版"失败降级为空"行为一致）。

import { AgentSettings } from '../tools/agent_settings.js';
import { t } from '../utils/i18n.js';
import { chat, SelfConsistencyConfig } from '../core/llm.js';
import { BaseAgent } from '../core/base_agent.js';
import { SQLCandidate } from './models.js';

/** 轻量 logger（对应 Python logging.getLogger(__name__)） */
const logger = {
  error: (...args) => console.error('[sql_generation_agent]', ...args),
  warn: (...args) => console.warn('[sql_generation_agent]', ...args),
  warning: (...args) => console.warn('[sql_generation_agent]', ...args),
  info: (...args) => console.info('[sql_generation_agent]', ...args),
  debug: (...args) => console.debug('[sql_generation_agent]', ...args),
};

// ============================================================
// LLMConfig 常量（对应 backend/config/constants.py LLMConfig；Node 侧尚未迁移
// 独立 config 模块，按 format_agent.js 既定约定就近内联所需常量）
// ============================================================
const LLMConfig = {
  TEMPERATURE_NORMAL: 0.3, // 正常温度（格式化、描述生成）
  MAX_TOKENS_LONG: 3000, // 长输出（SQL生成、描述）
  MAX_RETRIES_LLM: 2, // LLM调用重试
};

export const SQL_SEMANTIC_GUARDRAILS = `
## SQL 语义保真补充规则

1. 计数主语保真：用户问“多少/总数/count/total X with/where/containing Y”时，COUNT/SUM 的对象必须是 X；Y 只是过滤条件或关联条件，不能扩大成 Y 所在容器的全部行。
   - 例：“count atoms with triple-bond molecules containing phosphorus or bromine”应统计 element 为 phosphorus/bromine 且 molecule_id 出现在三键 bond 中的 atom 行数，不是统计这些 molecule_id 下所有 atom。
   - 如果当前查询是为最终 COUNT(X) 准备中间结果，必须输出 X 的行级 id 和关联 key，不能只 SELECT DISTINCT 父级/容器 id。
2. 跨源/中间表查询：如果当前 schema 里只有中间表，严禁引用原始数据源表；必须先用中间表求出键集合，再由上游补查原始数据源。
3. 文档抽取后的结构化表如果包含 id/code/registry code，优先用这些稳定键 JOIN；可读名称只用于展示或最终过滤，不能假设文档一定包含可读名称。
4. 文档抽取表常见同一实体多行互补：同一个稳定键的 category/amount/status/event_id 等可能分散在不同 chunk 行。遇到这种表时，先按稳定键 GROUP BY，用 MAX/ANY_VALUE/COALESCE 合并非空字段，再做 WHERE、JOIN 或比例计算；不要要求这些字段在同一行同时非空。
5. 文档 chunk 抽取出的重复行通常是同一个实体在多个切片里的重复出现。除非用户明确要求统计多笔记录的总和，否则预算金额、状态、类别这类实体属性必须先按 record_id 或 (record_id,event_id) 去重合并，再取 MAX/ANY_VALUE；不要因为同一实体出现多次就 SUM 重复金额。
6. semantic_extract_operator 可能自动提供 record_id、linked_event_id、record_ids 辅助列。文档实体合并时优先以 record_id 作为主实体键，用 linked_event_id 作为事件/活动关联键；record_ids 可用于校验某行包含哪些原始记录 ID。
7. SQL LIKE 中 "_" 是单字符通配符，不是字面下划线。匹配形如 atom_id 以 "_4" 结尾、编号后缀为 4、或 literal underscore 的条件时，必须使用 ESCAPE、正则或字符串拆分；不要写 LIKE '%_4'，否则会误匹配 "_14"、"_24" 等。
`.trim();

// ============================================================
// Self-consistency 配置读取（对应 Python config.get_config("SELF_CONSISTENCY", ...)）
// Node 桌面版无后端 config 服务，从环境变量读取并使用与 Python 默认值一致的回退。
// ============================================================

/**
 * 读取 Self-consistency 配置（对标 get_config("SELF_CONSISTENCY", key, default=...)）
 * @param {string} key
 * @param {*} defaultValue
 * @returns {*}
 */
function _getSelfConsistencyConfig(key, defaultValue) {
  const envVal = process.env[`SELF_CONSISTENCY_${key}`];
  if (envVal === undefined || envVal === null || envVal === '') {
    return defaultValue;
  }
  if (typeof defaultValue === 'boolean') {
    return ['true', '1', 'yes'].includes(String(envVal).toLowerCase());
  }
  if (typeof defaultValue === 'number') {
    const n = Number(envVal);
    return Number.isNaN(n) ? defaultValue : n;
  }
  return envVal;
}

// ============================================================
// SQLGenerationResult — 风格：用类型系统消除 JSON 解析特殊情况
// pydantic BaseModel → class，作 chat 的 response_model（带 fromJSON / name / schema）
// ============================================================

/**
 * SQL生成结果
 */
export class SQLGenerationResult {
  /**
   * @param {object} [opts]
   * @param {string} [opts.sql='']        生成的SQL查询语句
   * @param {string} [opts.reasoning='']  查询思考逻辑
   */
  constructor({ sql = '', reasoning = '' } = {}) {
    this.sql = sql;
    this.reasoning = reasoning;
  }

  /** response_model 名称（用于 chat 的错误信息提示） */
  static get name() {
    return 'SQLGenerationResult';
  }

  /** JSON Schema（供 chat 在格式错误重试时给出字段提示） */
  static schema() {
    return {
      type: 'object',
      properties: {
        sql: { type: 'string', description: '生成的SQL查询语句' },
        reasoning: {
          type: 'string',
          description: '查询思考逻辑，用通俗易懂的语言解释数据查找逻辑，避免技术术语',
        },
      },
      required: ['sql', 'reasoning'],
    };
  }

  /**
   * 从 LLM 返回的纯对象构造实例（chat response_model 入口）
   * @param {object} [data={}]
   * @returns {SQLGenerationResult}
   */
  static fromJSON(data = {}) {
    return new SQLGenerationResult({
      sql: (data && data.sql) || '',
      reasoning: (data && data.reasoning) || '',
    });
  }
}

// ============================================================
// SQLGenerationAgent
// ============================================================

/**
 * SQL生成Agent
 *
 * Step 2 起不再继承 BaseAgent：单步 agent，直接通过 run() 返回结果 dict。
 */
export class SQLGenerationAgent extends BaseAgent {
  constructor() {
    super({ name: 'SQLGenerationAgent', description: '基于LLM生成准确的SQL查询语句' });
  }

  /**
   * 生成SQL查询（原 reasoning，新架构唯一SQL生成入口）。
   *
   * 职责：基于增强后的问题和Schema生成SQL候选
   * 支持 Self-consistency 多候选生成和监督者重试反馈
   *
   * @param {object} agent_context - AgentContext
   * @param {Function} stream_callback
   * @returns {Promise<{sql_candidates: Array<object>, error?: string}>}
   */
  async run(agent_context, stream_callback) {
    // 新架构：单步查询模式 - 生成多个候选
    const question = agent_context.input_data.user_message ?? '';
    const entities = agent_context.input_data.entities ?? []; // 获取实体列表
    const metrics = agent_context.input_data.metrics ?? []; // 获取指标列表
    const schema_info = agent_context.input_data.schema_info ?? '';
    const database_id = agent_context.input_data.database_id ?? '';
    const retry_feedback = agent_context.input_data.retry_feedback; // 监督者反馈
    const n_candidates_override = agent_context.input_data.n_candidates; // 可选：覆盖候选数量

    logger.debug(
      `[SQLGen] entities count: ${entities.length}, metrics count: ${metrics.length}`,
    );

    // 验证输入
    if (!question) {
      logger.error('SQLGenerationAgent: 缺少question参数');
      return { sql_candidates: [], error: '缺少question参数' };
    }

    // 如果是重试，记录反馈信息
    if (retry_feedback) {
      logger.info(`🔄 基于监督者反馈重新生成SQL: ${String(retry_feedback).slice(0, 100)}...`);
    }

    // 获取数据库连接信息
    // 支持通过 input_data 直接传入（如 IntermediateDataSource 场景）
    let db_connection = agent_context.input_data.db_connection;
    if (!db_connection && database_id) {
      db_connection = await this._get_database_connection(database_id, agent_context.project_id);
    }

    // 开始SQL生成（支持Self-consistency）
    // 生成SQL候选 - 规则从 AgentSettings 中自动获取
    const sql_candidates = await this._generate_sql_candidates({
      question,
      entities, // 传递实体
      metrics, // 传递指标
      schema_info,
      db_connection,
      retry_feedback,
      agent_context,
      stream_callback,
      n_candidates_override, // 传递候选数量覆盖
    });

    return { sql_candidates };
  }

  /**
   * 生成SQL候选（支持Self-consistency）
   * 返回 sql_candidates 列表
   *
   * 规则从 AgentSettings 中自动获取（Agent 配置中的 rules 字段）
   *
   * @param {object} args
   * @param {string} args.question - 用户问题
   * @param {Array<object>} args.entities - 实体列表
   * @param {Array<object>} args.metrics - 指标列表
   * @param {string} args.schema_info - Schema信息
   * @param {any} args.db_connection - 数据库连接
   * @param {string} [args.retry_feedback] - 监督者反馈
   * @param {object} args.agent_context - Agent上下文
   * @param {Function} args.stream_callback - 流回调
   * @param {number|null} [args.n_candidates_override] - 可选：覆盖候选数量
   * @returns {Promise<Array<object>>}
   */
  async _generate_sql_candidates({
    question,
    entities,
    metrics,
    schema_info,
    db_connection,
    retry_feedback,
    agent_context,
    stream_callback,
    n_candidates_override = null,
  }) {
    // 使用 AgentSettings 获取配置（规则会自动从 Agent 配置获取）
    if (retry_feedback) {
      logger.debug('使用重试模式，反馈信息优先');
    } else {
      logger.debug('使用标准模式，完整上下文');
    }

    // 优先使用缓存的样例（NL2SQLTool 在样例短路阶段已召回并写入 cached_examples_text）
    const cached_examples_text = agent_context.input_data.cached_examples_text ?? '';
    let examples_text;
    if (cached_examples_text) {
      examples_text = cached_examples_text;
    } else {
      // 没有缓存时才召回（如重试场景）
      examples_text = await this._recall_examples({
        business_id: agent_context.input_data.business_id,
        database_id: agent_context.input_data.database_id,
        question,
        project_id: agent_context.project_id,
      });
      logger.debug(`独立召回结果长度: ${examples_text.length}`);
    }

    // 合并 IntermediateDataSource 的 schema_info
    schema_info = await this._merge_intermediate_schema(schema_info, agent_context);

    // 当前日期
    const current_date = AgentSettings.getDateContext();

    const config = await AgentSettings.getNl2sqlConfig(
      agent_context.input_data.project_id,
      agent_context.input_data.business_id,
      {
        schemaInfo: schema_info,
        question,
        retryFeedback: retry_feedback,
        dbConnection: db_connection,
        examples: examples_text,
        entities, // 传递实体
        metrics, // 传递指标
        currentDate: current_date, // 当前日期
      },
    );
    logger.debug(`[SQLGen] 获取到配置: model_id=${config.model_id}`);
    config.system_prompt = `${config.system_prompt || ''}\n\n${SQL_SEMANTIC_GUARDRAILS}`;

    // 获取Self-consistency配置 - 让chat自己处理
    const enable_sc = _getSelfConsistencyConfig('ENABLE_SELF_CONSISTENCY', false);
    let n_candidates = _getSelfConsistencyConfig('DEFAULT_N_CANDIDATES', 3);

    // 如果传入了覆盖值，使用覆盖值
    if (n_candidates_override !== null && n_candidates_override !== undefined) {
      n_candidates = n_candidates_override;
      logger.debug(`使用传入的 n_candidates=${n_candidates}`);
    }

    let sc_config;
    if (enable_sc && n_candidates > 1) {
      logger.info(`🎯 使用Self-consistency模式生成 ${n_candidates} 个候选`);
      sc_config = new SelfConsistencyConfig({
        n_candidates,
        base_temperature: LLMConfig.TEMPERATURE_NORMAL,
        temperature_variance: 0.1,
        strict_mode: false,
      });
    } else {
      logger.debug('使用单次生成模式');
      sc_config = null;
    }

    // 统一调用chat - 让chat自己处理Self-consistency逻辑
    let results;
    try {
      results = await chat(config.user_prompt, {
        project_id: agent_context.project_id,
        model_id: config.model_id,
        self_consistency: sc_config,
        response_model: SQLGenerationResult,
        system_message: config.system_prompt,
        temperature: LLMConfig.TEMPERATURE_NORMAL,
        max_tokens: LLMConfig.MAX_TOKENS_LONG,
        max_retries: LLMConfig.MAX_RETRIES_LLM,
        call_site: 'sql_generation',
      });
    } catch (e) {
      logger.error(`❌ [SQL-GENERATION] chat调用失败: ${e?.message ?? e}`);
      // 返回空列表，让NL2SQL Agent知道生成失败
      return [];
    }

    // 检查结果是否有效
    if (!results) {
      logger.error(`❌ [SQL-GENERATION] chat返回空结果: ${results}`);
      return [];
    }

    // 统一为列表格式处理
    if (!Array.isArray(results)) {
      results = [results];
    }

    // 统一处理结果
    const sql_candidates = [];
    for (const result of results) {
      let sql_candidate;
      if (result instanceof SQLGenerationResult) {
        sql_candidate = new SQLCandidate({
          sql: result.sql,
          reasoning: result.reasoning,
        });
      } else {
        // 字符串格式
        sql_candidate = new SQLCandidate({
          sql: String(result),
          reasoning: '',
        });
      }
      sql_candidates.push(sql_candidate);
    }

    // 简单告知生成完成 - 详细内容由 NL2SQLTool 流水线消费
    logger.info(`✅ 生成完成: ${sql_candidates.length} 个候选`);
    return sql_candidates.map((candidate) => candidate.to_dict());
  }

  /**
   * 获取数据库连接
   *
   * Python 版经 DatabaseConnectionService + async_session_factory 查库；Node 侧该后端
   * 服务尚未迁移，保留签名，未迁移时返回 null（与上层"无连接则跳过验证/合并"的降级路径一致）。
   *
   * @param {string} database_id - 数据库ID
   * @param {string} project_id - 项目ID
   * @returns {Promise<any|null>}
   */
  async _get_database_connection(database_id, project_id) {
    // TODO: DatabaseConnectionService / async_session_factory 尚未在 Node 迁移。
    //   迁好后在此查库返回 db_connection；未找到时 throw new Error(t('数据库连接不存在: {}', database_id))。
    logger.debug(
      `[SQLGen] _get_database_connection 依赖未迁移，跳过获取连接: database_id=${database_id}, project_id=${project_id}`,
    );
    return null;
  }

  /**
   * 合并 IntermediateDataSource 的 schema_info（仅 DuckDB 数据源）
   * @param {string} schema_info
   * @param {object} agent_context
   * @returns {Promise<string>}
   */
  async _merge_intermediate_schema(schema_info, agent_context) {
    const data_sources_info = agent_context.input_data.data_sources_info ?? {};
    const business_data_sources = data_sources_info.business_data_sources;
    if (!business_data_sources) {
      logger.debug('[SQLGen] business_data_sources 不存在，跳过合并');
      return schema_info;
    }

    // 检查当前目标数据源的 db_type，非 DuckDB 时跳过合并
    const database_id = agent_context.input_data.database_id ?? '';
    if (database_id) {
      const current_ds = business_data_sources.get_data_source(database_id);
      if (current_ds && current_ds.db_type !== 'duckdb') {
        logger.debug(
          `[SQLGen] 当前数据源 db_type=${current_ds.db_type}，非 DuckDB，跳过中间表 schema 合并`,
        );
        return schema_info;
      }
    }

    logger.debug(
      `[SQLGen] intermediate_data_sources keys: ${JSON.stringify(
        Object.keys(business_data_sources.intermediate_data_sources ?? {}),
      )}`,
    );

    // 用 session_id 获取已注册的 IntermediateDataSource
    const session_id = agent_context.session_id || agent_context.project_id;
    const intermediate_ds = (business_data_sources.intermediate_data_sources ?? {})[session_id];
    if (!intermediate_ds) {
      logger.debug(`[SQLGen] session_id=${session_id} 的 IntermediateDataSource 不存在`);
      return schema_info;
    }

    try {
      const profiles = await intermediate_ds.profile();
      logger.info(
        `[SQLGen] IntermediateDataSource 返回 ${profiles.length} 个表: ${JSON.stringify(
          profiles.map((p) => p.name),
        )}`,
      );
      if (!profiles.length) {
        return schema_info;
      }

      const preferred_items = agent_context.input_data.preferred_intermediate_tables ?? [];
      let preferred_table_names = new Set(
        preferred_items
          .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
          .map((item) =>
            SQLGenerationAgent._extract_intermediate_table_name(item.intermediate_table ?? ''),
          ),
      );
      preferred_table_names = new Set([...preferred_table_names].filter((name) => name));

      const preferred_profiles = profiles.filter((p) => preferred_table_names.has(p.name));
      const other_profiles = profiles.filter((p) => !preferred_table_names.has(p.name));

      const parts = [];
      if (preferred_profiles.length) {
        const preferred_lines = [];
        for (const p of preferred_profiles) {
          const preferred_meta =
            preferred_items.find(
              (item) =>
                item &&
                typeof item === 'object' &&
                !Array.isArray(item) &&
                SQLGenerationAgent._extract_intermediate_table_name(item.intermediate_table ?? '') ===
                  p.name,
            ) ?? {};
          preferred_lines.push(
            SQLGenerationAgent._format_intermediate_profile(p, {
              heading: '【优先使用】这是 SuperAgent 根据 depends 推荐的中间结果表',
              extra_lines: [
                `来源子问题: ${preferred_meta.task_id ?? ''} ${preferred_meta.task_title ?? ''}`.trim(),
                `输出别名: ${preferred_meta.output_alias ?? ''}`.trim(),
              ],
            }),
          );
        }
        parts.push('## 推荐中间结果表（优先）\n\n' + preferred_lines.join('\n\n'));
      }

      if (other_profiles.length) {
        const other_lines = other_profiles.map((p) =>
          SQLGenerationAgent._format_intermediate_profile(p, {
            heading:
              '【非优先】这是当前 session 的其他中间结果表，除非推荐表无法满足问题，否则不要优先使用',
          }),
        );
        parts.push('## 其他中间结果表（非优先）\n\n' + other_lines.join('\n\n'));
      }

      if (!parts.length) {
        return schema_info;
      }

      const intermediate_schema = parts.join('\n\n');
      let usage_hint;
      if (preferred_profiles.length) {
        usage_hint =
          '\n\n## 使用说明：如果本子问题提供了推荐中间结果表，' +
          '优先使用这些表；除非这些表无法满足问题，否则不要改用其他中间结果表。';
      } else {
        usage_hint =
          '\n\n## 使用说明：优先使用上述中间结果表，它们是前序步骤的查询结果，可直接查询获得答案。';
      }
      return schema_info
        ? `${intermediate_schema}${usage_hint}\n\n${schema_info}`
        : `${intermediate_schema}${usage_hint}`;
    } catch (e) {
      logger.warning(`[SQLGen] 合并 IntermediateDataSource schema 失败: ${e?.message ?? e}`);
      return schema_info;
    }
  }

  /**
   * @param {string} intermediate_table
   * @returns {string}
   */
  static _extract_intermediate_table_name(intermediate_table) {
    const table = (intermediate_table || '').trim();
    if (!table) {
      return '';
    }
    const dotIdx = table.indexOf('.');
    return dotIdx === -1 ? table : table.slice(dotIdx + 1);
  }

  /**
   * @param {any} profile
   * @param {object} [opts]
   * @param {string} [opts.heading='']
   * @param {string[]|null} [opts.extra_lines=null]
   * @returns {string}
   */
  static _format_intermediate_profile(profile, { heading = '', extra_lines = null } = {}) {
    let info = `表名: intermediate_db.${profile.name} ${heading}`.replace(/\s+$/, '');
    if (profile.description) {
      info += `\n业务规则: ${profile.description}`;
    }
    if (extra_lines) {
      const clean_lines = extra_lines.filter((line) => line);
      if (clean_lines.length) {
        info += '\n' + clean_lines.join('\n');
      }
    }
    if (profile.columns) {
      info += '\n列信息:';
      for (const c of profile.columns) {
        const cols = [`column_name=${c.name}`];
        const types = c.types ? [...c.types] : [];
        if (types.length) {
          cols.push(`data_type=${types[0]}`);
        }
        if (c.description) {
          cols.push(`description=${c.description}`);
        }
        if (c.sample_values) {
          cols.push(`example_values=${c.sample_values}`);
        }
        info += `\n  - ${cols.join(', ')}`;
      }
    }
    return info;
  }

  /**
   * 召回相似的 SQL 样例
   *
   * Python 版经 ExampleService + async_session_factory 查向量库；Node 侧该后端服务
   * 尚未迁移，保留签名与降级语义（失败/未迁移时返回空字符串，与 Python "失败降级为空" 一致）。
   *
   * @param {object} args
   * @param {string} args.business_id - 业务ID（必需）
   * @param {string} args.database_id - 数据库连接ID
   * @param {string} args.question - 用户问题
   * @param {string} args.project_id - 项目ID
   * @param {number} [args.top_k=3] - 返回样例数量（默认3个）
   * @returns {Promise<string>} 格式化的样例文本，失败时返回空字符串
   */
  async _recall_examples({ business_id, database_id, question, project_id, top_k = 3 }) {
    try {
      // 检查必需参数
      if (!business_id) {
        throw new Error(t('样例召回需要 business_id，但当前只有 database_id={}', database_id));
      }

      // TODO: ExampleService.search_examples / async_session_factory 尚未在 Node 迁移。
      //   迁好后在此查向量库并 this._format_examples(examples)。未迁移时降级为空字符串。
      void question;
      void project_id;
      void top_k;
      logger.info('未找到相似样例或样例库为空');
      return '';
    } catch (e) {
      logger.warning(`样例召回失败，继续生成: ${e?.message ?? e}`);
      return ''; // 失败时降级为空字符串
    }
  }

  /**
   * 格式化样例为可读文本
   *
   * 格式示例：
   * ### 参考样例 1（相似度：0.92）
   * 问题：查询销售额前10的产品
   * 答案：SELECT product_name, SUM(sales) as total FROM orders GROUP BY product_name ORDER BY total DESC LIMIT 10
   *
   * @param {Array<object>} examples - ExampleService.search_examples() 返回的样例列表
   * @returns {string} 格式化的样例文本
   */
  _format_examples(examples) {
    if (!examples || !examples.length) {
      return '';
    }

    // 检测最高相似度
    const max_similarity = examples.reduce(
      (acc, example) => Math.max(acc, example.similarity ?? 0.0),
      0.0,
    );
    const has_high_similarity = max_similarity > 0.9;

    const formatted_parts = [];
    let i = 0;
    for (const example of examples) {
      i += 1;
      const similarity = example.similarity ?? 0.0;
      const question = (example.question ?? '').trim();
      const content = (example.content ?? '').trim();

      // 跳过无效样例或低相似度样例
      if (!question || !content || similarity < 0.8) {
        continue;
      }

      let part = `### 参考样例 ${i}（相似度：${similarity.toFixed(2)}）\n`;
      part += `问题：${question}\n`;
      part += `答案：${content}\n`;

      formatted_parts.push(part);
    }

    if (!formatted_parts.length) {
      return '';
    }

    // 构建基础内容
    const content = formatted_parts.join('\n');

    // 如果有高相似度样例，添加强调提示
    if (has_high_similarity) {
      let header = '## 相关示例（重要参考）\n';
      header += '⚠️ **发现高度相似的历史样例（相似度>90%）**\n';
      header += '**重要：请优先参考以下写法，保持相似的查询结构和逻辑！**\n\n';
      return header + content;
    }

    return `## 相关示例（重要参考）\n${content}`;
  }
}
