// 迁移自 backend/yiw_kernel/semantic_catalogs/business/metric_view_service.py
//
// 指标视图定义管理服务（物化/虚拟指标视图：8 元组结构化定义的 CRUD + 召回）。
// 对外 class MetricViewService 及主要方法名 1:1 保留，供下游 import 不改调用方。
//
// ============================ 桌面版迁移要点 ============================
// 1) DB 访问：桌面版无 ORM/AsyncSession。所有需要查库的方法第一个参数改为 ctx 对象，
//    形如 { query(sql, params)->Promise<rows>, queryOne(sql, params)->Promise<row|null> }，
//    由上层注入（对齐 Python 版 db: AsyncSession 的位置）。本服务【不直接连库】。
//    SQLAlchemy 的 select/where/exists/update → 参数化 SQL（$1...）。
//    .in_() → = ANY($n)。所有查询带 deleted_at IS NULL 软删过滤。
//    Vastbase 把空串当 NULL：判空用 IS NOT NULL，不用 <> ''。
//    record 是从 ctx 取出的普通行对象（plain object），写库需要显式 UPDATE/INSERT，
//    不再有 ORM 的 db.add/commit/refresh，所以这里用显式 SQL（事务由 ctx 上层管理）。
//
// 2) embedding/向量召回：llm.js 无 embed，ctx.query 不能跑 pgvector。
//    - generate_embeddings：无法生成真实向量。改为不写 embedding 列，仅做"状态清理 +
//      统计返回"，保留对外接口与返回形状（success/total/processed/message）。
//      TODO(embedding): 接入向量服务后恢复真实向量写入。
//    - search / has_active_views：原依赖 embedding 列的向量相似度召回，退化为
//      名称/别名/描述的关键词（子串）打分召回，similarity 用归一化命中分模拟。
//      返回结构与 Python 一致（definition/similarity/name/aliases/...）。
//      TODO(embedding): 替换 _keyword_similarity 为真正 cosine_distance。
//      has_active_views 退化为"业务下是否有 active 视图"（不再要求 embedding 非空，
//      因为桌面版根本不写 embedding 列；否则将永远返回 false 导致工具被错误门控）。
//
// 3) 依赖模块 view_metric_definition / view_metric_runtime / metric_view_canonicalizer
//    尚未单独迁移为 .js。为保证本服务自洽且不静默丢功能，这里将其中本服务真正用到的
//    部分（谓词算子枚举、upgrade_metric_view_payload、to_metric_view_definition、
//    canonicalize_metric_view_definition、prioritize_metric_view_matches）就地 1:1
//    端口为模块内私有函数。
//    TODO(extract): 后续若单独迁移上述模块，把这些私有函数抽出改为 import，
//    对外接口不变。
//
// 4) fastapi_cache @cache → 用已迁 cache.js 的 withCache；invalidate_cache 同名复用。
// =======================================================================

import { EntityServiceBase } from './entity_service_base.js';
import { NotFoundError, ValidationError } from '../core/exceptions.js';
import { withCache, invalidate_cache } from '../core/cache.js';
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
    console.warn(`[MetricView] embed 失败,回退关键词召回: ${e?.message ?? e}`);
    return null;
  }
}

const METRIC_VIEW_EMBEDDING_MODEL = 'text-embedding-v3';
const METRIC_VIEW_EMBEDDING_BATCH = 16;

// ===== 状态常量（迁移自 models/metric_view_definition.py）=====
const METRIC_VIEW_STATUS_DRAFT = 'draft';
const METRIC_VIEW_STATUS_ACTIVE = 'active';
const METRIC_VIEW_STATUS_INACTIVE = 'inactive';
const METRIC_VIEW_STATUSES = [
  METRIC_VIEW_STATUS_DRAFT,
  METRIC_VIEW_STATUS_ACTIVE,
  METRIC_VIEW_STATUS_INACTIVE,
];

// metric_view_definitions 表全列（用于 _serialize_record / SELECT *）
const METRIC_VIEW_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'deleted_at',
  'deleted_by',
  'project_id',
  'source_id',
  'name',
  'description',
  'aliases',
  'tables',
  'fixed_predicates',
  'query_dimensions',
  'time_dimension',
  'projections',
  'group_by',
  'sort_spec',
  'embedding',
  'embedding_model',
  'status',
];

// ===========================================================================
//  谓词算子合法集合
//  迁移自 metric_view_service.py 的 _introspect_predicate_operators()：
//  原版从 FixedPredicateSpec.operator / QueryDimensionSpec.op 的 Pydantic Literal
//  反推。桌面版无 pydantic，这里直接内联 Literal 取值（与 view_metric_definition.py 同步）。
//  TODO(extract): 抽离 view_metric_definition 后改回 introspect。
// ===========================================================================
const _ALLOWED_PREDICATE_OPS = new Set(
  [
    // FixedPredicateSpec.operator
    '=', '!=', '>', '>=', '<', '<=', 'like', 'in', 'between', 'is_null', 'is_not_null',
    // QueryDimensionSpec.op
    '=', '>', '>=', '<', '<=', 'in', 'between',
  ].map((op) => String(op).toLowerCase()),
);

/** 把 SQL 操作符规范为小写（LLM/历史输入可能大写，严格枚举为小写）。 */
function _normalize_sql_op(op) {
  if (typeof op !== 'string') return op;
  const lower = op.trim().toLowerCase();
  if (_ALLOWED_PREDICATE_OPS.has(lower)) return lower;
  return op;
}

/** 对一组 dict 中指定 key（operator/op）做小写归一化，返回新数组不变更原对象。 */
function _normalize_op_case_in_list(items, key) {
  if (!items) return items;
  const newItems = [];
  for (const item of items) {
    if (item && typeof item === 'object' && !Array.isArray(item) && item[key] != null) {
      const normalized = { ...item };
      normalized[key] = _normalize_sql_op(item[key]);
      newItems.push(normalized);
    } else {
      newItems.push(item);
    }
  }
  return newItems;
}

// ===========================================================================
//  view_metric_definition.py 内联端口（仅本服务用到的部分）
//  TODO(extract): 拆为独立 view_metric_definition.js 后改为 import。
// ===========================================================================

const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LEGACY_JOIN_PATTERN =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=|>|>=|<|<=)\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const LEGACY_QUALIFIED_FIELD_PATTERN =
  /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_])/g;
const LEGACY_RAW_FIELD_PROJECTION_PATTERN =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+(.+?)\s*$/i;
const LEGACY_AGG_PROJECTION_PATTERN =
  /^\s*(SUM|AVG|MAX|MIN|COUNT)\(\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\)\s+AS\s+(.+?)\s*$/i;
const LEGACY_COUNT_DISTINCT_PROJECTION_PATTERN =
  /^\s*COUNT\s*\(\s*DISTINCT\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\)\s+AS\s+(.+?)\s*$/i;
const LEGACY_ROUND_PROJECTION_PATTERN =
  /^\s*ROUND\(\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(\d+)\s*\)\s+AS\s+(.+?)\s*$/i;

