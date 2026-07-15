// NL2SQL 子任务工具（sql_scan_operator）：把自然语言问题转 SQL 并执行。
//
// 扁平化重构（2026-06）：原实现调 NL2SQLAgent.run（5-goal 状态机：example_cache→schema→
// generate→supervise→complete），那是 SuperAgent 时代的「编排套编排」反模式——当前编排
// LLM 调本工具，工具内部又跑一个含 actor-critic(supervisor) 的状态机。
//
// 现已折叠成扁平流水线，与「扁平工具 + LLM 自主编排」理念对齐：
//   1. 解析 datasource + scan_hook
//   2. 样例精确匹配短路（similarity≥0.99 复用历史 SQL）
//   3. schema 召回（结构化 schema 喂给 SQL 生成 LLM）
//   4. SQL 生成（SQLGenerationAgent.run，self-consistency 多候选）
//   5. 取首个候选（中间源场景校验引用了中间表）
//   6. 执行 scan_hook → Table
//   7. 返回 Result({operator, result, 'sub-query', ...})
//
// 删除的能力：SupervisorAgent 的 LLM 审核/挑选(actor-critic) + SQLGeneration↔Supervisor
// 重试循环。编排 LLM 会看到本工具的执行结果(行数/字段/样本)，自主决定要不要换问法
// 重调；外层 bumpFailFast 防死循环。这比内嵌 supervisor 更贴合当前架构，且省掉一次 LLM 往返。
//
// 迁移要点：
// - BaseTool / Result 复用 core/base_tool.js。Result.createError(error, message, kwargs) /
//   Result.create(data, message, kwargs)；data/metadata 通过 kwargs 传入。
// - SQLDatabaseScan（operators.logical_operators）尚未迁移：内联一个最小算子，接口名
//   （get_next/infer_schema/copy_with/get_referenced_cols/to_dict）与 Python 1:1，复用
//   intermediate_table_utils.js 的 Table。
// - 扩展层 hook：PRE_HANDLERS.first_hit → JS PRE_HANDLERS.firstHit；
//   result_propagation.propagate 等价 Python 的 _ext_propagate。
// - BusinessDataSources.query 的 JS 签名为 query(name, sql, { project_id, session_id })，
//   business_data_sources 由其内部注入，无需显式透传（与 Python kwargs 透传等价）。
// - context.copy() / context.input_data / context.data / context.current_goal 复用 AgentContext。
// - IntermediateDataSource 判型用鸭子判型，避免与 datasources 形成硬依赖环。

import { BaseTool, Result, runTool } from '../core/base_tool.js';
import { runAgent } from '../core/base_agent.js';
import { PRE_HANDLERS } from '../core/extensions/registry.js';
import {
  PreNl2sqlExecuteHandler,
  PreNl2sqlExecuteResult, // eslint-disable-line no-unused-vars -- 文档/类型用途
} from '../core/extensions/pre_handler.js';
import { propagate as _ext_propagate } from '../core/extensions/result_propagation.js';
import { Table } from './intermediate_table_utils.js';
import { t } from '../utils/i18n.js';
// 扁平化：直接持有 NL2SQL 链路组件（不再经 AgentRegistry/NL2SQLAgent 状态机）
import { SQLGenerationAgent } from '../agents/sql_generation_agent.js';
import { ExampleRetrievalTool } from './example_retrieval_tool.js';
import { SchemaAnalysisTool } from './schema_analysis_tool.js';
import { applyExplicitAggregateHints } from './sql_aggregate_hints.js';

// 轻量 logger（对应 Python logging.getLogger）
const logger = {
  error: (...args) => console.error('[NL2SQLTool]', ...args),
  warn: (...args) => console.warn('[NL2SQLTool]', ...args),
  info: (...args) => console.info('[NL2SQLTool]', ...args),
  debug: (...args) => console.debug('[NL2SQLTool]', ...args),
};

/** 判断一个数据源是否为「中间数据源」（对应 isinstance(ds, IntermediateDataSource)）。 */
function isIntermediateDataSource(ds) {
  if (!ds) return false;
  const st = ds.source_type;
  if (st === 'intermediate_data_source' || st === 'intermediate') return true;
  return ds?.constructor?.name === 'IntermediateDataSource';
}

// ============================================================
// SQLDatabaseScan —— 最小算子（对应 operators.logical_operators.SQLDatabaseScan）
// operators.base / Table 尚未单独迁移，这里内联，接口名与 Python 子类一致。
// ============================================================

