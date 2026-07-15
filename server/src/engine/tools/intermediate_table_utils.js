// 迁移自 yiw_kernel/data_analyze/planner/tools/intermediate_table_utils.py
//
// 中间表工具：中间结果表名校验/归一 + 单表扫描算子。
//
// 迁移要点：
// - Python 的 IntermediateTableScan 继承 operators.base.Base（抽象算子基类）。
//   Node 侧 operators.base 尚未迁移，这里提供一个最小本地基类 _OperatorBase，
//   实现 SQLDatabaseScan / IntermediateTableScan 共用的 nodetag/schema 字段语义，
//   接口名（get_next / infer_schema / copy_with / get_referenced_cols / to_dict）
//   与 Python Base 子类一致，便于下游 import 不改调用方。
// - Python 的 Table（planagent.utils.Table）尚未迁移；这里内联一个最小 Table，
//   只覆盖本算子用到的语义：Table(columns:Set<string>, rows:Array<object>)，
//   可迭代、可索引、columns 属性。后续 Table 单独迁移后可替换本地实现。
// - DuckDB 中间结果落地复用 datasources/intermediate_data_source.js（其 query() 经
//   duck.js 子进程 → intermediate_storage_service.js 读 DuckDB）。
// - ValueError → 抛普通 Error（保留错误文案 1:1）。

import { t } from '../utils/i18n.js';

// 中间表名只允许标识符字符。LLM 工具参数会沿用该名称拼入 SQL，
// 必须挡住注入向量（ATTACH、COPY TO、read_csv('http://...') 等）。
const _VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * 校验中间表名（对应 _assert_valid_table_name）。非法时抛错。
 * @param {string} table_name
 * @returns {string}
 */
function _assert_valid_table_name(table_name) {
  if (typeof table_name !== 'string' || !_VALID_TABLE_NAME.test(table_name)) {
    // 对齐 Python repr：用 JSON.stringify 给出带引号的字面量
    throw new Error(
      `Invalid intermediate table name: ${JSON.stringify(table_name)} `
      + '(must match [A-Za-z_][A-Za-z0-9_]{0,127})',
    );
  }
  return table_name;
}

// ============================================================
// 最小 Table（对应 planagent.utils.Table 中本算子用到的子集）
// ============================================================

/**
 * 表数据容器（最小实现）。Python 版 Table 还有 from_df / to_df / sample_rows 等，
 * 本算子只用到构造 + columns + 可迭代 + 索引，故此处仅实现该子集。
 */
export class Table {
  /**
   * @param {Set<string>|Iterable<string>|null} columns
   * @param {Array<object>|Iterable<object>} rows
   */
  constructor(columns, rows) {
    const rowsArr = Array.isArray(rows) ? rows : [...(rows ?? [])];
    let cols = columns;
    if (cols == null && rowsArr.length > 0) {
      cols = new Set(Object.keys(rowsArr[0]));
    }
    /** @type {Set<string>} */
    this.columns = cols instanceof Set ? cols : new Set(cols ?? []);
    /** @type {Array<object>} */
    this._data = rowsArr;
  }

  /** 行数（对应 __len__） */
  get length() {
    return this._data.length;
  }

  /** 按下标取行（对应 __getitem__） */
  get(index) {
    return this._data[index];
  }

  /** 形状 [rows, cols]（对应 @property shape） */
  get shape() {
    return [this._data.length, this.columns.size];
  }

  /** 深拷贝行数组（对应 to_dict） */
  to_dict() {
    return structuredClone(this._data);
  }

  /** 可迭代（对应 __iter__） */
  [Symbol.iterator]() {
    return this._data[Symbol.iterator]();
  }
}

// ============================================================
// 最小算子基类（对应 operators.base.Base，Node 侧尚未单独迁移）
// ============================================================

/**
 * 算子基类最小实现。仅承载 SQLDatabaseScan / IntermediateTableScan 共用字段，
 * 抽象方法以「子类必须实现」抛错占位，接口名与 Python Base 对齐。
 */
class _OperatorBase {
  constructor() {
    this.nodetag = this.constructor.name;
    this.desc = '';
    /** @type {Set<string>|null} */
    this.schema = null;
    /** @type {Set<string>|null} */
    this.required_cols = null;
  }

  async get_next(_kwargs = {}) {
    throw new Error(`${this.constructor.name}.get_next() 未实现`);
  }

  infer_schema() {
    throw new Error(`${this.constructor.name}.infer_schema() 未实现`);
  }

  copy_with(_overrides = {}) {
    throw new Error(`${this.constructor.name}.copy_with() 未实现`);
  }

  get_referenced_cols() {
    throw new Error(`${this.constructor.name}.get_referenced_cols() 未实现`);
  }