function _sanitize_identifier(text, fallback) {
  let normalized = String(text || '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!normalized) normalized = fallback;
  const first = normalized[0];
  if (!/[A-Za-z]/.test(first) && first !== '_') {
    normalized = `t_${normalized}`;
  }
  return normalized;
}

function _generate_table_key(table_ref, existing_keys, preferred = null, index = 0) {
  let candidate;
  if (preferred) {
    candidate = _sanitize_identifier(preferred, `t_${index}`);
  } else if (index === 0) {
    candidate = 'main';
  } else {
    const tableName = String(table_ref || '').split('.').pop();
    candidate = _sanitize_identifier(tableName, `join_${index}`);
  }

  const base = candidate;
  let suffix = 1;
  while (existing_keys.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  existing_keys.add(candidate);
  return candidate;
}

function _build_legacy_reference_map(tables) {
  const referenceMap = {};
  for (const table of tables) {
    const tableKey = table.table_key;
    referenceMap[tableKey] = tableKey;
    referenceMap[String(table.table_ref || '')] = tableKey;
    const alias = table.alias;
    if (alias) referenceMap[String(alias)] = tableKey;
  }
  return referenceMap;
}

function _parse_legacy_field_string(fieldValue, referenceMap) {
  if (!fieldValue) return null;
  const text = String(fieldValue).trim();
  if (!text) return null;
  const dotIndex = text.indexOf('.');
  if (dotIndex <= 0) return null;
  const prefix = text.slice(0, dotIndex);
  const columnName = text.slice(dotIndex + 1);
  const tableKey = referenceMap[prefix];
  if (!tableKey || !columnName) return null;
  return { table_key: tableKey, column_name: columnName };
}

function _convert_legacy_expression_to_template(expression, referenceMap) {
  return String(expression || '').replace(
    LEGACY_QUALIFIED_FIELD_PATTERN,
    (whole, prefix, columnName) => {
      const tableKey = referenceMap[prefix];
      if (!tableKey) return whole;
      return `{{${tableKey}.${columnName}}}`;
    },
  );
}

function _upgrade_legacy_tables(legacyTables) {
  const existingKeys = new Set();
  const normalizedTables = [];

  legacyTables.forEach((table, index) => {
    const tableRef = String((table && table.table_ref) || '').trim();
    const preferred = (table && (table.table_key || table.key || table.alias)) || null;
    const tableKey = _generate_table_key(tableRef, existingKeys, preferred, index);
    normalizedTables.push({
      table_key: tableKey,
      table_ref: tableRef,
      join_type: table && table.join_type != null ? table.join_type : null,
      alias: table && table.alias != null ? table.alias : null,
      join_condition: table && table.join_condition != null ? table.join_condition : null,
    });
  });

  const referenceMap = _build_legacy_reference_map(normalizedTables);

  const upgradedTables = [];
  normalizedTables.forEach((table, index) => {
    const joinConditions = [];
    if (index > 0) {
      const rawJoinCondition = String(table.join_condition || '').trim();
      if (rawJoinCondition) {
        const matched = LEGACY_JOIN_PATTERN.exec(rawJoinCondition);
        if (matched) {
          const [, leftPrefix, leftColumn, operator, rightPrefix, rightColumn] = matched;
          const leftTableKey = referenceMap[leftPrefix];
          const rightTableKey = referenceMap[rightPrefix];
          if (leftTableKey && rightTableKey) {
            joinConditions.push({
              kind: 'field_compare',
              left: { table_key: leftTableKey, column_name: leftColumn },
              operator,
              right: { table_key: rightTableKey, column_name: rightColumn },
            });
          } else {
            joinConditions.push({
              kind: 'template',
              expression_template: _convert_legacy_expression_to_template(rawJoinCondition, referenceMap),
            });
          }
        } else {
          joinConditions.push({
            kind: 'template',
            expression_template: _convert_legacy_expression_to_template(rawJoinCondition, referenceMap),
          });
        }
      }
    }

    upgradedTables.push({
      table_key: table.table_key,
      table_ref: table.table_ref,
      join_type: table.join_type != null ? table.join_type : null,
      join_conditions: joinConditions,
    });
  });

  return upgradedTables;
}

function _upgrade_legacy_query_dimension(dim, referenceMap) {
  const field = _parse_legacy_field_string(dim.column, referenceMap);
  if (!field) {
    throw new Error(`cannot upgrade query dimension field: ${dim.column}`);
  }
  return {
    name: dim.name,
    field,
    op: dim.op,
    param_type: dim.param_type,
    required: dim.required != null ? dim.required : true,
    allowed_values: dim.allowed_values || [],
  };
}

function _upgrade_legacy_time_dimension(timeDimension, referenceMap) {
  if (!timeDimension) return null;
  const field = _parse_legacy_field_string(timeDimension.column, referenceMap);
  if (!field) {
    throw new Error(`cannot upgrade time dimension field: ${timeDimension.column}`);
  }
  return {
    field,
    op: timeDimension.op || 'between',
    extract_type: timeDimension.extract_type || 'day',
    required: timeDimension.required != null ? timeDimension.required : true,
    output_format: timeDimension.output_format || 'YYYY-MM-DD',
  };
}

function _upgrade_legacy_fixed_predicate(predicate, referenceMap) {
  const text = String(predicate || '').trim();
  if (!text) return { kind: 'template', expression_template: '' };

  let m = /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s+(IS NULL|IS NOT NULL)$/i.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(m[1], referenceMap);
    if (field) {
      return {
        kind: 'null_check',
        field,
        operator: m[2].toUpperCase() === 'IS NULL' ? 'is_null' : 'is_not_null',
      };
    }
  }

  m = /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s+BETWEEN\s+(.+?)\s+AND\s+(.+)$/i.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(m[1], referenceMap);
    if (field) {
      return {
        kind: 'range',
        field,
        operator: 'between',
        start: m[2].trim().replace(/^'|'$/g, ''),
        end: m[3].trim().replace(/^'|'$/g, ''),
      };
    }
  }

  m = /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s+IN\s*\((.+)\)$/i.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(m[1], referenceMap);
    if (field) {
      const values = m[2]
        .split(',')
        .map((item) => item.trim().replace(/^'|'$/g, ''))
        .filter((item) => item);
      return { kind: 'set', field, operator: 'in', values };
    }
  }

  m = /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s*(=|!=|>|>=|<|<=|LIKE)\s*(.+)$/i.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(m[1], referenceMap);
    if (field) {
      return {
        kind: 'comparison',
        field,
        operator: m[2].toLowerCase(),
        value: m[3].trim().replace(/^'|'$/g, ''),
      };
    }
  }

  return {
    kind: 'template',
    expression_template: _convert_legacy_expression_to_template(text, referenceMap),
  };
}

function _upgrade_legacy_projection(projection, referenceMap, index) {
  const text = String(projection || '').trim();

  let m = LEGACY_RAW_FIELD_PROJECTION_PATTERN.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(`${m[1]}.${m[2]}`, referenceMap);
    if (field) {
      return { projection_key: `projection_${index}`, kind: 'field', field, alias: m[3].trim() };
    }
  }

  m = LEGACY_ROUND_PROJECTION_PATTERN.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(`${m[1]}.${m[2]}`, referenceMap);
    if (field) {
      return {
        projection_key: `projection_${index}`,
        kind: 'aggregate',
        field,
        function: 'round',
        precision: parseInt(m[3], 10),
        alias: m[4].trim(),
      };
    }
  }

  m = LEGACY_COUNT_DISTINCT_PROJECTION_PATTERN.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(`${m[1]}.${m[2]}`, referenceMap);
    if (field) {
      return {
        projection_key: `projection_${index}`,
        kind: 'aggregate',
        field,
        function: 'count_distinct',
        alias: m[3].trim(),
      };
    }
  }

  m = LEGACY_AGG_PROJECTION_PATTERN.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(`${m[2]}.${m[3]}`, referenceMap);
    if (field) {
      return {
        projection_key: `projection_${index}`,
        kind: 'aggregate',
        field,
        function: m[1].toLowerCase(),
        alias: m[4].trim(),
      };
    }
  }

  return {
    projection_key: `projection_${index}`,
    kind: 'expression',
    expression_template: _convert_legacy_expression_to_template(text, referenceMap),
  };
}

function _upgrade_legacy_group_by_item(item, referenceMap) {
  const field = _parse_legacy_field_string(item, referenceMap);
  if (field) return { kind: 'field', field };
  return {
    kind: 'expression',
    expression_template: _convert_legacy_expression_to_template(String(item), referenceMap),
  };
}

function _upgrade_legacy_sort_item(item, referenceMap) {
  const text = String(item || '').trim();
  const matched = /^(.*?)\s+(ASC|DESC)$/i.exec(text);
  let direction = 'ASC';
  let target = text;
  if (matched) {
    target = matched[1].trim();
    direction = matched[2].toUpperCase();
  }
  const field = _parse_legacy_field_string(target, referenceMap);
  if (field) return { kind: 'field', field, direction };
  return {
    kind: 'expression',
    direction,
    expression_template: _convert_legacy_expression_to_template(target, referenceMap),
  };
}