export class SQLDatabaseScan {
  /**
   * @param {object} opts
   * @param {string} opts.source_name
   * @param {Object<string,string>|null} [opts.expected_schema=null]
   * @param {string} opts.query
   * @param {string|null} [opts.sql=null]
   * @param {(sourceName: string, sql: string) => Promise<Table>} opts.scan_hook
   */
  constructor({ source_name, expected_schema = null, query, sql = null, scan_hook } = {}) {
    this.nodetag = this.constructor.name;
    this.sql = sql;
    this.source_name = source_name;
    this.expected_schema = expected_schema;
    this.query = query;
    this.schema = this.infer_schema();
    this.scan_hook = scan_hook;
    this.desc = `A SQLDatabaseScanNode, which scans SQL database by Natural-Language query `
      + `'${query}' and expects schema ${JSON.stringify(this.expected_schema)}.`;
  }

  /**
   * 执行扫描（对应 async get_next）。
   * @param {object} [_kwargs]
   * @returns {Promise<Table>}
   */
  async get_next(_kwargs = {}) {
    return this.scan_hook(this.source_name, this.sql);
  }

  /** 推断 schema（对应 infer_schema）：取 expected_schema 的键集合。 */
  infer_schema() {
    if (!this.expected_schema) return new Set();
    return new Set(Object.keys(this.expected_schema));
  }

  /**
   * 以覆盖项克隆（对应 copy_with）。
   * @param {object} [overrides]
   * @returns {SQLDatabaseScan}
   */
  copy_with(overrides = {}) {
    return new SQLDatabaseScan({
      source_name: 'source_name' in overrides ? overrides.source_name : this.source_name,
      expected_schema: 'expected_schema' in overrides ? overrides.expected_schema : this.expected_schema,
      query: 'query' in overrides ? overrides.query : this.query,
      sql: 'sql' in overrides ? overrides.sql : this.sql,
      scan_hook: 'scan_hook' in overrides ? overrides.scan_hook : this.scan_hook,
    });
  }

  /** 引用列集合（对应 get_referenced_cols） */
  get_referenced_cols() {
    return this.schema;
  }

  /** 序列化（对应 to_dict） */
  to_dict() {
    return {
      nodetag: this.nodetag,
      source_name: this.source_name,
      expected_schema: this.expected_schema,
      query: this.query,
    };
  }
}

// ============================================================
// NL2SQLTool —— sql_scan_operator
// ============================================================

const _DESCRIPTION = `**sql_scan_operator** - 将自然语言问题转换为 SQL 并执行
\`\`\`json
{"tool": "sql_scan_operator", "params": {"question": "查询浙江省2025年12月的用电客户数量", "database_name": "数据源名称（不是表名）"}}
\`\`\`
- \`question\` 必须是**自然语言问题**，**禁止传入 SQL 语句**
- \`schema_hint\` 是框架内部字段，由 \`grep_tables\` / \`grep_columns\` 的结果自动注入；调用本工具时不要填写
- **question 必须含对齐过的精确字面量和业务口径**：下游让 NL2SQL 自己拼 SQL；对用户原文字面量直接 \`LIKE '%X%'\` 会命中多个语义不同的实体导致错答案（如 \`LIKE '%宏远%'\` 命中"宏远科技"+"宏远有限"+"中国宏远"三个独立公司）。所以调用前请确保：
  · 用户问题里要进 WHERE 的字符串字面量已对齐到 schema 真实存储值
  · 用户问题里的指标/聚合口径词已对齐到业务定义的口径
  · 这些对齐结果**显式写进 question 文本**——schema_hint 不传它们，下游 SQL LLM 只看 question
  如何对齐：浏览工具列表里"**SQL 查询前**的对齐类工具"

调用提示：
- 例：用户问"广州的销量"，先对齐到"广州市" → \`question="查询广州市的销量"\`
- 例：用户问"DAU 趋势"，先对齐到口径定义 → \`question="DAU 趋势（按 last_login_at >= date - 1d 去重统计 user_id）"\`
- 例：用户问"统计/total/count X with/where/containing Y"时，\`question\` 必须保留 X 的行级标识，不要只输出 X 的父级/容器 ID。比如统计满足元素条件的 atoms 且分子有三键，前置查询必须输出 \`atom_id + molecule_id\`，不能只输出 \`molecule_id\` 后再统计该分子的全部 atoms
- 例：匹配 literal 下划线或编号后缀时，提醒 SQL 生成使用 ESCAPE/正则/字符串拆分；不要让下游写 \`LIKE '%_4'\`，因为 SQL 中 \`_\` 是通配符，会误匹配 \`_14\`、\`_24\`
- \`grep_tables\` / \`grep_columns\` 的结果会自动合并进内部 \`schema_hint\`，无需手填`;