  to_dict() {
    throw new Error(`${this.constructor.name}.to_dict() 未实现`);
  }
}

// ============================================================
// IntermediateTableScan
// ============================================================

/**
 * 读取单个中间表并作为算子输入暴露（对应 class IntermediateTableScan(Base)）。
 */
export class IntermediateTableScan extends _OperatorBase {
  /**
   * @param {import('../datasources/intermediate_data_source.js').IntermediateDataSource} intermediate_ds
   * @param {string} table_name
   */
  constructor(intermediate_ds, table_name) {
    super();
    this.intermediate_ds = intermediate_ds;
    this.table_name = _assert_valid_table_name(table_name);
    this.source_name = intermediate_ds.datasource_name;
    this.desc = `A Scan operator node for intermediate table ${this.table_name}`;
    /** @type {Set<string>|null} */
    this.schema = null;
  }

  /**
   * 执行扫描，返回中间表全量数据（对应 async get_next）。
   * @param {object} [_kwargs]
   * @returns {Promise<Table>}
   */
  async get_next(_kwargs = {}) {
    // 表名已在构造时校验，拼入受控双引号标识符
    const sql = `SELECT * FROM "${this.table_name}"`;
    const query_result = await this.intermediate_ds.query(sql);
    if (!query_result.success) {
      throw new Error(t('查询失败: {}', query_result.message));
    }
    this.schema = new Set(query_result.columns || []);
    return new Table(this.schema, query_result.data || []);
  }

  /** 推断输出 schema（对应 infer_schema） */
  infer_schema() {
    return this.schema || new Set();
  }

  /**
   * 以覆盖项克隆（对应 copy_with）。
   * @param {object} [overrides]
   * @returns {IntermediateTableScan}
   */
  copy_with(overrides = {}) {
    return new IntermediateTableScan(
      'intermediate_ds' in overrides ? overrides.intermediate_ds : this.intermediate_ds,
      'table_name' in overrides ? overrides.table_name : this.table_name,
    );
  }

  /** 引用列集合（对应 get_referenced_cols） */
  get_referenced_cols() {
    return this.schema || new Set();
  }

  /** 序列化（对应 to_dict） */
  to_dict() {
    return {
      nodetag: this.nodetag,
      table_name: this.table_name,
      source_name: this.source_name,
    };
  }
}

// ============================================================
// 表名归一与中间表解析
// ============================================================

/**
 * 归一中间表名（去前后空白 + 取点号后段，再校验）。对应 normalize_table_name。
 * @param {string} table_name
 * @returns {string}
 */
export function normalize_table_name(table_name) {
  const parts = String(table_name ?? '').trim().split('.');
  const normalized = parts[parts.length - 1];
  if (normalized) {
    _assert_valid_table_name(normalized);
  }
  return normalized;
}

/** @alias normalize_table_name */
export const normalizeTableName = normalize_table_name;

/**
 * 解析中间表名（对应 resolve_intermediate_table_name）。
 *
 * 优先级：
 * 1. 显式 table_name → 归一后返回。
 * 2. preferred_intermediate_tables（去重后唯一）→ 返回。
 * 3. dependency_tables（去重后唯一）→ 返回。
 * 4. 否则返回 null（无法唯一确定）。
 *
 * @param {string|null} [table_name=null]
 * @param {Iterable<string>|null} [dependency_tables=null]
 * @param {Iterable<object>|null} [preferred_intermediate_tables=null]
 * @returns {string|null}
 */
export function resolve_intermediate_table_name(
  table_name = null,
  dependency_tables = null,
  preferred_intermediate_tables = null,
) {
  if (table_name) {
    return normalize_table_name(table_name);
  }

  const preferredTables = [];
  for (const item of preferred_intermediate_tables || []) {
    if (item && typeof item === 'object' && !Array.isArray(item) && item.intermediate_table) {
      const norm = normalize_table_name(item.intermediate_table || '');
      if (norm) preferredTables.push(norm);
    }
  }
  // 去重保序（对应 dict.fromkeys）
  const uniquePreferred = [...new Set(preferredTables)];
  if (uniquePreferred.length === 1) {
    return uniquePreferred[0];
  }

  const rawDependency = [];
  for (const item of dependency_tables || []) {
    if (item) {
      rawDependency.push(normalize_table_name(item));
    }
  }
  const uniqueDependency = [...new Set(rawDependency)];
  if (uniqueDependency.length === 1) {
    return uniqueDependency[0];
  }

  return null;
}

/** @alias resolve_intermediate_table_name */
export const resolveIntermediateTableName = resolve_intermediate_table_name;

export default {
  Table,
  IntermediateTableScan,
  normalize_table_name,
  resolve_intermediate_table_name,
};