function _is_plain_object(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function is_legacy_metric_view_payload(payload) {
  const tables = (payload && payload.tables) || [];
  if (!tables.length) return false;
  if (tables.some((table) => _is_plain_object(table) && !('table_key' in table))) return true;
  if (((payload.fixed_predicates) || []).some((item) => typeof item === 'string')) return true;
  if (((payload.projections) || []).some((item) => typeof item === 'string')) return true;
  if (((payload.group_by) || []).some((item) => typeof item === 'string')) return true;
  const sortSpec = payload.sort_spec || {};
  if (((sortSpec.order_by) || []).some((item) => typeof item === 'string')) return true;
  const queryDimensions = payload.query_dimensions || [];
  if (queryDimensions.some((item) => _is_plain_object(item) && !('field' in item))) return true;
  const timeDimension = payload.time_dimension;
  if (_is_plain_object(timeDimension) && !('field' in timeDimension) && 'column' in timeDimension) return true;
  return false;
}

/**
 * upgrade_metric_view_payload —— 把旧形态（alias/字符串投影等）升级为新 8 元组结构。
 * 与 view_metric_definition.py 同名同行为。
 */
function upgrade_metric_view_payload(payload) {
  if (!payload || !is_legacy_metric_view_payload(payload)) return payload;

  const legacyTables = payload.tables || [];
  const upgradedTables = _upgrade_legacy_tables(legacyTables);
  const referenceMap = {};
  for (const table of upgradedTables) referenceMap[table.table_key] = table.table_key;
  for (const legacyTable of legacyTables) {
    if (_is_plain_object(legacyTable)) {
      const tableRef = String(legacyTable.table_ref || '').trim();
      const alias = String(legacyTable.alias || '').trim();
      const upgradedTable = upgradedTables.find((item) => item.table_ref === tableRef);
      if (upgradedTable) {
        referenceMap[tableRef] = upgradedTable.table_key;
        if (alias) referenceMap[alias] = upgradedTable.table_key;
      }
    }
  }

  const upgradedQueryDimensions = (payload.query_dimensions || []).map((item) =>
    _upgrade_legacy_query_dimension(item, referenceMap),
  );
  const upgradedTimeDimension = _upgrade_legacy_time_dimension(payload.time_dimension, referenceMap);
  const upgradedFixedPredicates = (payload.fixed_predicates || []).map((item) =>
    _upgrade_legacy_fixed_predicate(item, referenceMap),
  );
  const upgradedProjections = (payload.projections || []).map((item, idx) =>
    _upgrade_legacy_projection(item, referenceMap, idx + 1),
  );
  const upgradedGroupBy = (payload.group_by || []).map((item) =>
    _upgrade_legacy_group_by_item(item, referenceMap),
  );

  const sortSpec = payload.sort_spec || {};
  const upgradedSortSpec = {
    order_by: (sortSpec.order_by || []).map((item) => _upgrade_legacy_sort_item(item, referenceMap)),
    limit_default: sortSpec.limit_default != null ? sortSpec.limit_default : 100,
  };

  return {
    ...payload,
    tables: upgradedTables,
    fixed_predicates: upgradedFixedPredicates,
    query_dimensions: upgradedQueryDimensions,
    time_dimension: upgradedTimeDimension,
    projections: upgradedProjections,
    group_by: upgradedGroupBy,
    sort_spec: upgradedSortSpec,
  };
}

/**
 * to_metric_view_definition —— 把一行 metric_view_definition 记录归一化为可用的定义对象。
 * 桌面版无 pydantic 校验：直接返回 upgrade 后的普通对象（形状与 Python model_dump 等价）。
 * 与 view_metric_definition.py 同名。
 */
function to_metric_view_definition(row) {
  const businessSourceId = row.business_source_id || row.source_id;
  const payload = upgrade_metric_view_payload({
    metric_id: row.id,
    name: row.name,
    descriptions: row.description ? [row.description] : [],
    aliases: row.aliases || [],
    source_id: businessSourceId,
    business_source_id: businessSourceId,
    connection_id: row.connection_id != null ? row.connection_id : null,
    tables: row.tables,
    fixed_predicates: row.fixed_predicates || [],
    query_dimensions: row.query_dimensions || [],
    time_dimension: row.time_dimension,
    projections: row.projections,
    group_by: row.group_by || [],
    sort_spec: row.sort_spec || { order_by: [], limit_default: 100 },
  });
  return payload;
}

// ===========================================================================
//  metric_view_canonicalizer.py 内联端口
//  视图定义结构校验 + 表引用规范化（依赖 table_metadata / column_metadata，走 ctx 查库）。
//  TODO(extract): 拆为独立 metric_view_canonicalizer.js 后改为 import。
// ===========================================================================

const FIELD_TOKEN_PATTERN_G =
  /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function build_canonical_table_ref(schemaName, tableName) {
  let schema = String(schemaName || '').trim();
  const name = String(tableName || '').trim();
  if (schema.toLowerCase() === 'default') schema = '';
  return schema ? `${schema}.${name}` : name;
}

function normalize_table_ref(text) {
  return String(text || '').trim().replace(/`/g, '').replace(/"/g, '');
}

function extract_bare_table_name(tableRef) {
  const normalized = normalize_table_ref(tableRef);
  return normalized ? normalized.split('.').pop() : '';
}

function canonical_ref_of(table) {
  return build_canonical_table_ref(table.schema_name, table.table_name);
}

/**
 * 读取数据源下所有表/列元数据，构建表引用解析索引。
 * 对齐 metric_view_canonicalizer.load_table_resolution_index（ctx 查库版）。
 */
async function load_table_resolution_index(ctx, source_id) {
  const businessDataSource = await ctx.queryOne(
    `SELECT id, source_type, source_id
       FROM business_data_sources
      WHERE id = $1 AND deleted_at IS NULL`,
    [source_id],
  );
  if (!businessDataSource) {
    throw new ValidationError('业务数据源不存在');
  }
  if (businessDataSource.source_type !== 'database_connection') {
    throw new ValidationError('当前业务视图仅支持绑定数据库类型的数据源');
  }

  const connectionId = businessDataSource.source_id;
  const tables = await ctx.query(
    `SELECT id, schema_name, table_name
       FROM table_metadata
      WHERE database_connection_id = $1 AND deleted_at IS NULL`,
    [connectionId],
  );

  const tableIds = tables.map((t) => t.id);
  let columnsByTable = new Map();
  if (tableIds.length) {
    const columns = await ctx.query(
      `SELECT table_id, column_name
         FROM column_metadata
        WHERE table_id::text = ANY($1::text[]) AND deleted_at IS NULL`,
      [tableIds],
    );
    for (const col of columns) {
      if (!col.column_name) continue;
      if (!columnsByTable.has(col.table_id)) columnsByTable.set(col.table_id, new Set());
      columnsByTable.get(col.table_id).add(String(col.column_name));
    }
  }

  const byCanonicalRef = new Map();
  const byBareName = new Map();
  for (const table of tables) {
    const canonical = {
      table_id: table.id,
      schema_name: table.schema_name,
      table_name: table.table_name,
      columns: columnsByTable.get(table.id) || new Set(),
    };
    byCanonicalRef.set(canonical_ref_of(canonical), canonical);
    const bareName = canonical.table_name;
    if (!byBareName.has(bareName)) byBareName.set(bareName, []);
    byBareName.get(bareName).push(canonical);
  }

  return { by_canonical_ref: byCanonicalRef, by_bare_name: byBareName };
}

function resolve_table_ref_strict(tableRef, index) {
  const normalized = normalize_table_ref(tableRef);
  if (!normalized) throw new ValidationError('查询表缺少 table_ref');

  const exact = index.by_canonical_ref.get(normalized);
  if (exact) return exact;

  const bareName = extract_bare_table_name(normalized);
  const bareMatches = index.by_bare_name.get(bareName) || [];
  if (bareMatches.length === 1) return bareMatches[0];
  if (bareMatches.length > 1) {
    const choices = bareMatches
      .map((item) => canonical_ref_of(item))
      .sort()
      .join('、');
    throw new ValidationError(
      `表引用 '${tableRef}' 不唯一，请改为 canonical table_ref。可选值：${choices}`,
    );
  }
  throw new ValidationError(`表引用 '${tableRef}' 在当前数据源中不存在或尚未同步`);
}

function validate_table_keys(metricDefinition) {
  const seen = new Set();
  (metricDefinition.tables || []).forEach((table, idx) => {
    const tableKey = String((table && table.table_key) || '').trim();
    const index = idx + 1;
    if (!tableKey) throw new ValidationError(`第 ${index} 个查询表缺少 table_key`);
    if (!SQL_IDENTIFIER_PATTERN.test(tableKey)) {
      throw new ValidationError(`table_key '${tableKey}' 不是合法标识符`);
    }
    if (seen.has(tableKey)) {
      throw new ValidationError(`table_key '${tableKey}' 重复，请保持唯一`);
    }
    seen.add(tableKey);
  });
}

function _validate_field_ref(field, tableIndex, context, requireColumn = true) {
  if (!field) return;
  const table = tableIndex[field.table_key];
  if (!table) {
    throw new ValidationError(`${context} 引用了未声明的 table_key '${field.table_key}'`);
  }
  if (requireColumn && !table.columns.has(field.column_name)) {
    throw new ValidationError(
      `${context} 引用了不存在的列 '${field.column_name}'，所属表: ${canonical_ref_of(table)}`,
    );
  }
}

function _validate_expression_template(expressionTemplate, tableIndex, context, requireColumn = true) {
  if (!expressionTemplate) return;
  let match;
  FIELD_TOKEN_PATTERN_G.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((match = FIELD_TOKEN_PATTERN_G.exec(expressionTemplate)) !== null) {
    _validate_field_ref(
      { table_key: match[1], column_name: match[2] },
      tableIndex,
      context,
      requireColumn,
    );
  }
}

function _validate_join_conditions(joinConditions, tableIndex, context, requireColumn = true) {
  for (const condition of joinConditions || []) {
    if (condition.kind === 'template') {
      _validate_expression_template(condition.expression_template, tableIndex, context, requireColumn);
      continue;
    }
    _validate_field_ref(condition.left, tableIndex, `${context} 左侧`, requireColumn);
    _validate_field_ref(condition.right, tableIndex, `${context} 右侧`, requireColumn);
  }
}

function _validate_fixed_predicates(predicates, tableIndex, requireColumn = true) {
  (predicates || []).forEach((predicate, idx) => {
    const context = `固定条件 #${idx + 1}`;
    if (predicate.kind === 'template') {
      _validate_expression_template(predicate.expression_template, tableIndex, context, requireColumn);
      return;
    }
    _validate_field_ref(predicate.field, tableIndex, context, requireColumn);
  });
}

function _validate_query_dimensions(dimensions, tableIndex, requireColumn = true) {
  (dimensions || []).forEach((dimension, idx) => {
    _validate_field_ref(dimension.field, tableIndex, `查询维度 #${idx + 1}`, requireColumn);
  });
}

function _validate_time_dimension(timeDimension, tableIndex, requireColumn = true) {
  if (timeDimension) {
    _validate_field_ref(timeDimension.field, tableIndex, '时间维度', requireColumn);
  }
}

function _validate_projections(projections, tableIndex, requireColumn = true) {
  (projections || []).forEach((projection, idx) => {
    const context = `投影列 #${idx + 1}`;
    if (projection.kind === 'expression') {
      _validate_expression_template(projection.expression_template, tableIndex, context, requireColumn);
      return;
    }
    _validate_field_ref(projection.field, tableIndex, context, requireColumn);
  });
}

function _validate_group_by(groupByItems, tableIndex, requireColumn = true) {
  (groupByItems || []).forEach((item, idx) => {
    const context = `GROUP BY #${idx + 1}`;
    if (item.kind === 'expression') {
      _validate_expression_template(item.expression_template, tableIndex, context, requireColumn);
      return;
    }
    _validate_field_ref(item.field, tableIndex, context, requireColumn);
  });
}

function _validate_sort_spec(orderItems, tableIndex, requireColumn = true) {
  (orderItems || []).forEach((item, idx) => {
    const context = `排序规则 #${idx + 1}`;
    if (item.kind === 'expression') {
      _validate_expression_template(item.expression_template, tableIndex, context, requireColumn);
      return;
    }
    if (item.kind === 'field') {
      _validate_field_ref(item.field, tableIndex, context, requireColumn);
    }
  });
}

function _build_intra_table_index(metricDefinition) {
  const tableIndex = {};
  for (const table of metricDefinition.tables || []) {
    tableIndex[table.table_key] = {
      table_id: '',
      schema_name: null,
      table_name: table.table_ref,
      columns: new Set(),
    };
  }
  return tableIndex;
}

