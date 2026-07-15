// 迁移自 backend/yiw_kernel/semantic_catalogs/database/schema_retrieval_service.py
//
// Schema 召回/检索服务（SuperAgent 取表/列结构的核心）
// 专门处理表和列的召回、智能剪枝等检索操作，供 nl2sql 等下游 1:1 import。
//
// ============================ 桌面版迁移要点 ============================
// 原 Python 版依赖向量库 / embedding（pgvector cosine_distance + core.llm.embed）做表/列召回。
// 桌面版无 ORM/session、无 embedding 服务，本实现改为：
//   - 经【注入的 query/queryOne】直接读 PG 元数据表（table_metadata / column_metadata /
//     relationship_metadata / database_connections / business_data_sources）。
//   - 「向量相似度召回」退化为【关键词 / 名称 / 描述匹配】：从 question 分词后，对
//     table_name/description（表）、column_name/description/example_values（列）做大小写不敏感
//     的子串命中打分，命中数归一化为 0~1 的伪 similarity，再走原有的 filter_by_relative_threshold。
//     ⚠️ 这不是真正的语义召回，召回质量弱于 embedding。
//   - TODO(embedding): 若后续接入向量检索（pgvector / 外部 embedding 服务），把
//     _keywordScoreTables / _keywordScoreColumns 替换为真正的 cosine_distance 查询即可，
//     对外接口（方法名/返回结构）无需变更。
//
// DB 访问约定（与其它已迁文件一致）：所有需要查库的方法第一个参数为 ctx/deps 对象，
// 形如 { query(sql, params)->Promise<rows>, queryOne(sql, params)->Promise<row|null> }，
// 由上层注入（对齐 Python 版 db: AsyncSession 的位置）。本服务【不直接连库】。
// Vastbase 把空串当 NULL：判空一律用 IS NOT NULL，绝不用 <> ''。
// =======================================================================

import { NotFoundError } from '../core/exceptions.js';
import { t } from '../utils/i18n.js';
import { filter_by_relative_threshold } from './similarity_filter.js';
import { embed } from '../core/llm.js';
import { vectorReady } from '../../db.js';

/**
 * 把问题向量化(供 vexdb_cosine_distance 召回)。query_embedding 已给则直接用;
 * 否则调 embed()。任何失败(无 EMBEDDING 模型/扩展未加载)返回 null → 调用方回退关键词。
 * @returns {Promise<number[]|null>}
 */