export class NL2SQLTool extends BaseTool {
  static name = 'sql_scan_operator';

  constructor(kwargs = {}) {
    super('sql_scan_operator', _DESCRIPTION, kwargs);

    // 对外暴露 inputs / output_type（对应 Python 类属性）
    this.inputs = {
      question: {
        type: 'string',
        description: 'The question need to be solved.',
      },
      database_name: {
        type: 'string',
        description: 'The name of the database data source where SQL executed.',
      },
    };
    this.output_type = 'string';
  }

  // NL2SQL 短路扩展通过 PRE_HANDLERS.firstHit(PreNl2sqlExecuteHandler, ...) 在 execute() 入口接入

  /**
   * 读取本工具的用户输入（对应 _get_tool_user_inputs）。
   * @param {import('../core/agent_context.js').AgentContext} context
   * @returns {object}
   */
  static _get_tool_user_inputs(context) {
    const tool_inputs = context.data?.['_tool_user_inputs'] ?? {};
    if (typeof tool_inputs !== 'object' || tool_inputs === null || Array.isArray(tool_inputs)) {
      return {};
    }
    const values = tool_inputs['sql_scan_operator'] ?? {};
    return (typeof values === 'object' && values !== null && !Array.isArray(values)) ? values : {};
  }

  /**
   * 清空本工具的用户输入（对应 _clear_tool_user_inputs）。
   * @param {import('../core/agent_context.js').AgentContext} context
   */
  static _clear_tool_user_inputs(context) {
    const tool_inputs = context.data?.['_tool_user_inputs'];
    if (typeof tool_inputs === 'object' && tool_inputs !== null && !Array.isArray(tool_inputs)) {
      delete tool_inputs['sql_scan_operator'];
    }
  }