function validate_metric_view_references(metricDefinition) {
  validate_table_keys(metricDefinition);
  const tableIndex = _build_intra_table_index(metricDefinition);

  (metricDefinition.tables || []).forEach((table, idx) => {
    _validate_join_conditions(table.join_conditions, tableIndex, `JOIN 表 #${idx + 1}`, false);
  });
  _validate_fixed_predicates(metricDefinition.fixed_predicates, tableIndex, false);
  _validate_query_dimensions(metricDefinition.query_dimensions, tableIndex, false);
  _validate_time_dimension(metricDefinition.time_dimension, tableIndex, false);
  _validate_projections(metricDefinition.projections, tableIndex, false);
  _validate_group_by(metricDefinition.group_by, tableIndex, false);
  _validate_sort_spec(
    (metricDefinition.sort_spec && metricDefinition.sort_spec.order_by) || [],
    tableIndex,
    false,
  );
}

function validate_metric_view_against_source(metricDefinition, resolvedTables) {
  (metricDefinition.tables || []).forEach((table, idx) => {
    _validate_join_conditions(table.join_conditions, resolvedTables, `JOIN 表 #${idx + 1}`);
  });
  _validate_fixed_predicates(metricDefinition.fixed_predicates, resolvedTables);
  _validate_query_dimensions(metricDefinition.query_dimensions, resolvedTables);
  _validate_time_dimension(metricDefinition.time_dimension, resolvedTables);
  _validate_projections(metricDefinition.projections, resolvedTables);
  _validate_group_by(metricDefinition.group_by, resolvedTables);
  _validate_sort_spec((metricDefinition.sort_spec && metricDefinition.sort_spec.order_by) || [], resolvedTables);
}

/**
 * canonicalize_metric_view_definition —— 严格结构 + 表引用规范化。
 * 返回带规范化 tables 的新定义对象（普通对象，形状等价 model_dump）。
 */
async function canonicalize_metric_view_definition(ctx, metricDefinition, { source_id, strict_source_resolution = true } = {}) {
  validate_metric_view_references(metricDefinition);

  if (!metricDefinition.tables || metricDefinition.tables.length === 0) {
    return metricDefinition;
  }

  if (!source_id) {
    if (strict_source_resolution) {
      throw new ValidationError('指标视图必须绑定数据源，才能保存稳定的表引用');
    }
    return metricDefinition;
  }

  const tableResolutionIndex = await load_table_resolution_index(ctx, source_id);
  if (tableResolutionIndex.by_canonical_ref.size === 0) {
    throw new ValidationError('当前数据源尚未同步表结构，无法校验业务视图定义');
  }

  const resolvedTables = {};
  const canonicalTables = [];
  for (const table of metricDefinition.tables) {
    const resolved = resolve_table_ref_strict(table.table_ref, tableResolutionIndex);
    resolvedTables[table.table_key] = resolved;
    canonicalTables.push({
      table_key: table.table_key,
      table_ref: canonical_ref_of(resolved),
      join_type: table.join_type != null ? table.join_type : null,
      join_conditions: table.join_conditions || [],
    });
  }

  validate_metric_view_against_source(metricDefinition, resolvedTables);

  return { ...metricDefinition, tables: canonicalTables };
}

// ===========================================================================
//  view_metric_runtime.py 内联端口（prioritize_metric_view_matches 及其依赖）
//  TODO(extract): 拆为独立 view_metric_runtime.js 后改为 import。
// ===========================================================================

const METRIC_VIEW_ANCHOR_NGRAM_MIN = 3;
const METRIC_VIEW_ANCHOR_NGRAM_MAX = 8;
const EXPLICIT_TIME_KEYWORDS = [
  '年', '月', '日', '季度', 'q1', 'q2', 'q3', 'q4', '本月', '上月', '近', '最近', '同比', '环比',
];

function normalize_metric_view_text(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[\s\-_.,，。；;:：/\\()（）[\]{}]+/g, '');
  return normalized.replace(/的/g, '');
}

function has_metric_view_alias_exact_match(question, match) {
  const normalizedQuestion = normalize_metric_view_text(question);
  if (!normalizedQuestion) return false;

  const candidates = [match.name || ''];
  candidates.push(...(match.aliases || []));
  for (const candidate of candidates) {
    const normalizedCandidate = normalize_metric_view_text(candidate);
    if (normalizedCandidate && normalizedQuestion.includes(normalizedCandidate)) return true;
  }
  return false;
}

function _definition_field(definition, key) {
  if (_is_plain_object(definition)) return definition[key];
  return definition != null ? definition[key] : undefined;
}

function has_metric_view_dimension_value_match(question, match) {
  const normalizedQuestion = normalize_metric_view_text(question);
  if (!normalizedQuestion) return false;

  const queryDimensions = _definition_field(match.definition, 'query_dimensions') || [];
  for (const dimension of queryDimensions) {
    const allowedValues = (_is_plain_object(dimension) ? dimension.allowed_values : dimension?.allowed_values) || [];
    const paramType = _is_plain_object(dimension) ? dimension.param_type : dimension?.param_type;
    if (paramType !== 'discrete') continue;
    for (const candidate of allowedValues) {
      const normalizedCandidate = normalize_metric_view_text(String(candidate));
      if (normalizedCandidate && normalizedQuestion.includes(normalizedCandidate)) return true;
    }
  }
  return false;
}

function extract_semantic_anchor_ngrams(text) {
  const normalizedText = normalize_metric_view_text(text);
  if (!normalizedText) return new Set();

  const anchors = new Set();
  const textLength = normalizedText.length;
  const maxNgram = Math.min(METRIC_VIEW_ANCHOR_NGRAM_MAX, textLength);
  for (let size = METRIC_VIEW_ANCHOR_NGRAM_MIN; size <= maxNgram; size += 1) {
    for (let start = 0; start <= textLength - size; start += 1) {
      const fragment = normalizedText.slice(start, start + size);
      if (/^[0-9a-z]+$/.test(fragment)) continue;
      anchors.add(fragment);
    }
  }
  return anchors;
}

function build_match_semantic_anchor_text(match) {
  const textParts = [match.name || '', match.description || ''];
  textParts.push(...(match.aliases || []));
  return textParts.filter((part) => part).join(' ');
}

function score_semantic_anchor_overlap(sharedAnchors, anchorDocumentFrequency) {
  let score = 0.0;
  for (const anchor of sharedAnchors) {
    const documentFrequency = anchorDocumentFrequency.get(anchor) || 1;
    score += (anchor.length ** 2) / documentFrequency;
  }
  return score;
}

function build_match_semantic_anchor_scores(question, matches) {
  const questionAnchors = extract_semantic_anchor_ngrams(question);
  const scores = {};
  if (questionAnchors.size === 0 || !matches.length) {
    matches.forEach((_match, index) => {
      scores[index] = 0.0;
    });
    return scores;
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
      anchorDocumentFrequency.set(anchor, (anchorDocumentFrequency.get(anchor) || 0) + 1);
    }
  });

  matches.forEach((_match, index) => {
    scores[index] = score_semantic_anchor_overlap(
      sharedAnchorSets[index] || new Set(),
      anchorDocumentFrequency,
    );
  });
  return scores;
}

function has_metric_view_fixed_value_match(question, match) {
  const normalizedQuestion = normalize_metric_view_text(question);
  if (!normalizedQuestion) return false;

  const fixedPredicates = _definition_field(match.definition, 'fixed_predicates') || [];
  for (const predicate of fixedPredicates) {
    const kind = _is_plain_object(predicate) ? predicate.kind : predicate?.kind;
    const value = _is_plain_object(predicate) ? predicate.value : predicate?.value;
    const values = (_is_plain_object(predicate) ? predicate.values : predicate?.values) || [];

    if (kind === 'comparison' && value != null) {
      const normalizedCandidate = normalize_metric_view_text(String(value));
      if (normalizedCandidate && normalizedQuestion.includes(normalizedCandidate)) return true;
    }
    if (kind === 'set') {
      for (const candidate of values) {
        const normalizedCandidate = normalize_metric_view_text(String(candidate));
        if (normalizedCandidate && normalizedQuestion.includes(normalizedCandidate)) return true;
      }
    }
  }
  return false;
}

function question_has_explicit_time_constraint(question) {
  const normalizedQuestion = normalize_metric_view_text(question);
  if (!normalizedQuestion) return false;
  return EXPLICIT_TIME_KEYWORDS.some((keyword) =>
    normalizedQuestion.includes(normalize_metric_view_text(keyword)),
  );
}

function has_metric_view_time_dimension_match(question, match) {
  if (!question_has_explicit_time_constraint(question)) return false;
  const timeDimension = _definition_field(match.definition, 'time_dimension');
  return Boolean(timeDimension);
}

/**
 * prioritize_metric_view_matches —— 对召回的视图候选做多键稳定排序。
 * 与 view_metric_runtime.py 同名同序：alias 精确命中 > 语义锚点分 > 时间维度命中 >
 * 维度值命中 > 固定值命中 > similarity > 原始顺序（稳定）。
 */
function prioritize_metric_view_matches(question, matches) {
  if (!matches || !matches.length) return [];

  const semanticAnchorScores = build_match_semantic_anchor_scores(question, matches);
  const indexed = matches.map((match, index) => ({ index, match }));

  // 构造可比较的元组（与 Python sort(key=..., reverse=True) 等价的降序比较）
  const sortKey = ({ index, match }) => [
    has_metric_view_alias_exact_match(question, match) ? 1 : 0,
    semanticAnchorScores[index] || 0.0,
    has_metric_view_time_dimension_match(question, match) ? 1 : 0,
    has_metric_view_dimension_value_match(question, match) ? 1 : 0,
    has_metric_view_fixed_value_match(question, match) ? 1 : 0,
    Number(match.similarity || 0.0),
    -index,
  ];

  indexed.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] > kb[i]) return -1;
      if (ka[i] < kb[i]) return 1;
    }
    return 0;
  });

  return indexed.map(({ match }) => match);
}

// ===========================================================================
//  关键词召回打分（embedding 退化实现）
//  TODO(embedding): 接入向量服务后替换为 cosine_distance 召回。
// ===========================================================================

