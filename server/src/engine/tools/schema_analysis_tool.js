// 迁移自 agenticdata_kernel/data_analyze/planner/dbagents/tools/schema_analysis_tool.py
/**
 * Schema Analysis Tool - 数据库 Schema 分析工具。
 * 从数据库召回相关表并构建 DDL/Schema 信息(向量/关键词召回 + 实体/指标/explored 协同召回 + 关系扩展)。
 * 1:1 迁移,调用已迁的 SchemaRetrievalService(其方法首参为注入 ctx={query,queryOne})。
 */
import { BaseTool, Result } from '../core/base_tool.js';
import { SchemaRetrievalService } from '../semantic/schema_retrieval_service.js';
import { t } from '../utils/i18n.js';
import { query, queryOne } from '../../db.js';

const logger = {
  info: (...a) => console.info('[SchemaAnalysis]', ...a),
  debug: (...a) => console.debug('[SchemaAnalysis]', ...a),
  warning: (...a) => console.warn('[SchemaAnalysis]', ...a),
  error: (...a) => console.error('[SchemaAnalysis]', ...a),
};

export class SchemaAnalysisTool extends BaseTool {
  constructor() {
    super('schema_analysis', '分析数据库Schema，召回相关表并构建DDL信息', {
      supported_task_types: ['nl2sql', 'schema_analysis'], version: '1.0.0', author: 'System',
    });
  }

  /** @param {import('../core/agent_context.js').AgentContext} context */
  async execute(context, kwargs = {}) {
    try {
      const database_id = kwargs.database_id;
      const user_message = kwargs.user_message ?? '';
      const entities = kwargs.entities ?? [];
      const metrics = kwargs.metrics ?? [];
      const explored_schema = kwargs.explored_schema;
      const schema_hint = kwargs.schema_hint;

      if (!database_id) return Result.createError('缺少database_id参数');

      const ctx = { query, queryOne };
      const db_connection = await this._get_database_connection(ctx, database_id);
      if (!db_connection) return Result.createError(`数据库连接不存在: ${database_id}`);

      // 从实体/指标提取表列(协同召回)
      const [entity_tables, entity_columns] = this._extract_entity_schema_info(entities);
      const [metric_tables, metric_columns] = this._extract_metric_schema_info(metrics);

      let all_tables = new Set([...entity_tables, ...metric_tables]);
      let all_columns = this._merge_columns(entity_columns, metric_columns);

      // 合并 schema_hint(上游精确表/列)
      let hint_tables = new Set();
      if (schema_hint) {
        hint_tables = new Set(schema_hint.tables || []);
        const hint_columns_raw = schema_hint.columns || {};
        if (hint_tables.size) {
          all_tables = new Set([...all_tables, ...hint_tables]);
          logger.info(`schema_hint 补充表: ${[...hint_tables]}`);
        }
        for (const [tbl, cols] of Object.entries(hint_columns_raw)) {
          const colSet = cols instanceof Set ? cols : new Set(cols);
          all_columns[tbl] = all_columns[tbl] ? new Set([...all_columns[tbl], ...colSet]) : colSet;
        }
      }

      // 合并 explored_schema(grep_* 探索)
      if (explored_schema) {
        const explored_tables = explored_schema.tables || new Set();
        const explored_columns = explored_schema.columns || {};
        const exSet = explored_tables instanceof Set ? explored_tables : new Set(explored_tables);
        if (exSet.size) all_tables = new Set([...all_tables, ...exSet]);
        if (Object.keys(explored_columns).length) all_columns = this._merge_columns(all_columns, explored_columns);
      }

      // schema_hint 的表应返回全部列
      const full_recall_tables = hint_tables;

      logger.info(`开始召回表: database_id=${database_id}, q=${String(user_message).slice(0, 50)}...`);
      const recall_result = await this._recall_tables(ctx, database_id, user_message, {
        project_id: context?.project_id ?? null,
        entity_tables: all_tables,
        entity_columns: all_columns,
        full_recall_tables,
      });

      let relevant_tables; let relationships;
      if (Array.isArray(recall_result) && recall_result.length === 2 && Array.isArray(recall_result[0])) {
        [relevant_tables, relationships] = recall_result;
      } else {
        relevant_tables = recall_result; relationships = [];
      }

      if (!relevant_tables || !relevant_tables.length) {
        logger.warning(`未找到相关表: database_id=${database_id}`);
        return Result.create({ schema_info: '', tables_found: 0 }, t('未找到相关表'));
      }

      const db_type = db_connection ? db_connection.db_type : null;
      const schema_info = this._build_schema_string(relevant_tables, db_type, relationships);
      logger.info(`成功构建Schema: ${relevant_tables.length} 个表`);
      return Result.create(
        { schema_info, tables_found: relevant_tables.length, tables: relevant_tables, relationships },
        t('成功分析{}个相关表', relevant_tables.length),
      );
    } catch (e) {
      logger.error(`Schema分析失败: ${e?.message ?? e}`);
      return Result.createError(`Schema分析失败: ${e?.message ?? e}`);
    }
  }

