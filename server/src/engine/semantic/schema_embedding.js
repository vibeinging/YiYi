// schema 向量化:为某连接的 table_metadata / column_metadata 生成 embedding。
// 供数据源 schema 同步后自动调用(让真实库导入即可用向量召回),也可被 build_vector_index 复用。
//
// embedding 统一存 JSON 文本,召回侧 vexdb_cosine_distance(embedding, vexdb_f32($q)) 接受。

import { embed } from '../core/llm.js';
import { vectorReady, query } from '../../db.js';

const BATCH = 16;

function jstr(v) {
  if (v == null) return '';
  if (typeof v === 'string') {
    const s = v.trim();
    if (s && (s[0] === '[' || s[0] === '{')) {
      try { const o = JSON.parse(s); return Array.isArray(o) ? o.join(' ') : Object.values(o).join(' '); } catch { return s; }
    }
    return s;
  }
  if (Array.isArray(v)) return v.join(' ');
  return String(v);
}

async function embedRows(rows, textFn, table, projectId) {
  let done = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    let vecs = [];
    try { vecs = await embed(chunk.map(textFn), { project_id: projectId }); }
    catch (e) {
      const message = String(e?.message ?? e);
      errors.push(message);
      console.warn(`[schema_embedding] embed 失败(${table} batch ${i}): ${message}`);
      break;
    }
    for (let j = 0; j < chunk.length; j += 1) {
      if (!vecs[j]) continue;
      await query(
        `UPDATE ${table} SET embedding = $1, embedding_model = 'text-embedding-v3', updated_at = now() WHERE id = $2`,
        [JSON.stringify(vecs[j]), chunk[j].id],
      ).catch(() => {});
      done += 1;
    }
  }
  return { done, errors };
}

/**
 * 为某连接补 schema 向量。默认只补 embedding 为空的行;force=true 全量重建。
 * @param {string} connectionId
 * @param {{projectId?:string, force?:boolean, tableIds?:string[]|null, includeTables?:boolean, includeColumns?:boolean}} [opts]
 * @returns {Promise<{tables:number, columns:number, skipped?:string, error?:string}>}
 */
export async function embedConnectionSchema(
  connectionId,
  { projectId = null, force = false, tableIds = null, includeTables = true, includeColumns = true } = {},
) {
  if (!vectorReady) return { tables: 0, columns: 0, skipped: '向量扩展未加载' };
  try {
    const filteredTableIds = Array.isArray(tableIds)
      ? tableIds.map((id) => String(id || '').trim()).filter(Boolean)
      : null;
    const hasTableFilter = !!(filteredTableIds && filteredTableIds.length);
    const filterSql = hasTableFilter ? 'AND id = ANY($2::text[])' : '';
    const columnFilterSql = hasTableFilter ? 'AND t.id = ANY($2::text[])' : '';
    const params = hasTableFilter ? [connectionId, filteredTableIds] : [connectionId];
    const blank = force ? '' : "AND (embedding IS NULL OR embedding = '')";
    const blankC = force ? '' : "AND (c.embedding IS NULL OR c.embedding = '')";

    let tCount = 0;
    const errors = [];
    if (includeTables) {
      const tables = await query(
        `SELECT id, table_name, description, keywords FROM table_metadata
          WHERE database_connection_id = $1 AND deleted_at IS NULL ${filterSql} ${blank}`,
        params,
      ).catch(() => []);
      const embedded = await embedRows(
        tables, (r) => `${jstr(r.table_name)} ${jstr(r.description)} ${jstr(r.keywords)}`.trim(), 'table_metadata', projectId,
      );
      tCount = embedded.done;
      errors.push(...embedded.errors);
    }

    let cCount = 0;
    if (includeColumns) {
      const cols = await query(
        `SELECT c.id, c.column_name, c.description, c.example_values
           FROM column_metadata c JOIN table_metadata t ON c.table_id = t.id
          WHERE t.database_connection_id = $1 AND c.deleted_at IS NULL AND t.deleted_at IS NULL ${columnFilterSql} ${blankC}`,
        params,
      ).catch(() => []);
      const embedded = await embedRows(
        cols, (r) => `${jstr(r.column_name)} ${jstr(r.description)} ${jstr(r.example_values)}`.trim(), 'column_metadata', projectId,
      );
      cCount = embedded.done;
      errors.push(...embedded.errors);
    }

    return { tables: tCount, columns: cCount, ...(errors.length ? { errors } : {}) };
  } catch (e) {
    console.warn(`[schema_embedding] 失败: ${e?.message ?? e}`);
    return { tables: 0, columns: 0, error: String(e?.message ?? e) };
  }
}

/**
 * 用插件的 getExampleValues 采样列示例值,填进 column_metadata.example_values(JSON 文本数组)。
 * 供 schema 同步后调用,提升 NL2SQL 上下文与 embedding 质量。DuckDB 无插件则跳过。
 * @param {string} connectionId
 * @param {object} plugin PluginRegistry.get(db_type) 实例
 * @param {object} config {db_type,host,port,username,password,database}
 * @param {{limit?:number, onlyEmpty?:boolean}} [opts]
 * @returns {Promise<{tables:number, columns:number, skipped?:string}>}
 */
export async function populateExampleValues(connectionId, plugin, config, { limit = 3, onlyEmpty = true } = {}) {
  if (!plugin || typeof plugin.getExampleValues !== 'function') {
    return { tables: 0, columns: 0, skipped: '插件不支持 getExampleValues' };
  }
  // onlyEmpty 时:只取还有空 example_values 列的表,避免在已覆盖的表上重复采样(re-sync 提速)。
  const tableSql = onlyEmpty
    ? `SELECT DISTINCT t.id, t.schema_name, t.table_name
         FROM table_metadata t JOIN column_metadata c ON c.table_id = t.id
        WHERE t.database_connection_id = $1 AND t.deleted_at IS NULL AND c.deleted_at IS NULL
          AND (c.example_values IS NULL OR c.example_values = '')`
    : `SELECT id, schema_name, table_name FROM table_metadata
        WHERE database_connection_id = $1 AND deleted_at IS NULL`;
  const tables = await query(tableSql, [connectionId]).catch(() => []);
  let tCount = 0; let cCount = 0;
  for (const tb of tables) {
    let examples;
    try {
      examples = await plugin.getExampleValues(config, tb.table_name, { schemaName: tb.schema_name, limit });
    } catch (e) {
      console.warn(`[example_values] 表 ${tb.table_name} 采样失败: ${e?.message ?? e}`);
      continue;
    }
    if (!examples || typeof examples !== 'object') continue;
    tCount += 1;
    for (const [colName, values] of Object.entries(examples)) {
      if (!Array.isArray(values) || !values.length) continue;
      const blank = onlyEmpty ? "AND (example_values IS NULL OR example_values = '')" : '';
      await query(
        `UPDATE column_metadata SET example_values = $1, updated_at = now()
          WHERE table_id = $2 AND column_name = $3 AND deleted_at IS NULL ${blank}`,
        [JSON.stringify(values), tb.id, colName],
      ).catch(() => {});
      cCount += 1;
    }
  }
  return { tables: tCount, columns: cCount };
}

export default embedConnectionSchema;