async function embedQuestion(question, project_id = null, query_embedding = null) {
  if (Array.isArray(query_embedding) && query_embedding.length) return query_embedding;
  if (!vectorReady || !question || !String(question).trim()) return null;
  try {
    const v = await embed(question, { project_id });
    return Array.isArray(v) && v.length ? v : null;
  } catch (e) {
    console.warn(`[SchemaRetrieval] embed 失败,回退关键词召回: ${e?.message ?? e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 内部工具：example_values（PG 里存 JSON 字符串数组）解析
// 对应 ColumnMetadata.example_values_list property。
// ---------------------------------------------------------------------------
function parseExampleValues(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 内部工具：enum_mappings（JSONB）解析为对象
// ---------------------------------------------------------------------------
function parseEnumMappings(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 内部工具：把 PG bool 列规整为 JS boolean（pg 驱动一般已返回 boolean，这里兜底字符串）
// ---------------------------------------------------------------------------
function toBool(v) {
  if (v === true || v === false) return v;
  if (v == null) return false;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase();
  return s === 't' || s === 'true' || s === '1' || s === 'y';
}

// ---------------------------------------------------------------------------
// 关键词召回打分工具（embedding 退化实现）
// 把 question 切成关键词（中英文/数字混合），对候选文本计算命中数 → 伪 similarity(0~1)。
// ---------------------------------------------------------------------------
function tokenizeQuestion(question) {
  if (!question) return [];
  const lower = String(question).toLowerCase();
  // 英文/数字按词切；中文按字切（无分词器时退化为单字 n-gram，召回更宽）。
  const asciiTokens = lower.match(/[a-z0-9_]+/g) || [];
  const cjkChars = lower.match(/[一-鿿]/g) || [];
  // 中文再补 2-gram，提升短词命中率（如「订单」「金额」）
  const cjkBigrams = [];
  for (let i = 0; i + 1 < cjkChars.length; i += 1) {
    cjkBigrams.push(cjkChars[i] + cjkChars[i + 1]);
  }
  const tokens = new Set([...asciiTokens, ...cjkChars, ...cjkBigrams].filter((tk) => tk && tk.length >= 1));
  return [...tokens];
}

/** 对一段文本统计 tokens 的命中数（子串匹配，大小写不敏感） */
function countHits(text, tokens) {
  if (!text || !tokens.length) return 0;
  const hay = String(text).toLowerCase();
  let hits = 0;
  for (const tk of tokens) {
    if (hay.includes(tk)) hits += 1;
  }
  return hits;
}

export class SchemaRetrievalService {
  // ==================== schema 感知 key ====================

  /**
   * 生成 schema 感知的表唯一标识，用于去重。
   * 当 schema_name 为 null 或 'default' 时退化为纯 table_name，
   * 保持对单 schema 数据库的向后兼容。
   * @param {string|null} schema_name
   * @param {string} table_name
   * @returns {string}
   */
  static _table_key(schema_name, table_name) {
    if (schema_name && schema_name !== 'default') {
      return `${schema_name}.${table_name}`;
    }
    return table_name;
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 校验数据库连接是否存在（权限已在路由层验证），返回连接行对象。
   *
   * 自愈：上游有路径会误把 business_data_sources 绑定行 id 当成 connection_id 传进来
   * （DatabaseDataSource.id = 绑定行 id，非真连接 id）。直查不到时，尝试把该 id 当
   * 绑定行 id 解析到它绑定的真实 source_id（= database_connections.id）再查一次，命中即恢复。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @returns {Promise<object>} 连接行（含 extra_config 等原始字段）
   */
  static async _validate_connection(ctx, connection_id) {
    const connection = await ctx.queryOne(
      `SELECT id, project_id, db_type, schema_config, extra_config
         FROM database_connections
        WHERE id = $1 AND deleted_at IS NULL`,
      [connection_id],
    );
    if (connection) return connection;

    // 自愈：把传入 id 当 business_data_sources 绑定行 id 解析真实连接
    const recovered = await SchemaRetrievalService._recover_connection_from_binding(ctx, connection_id);
    if (recovered != null) return recovered;

    throw new NotFoundError(t('数据库连接不存在'));
  }

  /**
   * 把可能的 business_data_sources 绑定行 id 解析为真实 database_connections 行。
   * 命中（传入的确是绑定行 id 且其 source_id 指向存在的连接）→ 返回连接并告警；
   * 否则返回 null（交由调用方报 404）。绝不抛异常打断主流程。
   *
   * @param {{queryOne:Function}} ctx
   * @param {string} maybe_binding_id
   * @returns {Promise<object|null>}
   */
  static async _recover_connection_from_binding(ctx, maybe_binding_id) {
    try {
      const bindingRow = await ctx.queryOne(
        `SELECT source_id FROM business_data_sources
          WHERE id = $1
            AND source_type = 'database_connection'
            AND deleted_at IS NULL`,
        [maybe_binding_id],
      );
      const realSourceId = bindingRow ? bindingRow.source_id : null;
      if (!realSourceId) return null;

      const connection = await ctx.queryOne(
        `SELECT id, project_id, db_type, schema_config, extra_config
           FROM database_connections
          WHERE id = $1 AND deleted_at IS NULL`,
        [realSourceId],
      );
      if (connection != null) {
        console.warn(
          '[CONN-RECOVER] 传入的是 business_data_sources 绑定行 id，已自愈解析到真实连接 | '
          + `binding_id=${maybe_binding_id} -> connection_id=${realSourceId}`,
        );
      }
      return connection;
    } catch (e) {
      console.error(`[CONN-RECOVER] 自愈解析失败: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * 解析连接行的 extra_config（JSON 文本）为对象。对应 extra_config_dict property。
   * @param {object} connection
   * @returns {object}
   */
  static _extraConfigDict(connection) {
    const raw = connection && connection.extra_config;
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  /**
   * 格式化表召回结果。
   * @param {object} table 表行（含 id/table_name/schema_name/description）
   * @param {string} retrieval_method
   * @param {number|null} [distance=null]
   * @returns {object}
   */
  static _format_table_result(table, retrieval_method, distance = null) {
    const result = {
      id: table.id,
      table_name: table.table_name,
      schema_name: table.schema_name,
      description: table.description,
      retrieval_method,
    };
    if (distance != null) {
      result.similarity = 1.0 - (Number(distance) / 2.0);
      result.distance = Number(distance);
    }
    return result;
  }

  /**
   * 格式化列召回结果（统一的列格式化方法）。
   * @param {object} column 列行（PG 行：含 column_name、data_type、is_xxx 标志、example_values、enum_mappings 等）
   * @param {boolean} [include_example_values=true] 是否包含全部示例值（false 时只取前 3 个）
   * @returns {object}
   */
  static _format_column_result(column, include_example_values = true) {
    const result = {
      column_name: column.column_name,
      data_type: column.data_type,
    };

    // 枚举映射：生成 enum_hint 供 LLM 理解枚举值含义
    const enumMappingsObj = parseEnumMappings(column.enum_mappings);
    if (enumMappingsObj) {
      result.enum_mappings = enumMappingsObj;
      try {
        const mappings = (enumMappingsObj.mappings) || [];
        if (mappings.length) {
          const hintLines = [];
          for (const m of mappings) {
            if (!m || typeof m !== 'object') continue;
            const code = String(m.code ?? '').trim();
            const label = String(m.label ?? '').trim();
            if (!code || !label) continue;
            hintLines.push(`${code}=${label}`);
          }
          if (hintLines.length) {
            const enumHint = `枚举值说明：${hintLines.join(', ')}`;
            result.enum_hint = enumHint;
          }
        }
      } catch (_) {
        // 忽略枚举提示生成错误
      }
    }

    // 可选字段
    if (column.description) result.description = column.description;

    const exampleList = parseExampleValues(column.example_values);
    if (exampleList && exampleList.length > 0) {
      result.example_values = include_example_values ? exampleList : exampleList.slice(0, 3);
    }
    if (toBool(column.is_primary_key)) result.is_primary_key = true;
    if (toBool(column.is_indexed)) result.is_indexed = true;
    if (toBool(column.is_foreign_key)) result.is_foreign_key = true;
    if (toBool(column.is_high_recall)) result.is_high_recall = true;

    const defaultValue = column.default_value;
    if (defaultValue && !['NULL', '', 'none', 'None'].includes(defaultValue)) {
      result.default_value = defaultValue;
    }
    // is_nullable 字段：明确为 false 时输出
    if (Object.prototype.hasOwnProperty.call(column, 'is_nullable') && !toBool(column.is_nullable)) {
      result.is_nullable = false;
    }

    return result;
  }

  /**
   * 构建「高召回列」的 SQL 片段（高召回列、主键、外键）。
   * 返回可直接拼进 WHERE 的布尔表达式（无参数）。
   * @returns {string}
   */
  static _build_high_recall_condition() {
    return '(is_high_recall = TRUE OR is_primary_key = TRUE OR is_foreign_key = TRUE)';
  }

  // ==================== 表召回方法 ====================

  /**
   * 基于相似度搜索相关表（带动态阈值过滤，权限已在路由层验证）。
   *
   * ⚠️ embedding 退化：原版用 pgvector cosine_distance 召回；桌面版退化为对
   *    table_name/description 做关键词命中打分（详见文件头）。
   *    query_embedding 参数保留以兼容签名，但当前实现忽略它。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {string} question
   * @param {object} [opts]
   * @param {string|null} [opts.project_id=null]
   * @param {number} [opts.max_limit=20]
   * @param {number} [opts.similarity_threshold=0.3]
   * @param {Array<number>|null} [opts.query_embedding=null] 预留（当前忽略）
   * @returns {Promise<Array<object>>}
   */
  static async search_relevant_tables_vector(ctx, connection_id, question, {
    project_id = null, max_limit = 20, similarity_threshold = 0.3, query_embedding = null,
  } = {}) {
    try {
      await SchemaRetrievalService._validate_connection(ctx, connection_id);

      // ① 优先真·向量召回(vexdb_cosine_distance);失败/无 embedding 回退关键词
      let tables = null;
      const qvec = await embedQuestion(question, project_id, query_embedding);
      if (qvec) {
        tables = await SchemaRetrievalService._vectorScoreTables(ctx, connection_id, qvec, max_limit);
        if (tables && tables.length) console.log(`向量召回(vexdb): ${tables.length} 个表`);
      }

      // ② 关键词兜底(无向量结果时)
      if (!tables || !tables.length) {
        const rows = await ctx.query(
          `SELECT id, table_name, schema_name, description, is_high_recall
             FROM table_metadata
            WHERE database_connection_id = $1 AND deleted_at IS NULL`,
          [connection_id],
        );
        if (!rows.length) return [];
        tables = SchemaRetrievalService._keywordScoreTables(rows, question, max_limit);
        console.log(`关键词召回(向量为空兜底): ${tables.length} 个表`);
      }

      // 应用 Top 差距过滤
      return filter_by_relative_threshold(tables, {
        score_key: 'similarity',
        threshold: similarity_threshold,
        higher_is_better: true,
      });
    } catch (e) {
      console.error(`向量召回失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * vexdb_cosine_distance 向量召回表:对该连接下有 embedding 的表按余弦距离升序取 top-N。
   * similarity = 1 - distance(余弦距离),retrieval_method='vector'。
   * @returns {Promise<Array<object>>}
   */
  static async _vectorScoreTables(ctx, connection_id, queryVec, max_limit) {
    const rows = await ctx.query(
      `SELECT id, table_name, schema_name, description, is_high_recall,
              vexdb_cosine_distance(embedding, vexdb_f32($1)) AS distance
         FROM table_metadata
        WHERE database_connection_id = $2 AND embedding IS NOT NULL AND deleted_at IS NULL
        ORDER BY distance ASC
        LIMIT $3`,
      [JSON.stringify(queryVec), connection_id, max_limit],
    ).catch((e) => { console.warn(`[SchemaRetrieval] 向量召回表 SQL 失败: ${e?.message ?? e}`); return []; });
    return rows.map((tb) => {
      const res = SchemaRetrievalService._format_table_result(tb, 'vector', tb.distance);
      res.similarity = Math.max(0, 1.0 - Number(tb.distance ?? 1));
      res.distance = Number(tb.distance ?? 1);
      return res;
    });
  }

  /**
   * 关键词命中给表打分并按伪 similarity 排序，取前 max_limit 个。
   * 命中数归一化：similarity = min(1, hits / 关键词上界)；无命中给一个很低的基线分。
   * @param {Array<object>} rows 表行
   * @param {string} question
   * @param {number} max_limit
   * @returns {Array<object>}
   */
  static _keywordScoreTables(rows, question, max_limit) {
    const tokens = tokenizeQuestion(question);
    const norm = Math.max(1, Math.min(tokens.length, 5)); // 命中归一化上界（最多看 5 个 token）
    const scored = rows.map((tb) => {
      const hits = countHits(tb.table_name, tokens) + countHits(tb.description, tokens);
      // 无 question/tokens 时（norm 退化），所有表给中性分，保持「召回为空→返回全部」的兜底语义
      const similarity = tokens.length
        ? Math.min(1.0, hits / norm)
        : 0.5;
      const res = SchemaRetrievalService._format_table_result(tb, 'keyword', null);
      res.similarity = similarity;
      res.distance = (1.0 - similarity) * 2.0; // 与 similarity 互逆，保持下游字段存在
      res._hits = hits;
      return res;
    });
    // 命中优先；无命中的也保留（让 filter_by_relative_threshold 决定），但排在后面
    scored.sort((a, b) => (b.similarity - a.similarity));
    const limited = scored.slice(0, max_limit);
    // 清理内部字段
    for (const r of limited) delete r._hits;
    return limited;
  }

  /**
   * 搜索高召回表（返回所有高优先级表，不限制数量，权限已在路由层验证）。
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @returns {Promise<Array<object>>}
   */
  static async search_high_recall_tables(ctx, connection_id) {
    try {
      await SchemaRetrievalService._validate_connection(ctx, connection_id);

      const tablesOrm = await ctx.query(
        `SELECT id, table_name, schema_name, description
           FROM table_metadata
          WHERE is_high_recall = TRUE
            AND database_connection_id = $1
            AND deleted_at IS NULL`,
        [connection_id],
      );

      const tables = tablesOrm.map((tb) => SchemaRetrievalService._format_table_result(tb, 'high_recall'));
      console.log(`high_recall找到 ${tables.length} 个相关表`);
      return tables;
    } catch (e) {
      console.error(`high_recall召回失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 合并向量(关键词)和高召回表结果，去重并标注召回方式。
   * @param {Array<object>} vector_results
   * @param {Array<object>|null} [high_recall_results=null]
   * @returns {Array<object>}
   */
  static _merge_results(vector_results, high_recall_results = null) {
    const tableMap = new Map();

    // 高召回表优先
    if (high_recall_results) {
      for (const result of high_recall_results) {
        result.retrieval_method = 'high_recall';
        tableMap.set(result.id, result);
      }
    }

    // 向量召回结果
    for (const result of vector_results) {
      const tableId = result.id;
      if (!tableMap.has(tableId)) {
        result.retrieval_method = 'vector';
        tableMap.set(tableId, result);
      } else {
        const existing = tableMap.get(tableId);
        const existingMethods = existing.retrieval_method.split(',');
        if (!existingMethods.includes('vector')) {
          existing.retrieval_method = [...existingMethods, 'vector'].sort().join(',');
        }
      }
    }

    return [...tableMap.values()];
  }

  // ==================== 列召回方法 ====================

  /**
   * 跨表召回相关列（列优先策略，权限已在路由层验证）。
   *
   * ⚠️ embedding 退化：原版用 pgvector cosine_distance 跨表召回列；桌面版退化为对
   *    column_name/description/example_values 做关键词命中打分（详见文件头）。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {string} question
   * @param {object} [opts]
   * @param {string|null} [opts.project_id=null]
   * @param {number} [opts.max_limit=30]
   * @param {number} [opts.similarity_threshold=0.3]
   * @param {Array<number>|null} [opts.query_embedding=null] 预留（当前忽略）
   * @returns {Promise<Array<object>>}
   */
  static async search_relevant_columns_cross_tables(ctx, connection_id, question, {
    project_id = null, max_limit = 30, similarity_threshold = 0.3, query_embedding = null,
  } = {}) {
    try {
      await SchemaRetrievalService._validate_connection(ctx, connection_id);

      // ① 优先真·向量召回;失败/无 embedding 回退关键词
      let columns = null;
      const qvec = await embedQuestion(question, project_id, query_embedding);
      if (qvec) {
        columns = await SchemaRetrievalService._vectorScoreColumns(ctx, connection_id, qvec, max_limit);
        if (columns && columns.length) console.log(`向量召回列(vexdb): ${columns.length} 个列`);
      }

      // ② 关键词兜底
      if (!columns || !columns.length) {
        const rows = await ctx.query(
          `SELECT c.id            AS column_id,
                  c.column_name   AS column_name,
                  c.table_id      AS table_id,
                  c.data_type     AS data_type,
                  c.is_nullable   AS is_nullable,
                  c.is_high_recall AS is_high_recall,
                  c.is_primary_key AS is_primary_key,
                  c.is_foreign_key AS is_foreign_key,
                  c.is_indexed    AS is_indexed,
                  c.description   AS description,
                  c.example_values AS example_values,
                  c.default_value AS default_value,
                  t.table_name    AS table_name,
                  t.schema_name   AS schema_name,
                  t.description   AS table_description
             FROM column_metadata c
             JOIN table_metadata t ON c.table_id = t.id
            WHERE t.database_connection_id = $1
              AND c.deleted_at IS NULL
              AND t.deleted_at IS NULL`,
          [connection_id],
        );
        if (!rows.length) return [];
        columns = SchemaRetrievalService._keywordScoreColumns(rows, question, max_limit);
        console.log(`跨表列召回(向量为空兜底): ${columns.length} 个列`);
      }

      // 双重过滤：相对阈值 + 绝对阈值，带智能降级
      const filteredColumns = filter_by_relative_threshold(columns, {
        score_key: 'similarity',
        threshold: similarity_threshold,
        higher_is_better: true,
        min_absolute_threshold: 0.5,
      });

      console.log(`跨表列召回过滤后: ${filteredColumns.length} 个列`);
      return filteredColumns;
    } catch (e) {
      console.error(`跨表列召回失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 关键词命中给跨表列打分并取前 max_limit 个，构造与原版一致的 col_data 结构。
   * @param {Array<object>} rows JOIN 后的列行
   * @param {string} question
   * @param {number} max_limit
   * @returns {Array<object>}
   */
  static _keywordScoreColumns(rows, question, max_limit) {
    const tokens = tokenizeQuestion(question);
    const norm = Math.max(1, Math.min(tokens.length, 5));

    const scored = rows.map((column) => {
      const exampleList = parseExampleValues(column.example_values);
      const exampleText = exampleList.length ? exampleList.join(' ') : '';
      const hits = countHits(column.column_name, tokens)
        + countHits(column.description, tokens)
        + countHits(exampleText, tokens);
      const similarity = tokens.length ? Math.min(1.0, hits / norm) : 0.5;
      return SchemaRetrievalService._columnRowToData(column, similarity, (1.0 - similarity) * 2.0);
    });

    scored.sort((a, b) => (b.similarity - a.similarity));
    return scored.slice(0, max_limit);
  }

  /** 把 JOIN 列行 + similarity/distance 构造成统一 col_data(关键词/向量两条路共用)。 */
  static _columnRowToData(column, similarity, distance) {
    const exampleList = parseExampleValues(column.example_values);
    const colData = {
      column_id: column.column_id,
      column_name: column.column_name,
      table_id: column.table_id,
      table_name: column.table_name,
      schema_name: column.schema_name,
      table_description: column.table_description || '',
      description: column.description || '',
      similarity,
      distance,
      data_type: column.data_type,
      is_nullable: column.is_nullable,
      is_high_recall: toBool(column.is_high_recall),
      is_primary_key: toBool(column.is_primary_key),
      is_foreign_key: toBool(column.is_foreign_key),
    };
    if (exampleList.length > 0) colData.example_values = exampleList;
    if (toBool(column.is_indexed)) colData.is_indexed = true;
    const defaultValue = column.default_value;
    if (defaultValue && !['NULL', '', 'none', 'None'].includes(defaultValue)) {
      colData.default_value = defaultValue;
    }
    return colData;
  }

  /**
   * vexdb_cosine_distance 向量召回跨表列:对有 embedding 的列按余弦距离升序取 top-N。
   * @returns {Promise<Array<object>>}
   */
  static async _vectorScoreColumns(ctx, connection_id, queryVec, max_limit) {
    const rows = await ctx.query(
      `SELECT c.id AS column_id, c.column_name AS column_name, c.table_id AS table_id,
              c.data_type AS data_type, c.is_nullable AS is_nullable, c.is_high_recall AS is_high_recall,
              c.is_primary_key AS is_primary_key, c.is_foreign_key AS is_foreign_key, c.is_indexed AS is_indexed,
              c.description AS description, c.example_values AS example_values, c.default_value AS default_value,
              t.table_name AS table_name, t.schema_name AS schema_name, t.description AS table_description,
              vexdb_cosine_distance(c.embedding, vexdb_f32($1)) AS distance
         FROM column_metadata c
         JOIN table_metadata t ON c.table_id = t.id
        WHERE t.database_connection_id = $2 AND c.embedding IS NOT NULL
          AND c.deleted_at IS NULL AND t.deleted_at IS NULL
        ORDER BY distance ASC
        LIMIT $3`,
      [JSON.stringify(queryVec), connection_id, max_limit],
    ).catch((e) => { console.warn(`[SchemaRetrieval] 向量召回列 SQL 失败: ${e?.message ?? e}`); return []; });
    return rows.map((c) => SchemaRetrievalService._columnRowToData(c, Math.max(0, 1.0 - Number(c.distance ?? 1)), Number(c.distance ?? 1)));
  }

  /**
   * 从召回的列聚合出表，并补充高召回元素（权限已在路由层验证）。
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {Array<object>} recalled_columns 来自 search_relevant_columns_cross_tables
   * @param {string} connection_id
   * @returns {Promise<Array<object>>}
   */
  static async aggregate_tables_from_columns(ctx, recalled_columns, connection_id) {
    try {
      await SchemaRetrievalService._validate_connection(ctx, connection_id);

      // 1. 按 table_id 分组召回的列
      const tableColumnsMap = new Map(); // table_id -> {table_info, columns, column_ids:Set}
      for (const col of recalled_columns) {
        const tableId = col.table_id;
        if (!tableColumnsMap.has(tableId)) {
          tableColumnsMap.set(tableId, {
            table_info: {
              id: tableId,
              table_name: col.table_name,
              schema_name: col.schema_name ?? null,
              description: col.table_description,
              retrieval_method: 'vector',
            },
            columns: [],
            column_ids: new Set(),
          });
        }
        const entry = tableColumnsMap.get(tableId);
        entry.columns.push(SchemaRetrievalService._format_column_result_from_dict(col));
        entry.column_ids.add(col.column_id);
      }

      console.log(`从召回列中聚合出 ${tableColumnsMap.size} 个表`);

      // 2. 为每个表补充高召回列、主键、外键
      for (const [tableId, tableData] of tableColumnsMap.entries()) {
        const recalledColumnIds = [...tableData.column_ids];
        const additionalColumns = await SchemaRetrievalService._queryColumns(ctx, {
          table_id: tableId,
          excludeIds: recalledColumnIds,
          highRecallOnly: true,
        });
        for (const col of additionalColumns) {
          tableData.columns.push(SchemaRetrievalService._format_column_result(col));
        }
        if (additionalColumns.length) {
          console.log(`为表 ${tableData.table_info.table_name} 补充了 ${additionalColumns.length} 个列`);
        }
      }

      // 3. 查询并添加高召回表（及其所有列）
      const highRecallTables = await ctx.query(
        `SELECT id, table_name, schema_name, description
           FROM table_metadata
          WHERE database_connection_id = $1
            AND is_high_recall = TRUE
            AND deleted_at IS NULL`,
        [connection_id],
      );

      for (const table of highRecallTables) {
        const tableId = table.id;

        if (tableColumnsMap.has(tableId)) {
          // 表已在 map 中：合并召回方式标签 + 补全缺失列
          const entry = tableColumnsMap.get(tableId);
          const existingMethods = entry.table_info.retrieval_method.split(',');
          if (!existingMethods.includes('high_recall')) {
            entry.table_info.retrieval_method = [...existingMethods, 'high_recall'].sort().join(',');
          }

          const recalledColumnIds = [...entry.column_ids];
          const missingColumns = await SchemaRetrievalService._queryColumns(ctx, {
            table_id: tableId,
            excludeIds: recalledColumnIds,
          });
          for (const col of missingColumns) {
            entry.columns.push(SchemaRetrievalService._format_column_result(col));
            entry.column_ids.add(col.id);
          }
          if (missingColumns.length) {
            console.log(`高召回表 ${table.table_name} 已被向量召回，补充了 ${missingColumns.length} 个缺失列`);
          }
        } else {
          // 新增高召回表，取其所有列
          const allColumns = await SchemaRetrievalService._queryColumns(ctx, { table_id: tableId });
          tableColumnsMap.set(tableId, {
            table_info: {
              id: tableId,
              table_name: table.table_name,
              schema_name: table.schema_name,
              description: table.description || '',
              retrieval_method: 'high_recall',
            },
            columns: allColumns.map((col) => SchemaRetrievalService._format_column_result(col)),
            column_ids: new Set(allColumns.map((col) => col.id)),
          });
          console.log(`添加高召回表 ${table.table_name}，包含 ${allColumns.length} 个列`);
        }
      }

      // 4. 构建最终结果
      const finalTables = [];
      for (const tableData of tableColumnsMap.values()) {
        const tableInfo = tableData.table_info;
        tableInfo.columns = tableData.columns;
        finalTables.push(tableInfo);
      }

      console.log(`聚合完成，总计 ${finalTables.length} 个表`);
      return finalTables;
    } catch (e) {
      console.error(`表聚合失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 内部：按条件查询某表的列（统一封装 SELECT，避免到处拼 SQL）。
   * @param {{query:Function}} ctx
   * @param {object} opts
   * @param {string} opts.table_id
   * @param {Array<string>} [opts.excludeIds=[]] 排除的 column id
   * @param {boolean} [opts.highRecallOnly=false] 仅高召回列（高召回/主键/外键）
   * @param {Array<string>|null} [opts.entityColNames=null] 额外纳入的实体命中列名（与高召回条件 OR）
   * @returns {Promise<Array<object>>}
   */
  static async _queryColumns(ctx, {
    table_id, excludeIds = [], highRecallOnly = false, entityColNames = null,
  }) {
    const params = [table_id];
    let sql = `SELECT id, table_id, column_name, data_type, is_nullable, default_value,
                      is_primary_key, is_foreign_key, is_indexed, is_high_recall,
                      enum_mappings, description, example_values
                 FROM column_metadata
                WHERE table_id = $1 AND deleted_at IS NULL`;

    if (excludeIds && excludeIds.length) {
      params.push(excludeIds);
      sql += ` AND id <> ALL($${params.length})`;
    }

    if (highRecallOnly && entityColNames && entityColNames.length) {
      params.push(entityColNames);
      sql += ` AND (${SchemaRetrievalService._build_high_recall_condition()} OR column_name = ANY($${params.length}))`;
    } else if (highRecallOnly) {
      sql += ` AND ${SchemaRetrievalService._build_high_recall_condition()}`;
    } else if (entityColNames && entityColNames.length) {
      params.push(entityColNames);
      sql += ` AND (${SchemaRetrievalService._build_high_recall_condition()} OR column_name = ANY($${params.length}))`;
    }

    sql += ' ORDER BY id';
    return ctx.query(sql, params);
  }

  /**
   * 从字典格式化列结果（用于跨表召回）。
   * @param {object} col_dict
   * @returns {object}
   */
  static _format_column_result_from_dict(col_dict) {
    const result = {
      id: col_dict.column_id,
      column_name: col_dict.column_name,
      data_type: col_dict.data_type,
      nullable: col_dict.is_nullable != null ? col_dict.is_nullable : true,
    };

    if (col_dict.example_values) result.example_values = col_dict.example_values;
    if (col_dict.is_primary_key) result.is_primary_key = true;
    if (col_dict.is_indexed) result.is_indexed = true;
    if (col_dict.is_foreign_key) result.is_foreign_key = true;
    if (col_dict.description) result.description = col_dict.description;
    if (col_dict.is_high_recall) result.is_high_recall = true;
    if (col_dict.default_value) result.default_value = col_dict.default_value;
    if (col_dict.similarity != null) result.similarity = col_dict.similarity;

    return result;
  }

  /**
   * 智能召回相关列（关键词相似度 + 优先级规则 + 动态阈值过滤，权限已在路由层验证）。
   *
   * 优先级规则：
   *  1. is_high_recall=true 的列（必选）
   *  2. is_primary_key / is_foreign_key 的列（必选）
   *  3. 关键词相似度 + Top 差距过滤
   *
   * ⚠️ embedding 退化：原版第 3 步用向量相似度；桌面版退化为关键词命中打分。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} table_id
   * @param {string} question
   * @param {object} [opts]
   * @param {string|null} [opts.project_id=null]
   * @param {number} [opts.max_limit=20]
   * @param {number} [opts.similarity_threshold=0.3]
   * @param {Array<number>|null} [opts.query_embedding=null] 预留（当前忽略）
   * @returns {Promise<Array<object>>}
   */
  static async search_relevant_columns(ctx, table_id, question, {
    project_id = null, max_limit = 20, similarity_threshold = 0.3, query_embedding = null,
  } = {}) {
    try {
      // 1. 验证表权限
      const table = await ctx.queryOne(
        `SELECT id, database_connection_id FROM table_metadata
          WHERE id = $1 AND deleted_at IS NULL`,
        [table_id],
      );
      if (!table) {
        console.warn(`表 ${table_id} 不存在`);
        return [];
      }
      await SchemaRetrievalService._validate_connection(ctx, table.database_connection_id);

      // 2. 获取所有列
      const allColumns = await SchemaRetrievalService._queryColumns(ctx, { table_id });
      if (!allColumns.length) return [];

      // 3. 分类：必选列 vs 可选列
      const mustIncludeColumns = [];
      const optionalColumns = [];
      for (const col of allColumns) {
        if (toBool(col.is_high_recall) || toBool(col.is_primary_key) || toBool(col.is_foreign_key)) {
          mustIncludeColumns.push(col);
        } else {
          optionalColumns.push(col);
        }
      }

      // 4. 关键词召回（对可选列打分 + 动态阈值过滤）
      const remainingSlots = max_limit;
      let vectorRankedColumns = [];

      if (optionalColumns.length) {
        const tokens = tokenizeQuestion(question);
        if (tokens.length) {
          const norm = Math.max(1, Math.min(tokens.length, 5));
          const vectorWithScores = optionalColumns.map((col) => {
            const exampleList = parseExampleValues(col.example_values);
            const exampleText = exampleList.length ? exampleList.join(' ') : '';
            const hits = countHits(col.column_name, tokens)
              + countHits(col.description, tokens)
              + countHits(exampleText, tokens);
            return { column: col, similarity: Math.min(1.0, hits / norm) };
          });

          const filteredVector = filter_by_relative_threshold(vectorWithScores, {
            score_key: 'similarity',
            threshold: similarity_threshold,
            higher_is_better: true,
          });
          vectorRankedColumns = filteredVector
            .slice(0, remainingSlots)
            .map((item) => item.column);
        } else {
          // 降级：无 question/tokens 时按列名排序返回
          console.warn('无查询关键词，使用降级策略');
          vectorRankedColumns = [...optionalColumns]
            .sort((a, b) => String(a.column_name).localeCompare(String(b.column_name)))
            .slice(0, remainingSlots);
        }
      }

      // 5. 合并结果（必选列 + 过滤后的关键词列）
      const finalColumns = [...mustIncludeColumns, ...vectorRankedColumns];

      // 6. 格式化输出
      const result = finalColumns.map((col) => SchemaRetrievalService._format_column_result(col));

      console.log(
        `表 ${table_id} 智能召回列: `
        + `必选列=${mustIncludeColumns.length}, `
        + `关键词召回列=${vectorRankedColumns.length}, `
        + `总计=${result.length}`,
      );

      return result;
    } catch (e) {
      console.error(`列智能召回失败: ${e?.message ?? e}`);
      return [];
    }
  }

  // ==================== 组合召回方法（表+列） ====================

  /**
   * 列优先召回流程（不含 LLM 筛选，权限已在路由层验证）。
   *  1. 跨表关键词召回列（带动态阈值过滤）
   *  2. 聚合表 + 补充高召回列和表
   *  3. 返回最终结果
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {string} question
   * @param {object} [opts]
   * @param {string|null} [opts.project_id=null]
   * @param {string|null} [opts.user_id=null]
   * @param {number} [opts.table_limit=5]
   * @returns {Promise<Array<object>>}
   */
  static async search_relevant_schema_column_first(ctx, connection_id, question, {
    project_id = null, user_id = null, table_limit = 5,
  } = {}) {
    try {
      // 列召回数量 = 表数量限制 * 3（每张表平均 3 列）
      const columnLimit = table_limit * 3;
      const recalledColumns = await SchemaRetrievalService.search_relevant_columns_cross_tables(
        ctx, connection_id, question, {
          project_id,
          max_limit: columnLimit,
          similarity_threshold: 0.3,
        },
      );

      console.log(`列优先召回：跨表召回了 ${recalledColumns.length} 个列`);

      if (!recalledColumns.length) {
        console.warn('列优先召回：未找到相关列');
        return [];
      }

      const tablesWithColumns = await SchemaRetrievalService.aggregate_tables_from_columns(
        ctx, recalledColumns, connection_id,
      );

      console.log(`列优先召回：共返回 ${tablesWithColumns.length} 个相关表（含列信息）`);
      return tablesWithColumns;
    } catch (e) {
      console.error(`列优先召回失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 智能召回相关表及其列信息（根据数据库配置自动选择召回策略）。
   *
   * 召回策略由连接的 extra_config 决定：
   *  - retrieval_mode: 'table'(表优先) 或 'column'(列优先)
   *  - table_limit: 返回表数量限制（默认 5）
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {string} question
   * @param {object} [opts]
   * @param {string|null} [opts.project_id=null]
   * @param {number|null} [opts.limit=null] 表数量限制（可选，优先于配置的 table_limit）
   * @returns {Promise<Array<object>>}
   */
  static async search_relevant_tables_with_columns(ctx, connection_id, question, {
    project_id = null, limit = null,
  } = {}) {
    try {
      console.log('🔍 [SchemaRetrieval] ===== Schema召回开始 =====');
      console.log(`🔍 [SchemaRetrieval] connection_id: ${connection_id}`);
      console.log(`🔍 [SchemaRetrieval] project_id: ${project_id}`);
      const qPreview = question && question.length > 100 ? `${question.slice(0, 100)}...` : question;
      console.log(`🔍 [SchemaRetrieval] question: ${qPreview}`);

      // 从连接配置读取召回模式和限制
      const connection = await SchemaRetrievalService._validate_connection(ctx, connection_id);
      const extraConfig = SchemaRetrievalService._extraConfigDict(connection);
      const retrievalMode = extraConfig.retrieval_mode ?? 'table';
      const tableLimit = limit != null ? limit : (extraConfig.table_limit ?? 5);

      console.log(`🔍 [SchemaRetrieval] 数据库 ${connection_id} 召回模式: ${retrievalMode}, 表数量限制: ${tableLimit}`);

      if (retrievalMode === 'column') {
        console.log('使用列优先召回策略');
        return await SchemaRetrievalService.search_relevant_schema_column_first(
          ctx, connection_id, question, { project_id, table_limit: tableLimit },
        );
      }

      // 默认：表优先召回
      console.log('使用表优先召回策略');

      let vectorResults = [];
      let highRecallResults = [];

      // 关键词召回（候选池是最终数量的 4 倍）
      try {
        vectorResults = await SchemaRetrievalService.search_relevant_tables_vector(
          ctx, connection_id, question, {
            project_id,
            max_limit: tableLimit * 4,
            similarity_threshold: 0.20,
          },
        );
        console.log(`向量召回找到 ${vectorResults.length} 个相关表`);
      } catch (e) {
        console.error(`向量召回异常: ${e?.message ?? e}`);
      }

      // 高优先级表召回（不限制数量，不计入 table_limit）
      try {
        highRecallResults = await SchemaRetrievalService.search_high_recall_tables(ctx, connection_id);
        console.log(`高优先级召回找到 ${highRecallResults.length} 个相关表`);
      } catch (e) {
        console.error(`高优先级召回异常: ${e?.message ?? e}`);
      }

      // 向量召回表限制数量；高召回表全部保留
      const vectorResultsLimited = vectorResults.slice(0, tableLimit);
      const mergedResults = SchemaRetrievalService._merge_results(vectorResultsLimited, highRecallResults);

      console.log(
        `最终召回: ${highRecallResults.length} 个高优先级表 + ${vectorResultsLimited.length} 个向量召回表 `
        + `= 共 ${mergedResults.length} 个表`,
      );

      // 为召回的表补充列信息（表召回模式下取所有列）
      const tablesWithColumns = [];
      for (const table of mergedResults) {
        const tableId = table.id;
        if (tableId) {
          const allColumns = await SchemaRetrievalService._queryColumns(ctx, { table_id: tableId });
          table.columns = allColumns.map((col) => SchemaRetrievalService._format_column_result(col));
          tablesWithColumns.push(table);
        }
      }

      console.log(`智能召回共返回 ${tablesWithColumns.length} 个相关表（含列信息）`);
      return tablesWithColumns;
    } catch (e) {
      console.error(`智能召回失败: ${e?.message ?? e}`);
      return [];
    }
  }

  // ==================== 表间关系查询 ====================

  /**
   * 获取已召回表集合之间的关系。
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {Array<string>} table_names 已召回的表名列表（plain name）
   * @param {Set<string>|null} [table_keys=null] schema 感知的表 key 集合（精确过滤，可选）
   * @returns {Promise<Array<object>>}
   */
  static async get_table_relationships(ctx, connection_id, table_names, table_keys = null) {
    if (!table_names || table_names.length < 2) return [];

    try {
      // 查涉及这些表的关系（用 plain name 查询，可能多匹配），JOIN 出 source 表信息
      const rows = await ctx.query(
        `SELECT r.source_table_id   AS source_table_id,
                r.target_table_id   AS target_table_id,
                r.source_column     AS source_column,
                r.target_column     AS target_column,
                r.relationship_type AS relationship_type,
                t.table_name        AS source_table_name,
                t.schema_name       AS source_schema_name
           FROM relationship_metadata r
           JOIN table_metadata t ON r.source_table_id = t.id
          WHERE r.database_connection_id = $1
            AND r.deleted_at IS NULL
            AND t.table_name::text = ANY($2::text[])`,
        [connection_id, table_names],
      );
      if (!rows.length) return [];

      // 获取 target_table_name 映射
      const targetIds = [...new Set(rows.map((row) => row.target_table_id))];
      if (!targetIds.length) return [];

      const targetRows = await ctx.query(
        `SELECT id, table_name, schema_name FROM table_metadata
          WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
        [targetIds],
      );
      const targetInfoMap = new Map();
      for (const r of targetRows) targetInfoMap.set(r.id, [r.table_name, r.schema_name]);

      // 用 schema-aware key 做精确过滤
      const filterKeys = table_keys || new Set(table_names);

      const relationships = [];
      for (const rel of rows) {
        const targetInfo = targetInfoMap.get(rel.target_table_id);
        if (!targetInfo) continue;
        const [targetName, targetSchema] = targetInfo;
        const sourceName = rel.source_table_name;
        const sourceSchema = rel.source_schema_name;

        const sourceKey = SchemaRetrievalService._table_key(sourceSchema, sourceName);
        const targetKey = SchemaRetrievalService._table_key(targetSchema, targetName);

        if (filterKeys.has(sourceKey) && filterKeys.has(targetKey)) {
          const sourceFull = sourceSchema && sourceSchema !== 'default' ? `${sourceSchema}.${sourceName}` : sourceName;
          const targetFull = targetSchema && targetSchema !== 'default' ? `${targetSchema}.${targetName}` : targetName;
          relationships.push({
            source_table: sourceFull,
            source_column: rel.source_column,
            target_table: targetFull,
            target_column: rel.target_column,
            relationship_type: rel.relationship_type,
          });
        }
      }

      return relationships;
    } catch (e) {
      console.warn(`查询表间关系失败: ${e?.message ?? e}`);
      return [];
    }
  }

  // ==================== 关系驱动表扩展 ====================

  /**
   * 基于已召回表的关系，自动扩展关联但未被召回的表。
   * 只取关联列（PK/FK/高召回列），扩展深度限 1 层。
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {Array<object>} existing_tables 已召回的表列表（会被就地追加）
   * @param {number} [max_expand=3] 最多扩展表数量
   * @returns {Promise<Array<object>>}
   */
  static async expand_tables_by_relationships(ctx, connection_id, existing_tables, max_expand = 3) {
    try {
      const recalledTableKeys = new Set(
        existing_tables.map((tb) => SchemaRetrievalService._table_key(tb.schema_name, tb.table_name || '')),
      );
      const recalledTableNames = [...new Set(existing_tables.map((tb) => tb.table_name || ''))];
      if (!recalledTableNames.length) return existing_tables;

      // 查出已召回表的 table_id（plain name 查询，再用 schema-aware key 过滤）
      const recalledRows = await ctx.query(
        `SELECT id, table_name, schema_name FROM table_metadata
          WHERE database_connection_id = $1
            AND table_name::text = ANY($2::text[])
            AND deleted_at IS NULL`,
        [connection_id, recalledTableNames],
      );
      const recalledIds = new Set();
      for (const r of recalledRows) {
        const tkey = SchemaRetrievalService._table_key(r.schema_name, r.table_name);
        if (recalledTableKeys.has(tkey)) recalledIds.add(r.id);
      }
      if (!recalledIds.size) return existing_tables;

      // 单端匹配：查找至少一端在已召回集合中的关系
      const recalledIdArr = [...recalledIds];
      const allRels = await ctx.query(
        `SELECT source_table_id, target_table_id, source_column, target_column
           FROM relationship_metadata
          WHERE database_connection_id = $1
            AND deleted_at IS NULL
            AND (source_table_id::text = ANY($2::text[]) OR target_table_id::text = ANY($2::text[]))`,
        [connection_id, recalledIdArr],
      );
      if (!allRels.length) return existing_tables;

      // 统计未召回表被引用次数（被多张已召回表引用 → 优先级更高）
      const candidateRefCount = new Map(); // table_id -> count
      const candidateRelColumns = new Map(); // table_id -> Set<col>
      for (const rel of allRels) {
        let tid;
        let col;
        if (recalledIds.has(rel.source_table_id) && !recalledIds.has(rel.target_table_id)) {
          tid = rel.target_table_id;
          col = rel.target_column;
        } else if (recalledIds.has(rel.target_table_id) && !recalledIds.has(rel.source_table_id)) {
          tid = rel.source_table_id;
          col = rel.source_column;
        } else {
          continue; // 两端都已召回或都未召回，跳过
        }
        candidateRefCount.set(tid, (candidateRefCount.get(tid) || 0) + 1);
        if (!candidateRelColumns.has(tid)) candidateRelColumns.set(tid, new Set());
        candidateRelColumns.get(tid).add(col);
      }
      if (!candidateRefCount.size) return existing_tables;

      // 按引用次数排序，取 top N
      const sortedCandidates = [...candidateRefCount.entries()].sort((a, b) => b[1] - a[1]);
      const topCandidates = sortedCandidates.slice(0, max_expand);

      // 查候选表的元数据
      const candidateIds = topCandidates.map(([tid]) => tid);
      const candidateRows = await ctx.query(
        `SELECT id, table_name, schema_name FROM table_metadata
          WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
        [candidateIds],
      );
      const candidateTables = new Map();
      for (const tb of candidateRows) candidateTables.set(tb.id, tb);

      for (const [tid, refCount] of topCandidates) {
        const tableOrm = candidateTables.get(tid);
        if (!tableOrm) continue;
        const tkey = SchemaRetrievalService._table_key(tableOrm.schema_name, tableOrm.table_name);
        if (recalledTableKeys.has(tkey)) continue;

        const relColNames = [...(candidateRelColumns.get(tid) || new Set())];
        const columns = await SchemaRetrievalService._get_columns_for_entity_table(ctx, tid, relColNames);

        existing_tables.push({
          table_name: tableOrm.table_name,
          schema_name: tableOrm.schema_name,
          columns,
          retrieval_method: 'relationship_expansion',
        });
        recalledTableKeys.add(tkey);
        console.log(
          `  ✅ 关系扩展: ${tableOrm.table_name}（被 ${refCount} 张已召回表引用，返回 ${columns.length} 列）`,
        );
      }

      return existing_tables;
    } catch (e) {
      console.warn(`关系驱动表扩展失败: ${e?.message ?? e}`);
      return existing_tables;
    }
  }

  // ==================== 实体协同召回方法 ====================

  /**
   * 补充实体命中但未被向量召回的表（权限已在路由层验证）。
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {Array<object>} existing_tables 已召回的表列表（会被就地修改/追加）
   * @param {Set<string>} entity_tables 实体命中的表名集合（可含 "schema.table"）
   * @param {Object<string, Set<string>>|null} [entity_columns=null] 实体命中的列 {table_name: Set(col)}
   * @param {Set<string>|null} [full_recall_tables=null] 需返回全部列的表名集合（schema_hint）
   * @returns {Promise<Array<object>>}
   */
  static async supplement_entity_tables(
    ctx, connection_id, existing_tables, entity_tables, entity_columns = null, full_recall_tables = null,
  ) {
    try {
      if (!entity_tables || (entity_tables.size != null ? entity_tables.size === 0 : !entity_tables.length)) {
        return existing_tables;
      }

      const entityColumns = entity_columns || {};
      const fullRecallTables = full_recall_tables || new Set();
      const entityTablesSet = entity_tables instanceof Set ? entity_tables : new Set(entity_tables);

      // schema 感知 key 去重
      const recalledTableKeys = new Set(
        existing_tables.map((tb) => SchemaRetrievalService._table_key(tb.schema_name, tb.table_name || '')),
      );

      // entity_tables 可能含 "schema.table" 格式，用 recalledTableKeys 对比
      const missingTables = new Set([...entityTablesSet].filter((k) => !recalledTableKeys.has(k)));

      // 即使表已被向量召回，也需补充指标关联列
      for (const tableName of entityTablesSet) {
        const requiredColumns = entityColumns[tableName];
        if (requiredColumns && (requiredColumns.size != null ? requiredColumns.size : requiredColumns.length)) {
          const requiredSet = requiredColumns instanceof Set ? requiredColumns : new Set(requiredColumns);
          if (recalledTableKeys.has(tableName)) {
            for (const table of existing_tables) {
              const existingKey = SchemaRetrievalService._table_key(table.schema_name, table.table_name || '');
              if (existingKey === tableName) {
                const existingCols = new Set((table.columns || []).map((c) => c.column_name));
                const missingCols = [...requiredSet].filter((c) => !existingCols.has(c));
                if (missingCols.length) {
                  console.log(`🔗 [协同召回] 表 ${tableName} 已召回但缺少列: ${missingCols.join(', ')}`);
                  missingTables.add(tableName);
                }
                break;
              }
            }
          }
        }
      }

      if (!missingTables.size) {
        console.log('实体命中的表已全部被向量召回，且列信息完整');
        return existing_tables;
      }

      console.log(`🔗 [协同召回] 补充实体表: ${[...missingTables].join(', ')}`);

      for (const tableName of missingTables) {
        // tableName 可能是 "schema.table" 或纯 "table"
        let schemaPart = null;
        let tablePart = tableName;
        const dotIdx = tableName.indexOf('.');
        if (dotIdx >= 0) {
          schemaPart = tableName.slice(0, dotIdx);
          tablePart = tableName.slice(dotIdx + 1);
        }

        // 同名表可能存在于多个 schema，取所有匹配项逐一处理
        const params = [connection_id, tablePart];
        let sql = `SELECT id, table_name, schema_name, description, is_high_recall
                     FROM table_metadata
                    WHERE database_connection_id = $1
                      AND table_name = $2
                      AND deleted_at IS NULL`;
        if (schemaPart) {
          params.push(schemaPart);
          sql += ` AND schema_name = $${params.length}`;
        }
        const tableOrmList = await ctx.query(sql, params);

        for (const tableOrm of tableOrmList) {
          const tkey = SchemaRetrievalService._table_key(tableOrm.schema_name, tableOrm.table_name);
          const entityColRaw = entityColumns[tableName];
          const entityColNames = entityColRaw
            ? [...(entityColRaw instanceof Set ? entityColRaw : new Set(entityColRaw))]
            : [];

          if (recalledTableKeys.has(tkey)) {
            // 表已被召回，只补缺失列
            for (const existingTable of existing_tables) {
              const existingKey = SchemaRetrievalService._table_key(
                existingTable.schema_name, existingTable.table_name || '',
              );
              if (existingKey === tkey) {
                const existingColNames = new Set((existingTable.columns || []).map((c) => c.column_name));
                const columns = await SchemaRetrievalService._get_columns_for_entity_table(
                  ctx, tableOrm.id, entityColNames,
                );
                const supplementCols = columns.filter((c) => !existingColNames.has(c.column_name));
                if (!existingTable.columns) existingTable.columns = [];
                existingTable.columns.push(...supplementCols);
                console.log(
                  `  ✅ 补充表 ${tkey}，新增 ${supplementCols.length} 列（总共 ${existingTable.columns.length} 列）`,
                );
                break;
              }
            }
          } else {
            // 表未被召回，完整添加
            const isFullRecall = toBool(tableOrm.is_high_recall) || fullRecallTables.has(tableName);
            let columns;
            if (isFullRecall) {
              const allColumns = await SchemaRetrievalService._queryColumns(ctx, { table_id: tableOrm.id });
              columns = allColumns.map((col) => SchemaRetrievalService._format_column_result(col));
              const source = toBool(tableOrm.is_high_recall) ? '高召回表' : 'schema_hint';
              console.log(`  ✅ 补充${source} ${tkey}，返回全部 ${columns.length} 列`);
            } else {
              columns = await SchemaRetrievalService._get_columns_for_entity_table(
                ctx, tableOrm.id, entityColNames,
              );
              console.log(`  ✅ 补充表 ${tkey}，${columns.length} 列（高召回列+实体列）`);
            }

            existing_tables.push({
              table_name: tableOrm.table_name,
              schema_name: tableOrm.schema_name,
              columns,
              retrieval_method: 'entity',
            });
            recalledTableKeys.add(tkey);
          }
        }
      }

      return existing_tables;
    } catch (e) {
      console.error(`实体协同召回失败: ${e?.message ?? e}`);
      return existing_tables;
    }
  }

  /**
   * 获取实体表的列信息（高召回列 + 主键/外键 + 实体命中的列）。
   * 示例值只取前 3 个（include_example_values=false）。
   * @param {{query:Function}} ctx
   * @param {string} table_id
   * @param {Array<string>|Set<string>|null} [entity_col_names=null]
   * @returns {Promise<Array<object>>}
   */
  static async _get_columns_for_entity_table(ctx, table_id, entity_col_names = null) {
    const entityColNames = entity_col_names
      ? [...(entity_col_names instanceof Set ? entity_col_names : new Set(entity_col_names))]
      : [];

    const columnsOrm = await SchemaRetrievalService._queryColumns(ctx, {
      table_id,
      highRecallOnly: true,
      entityColNames: entityColNames.length ? entityColNames : null,
    });

    return columnsOrm.map((col) => SchemaRetrievalService._format_column_result(col, false));
  }
}

export default SchemaRetrievalService;