  /**
   * 执行 sql_scan_operator（扁平流水线）。
   *
   * 流程：样例短路 → schema 召回 → SQL 生成 → 取首候选(中间源校验引用) → 执行 → 返回 Result。
   * 对外契约(返回 Result 结构、scan_hook、外层 landAndSlim 消费)与旧 NL2SQLAgent 实现完全一致。
   *
   * @param {import('../core/agent_context.js').AgentContext} context
   * @param {object} [kwargs]
   * @returns {Promise<Result>}
   */
  async execute(context, kwargs = {}) {
    const question = kwargs.question;
    const schema_hint = kwargs.schema_hint;
    let database = kwargs.database_name;
    const depends_on = kwargs.depends_on;
    const dependency_tables = kwargs.dependency_tables;
    const preferred_intermediate_tables = kwargs.preferred_intermediate_tables;
    const stream_callback = kwargs.stream_callback;
    const entities_in = kwargs.entities;
    const metrics_in = kwargs.metrics;

    /** @type {import('../datasources/business_data_sources.js').BusinessDataSources} */
    const data_sources = context.input_data['data_sources_info']['business_data_sources'];

    // database_name 未指定时，自动使用第一个（也是唯一的）数据源
    if (!database && data_sources.data_sources && data_sources.data_sources.size) {
      const first_ds = data_sources.data_sources.values().next().value;
      database = first_ds?.datasource_name ?? null;
    }
    const datasource = data_sources.get_data_source_by_name(database);

    const scan_hook = async (_db_name, sql) => {
      // business_data_sources 由 JS BusinessDataSources.query 内部注入，无需显式透传
      const result = await data_sources.query(_db_name, sql, {
        project_id: context.project_id,
        session_id: context.session_id,
      });
      if (!result.success) {
        throw new Error(t('SQL 查询失败 `{}`: {}', sql, result.message));
      }
      return new Table(new Set(result.columns), result.data);
    };

    const new_context = context.copy();
    new_context.input_data['user_message'] = question;
    new_context.current_goal = 'check_example_cache';
    if (database) {
      new_context.input_data['database_name'] = database;
    }
    if (schema_hint) {
      new_context.input_data['schema_hint'] = schema_hint;
    }
    // 2026-06-02：透传 agentic_search 上游字段
    if (entities_in) {
      new_context.input_data['entities'] = entities_in;
    }
    if (metrics_in) {
      new_context.input_data['metrics'] = metrics_in;
    }
    if (depends_on) {
      new_context.input_data['depends_on'] = depends_on;
    }
    if (dependency_tables) {
      new_context.input_data['dependency_tables'] = dependency_tables;
    }
    if (preferred_intermediate_tables) {
      new_context.input_data['preferred_intermediate_tables'] = preferred_intermediate_tables;
    }

    // schema 召回需要真实的 DatabaseConnection id（DatabaseDataSource.connection_id）。
    // 绝不能回退到 datasource.id —— 对 DatabaseDataSource 而言 .id 是
    // business_data_sources 绑定行 id（非连接 id），喂进召回会 404
    // 「Database connection not found」（实测并发下的幽灵 id 即此绑定行 id）。
    if (isIntermediateDataSource(datasource)) {
      // 中间源走下方 intermediate_ds 分支，database_id 不参与 DB 连接召回
      new_context.input_data['database_id'] = datasource.id;
    } else {
      const conn_id = datasource?.connection_id ?? null;
      if (!conn_id) {
        logger.error(
          `[NL2SQLTool] 数据源 ${database || ''} (type=${datasource?.constructor?.name}, `
          + `id=${datasource?.id}) 缺少 connection_id，拒绝回退到绑定行 id（会导致召回 404）`,
        );
        throw new Error(t('数据源 {} 缺少有效的数据库连接，无法召回 schema', database || ''));
      }
      new_context.input_data['database_id'] = conn_id;
    }
    new_context.input_data['business_id'] = datasource.business_id;

    logger.info(
      `[NL2SQLTool] 透传实体选择上下文: database_name=${database || ''}, `
      + `schema_hint_tables=${_countSchemaHint(schema_hint, 'tables')}, `
      + `schema_hint_columns=${_countSchemaHint(schema_hint, 'columns')}, `
      + `depends_on=${(depends_on || []).length}, `
      + `dependency_tables=${(dependency_tables || []).length}, `
      + `preferred_intermediate_tables=${(preferred_intermediate_tables || []).length}`,
    );

    // IntermediateDataSource：传递给 NL2SQLAgent 内部处理
    if (isIntermediateDataSource(datasource)) {
      new_context.input_data['intermediate_ds'] = datasource;
    }

    // 传递会话级消歧缓存，避免同一会话重复询问用户
    // 优先从 kwargs 获取（SkillAgent._enrich_tool_params 注入），fallback 到 context.data
    const _cache_from_kwargs = kwargs.session_resolved_cache;
    const _cache_from_data = context.data?.['session_resolved_cache'];
    const session_resolved_cache = _cache_from_kwargs || _cache_from_data;
    if (session_resolved_cache) {
      new_context.input_data['session_resolved_cache'] = session_resolved_cache;
      logger.info(
        '[NL2SQLTool] 传递 session_resolved_cache: '
        + `entities=${(session_resolved_cache.entities || []).length}, `
        + `metrics=${(session_resolved_cache.metrics || []).length}`,
      );
    }

    // 包装 stream_callback：抑制内部 agent 的 recall + 默认 msg_category 为 tool_detail。
    // task_group 由 streaming_context 隐式注入，无需在此显式传。
    const wrapped_callback = NL2SQLTool._wrap_callback(stream_callback);

    const tool_user_inputs = NL2SQLTool._get_tool_user_inputs(context);

    // 扩展层 PreNl2sqlExecute hook：业务视图召回等"NL2SQL 短路"扩展在此切入；
    // handler 内部按 Continuation/扩展私有 state 自行 gate，无 handler 注册时
    // firstHit 返回 null，主线无额外开销
    const pre_result = await PRE_HANDLERS.firstHit(
      PreNl2sqlExecuteHandler,
      {
        question,
        context: new_context,
        datasource,
        dataSources: data_sources,
        streamCallback: wrapped_callback,
        toolUserInputs: tool_user_inputs || {},
      },
    );
    if (pre_result != null && pre_result.shortCircuit && pre_result.result != null) {
      NL2SQLTool._clear_tool_user_inputs(context);
      return pre_result.result;
    }

    // ===== 扁平流水线（替代旧 NL2SQLAgent.run 5-goal 状态机）=====
    // 产出与旧 NL2SQLAgent.run 同构的 Result（_process_agent_result 读 .success/.error/
    // .data['selected_sql']/.data['final_result']/.data['entities']/.data['metrics']）。
    const agent_result = await NL2SQLTool._run_flat_pipeline(
      new_context,
      datasource,
      wrapped_callback,
    );

    if (tool_user_inputs && Object.keys(tool_user_inputs).length) {
      NL2SQLTool._clear_tool_user_inputs(context);
    }
    return NL2SQLTool._process_agent_result(agent_result, database, question, scan_hook);
  }

