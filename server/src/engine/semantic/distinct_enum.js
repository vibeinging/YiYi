// 迁移自 backend entity/column 服务的去重值采样 + 低基数自动枚举。
//   - column_metadata.distinct_values:低基数列(<=threshold)的去重候选值(NL2SQL WHERE 值匹配用)
//   - column_metadata.enum_mappings:低基数列自动枚举(code=label=value;对齐 intelligent_sampler 的 sync 策略)
//
// 注:Node column_metadata 不存原始列注释,故 Python 的「注释正则解析码值」路径无输入,
// 这里只做基于 distinct 的自动枚举;真实码值翻译(0=启用)需注释或 LLM,后续增量。

import { query } from '../../db.js';

const DEFAULT_THRESHOLD = 50;   // 去重值上限(超过视为非枚举,不落)
const ENUM_MAX = 50;            // 自动枚举上限

function isLikelyCategorical(dataType) {
  const t = String(dataType || '').toLowerCase();
  // 连续/大文本/时间列不当枚举
  if (/(float|double|decimal|real|numeric|timestamp|datetime|date|time|blob|json|text)/.test(t)) return false;
  return true;
}

/**
 * 为某连接的低基数列填 distinct_values + 自动 enum_mappings。
 * @param {string} connectionId
 * @param {object} plugin PluginRegistry.get(db_type) 实例(需 getDistinctValues)
 * @param {object} config {db_type,host,port,username,password,database}
 * @param {{threshold?:number, onlyEmpty?:boolean}} [opts]
 * @returns {Promise<{columns:number, enums:number, skipped?:string}>}
 */
export async function populateDistinctAndEnum(connectionId, plugin, config, { threshold = DEFAULT_THRESHOLD, onlyEmpty = true } = {}) {
  if (!plugin || typeof plugin.getDistinctValues !== 'function') {
    return { columns: 0, enums: 0, skipped: '插件不支持 getDistinctValues' };
  }
  const blank = onlyEmpty ? "AND (c.distinct_values IS NULL OR c.distinct_values = '')" : '';
  const cols = await query(
    `SELECT c.id, c.column_name, c.data_type, t.table_name, t.schema_name
       FROM column_metadata c JOIN table_metadata t ON c.table_id = t.id
      WHERE t.database_connection_id = $1 AND c.deleted_at IS NULL AND t.deleted_at IS NULL ${blank}`,
    [connectionId],
  ).catch(() => []);

  let cCount = 0; let eCount = 0;
  for (const col of cols) {
    if (!isLikelyCategorical(col.data_type)) continue;
    let res;
    try {
      res = await plugin.getDistinctValues(config, col.table_name, col.column_name, {
        schemaName: col.schema_name, limit: threshold + 1,
      });
    } catch (e) {
      continue;
    }
    if (!res?.success || !Array.isArray(res.data)) continue;
    const values = res.data.filter((v) => v !== null && v !== undefined && String(v) !== '');
    // 超过阈值:非枚举列,不落 distinct(避免把高基数列当枚举)
    if (!values.length || values.length > threshold) continue;

    await query(
      `UPDATE column_metadata SET distinct_values=$1, updated_at=now() WHERE id=$2`,
      [JSON.stringify(values), col.id],
    ).catch(() => {});
    cCount += 1;

    // 自动枚举(code=label=value):1<len<=ENUM_MAX 才建,单值列无枚举意义
    if (values.length > 1 && values.length <= ENUM_MAX) {
      const mapping = {};
      for (const v of values) mapping[String(v)] = String(v);
      await query(
        `UPDATE column_metadata SET enum_mappings=$1, updated_at=now() WHERE id=$2`,
        [JSON.stringify(mapping), col.id],
      ).catch(() => {});
      eCount += 1;
    }
  }
  return { columns: cCount, enums: eCount };
}