  async _get_database_connection(ctx, database_id) {
    return ctx.queryOne(
      `SELECT id, project_id, db_type, schema_config, extra_config, database, host FROM database_connections WHERE id = $1 AND deleted_at IS NULL`,
      [database_id],
    ).catch(() => null);
  }

  _extract_entity_schema_info(entities) {
    const entity_tables = new Set();
    const entity_columns = {};
    for (const entity of entities || []) {
      const table_name = entity.table_name || '';
      const column_name = entity.column_name || '';
      const schema_name = entity.schema_name || '';
      if (table_name) {
        const full = schema_name && schema_name !== 'default' ? `${schema_name}.${table_name}` : table_name;
        entity_tables.add(full);
        if (column_name) {
          if (!entity_columns[full]) entity_columns[full] = new Set();
          entity_columns[full].add(column_name);
        }
      }
    }
    return [entity_tables, entity_columns];
  }

  _extract_metric_schema_info(metrics) {
    const metric_tables = new Set();
    const metric_columns = {};
    for (const metric of metrics || []) {
      for (const tb of metric.related_tables || []) metric_tables.add(tb);
      const related_columns = metric.related_columns || {};
      for (const [table_name, columns] of Object.entries(related_columns)) {
        if (!metric_columns[table_name]) metric_columns[table_name] = new Set();
        for (const c of columns) metric_columns[table_name].add(c);
      }
    }
    return [metric_tables, metric_columns];
  }

  _merge_columns(columns1, columns2) {
    const merged = {};
    for (const [tbl, cols] of Object.entries(columns1 || {})) merged[tbl] = new Set(cols);
    for (const [tbl, cols] of Object.entries(columns2 || {})) {
      if (!merged[tbl]) merged[tbl] = new Set();
      for (const c of cols) merged[tbl].add(c);
    }
    return merged;
  }

  async _recall_tables(ctx, database_id, user_message = null, opts = {}) {
    const { project_id = null, entity_tables = null, entity_columns = null, full_recall_tables = null } = opts;
    try {
      let tables = await SchemaRetrievalService.search_relevant_tables_with_columns(
        ctx, database_id, user_message, { project_id, limit: 5 },
      );
      logger.info(`向量/关键词召回找到 ${tables.length} 个相关表`);

      if (entity_tables && (entity_tables.size ?? entity_tables.length)) {
        tables = await SchemaRetrievalService.supplement_entity_tables(
          ctx, database_id, tables, entity_tables, entity_columns, full_recall_tables,
        );
      }

      tables = await SchemaRetrievalService.expand_tables_by_relationships(ctx, database_id, tables, 3);
      logger.info(`最终召回 ${tables.length} 个表`);

      const table_names = tables.filter((tb) => tb.table_name).map((tb) => tb.table_name);
      const recalled_table_keys = new Set(
        tables.filter((tb) => tb.table_name).map((tb) => SchemaRetrievalService._table_key(tb.schema_name, tb.table_name || '')),
      );
      let relationships = [];
      if (table_names.length >= 2) {
        relationships = await SchemaRetrievalService.get_table_relationships(ctx, database_id, table_names, recalled_table_keys);
      }

      const allowed = new Set(['table_name', 'schema_name', 'columns', 'retrieval_method']);
      for (const table of tables) {
        for (const key of Object.keys(table)) if (!allowed.has(key)) delete table[key];
      }
      return [tables, relationships];
    } catch (e) {
      logger.error(`表召回失败: ${e?.stack ?? e?.message ?? e}`);
      return [];
    }
  }