  /**
   * 扁平 NL2SQL 流水线（替代旧 NL2SQLAgent.run 状态机）。
   *
   * 步骤：样例短路 → schema 召回 → SQL 生成 → 取首候选(中间源校验) → 组装 Result。
   * 不再有 supervisor actor-critic / 重试循环：候选挑选用「取首个 self-consistency 候选」，
   * 准确性由编排 LLM(看到执行结果自主决策) + 外层 align/grep 兜底。
   *
   * 返回 Result 与旧 NL2SQLAgent.run 同构：成功 data 含 selected_sql/entities/metrics；
   * 失败 data 含 final_result{success:false,error,...}。
   *
   * @param {object} ctx - 已 copy 并填好 input_data 的 AgentContext
   * @param {object} datasource - 目标数据源
   * @param {Function} stream_callback - 已包装的回调
   * @returns {Promise<Result>}
   */
  static async _run_flat_pipeline(ctx, datasource, stream_callback) {
    const data = ctx.data;
    const user_message = ctx.input_data['user_message'] || '';
    const database_id = ctx.input_data['database_id'] ?? '';
    const entities = ctx.input_data['entities'] ?? [];
    const metrics = ctx.input_data['metrics'] ?? [];
    const is_intermediate = isIntermediateDataSource(datasource);

    // ---------- 步骤1：样例精确匹配短路（仅非中间源场景）----------
    // similarity≥0.99 直接复用历史 SQL，跳过 LLM 生成。
    let selected_sql = null;
    if (!is_intermediate) {
      try {
        const example_tool = new ExampleRetrievalTool();
        const ex_result = await runTool(example_tool, ctx, {
          user_message,
          database_id,
          project_id: ctx.input_data['project_id'] || ctx.project_id,
          business_id: ctx.input_data['business_id'],
          top_k: 1,
          stream_callback,
        });
        const ex_data = ex_result?.toDict?.()?.data ?? {};
        const examples = ex_data.examples ?? [];
        if (examples.length) {
          const top = examples[0];
          const similarity = top.similarity ?? 0;
          if (similarity >= 0.99) {
            logger.info(`[NL2SQLTool] 命中样例精确匹配 (${(similarity * 100).toFixed(2)}%)，复用缓存 SQL`);
            selected_sql = top.sql ?? '';
          } else {
            // 未达阈值，缓存样例文本供 SQL 生成 prompt 复用
            ctx.input_data['cached_examples_text'] = ex_data.examples_text ?? '';
          }
        }
      } catch (e) {
        logger.warn(`[NL2SQLTool] 样例召回失败，继续正常流程: ${e?.message ?? e}`);
      }
    }

    // ---------- 步骤2：schema 召回 / 中间源 schema 构建 ----------
    if (!selected_sql) {
      if (is_intermediate) {
        // 中间源：从 IntermediateDataSource.profile 构建 schema 文本
        const [schema_text, table_names] = await NL2SQLTool._build_intermediate_schema(datasource, user_message);
        if (!schema_text) {
          return Result.create(
            { final_result: { success: false, error: t('中间数据源中没有可用的表'), data: [], row_count: 0 } },
            t('NL2SQLAgent 执行完成'),
          );
        }
        data['schema_info'] = schema_text;
        data['_intermediate_table_names'] = table_names;
        ctx.input_data['db_connection'] = datasource;
        ctx.input_data['database_id'] = '';
      } else {
        try {
          const schema_tool = new SchemaAnalysisTool();
          const sa_result = await runTool(schema_tool, ctx, {
            user_message,
            database_id,
            project_id: ctx.input_data['project_id'] || ctx.project_id,
            entities,
            metrics,
            schema_hint: ctx.input_data['schema_hint'],
            analysis_depth: 'standard',
            stream_callback,
          });
          const sa_data = sa_result?.toDict?.()?.data ?? {};
          data['schema_info'] = sa_data.schema_info ?? '';
          data['relationships'] = sa_data.relationships ?? [];
        } catch (e) {
          logger.warn(`[NL2SQLTool] schema 召回失败，使用空 schema 继续: ${e?.message ?? e}`);
          data['schema_info'] = '';
          data['relationships'] = [];
        }
      }
      ctx.input_data['schema_info'] = data['schema_info'];

      // ---------- 步骤3：SQL 生成（单次，self-consistency 多候选）----------
      const sql_gen = new SQLGenerationAgent();
      const gen_out = await runAgent(sql_gen, ctx, stream_callback, { method: 'run' });
      const candidates = gen_out?.sql_candidates ?? [];

      if (!candidates.length) {
        const err = gen_out?.error || t('SQL生成为空');
        logger.error(`[NL2SQLTool] SQL 生成失败: ${err}`);
        return Result.create(
          { final_result: { success: false, error: err, data: [], row_count: 0, should_replan_subtasks: true, replan_reason: err } },
          t('NL2SQLAgent 执行完成'),
        );
      }

      // ---------- 步骤4：取首个候选（中间源场景校验引用了中间表）----------
      // 旧 supervisor 的 LLM 审核/挑选已删：self-consistency 已投票，取首候选；
      // 准确性由编排 LLM(看到执行结果)兜底。
      selected_sql = candidates[0]?.sql ?? '';
      if (!selected_sql) {
        return Result.create(
          { final_result: { success: false, error: t('生成的候选 SQL 为空'), data: [], row_count: 0 } },
          t('NL2SQLAgent 执行完成'),
        );
      }
      // 中间源场景：校验 SQL 引用了中间表，否则可能硬编码数值
      const intermediate_tables = data['_intermediate_table_names'];
      if (
        is_intermediate &&
        intermediate_tables &&
        intermediate_tables.length &&
        !intermediate_tables.some((tbl) => selected_sql.toUpperCase().includes(tbl.toUpperCase()))
      ) {
        logger.warn(`[NL2SQLTool] SQL 未引用中间表 ${JSON.stringify(intermediate_tables)}: ${selected_sql}`);
        return Result.create(
          {
            final_result: {
              success: false,
              error: t('SQL未引用中间结果表（可用表: {}），请基于表数据查询而非硬编码数值', intermediate_tables.join(', ')),
              data: [], row_count: 0, should_replan_subtasks: true,
              replan_reason: t('SQL未引用中间结果表'),
            },
          },
          t('NL2SQLAgent 执行完成'),
        );
      }
    }

    // ---------- 步骤5：组装 Result（selected_sql 供 _process_agent_result 执行）----------
    selected_sql = applyExplicitAggregateHints(selected_sql, user_message);
    logger.info(`[NL2SQLTool] 选定 SQL: ${String(selected_sql).slice(0, 120)}`);
    // data 透传给 _ext_propagate（扩展 propagator 从 sourceData 读私有字段）；
    // selected_sql/entities/metrics 是 _process_agent_result 读取的权威字段，显式覆盖。
    return Result.create(
      { ...data, selected_sql, entities, metrics },
      t('NL2SQLAgent 执行完成'),
    );
  }