/** 把文本切成关键词（中英文/数字混合的连续片段 + 单字中文）。 */
function _tokenize(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase();
  const tokens = new Set();
  // 英文/数字连续片段
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    if (m[0].length >= 2) tokens.add(m[0]);
  }
  // 中文单字 + 2gram（粗粒度，够做子串召回）
  const cjk = lower.match(/[一-鿿]+/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i < seg.length; i += 1) {
      tokens.add(seg[i]);
      if (i + 1 < seg.length) tokens.add(seg.slice(i, i + 2));
    }
  }
  return [...tokens];
}

/**
 * 关键词伪 similarity：query token 在候选文本中命中数 / query token 总数，归一到 0~1。
 * 仅用于桌面版无 embedding 时的退化召回。
 */
function _keyword_similarity(queryText, candidateText) {
  const queryTokens = _tokenize(queryText);
  if (!queryTokens.length) return 0.0;
  const haystack = String(candidateText || '').toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / queryTokens.length;
}

// ===========================================================================
//  MetricViewService
// ===========================================================================

export class MetricViewService extends EntityServiceBase {
  /** 指标视图定义管理服务 */

  static _EMBEDDING_ALLOWED_VALUES_LIMIT = 20;

  /**
   * 业务下是否有任何激活视图（给 SuperAgent 工具门控用，高频路径走缓存）。
   *
   * 桌面版无 embedding 列写入，故不再要求 embedding 非空——只问"项目里有没有 active 视图"。
   * 失效协议：写操作后调 invalidate_metric_view_cache 同步清除。
   *
   * @param {object} ctx - 注入的查库上下文 { query, queryOne }
   * @param {string} project_id
   * @returns {Promise<boolean>}
   */
  static async has_active_views(ctx, project_id) {
    if (!project_id) return false;
    return MetricViewService._has_active_views_cached(ctx, project_id);
  }

  // 缓存键必须只由 project_id 决定（ctx 每次注入、不能进 key）。这里用自定义 keyBuilder
  // 显式构造 `has_active_views:project_id=<id>`，从而：
  //   1) 不同 project_id 互不串缓存；2) invalidate_cache('has_active_views',{project_id}) 精确匹配清除。
  static _has_active_views_cached = withCache({
    expire: 120,
    keyBuilder: (fn, _ns, { args = [] } = {}) => `${fn.name}:project_id=${args[1]}`,
  })(
    async function has_active_views(ctx, project_id) {
      const row = await ctx.queryOne(
        `SELECT 1
           FROM metric_view_definitions
          WHERE project_id = $1
            AND deleted_at IS NULL
            AND status = $2
          LIMIT 1`,
        [project_id, METRIC_VIEW_STATUS_ACTIVE],
      );
      return Boolean(row);
    },
  );

  /** 清除指标视图相关缓存——项目方 create/update/delete/embedding 后调用。 */
  static async invalidate_metric_view_cache(project_id) {
    if (!project_id) return;
    await invalidate_cache('has_active_views', { project_id });
  }

  /**
   * 构建指标视图召回文本（Phase 1 轻量规则增强）。
   * @param {object} record - metric_view_definition 行对象
   * @returns {string}
   */
  static _build_embedding_text(record) {
    const parts = [record.name];
    if (record.aliases) {
      for (const alias of record.aliases) {
        if (alias) parts.push(String(alias));
      }
    }
    if (record.description) parts.push(record.description);

    if (record.tables) {
      const tableNames = [];
      for (const table of record.tables) {
        if (_is_plain_object(table)) {
          const tableRef = table.table_ref || table.table_key || table.alias;
          if (tableRef) tableNames.push(String(tableRef));
        }
      }
      if (tableNames.length) parts.push(`tables ${tableNames.join(' ')}`);
    }

    if (record.query_dimensions) {
      const dimNames = [];
      const discreteValueTokens = [];
      for (const dim of record.query_dimensions) {
        if (!_is_plain_object(dim)) continue;
        if (dim.name) dimNames.push(String(dim.name));
        const field = dim.field || {};
        if (_is_plain_object(field)) {
          for (const token of [field.table_key, field.column_name]) {
            if (token) dimNames.push(String(token));
          }
        }
        const allowedValues = dim.allowed_values || [];
        if (
          dim.param_type === 'discrete'
          && allowedValues.length
          && allowedValues.length <= MetricViewService._EMBEDDING_ALLOWED_VALUES_LIMIT
        ) {
          for (const value of allowedValues.slice(0, MetricViewService._EMBEDDING_ALLOWED_VALUES_LIMIT)) {
            if (value) discreteValueTokens.push(String(value));
          }
        }
      }
      if (dimNames.length) parts.push(`dimensions ${dimNames.join(' ')}`);
      if (discreteValueTokens.length) parts.push(`dimension_values ${discreteValueTokens.join(' ')}`);
    }

    if (record.time_dimension && _is_plain_object(record.time_dimension)) {
      const field = record.time_dimension.field || {};
      let timeColumn = null;
      if (_is_plain_object(field)) {
        const tableKey = field.table_key;
        const columnName = field.column_name;
        if (tableKey && columnName) timeColumn = `${tableKey}.${columnName}`;
      }
      if (!timeColumn) timeColumn = record.time_dimension.column;
      const extractType = record.time_dimension.extract_type;
      if (timeColumn || extractType) {
        parts.push(`time ${[timeColumn, extractType].filter((item) => item).map(String).join(' ')}`);
      }
    }

    if (record.projections) {
      const projectionTokens = [];
      for (const projection of record.projections.slice(0, 3)) {
        if (_is_plain_object(projection)) {
          const alias = projection.alias;
          const kind = projection.kind;
          if (alias) projectionTokens.push(String(alias));
          else if (kind) projectionTokens.push(String(kind));
        } else {
          projectionTokens.push(String(projection));
        }
      }
      if (projectionTokens.length) parts.push(`projections ${projectionTokens.join(' ')}`);
    }

    return parts.filter((part) => part).join(' ');
  }

  /**
   * 序列化一条记录（排除 embedding），并做一次 upgrade 归一化（失败降级原始 payload）。
   * @param {object} record
   * @returns {object}
   */
  static _serialize_record(record) {
    const payload = {};
    for (const column of METRIC_VIEW_COLUMNS) {
      if (column === 'embedding') continue;
      payload[column] = record[column] !== undefined ? record[column] : null;
    }
    try {
      return upgrade_metric_view_payload(payload);
    } catch (exc) {
      // 草稿允许字段不全, upgrade 失败时降级为原始 dict
      console.warn(
        `_serialize_record: upgrade 失败 id=${payload.id} status=${payload.status} err=${exc?.message ?? exc}，降级返回原始 payload`,
      );
      return payload;
    }
  }

  /**
   * 批量构建数据源摘要（business_source_id → 物理源信息）。
   * @param {object} ctx
   * @param {string[]} source_ids
   * @returns {Promise<Object<string, object>>}
   */
  static async _build_source_summary_map(ctx, source_ids) {
    const uniqueIds = [...new Set((source_ids || []).filter((id) => id))];
    if (!uniqueIds.length) return {};

    const items = await ctx.query(
      `SELECT id, source_type, source_id
         FROM business_data_sources
        WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
      [uniqueIds],
    );

    const databaseIds = items.filter((i) => i.source_type === 'database_connection').map((i) => i.source_id);
    const structuredIds = items.filter((i) => i.source_type === 'structured_data_source').map((i) => i.source_id);
    const unstructuredIds = items.filter((i) => i.source_type === 'unstructured_data_source').map((i) => i.source_id);
    const mcpIds = items.filter((i) => i.source_type === 'mcp_data_source').map((i) => i.source_id);

    // (source_type, source_id) → physical name
    const physicalNameMap = new Map();
    const keyOf = (type, id) => `${type}::${id}`;

    const loadNames = async (ids, table, sourceType) => {
      if (!ids.length) return;
      const rows = await ctx.query(
        `SELECT id, name FROM ${table} WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
        [ids],
      );
      for (const source of rows) {
        physicalNameMap.set(keyOf(sourceType, source.id), source.name);
      }
    };

    await loadNames(databaseIds, 'database_connections', 'database_connection');
    await loadNames(structuredIds, 'structured_data_sources', 'structured_data_source');
    await loadNames(unstructuredIds, 'unstructured_data_sources', 'unstructured_data_source');
    await loadNames(mcpIds, 'mcp_data_sources', 'mcp_data_source');