  _build_schema_string(tables, db_type = null, relationships = null) {
    if (!tables || !tables.length) return '';
    try {
      const schema_parts = [];
      let enum_column_count = 0;
      const fk_lookup = {};
      if (relationships) {
        for (const rel of relationships) {
          fk_lookup[`${String(rel.source_table).toLowerCase()} ${String(rel.source_column).toLowerCase()}`] = [rel.target_table, rel.target_column, rel.relationship_type || ''];
        }
      }
      for (const table of tables) {
        const table_name = table.table_name || '';
        let schema_name = table.schema_name || '';
        const table_description = table.description || '';
        const columns = table.columns || [];
        if (db_type && ['MYSQL', 'DORIS'].includes(String(db_type).toUpperCase())) schema_name = null;
        if (!table_name) continue;
        const full_table_name = schema_name && schema_name !== 'default' ? `${schema_name}.${table_name}` : table_name;
        let table_info = `表名: ${full_table_name}`;
        if (table_description) table_info += `\n业务规则: ${table_description}`;
        if (columns.length) {
          table_info += '\n列信息:';
          const allowed_column_keys = ['column_name', 'data_type', 'description', 'example_values', 'enum_hint'];
          const table_identifier = schema_name && schema_name !== 'default' ? `${schema_name}.${table_name}` : table_name;
          for (const column of columns) {
            const col_parts = [];
            const column_name = column.column_name || '';
            for (const key of allowed_column_keys) {
              let value = column[key];
              if (key === 'enum_hint' && value && column_name) {
                value = `${table_identifier}.${column_name}: ${value}`;
                enum_column_count += 1;
              }
              if (value) col_parts.push(`${key}=${value}`);
            }
            const fk_key = `${full_table_name.toLowerCase()} ${column_name.toLowerCase()}`;
            if (fk_lookup[fk_key]) {
              const [tgt_table, tgt_col, rel_type] = fk_lookup[fk_key];
              col_parts.push(`FK→${tgt_table}.${tgt_col}(${rel_type})`);
            }
            if (col_parts.length) table_info += `\n  - ${col_parts.join(', ')}`;
          }
        }
        schema_parts.push(table_info);
      }
      if (enum_column_count > 0) logger.info(`Schema信息包含 ${enum_column_count} 个枚举列`);
      let result = schema_parts.join('\n\n');
      if (relationships && relationships.length) {
        const rel_lines = [];
        for (const rel of relationships) {
          const src = `${rel.source_table}.${rel.source_column}`;
          const tgt = `${rel.target_table}.${rel.target_column}`;
          rel_lines.push(`- ${src} → ${tgt}（${rel.relationship_type || ''}）`);
        }
        if (rel_lines.length) {
          result += '\n\n## ⚠️ 表间关系（CRITICAL - JOIN 时优先使用以下外键条件）\n'
            + '以下是已声明的表间外键关系。当 SQL 需要关联这些表时，**必须优先使用声明的外键列作为 JOIN 条件**：\n'
            + rel_lines.join('\n');
        }
      }
      return result;
    } catch (e) {
      logger.error(`构建Schema字符串失败: ${e?.message ?? e}`);
      return `构建Schema时出错: ${e?.message ?? e}`;
    }
  }

  validate_params(kwargs = {}) {
    const database_id = kwargs.database_id;
    return typeof database_id === 'string' && database_id.length > 0;
  }
}

export default SchemaAnalysisTool;