  /**
   * 从中间结果数据源构建 schema 文本（移植自旧 NL2SQLAgent._build_intermediate_schema）。
   * @param {*} intermediate_ds
   * @param {string} question
   * @returns {Promise<[string, Array<string>]>}
   */
  static async _build_intermediate_schema(intermediate_ds, question) {
    const profiles = await intermediate_ds.profile(question);
    if (!profiles || !profiles.length) {
      return ['', []];
    }

    const schema_parts = [];
    for (const p of profiles) {
      let info = `${t('表名')}: ${p.name}`;
      if (p.description) {
        info += `\n${t('描述')}: ${p.description}`;
      }
      if (p.columns) {
        info += `\n${t('列信息')}:`;
        for (const c of p.columns) {
          const col_desc = [`column_name=${c.name}`];
          if (c.types) {
            const first_type = Array.isArray(c.types) ? c.types[0] : [...c.types][0];
            const type_name = first_type && first_type.name ? first_type.name : String(first_type);
            col_desc.push(`data_type=${type_name}`);
          }
          if (c.description) {
            col_desc.push(`description=${c.description}`);
          }
          if (c.sample_values) {
            col_desc.push(`example_values=${c.sample_values}`);
          }
          info += `\n  - ${col_desc.join(', ')}`;
        }
      }
      if (p.sample_rows) {
        info += `\n${t('样本数据（前{}行）', p.sample_rows.length)}: ${p.sample_rows}`;
      }
      schema_parts.push(info);
    }

    let schema_text = schema_parts.join('\n\n');
    const table_names = profiles.map((p) => p.name);
    schema_text +=
      '\n\n' +
      t(
        '⚠️ 重要：所有中间结果表的数据均来自同一数据库查询结果。' +
          '列名中的单位后缀（如 _万元）仅为标注，未标注单位后缀的同名列使用相同单位，' +
          '请直接进行数值运算，**禁止进行单位转换**。' +
          'SQL 必须引用上述表进行查询，**禁止直接使用字面量数值代替表查询**。',
      );
    return [schema_text, table_names];
  }