    const summaryMap = {};
    for (const item of items) {
      summaryMap[item.id] = {
        source_id: item.id,
        business_source_id: item.id,
        connection_id: item.source_id,
        source_type: item.source_type,
        source_name: physicalNameMap.get(keyOf(item.source_type, item.source_id)) ?? item.source_id,
      };
    }
    return summaryMap;
  }

  static _build_definition_input_from_record(record) {
    return {
      name: record.name,
      description: record.description,
      aliases: record.aliases || [],
      source_id: record.source_id,
      tables: record.tables || [],
      fixed_predicates: record.fixed_predicates || [],
      query_dimensions: record.query_dimensions || [],
      time_dimension: record.time_dimension,
      projections: record.projections || [],
      group_by: record.group_by || [],
      sort_spec: record.sort_spec || { order_by: [], limit_default: 100 },
    };
  }

  /**
   * 把视图定义字段拍平为可落库的列值集合（create/update/draft/non-draft 共用）。
   * @returns {object} 形如 { name, description, source_id, aliases, tables, ... }
   */
  static _build_record_columns({ name, description, source_id, normalized_or_raw }) {
    return {
      name,
      description,
      source_id,
      aliases: normalized_or_raw.aliases || null,
      tables: normalized_or_raw.tables || [],
      fixed_predicates: normalized_or_raw.fixed_predicates || null,
      query_dimensions: normalized_or_raw.query_dimensions || null,
      time_dimension: normalized_or_raw.time_dimension != null ? normalized_or_raw.time_dimension : null,
      projections: normalized_or_raw.projections || [],
      group_by: normalized_or_raw.group_by || null,
      sort_spec: normalized_or_raw.sort_spec || { order_by: [], limit_default: 100 },
    };
  }

  /** 构造草稿落库用的字段字典（跳过 normalize，原样保留 LLM 输出）。 */
  static _build_draft_payload({
    aliases,
    tables,
    projections,
    fixed_predicates,
    query_dimensions,
    time_dimension,
    group_by,
    sort_spec,
  }) {
    return {
      aliases,
      tables,
      fixed_predicates,
      query_dimensions,
      time_dimension,
      projections,
      group_by,
      sort_spec,
    };
  }

  /**
   * 写库前用 ViewMetricDefinition 做一次结构校验与归一化，把默认值稳定写入 JSON 字段。
   * @returns {Promise<object>} 归一化后的字段集合
   */
  static async _normalize_definition_payload(ctx, {
    name,
    source_id,
    aliases,
    tables,
    projections,
    fixed_predicates,
    query_dimensions,
    time_dimension,
    group_by,
    sort_spec,
    strict_source_resolution = true,
  }) {
    // operator/op 大小写归一化（兜底大写 'IN'/'LIKE'）
    fixed_predicates = _normalize_op_case_in_list(fixed_predicates, 'operator');
    query_dimensions = _normalize_op_case_in_list(query_dimensions, 'op');
    if (_is_plain_object(time_dimension) && time_dimension.op) {
      time_dimension = { ...time_dimension };
      time_dimension.op = _normalize_sql_op(time_dimension.op);
    }

    let definition;
    try {
      const normalizedPayload = upgrade_metric_view_payload({
        metric_id: 'draft_metric_view',
        name,
        aliases: aliases || [],
        source_id,
        descriptions: [],
        tables,
        fixed_predicates: fixed_predicates || [],
        query_dimensions: query_dimensions || [],
        time_dimension,
        projections,
        group_by: group_by || [],
        sort_spec: sort_spec || { order_by: [], limit_default: 100 },
      });
      // 桌面版无 pydantic：直接用 upgrade 后的普通对象作为 definition，
      // 字段默认值在 canonicalize / 下面落库时补齐。
      definition = MetricViewService._coerce_definition_defaults(normalizedPayload);
      definition = await canonicalize_metric_view_definition(ctx, definition, {
        source_id,
        strict_source_resolution,
      });
    } catch (exc) {
      throw new ValidationError(`指标视图定义不合法: ${exc?.message ?? exc}`);
    }

    return {
      aliases: (definition.aliases && definition.aliases.length ? definition.aliases : null),
      tables: definition.tables || [],
      fixed_predicates: (definition.fixed_predicates && definition.fixed_predicates.length ? definition.fixed_predicates : null),
      query_dimensions: (definition.query_dimensions && definition.query_dimensions.length ? definition.query_dimensions : null),
      time_dimension: definition.time_dimension != null ? definition.time_dimension : null,
      projections: definition.projections || [],
      group_by: (definition.group_by && definition.group_by.length ? definition.group_by : null),
      sort_spec: definition.sort_spec || { order_by: [], limit_default: 100 },
    };
  }

  /**
   * 为 upgrade 后的 payload 补齐 pydantic 默认值（替代 model_validate + model_dump）。
   * 仅补本服务后续会用到的容器默认值，保持形状稳定。
   */
  static _coerce_definition_defaults(payload) {
    const def = { ...payload };
    def.aliases = def.aliases || [];
    def.tables = def.tables || [];
    def.fixed_predicates = def.fixed_predicates || [];
    def.query_dimensions = def.query_dimensions || [];
    def.time_dimension = def.time_dimension != null ? def.time_dimension : null;
    def.projections = def.projections || [];
    def.group_by = def.group_by || [];
    const sortSpec = def.sort_spec || {};
    def.sort_spec = {
      order_by: sortSpec.order_by || [],
      limit_default: sortSpec.limit_default != null ? sortSpec.limit_default : 100,
    };
    return def;
  }

  /**
   * 存储契约修复：扫描项目/视图记录，重新归一化并（非 dry_run 时）回写。
   * @param {object} ctx
   * @param {{project_id?:string, metric_view_id?:string, dry_run?:boolean}} options
   * @returns {Promise<object>} summary
   */
  static async repair_storage_contract(ctx, { project_id = null, metric_view_id = null, dry_run = true } = {}) {
    const params = [];
    let sql = `SELECT ${METRIC_VIEW_COLUMNS.join(', ')}
                 FROM metric_view_definitions
                WHERE deleted_at IS NULL`;
    if (project_id) {
      params.push(project_id);
      sql += ` AND project_id = $${params.length}`;
    }
    if (metric_view_id) {
      params.push(metric_view_id);
      sql += ` AND id = $${params.length}`;
    }
    sql += ' ORDER BY created_at ASC';

    const records = await ctx.query(sql, params);

    const summary = {
      dry_run,
      scanned: records.length,
      updated: 0,
      skipped: [],
      failed: [],
    };

    for (const record of records) {
      if (!record.source_id) {
        summary.skipped.push({ id: record.id, name: record.name, reason: 'missing_source_id' });
        continue;
      }

      try {
        const currentUpgraded = MetricViewService._coerce_definition_defaults(
          upgrade_metric_view_payload(MetricViewService._build_definition_input_from_record(record)),
        );
        const currentPayload = {
          name: record.name,
          description: record.description,
          aliases: currentUpgraded.aliases || [],
          source_id: record.source_id,
          tables: currentUpgraded.tables,
          fixed_predicates: currentUpgraded.fixed_predicates,
          query_dimensions: currentUpgraded.query_dimensions,
          time_dimension: currentUpgraded.time_dimension,
          projections: currentUpgraded.projections,
          group_by: currentUpgraded.group_by,
          sort_spec: currentUpgraded.sort_spec,
        };

        const normalized = await MetricViewService._normalize_definition_payload(ctx, {
          name: record.name,
          source_id: record.source_id,
          aliases: record.aliases,
          tables: record.tables || [],
          projections: record.projections || [],
          fixed_predicates: record.fixed_predicates,
          query_dimensions: record.query_dimensions,
          time_dimension: record.time_dimension,
          group_by: record.group_by,
          sort_spec: record.sort_spec,
          strict_source_resolution: true,
        });

        const nextPayload = {
          name: record.name,
          description: record.description,
          aliases: normalized.aliases || [],
          source_id: record.source_id,
          tables: normalized.tables,
          fixed_predicates: normalized.fixed_predicates || [],
          query_dimensions: normalized.query_dimensions || [],
          time_dimension: normalized.time_dimension,
          projections: normalized.projections,
          group_by: normalized.group_by || [],
          sort_spec: normalized.sort_spec,
        };

        if (_stable_json(currentPayload) === _stable_json(nextPayload)) {
          continue;
        }

        summary.updated += 1;
        if (dry_run) continue;

        await ctx.query(
          `UPDATE metric_view_definitions
              SET aliases = $1, tables = $2, fixed_predicates = $3, query_dimensions = $4,
                  time_dimension = $5, projections = $6, group_by = $7, sort_spec = $8,
                  updated_at = $9
            WHERE id = $10`,
          [
            _json_or_null(normalized.aliases),
            _json_or_null(normalized.tables),
            _json_or_null(normalized.fixed_predicates),
            _json_or_null(normalized.query_dimensions),
            _json_or_null(normalized.time_dimension),
            _json_or_null(normalized.projections),
            _json_or_null(normalized.group_by),
            _json_or_null(normalized.sort_spec),
            new Date(),
            record.id,
          ],
        );
      } catch (exc) {
        summary.failed.push({ id: record.id, name: record.name, reason: String(exc?.message ?? exc) });
      }
    }

    return summary;
  }

  /**
   * 创建指标视图定义。
   * @param {object} ctx
   * @returns {Promise<{success:boolean,id:string,message:string}>}
   */
  static async create(ctx, {
    project_id,
    name,
    source_id,
    tables,
    projections,
    description = null,
    aliases = null,
    fixed_predicates = null,
    query_dimensions = null,
    time_dimension = null,
    group_by = null,
    sort_spec = null,
    status = METRIC_VIEW_STATUS_ACTIVE,
  }) {
    try {
      await MetricViewService._validate_business(ctx, project_id);

      if (!METRIC_VIEW_STATUSES.includes(status)) {
        throw new ValidationError(`非法的状态值: ${status}`);
      }

      const businessDataSource = await ctx.queryOne(
        `SELECT id, project_id, source_type, source_id, deleted_at
           FROM business_data_sources WHERE id = $1`,
        [source_id],
      );
      if (!businessDataSource || businessDataSource.deleted_at != null) {
        throw new ValidationError('项目数据源不存在');
      }
      if (businessDataSource.project_id !== project_id) {
        throw new ValidationError('指标视图绑定的数据源不属于当前项目');
      }
      // 注：business_data_sources 表无 is_active 列，原 Python getattr 默认 True，恒不触发停用判断。

      // 名称唯一性
      const existing = await ctx.queryOne(
        `SELECT 1 FROM metric_view_definitions
          WHERE project_id = $1 AND name = $2 AND deleted_at IS NULL LIMIT 1`,
        [project_id, name],
      );
      if (existing) {
        throw new ValidationError(`指标视图名称 '${name}' 已存在`);
      }

      let payload;
      if (status === METRIC_VIEW_STATUS_DRAFT) {
        payload = MetricViewService._build_draft_payload({
          aliases, tables, projections, fixed_predicates, query_dimensions, time_dimension, group_by, sort_spec,
        });
      } else {
        payload = await MetricViewService._normalize_definition_payload(ctx, {
          name, source_id, aliases, tables, projections, fixed_predicates,
          query_dimensions, time_dimension, group_by, sort_spec, strict_source_resolution: true,
        });
      }

      const cols = MetricViewService._build_record_columns({
        name, description, source_id, normalized_or_raw: payload,
      });

      const now = new Date();
      const inserted = await ctx.queryOne(
        `INSERT INTO metric_view_definitions
           (project_id, status, name, description, source_id, aliases, tables,
            fixed_predicates, query_dimensions, time_dimension, projections,
            group_by, sort_spec, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          project_id,
          status,
          cols.name,
          cols.description,
          cols.source_id,
          _json_or_null(cols.aliases),
          _json_or_null(cols.tables),
          _json_or_null(cols.fixed_predicates),
          _json_or_null(cols.query_dimensions),
          _json_or_null(cols.time_dimension),
          _json_or_null(cols.projections),
          _json_or_null(cols.group_by),
          _json_or_null(cols.sort_spec),
          now,
          now,
        ],
      );

      await MetricViewService.invalidate_metric_view_cache(project_id);
      return { success: true, id: inserted?.id, message: `成功创建指标视图 ${name}` };
    } catch (e) {
      console.error(`创建指标视图失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 更新指标视图定义。
   * @param {object} ctx
   * @returns {Promise<{success:boolean,id:string,message:string}>}
   */
  static async update(ctx, {
    metric_view_id,
    project_id,
    name,
    source_id,
    tables,
    projections,
    description = null,
    aliases = null,
    fixed_predicates = null,
    query_dimensions = null,
    time_dimension = null,
    group_by = null,
    sort_spec = null,
    status = null,
  }) {
    try {
      await MetricViewService._validate_business(ctx, project_id);

      if (status != null && !METRIC_VIEW_STATUSES.includes(status)) {
        throw new ValidationError(`非法的状态值: ${status}`);
      }

      const businessDataSource = await ctx.queryOne(
        `SELECT id, project_id, source_type, source_id, deleted_at
           FROM business_data_sources WHERE id = $1`,
        [source_id],
      );
      if (!businessDataSource || businessDataSource.deleted_at != null) {
        throw new ValidationError('项目数据源不存在');
      }
      if (businessDataSource.project_id !== project_id) {
        throw new ValidationError('指标视图绑定的数据源不属于当前项目');
      }

      const record = await ctx.queryOne(
        `SELECT ${METRIC_VIEW_COLUMNS.join(', ')}
           FROM metric_view_definitions
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [metric_view_id, project_id],
      );
      if (!record) {
        throw new NotFoundError('指标视图不存在');
      }

      if (record.name !== name) {
        const dup = await ctx.queryOne(
          `SELECT 1 FROM metric_view_definitions
            WHERE project_id = $1 AND name = $2 AND id <> $3 AND deleted_at IS NULL LIMIT 1`,
          [project_id, name, metric_view_id],
        );
        if (dup) {
          throw new ValidationError(`指标视图名称 '${name}' 已存在`);
        }
      }

      const targetStatus = status != null ? status : record.status;
      let payload;
      if (targetStatus === METRIC_VIEW_STATUS_DRAFT) {
        payload = MetricViewService._build_draft_payload({
          aliases, tables, projections, fixed_predicates, query_dimensions, time_dimension, group_by, sort_spec,
        });
      } else {
        payload = await MetricViewService._normalize_definition_payload(ctx, {
          name, source_id, aliases, tables, projections, fixed_predicates,
          query_dimensions, time_dimension, group_by, sort_spec, strict_source_resolution: true,
        });
      }

      const cols = MetricViewService._build_record_columns({
        name, description, source_id, normalized_or_raw: payload,
      });

      const nextStatus = status != null ? status : record.status;
      // 状态变更为非 active 时清空 embedding（向量召回仅服务 active 视图）
      const clearEmbedding = nextStatus !== METRIC_VIEW_STATUS_ACTIVE && record.embedding != null;

      await ctx.query(
        `UPDATE metric_view_definitions
            SET name = $1, description = $2, source_id = $3, aliases = $4, tables = $5,
                fixed_predicates = $6, query_dimensions = $7, time_dimension = $8,
                projections = $9, group_by = $10, sort_spec = $11, status = $12,
                embedding = CASE WHEN $13 THEN NULL ELSE embedding END,
                embedding_model = CASE WHEN $13 THEN NULL ELSE embedding_model END,
                updated_at = $14
          WHERE id = $15`,
        [
          cols.name,
          cols.description,
          cols.source_id,
          _json_or_null(cols.aliases),
          _json_or_null(cols.tables),
          _json_or_null(cols.fixed_predicates),
          _json_or_null(cols.query_dimensions),
          _json_or_null(cols.time_dimension),
          _json_or_null(cols.projections),
          _json_or_null(cols.group_by),
          _json_or_null(cols.sort_spec),
          nextStatus,
          clearEmbedding,
          new Date(),
          metric_view_id,
        ],
      );

      await MetricViewService.invalidate_metric_view_cache(project_id);
      return { success: true, id: metric_view_id, message: `成功更新指标视图 ${name}` };
    } catch (e) {
      console.error(`更新指标视图失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 获取指标视图列表（分页）。
   * @param {object} ctx
   * @returns {Promise<[object[], number]>} [items, total]
   */
  static async get_list(ctx, {
    project_id,
    source_id = null,
    active_only = false,
    status_filter = null,
    page = 1,
    page_size = 20,
  }) {
    try {
      await MetricViewService._validate_business(ctx, project_id);

      const params = [project_id];
      let where = 'project_id = $1 AND deleted_at IS NULL';
      if (source_id) {
        params.push(source_id);
        where += ` AND source_id = $${params.length}`;
      }
      if (status_filter) {
        if (!METRIC_VIEW_STATUSES.includes(status_filter)) {
          throw new ValidationError(`非法的状态过滤值: ${status_filter}`);
        }
        params.push(status_filter);
        where += ` AND status = $${params.length}`;
      } else if (active_only) {
        params.push(METRIC_VIEW_STATUS_ACTIVE);
        where += ` AND status = $${params.length}`;
      }

      const countRow = await ctx.queryOne(
        `SELECT COUNT(*) AS cnt FROM metric_view_definitions WHERE ${where}`,
        params,
      );
      const total = countRow ? Number(countRow.cnt) || 0 : 0;

      let listSql = `SELECT ${METRIC_VIEW_COLUMNS.join(', ')}
                       FROM metric_view_definitions
                      WHERE ${where}
                   ORDER BY created_at DESC`;
      const listParams = [...params];
      if (page_size > 0) {
        listParams.push(page_size);
        listSql += ` LIMIT $${listParams.length}`;
        listParams.push((page - 1) * page_size);
        listSql += ` OFFSET $${listParams.length}`;
      }

      const records = await ctx.query(listSql, listParams);

      const sourceSummaryMap = await MetricViewService._build_source_summary_map(
        ctx,
        records.map((record) => record.source_id),
      );

      const items = [];
      for (const record of records) {
        const payload = MetricViewService._serialize_record(record);
        Object.assign(payload, sourceSummaryMap[record.source_id] || {});
        items.push(payload);
      }
      return [items, total];
    } catch (e) {
      console.error(`获取指标视图列表失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 获取指标视图详情。
   * @param {object} ctx
   * @returns {Promise<object>}
   */
  static async get_detail(ctx, { metric_view_id, project_id }) {
    try {
      await MetricViewService._validate_business(ctx, project_id);

      const record = await ctx.queryOne(
        `SELECT ${METRIC_VIEW_COLUMNS.join(', ')}
           FROM metric_view_definitions
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [metric_view_id, project_id],
      );
      if (!record) {
        throw new NotFoundError('指标视图不存在');
      }

      const payload = MetricViewService._serialize_record(record);
      const sourceSummaryMap = await MetricViewService._build_source_summary_map(ctx, [record.source_id]);
      Object.assign(payload, sourceSummaryMap[record.source_id] || {});
      return payload;
    } catch (e) {
      console.error(`获取指标视图详情失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 软删除指标视图。
   * @param {object} ctx
   * @returns {Promise<void>}
   */
  static async delete(ctx, { metric_view_id, project_id }) {
    try {
      await MetricViewService._validate_business(ctx, project_id);

      const record = await ctx.queryOne(
        `SELECT id FROM metric_view_definitions
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [metric_view_id, project_id],
      );
      if (!record) {
        throw new NotFoundError('指标视图不存在');
      }

      await ctx.query(
        `UPDATE metric_view_definitions SET deleted_at = $1, updated_at = $1 WHERE id = $2`,
        [new Date(), metric_view_id],
      );

      await MetricViewService.invalidate_metric_view_cache(project_id);
    } catch (e) {
      console.error(`删除指标视图失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 切换指标视图状态: draft / active / inactive。
   * 草稿 -> 启用前会触发严格 schema 解析校验，失败抛 ValidationError。
   * @param {object} ctx
   * @returns {Promise<{success:boolean,id:string,status:string,message:string}>}
   */
  static async update_status(ctx, { metric_view_id, project_id, status }) {
    try {
      if (!METRIC_VIEW_STATUSES.includes(status)) {
        throw new ValidationError(`非法的状态值: ${status}`);
      }

      await MetricViewService._validate_business(ctx, project_id);

      const record = await ctx.queryOne(
        `SELECT ${METRIC_VIEW_COLUMNS.join(', ')}
           FROM metric_view_definitions
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [metric_view_id, project_id],
      );
      if (!record) {
        throw new NotFoundError('指标视图不存在');
      }

      // 任何状态切到 active 都必须能通过严格 schema 解析
      const willBecomeActive =
        status === METRIC_VIEW_STATUS_ACTIVE && record.status !== METRIC_VIEW_STATUS_ACTIVE;
      if (willBecomeActive) {
        await MetricViewService._normalize_definition_payload(ctx, {
          name: record.name,
          source_id: record.source_id,
          aliases: record.aliases,
          tables: record.tables || [],
          projections: record.projections || [],
          fixed_predicates: record.fixed_predicates,
          query_dimensions: record.query_dimensions,
          time_dimension: record.time_dimension,
          group_by: record.group_by,
          sort_spec: record.sort_spec,
          strict_source_resolution: true,
        });
      }

      const clearEmbedding = status !== METRIC_VIEW_STATUS_ACTIVE && record.embedding != null;

      await ctx.query(
        `UPDATE metric_view_definitions
            SET status = $1,
                embedding = CASE WHEN $2 THEN NULL ELSE embedding END,
                embedding_model = CASE WHEN $2 THEN NULL ELSE embedding_model END,
                updated_at = $3
          WHERE id = $4`,
        [status, clearEmbedding, new Date(), metric_view_id],
      );

      return {
        success: true,
        id: metric_view_id,
        status,
        message: `状态已更新为 ${status}`,
      };
    } catch (e) {
      if (e instanceof NotFoundError || e instanceof ValidationError) throw e;
      console.error(`更新指标视图状态失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 批量生成指标视图向量（真·向量：embed(name+aliases+description+结构文本)→写 embedding 列）。
   *
   * 仅对 active 视图中 embedding IS NULL 的行批量生成（每批 ≤16）。无 EMBEDDING 模型/
   * 向量扩展未就绪/embed 失败时降级：不抛异常，processed=0，保留对外接口与返回形状。
   *
   * @param {object} ctx
   * @returns {Promise<{success:boolean,total:number,processed:number,message:string}>}
   */
  static async generate_embeddings(ctx, { project_id, metric_view_id = null }) {
    try {
      await MetricViewService._validate_business(ctx, project_id);

      // 清理非 active 视图的 embedding 残留（历史脏数据兜底）
      await ctx.query(
        `UPDATE metric_view_definitions
            SET embedding = NULL, embedding_model = NULL
          WHERE project_id = $1
            AND deleted_at IS NULL
            AND status <> $2
            AND embedding IS NOT NULL`,
        [project_id, METRIC_VIEW_STATUS_ACTIVE],
      );

      // 只取尚未生成向量(embedding IS NULL)的启用视图
      const params = [project_id, METRIC_VIEW_STATUS_ACTIVE];
      let sql = `SELECT id, name, aliases, description, tables, query_dimensions,
                        time_dimension, projections
                   FROM metric_view_definitions
                  WHERE project_id = $1 AND deleted_at IS NULL AND status = $2
                    AND embedding IS NULL`;
      if (metric_view_id) {
        params.push(metric_view_id);
        sql += ` AND id = $${params.length}`;
      }
      const records = await ctx.query(sql, params);

      if (!records.length) {
        return {
          success: true,
          total: 0,
          processed: 0,
          message: '没有找到需要生成向量的启用视图(草稿/停用视图不参与向量生成)',
        };
      }

      let processed = 0;
      // 批量(每批 ≤16)embed → 逐行 UPDATE embedding 列。embed 失败/无模型降级 processed=0。
      try {
        for (let i = 0; i < records.length; i += METRIC_VIEW_EMBEDDING_BATCH) {
          const batch = records.slice(i, i + METRIC_VIEW_EMBEDDING_BATCH);
          const texts = batch.map((r) => MetricViewService._build_embedding_text(r) || r.name || '');
          // eslint-disable-next-line no-await-in-loop
          const vectors = await embed(texts, { project_id });
          if (!Array.isArray(vectors) || !vectors.length) break;
          for (let j = 0; j < batch.length; j += 1) {
            const vec = vectors[j];
            if (!Array.isArray(vec) || !vec.length) continue;
            // eslint-disable-next-line no-await-in-loop
            await ctx.query(
              // embedding 统一存 JSON 文本(与 schema_retrieval/metric/entity 一致);
              // 召回侧 vexdb_cosine_distance(embedding, vexdb_f32($q)) 接受 JSON 文本列
              `UPDATE metric_view_definitions
                  SET embedding = $1, embedding_model = $2, updated_at = $3
                WHERE id = $4`,
              [JSON.stringify(vec), METRIC_VIEW_EMBEDDING_MODEL, new Date(), batch[j].id],
            );
            processed += 1;
          }
        }
      } catch (embedErr) {
        // 无 EMBEDDING 模型/向量扩展未就绪/embed 失败 → 降级，不抛异常
        console.warn(`[MetricView] 向量生成降级(无向量服务或 embed 失败): ${embedErr?.message ?? embedErr}`);
      }

      await MetricViewService.invalidate_metric_view_cache(project_id);
      const message = processed > 0
        ? `成功为 ${processed}/${records.length} 个启用视图生成向量`
        : `无向量服务或 embed 失败，已识别 ${records.length} 个启用视图但未生成向量`;
      return {
        success: true,
        total: records.length,
        processed,
        message,
      };
    } catch (e) {
      console.error(`生成指标视图向量失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * vexdb_cosine_distance 向量召回 active 视图：对有 embedding 的视图按余弦距离升序取 top-N。
   * similarity = max(0, 1 - distance)。返回与关键词路径一致的 { model, similarity } 列表。
   * SQL/向量扩展失败 → 返回空，调用方回退关键词。
   * @returns {Promise<Array<{model:object, similarity:number}>>}
   */
  static async _vectorScoreViews(ctx, project_id, queryVec, limit) {
    const rows = await ctx.query(
      `SELECT ${METRIC_VIEW_COLUMNS.map((c) => (c === 'embedding' ? null : c)).filter((c) => c).join(', ')},
              vexdb_cosine_distance(embedding, vexdb_f32($1)) AS distance
         FROM metric_view_definitions
        WHERE project_id = $2
          AND status = $3
          AND embedding IS NOT NULL
          AND deleted_at IS NULL
        ORDER BY distance ASC
        LIMIT $4`,
      [JSON.stringify(queryVec), project_id, METRIC_VIEW_STATUS_ACTIVE, limit],
    ).catch((e) => {
      console.warn(`[MetricView] 向量召回 SQL 失败: ${e?.message ?? e}`);
      return [];
    });
    return rows.map((model) => ({
      model,
      similarity: Math.max(0, 1.0 - Number(model.distance ?? 1)),
    }));
  }

  /**
   * 搜索 metric view definitions（向量优先 vexdb_cosine_distance，向量空回退关键词召回）。
   *
   * @param {object} ctx
   * @returns {Promise<object[]>}
   */
  static async search(ctx, {
    query_text,
    project_id,
    limit = 3,
    min_similarity = 0.7,
    query_embedding = null,
  }) {
    try {
      // ① 优先真·向量召回(vexdb_cosine_distance)；失败/无 embedding 回退关键词
      let scored = null;
      const qvec = await embedQuestion(query_text, project_id, query_embedding);
      if (qvec) {
        scored = await MetricViewService._vectorScoreViews(ctx, project_id, qvec, limit);
        if (scored && scored.length) console.log(`[MetricView] 向量召回(vexdb): ${scored.length} 个视图`);
      }

      // ② 关键词兜底（向量为空或无结果时；不依赖 embedding 列是否非空，避免永久空召回）
      if (!scored || !scored.length) {
        const rows = await ctx.query(
          `SELECT ${METRIC_VIEW_COLUMNS.join(', ')}
             FROM metric_view_definitions
            WHERE project_id = $1
              AND deleted_at IS NULL
              AND status = $2`,
          [project_id, METRIC_VIEW_STATUS_ACTIVE],
        );
        if (!rows.length) return [];

        // 关键词伪 similarity 打分（name + aliases + description）
        scored = [];
        for (const model of rows) {
          const candidateText = [
            model.name || '',
            ...(model.aliases || []),
            model.description || '',
          ].join(' ');
          const similarity = _keyword_similarity(query_text, candidateText);
          scored.push({ model, similarity });
        }
        scored.sort((a, b) => b.similarity - a.similarity);
      }

      const top = scored.slice(0, limit);

      const sourceSummaryMap = await MetricViewService._build_source_summary_map(
        ctx,
        top.map(({ model }) => model.source_id),
      );

      const matches = [];
      for (const { model, similarity } of top) {
        if (similarity >= min_similarity) {
          const sourceSummary = sourceSummaryMap[model.source_id] || {};
          matches.push({
            definition: to_metric_view_definition(model),
            similarity,
            name: model.name,
            aliases: model.aliases || [],
            description: model.description || '',
            source_id: model.source_id,
            business_source_id: sourceSummary.business_source_id ?? model.source_id,
            connection_id: sourceSummary.connection_id ?? null,
            source_name: sourceSummary.source_name ?? null,
          });
        }
      }
      return prioritize_metric_view_matches(query_text, matches);
    } catch (e) {
      console.error(`搜索指标视图失败: ${e?.message ?? e}`);
      return [];
    }
  }
}

// ===========================================================================
//  小工具
// ===========================================================================

/** JSON 字段落库：null/undefined → null，对象/数组 → JSON 字符串（pg 驱动也接受对象，这里统一字符串化）。 */
function _json_or_null(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** 稳定排序键的 JSON 序列化（对齐 Python json.dumps(sort_keys=True, ensure_ascii=False)）。 */
function _stable_json(value) {
  const sortKeys = (input) => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input && typeof input === 'object') {
      const out = {};
      for (const key of Object.keys(input).sort()) out[key] = sortKeys(input[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(sortKeys(value));
}

export default MetricViewService;