  /**
   * 包装 stream_callback：默认抑制 recall + msg_category 归为 tool_detail（对应 _wrap_callback）。
   *
   * task_group 由 streaming_context 的 contextvar 在 StreamCallback 内部自动注入。
   * @param {Function|null} callback
   * @returns {Function|null}
   */
  static _wrap_callback(callback) {
    if (callback == null) {
      return null;
    }
    return async (...args) => {
      // 末位若为 options 对象则补默认值；否则追加一个 options 对象
      const last = args[args.length - 1];
      let opts;
      if (last && typeof last === 'object' && !Array.isArray(last)) {
        opts = last;
      } else {
        opts = {};
        args.push(opts);
      }
      if (!('recall' in opts)) opts.recall = false;
      if (!('msg_category' in opts)) opts.msg_category = 'tool_detail';
      return callback(...args);
    };
  }

  /**
   * 统一处理 NL2SQLAgent 返回结果（对应 _process_agent_result）：提取 SQL → 执行 → 返回。
   *
   * 扩展私有字段透传：通过 result_propagation.propagate(...) 把 agent_result.data 中
   * 扩展（如 ViewMetric）注入的决策键复制到本工具构造的新 Result 上，让上层
   * SuperAgent.observation 仍能读到。
   * @param {Result} agent_result
   * @param {string} database
   * @param {string} question
   * @param {(sourceName: string, sql: string) => Promise<Table>} scan_hook
   * @returns {Promise<Result>}
   */
  static async _process_agent_result(agent_result, database, question, scan_hook) {
    if (!agent_result.success) {
      const error_msg = agent_result.error || 'NL2SQL Agent 执行失败';
      logger.error(`NL2SQL Agent 失败: ${error_msg}`);
      const error_result = Result.createError(error_msg);
      return _ext_propagate(agent_result.data, error_result);
    }

    const sql = agent_result.data?.['selected_sql'];
    if (!sql) {
      const final_result = agent_result.data?.['final_result'] ?? {};
      const error_msg = final_result.error ?? '未生成有效SQL';
      const should_replan_subtasks = Boolean(final_result.should_replan_subtasks);
      const replan_reason = final_result.replan_reason || error_msg;
      logger.error(`NL2SQL Agent 未产出SQL: ${error_msg}`);
      const error_result = Result.createError(error_msg, '', {
        data: {
          error: error_msg,
          should_replan_subtasks,
          replan_reason,
          datasource_name: database,
          'sub-query': question,
        },
        metadata: {
          should_replan_subtasks,
          replan_reason,
        },
      });
      return _ext_propagate(agent_result.data, error_result);
    }

    const operator = new SQLDatabaseScan({ source_name: database, query: question, scan_hook, sql });
    const result = await operator.get_next();
    const final_result = Result.create(
      {
        operator,
        result,
        'sub-query': question,
        resolved_entities: agent_result.data?.['entities'] ?? [],
        resolved_metrics: agent_result.data?.['metrics'] ?? [],
      },
      t('查询执行成功'),
    );
    return _ext_propagate(agent_result.data, final_result);
  }
}

/**
 * 统计 schema_hint 某字段长度（tables 数组 / columns 对象键数）。
 * @param {*} schema_hint
 * @param {'tables'|'columns'} field
 * @returns {number}
 */
function _countSchemaHint(schema_hint, field) {
  if (!schema_hint || typeof schema_hint !== 'object' || Array.isArray(schema_hint)) return 0;
  const v = schema_hint[field];
  if (field === 'tables') return Array.isArray(v) ? v.length : 0;
  // columns 为对象
  return (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).length : 0;
}

export default NL2SQLTool;
