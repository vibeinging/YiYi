// 迁移自 backend/yiw_kernel/semantic_catalogs/business/entity_service_base.py
//
// 实体服务基类 —— 提供实体管理的公共方法，供数据库 / 结构化数据服务继承使用。
// 是 metric_service / metric_view / entity_service 的依赖基类，对外方法名按源码 1:1 保留。
//
// ============================ 桌面版迁移要点 ============================
// 1. 无 ORM / AsyncSession：原 Python 用 SQLAlchemy select/func + db.add/flush/commit。
//    本版所有需要查库的方法第一个参数改为注入的 ctx/deps：
//      { query(sql, params)->Promise<rows>, queryOne(sql, params)->Promise<row|null>,
//        execute(sql, params)->Promise<{rowCount}> }（与其它已迁文件一致）。
//    ⚠️ 桌面版无写库/事务接口；原 db.add_all + db.flush 的「批量写实体」纯插入语义在本层
//       退化为返回待插入的实体行数组（caller 自行落库），保留对外方法名与返回结构。
//    Vastbase 把空串当 NULL：判空用 IS NOT NULL；所有查询带 deleted_at IS NULL 软删过滤。
//    .in_() → = ANY($n)。
// 2. embedding/向量召回：llm.js 无 embed()，ctx.query 不能跑 pgvector。
//    - search_similar_entities：原 pgvector cosine_distance 召回退化为
//      name/meta_data 关键词 LIKE/子串打分召回（参照 schema_retrieval_service._keywordScore）。
//      保留对外接口与返回形状（id/name/entity_name/similarity/meta_data/table_name/
//      schema_name/column_name/source_type/rule）。
//      TODO(embedding): 接入真正向量检索后，把 _keywordScoreEntities 换回 cosine_distance 查询。
//    - _generate_embeddings_for_entities：无 embed()，退化为 no-op（返回 {total:0,processed:0}），
//      并标注 TODO(embedding)。
//    - _batch_get_entity_stats 的 vector_count（COUNT(embedding)）保留按 embedding IS NOT NULL 统计。
// 3. 表名（蛇形复数）：entity_mappings / entity_mapping_configs / businesses（来自 models.__tablename__）。
//    meta_data 在 entity_mappings 表里是 Text(JSON 字符串)；metadata_fields/sample_entities 在
//    entity_mapping_configs 里是 JSONB（pg 驱动返回对象/数组）。
// =======================================================================

import { NotFoundError } from '../core/exceptions.js';
import { t } from '../utils/i18n.js';
import { embed } from '../core/llm.js';
import { vectorReady } from '../../db.js';

// embedding 模型名（与 embed() 默认 EMBEDDING 模型 text-embedding-v3 对齐）
const EMBEDDING_MODEL = 'text-embedding-v3';

/**
 * 把查询文本向量化（供 vexdb_cosine_distance 召回）。query_embedding 已给则直接用；
 * 否则调 embed()。任何失败（无 EMBEDDING 模型 / 扩展未加载）返回 null → 调用方回退关键词。
 * 参照 schema_retrieval_service.js 的 embedQuestion 写法。
 * @param {string} queryText
 * @param {string|null} project_id
 * @param {number[]|null} query_embedding
 * @returns {Promise<number[]|null>}
 */
async function embedQuestion(queryText, project_id = null, query_embedding = null) {
  if (Array.isArray(query_embedding) && query_embedding.length) return query_embedding;
  if (!vectorReady || !queryText || !String(queryText).trim()) return null;
  try {
    const v = await embed(queryText, { project_id });
    return Array.isArray(v) && v.length ? v : null;
  } catch (e) {
    console.warn(`[EntityServiceBase] embed 失败，回退关键词召回: ${e?.message ?? e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 关键词召回打分工具（embedding 退化实现，参照 schema_retrieval_service.js）
// 把 query_text 切成关键词（中英文/数字混合），对候选文本计算命中数 → 伪 similarity(0~1)。
// ---------------------------------------------------------------------------
function tokenizeQuery(queryText) {
  if (!queryText) return [];
  const lower = String(queryText).toLowerCase();
  const asciiTokens = lower.match(/[a-z0-9_]+/g) || [];
  const cjkChars = lower.match(/[一-鿿]/g) || [];
  const cjkBigrams = [];
  for (let i = 0; i + 1 < cjkChars.length; i += 1) {
    cjkBigrams.push(cjkChars[i] + cjkChars[i + 1]);
  }
  const tokens = new Set(
    [...asciiTokens, ...cjkChars, ...cjkBigrams].filter((tk) => tk && tk.length >= 1),
  );
  return [...tokens];
}

/** 对一段文本统计 tokens 的命中数（子串匹配，大小写不敏感）。 */
function countHits(text, tokens) {
  if (!text || !tokens.length) return 0;
  const hay = String(text).toLowerCase();
  let hits = 0;
  for (const tk of tokens) {
    if (hay.includes(tk)) hits += 1;
  }
  return hits;
}

export class EntityServiceBase {
  // ==================== 公共辅助方法 ====================

  /**
   * 验证项目（去业务层后：scope 恒为 project_id，不再查 businesses 表）。
   * 保留方法名以兼容下游 import；签名退化为只收 project_id，恒放行（项目存在性由路由层/上层保证）。
   * @param {{queryOne:Function}} ctx
   * @param {string} project_id
   * @returns {Promise<object>} { id: project_id }
   */
  static async _validate_business(ctx, project_id) {
    return { id: project_id, project_id };
  }

  /**
   * 将数据库值转换为 JSON 可序列化的格式。
   * 对应 Python 的 Decimal/datetime/date/time/UUID/bytes 处理；
   * JS 中 pg 驱动一般已返回原生类型，这里做兜底转换。
   * @param {*} value
   * @returns {*}
   */
  static _to_json_serializable(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))) {
      try {
        return Buffer.from(value).toString('utf-8');
      } catch (_) {
        return Buffer.from(value).toString('hex');
      }
    }
    if (Array.isArray(value)) {
      return value.map((item) => EntityServiceBase._to_json_serializable(item));
    }
    if (typeof value === 'object') {
      const result = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = EntityServiceBase._to_json_serializable(v);
      }
      return result;
    }
    return String(value);
  }

  /**
   * 选取不同长度的样本实体。
   * @param {Array<string>} entities
   * @param {number} [count=3]
   * @returns {Array<string>}
   */
  static get_diverse_length_samples(entities, count = 3) {
    if (!entities || !entities.length) return [];
    const uniqueEntities = [...new Set(entities)];
    if (uniqueEntities.length <= count) return uniqueEntities;
    const sortedEntities = [...uniqueEntities].sort((a, b) => String(a).length - String(b).length);
    const bucketSize = Math.floor(sortedEntities.length / count);
    const samples = [];
    for (let i = 0; i < count; i += 1) {
      const idx = i * bucketSize + Math.floor(bucketSize / 2);
      samples.push(sortedEntities[Math.min(idx, sortedEntities.length - 1)]);
    }
    return samples;
  }

  /**
   * 计算向量状态。
   * @param {number} entity_count
   * @param {number} vector_count
   * @returns {string}
   */
  static _calculate_vector_status(entity_count, vector_count) {
    if (entity_count === 0) return '未生成';
    if (vector_count === entity_count) return '已生成';
    if (vector_count > 0) return `部分生成(${vector_count}/${entity_count})`;
    return '未生成';
  }

  /**
   * 解析 meta_data JSON 字符串。
   * @param {string|object|null} meta_data_str
   * @returns {object}
   */
  static _parse_meta_data(meta_data_str) {
    if (!meta_data_str) return {};
    if (typeof meta_data_str === 'object') return meta_data_str;
    try {
      const parsed = JSON.parse(meta_data_str);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  // ==================== 批量存储实体 ====================

  /**
   * 批量构建实体行（对应原版 _store_entities_batch）。
   *
   * ⚠️ 桌面版无写库/事务接口：原 Python 用 db.add_all + db.flush 真插入并回填主键。
   *    本层退化为「构建并返回待插入实体行数组」，由 caller 负责落库（保留对外方法名与返回结构）。
   *    每行结构对齐 entity_mappings 表列：
   *      { business_id, name, source_id, source_type, entity_type, config_id, meta_data(JSON字符串) }。
   *
   * @param {object} ctx 注入的 deps（保留位置参数，当前不直接写库）
   * @param {string} project_id
   * @param {string} source_id
   * @param {string} source_type
   * @param {Array<object>} entity_values
   * @param {string} table_name
   * @param {string} column_name
   * @param {object} [opts]
   * @param {string|null} [opts.config_id=null]
   * @param {string} [opts.entity_type='column_value']
   * @param {boolean} [opts.include_source_value=true] 是否在 meta_data 中包含 source_value 字段
   * @param {string|null} [opts.schema_name=null] Schema 名称（多 schema 场景）
   * @returns {Promise<Array<object>>} 待插入的实体行数组
   */
  static async _store_entities_batch(
    ctx,
    project_id,
    source_id,
    source_type,
    entity_values,
    table_name,
    column_name,
    {
      config_id = null,
      entity_type = 'column_value',
      include_source_value = true,
      schema_name = null,
    } = {},
  ) {
    const entityMappings = [];
    for (const entityData of entity_values) {
      const entityName = entityData.entity_name;

      // 构建 meta_data
      const metaData = {
        table_name,
        column_name,
      };

      // 添加 schema_name（多 schema 场景下用于区分同名表）
      if (schema_name) {
        metaData.schema_name = schema_name;
      }

      if (include_source_value) {
        metaData.source_value = entityData.source_value ?? entityName;
      }

      // 添加其他元数据字段
      for (const [key, value] of Object.entries(entityData)) {
        if (!['entity_name', 'table_name', 'column_name', 'source_value'].includes(key)) {
          metaData[key] = value;
        }
      }

      entityMappings.push({
        project_id,
        name: entityName,
        source_id,
        source_type,
        entity_type,
        config_id,
        meta_data: JSON.stringify(metaData),
      });
    }

    // 桌面版：返回待插入行（原版 db.add_all + db.flush 由 caller 接管）。
    return entityMappings;
  }

  // ==================== 批量统计查询 ====================

  /**
   * 批量获取实体统计信息（实体数量和向量数量）。
   * @param {{query:Function}} ctx
   * @param {Array<string>} config_ids
   * @returns {Promise<Object<string,{entity_count:number, vector_count:number}>>}
   */
  static async _batch_get_entity_stats(ctx, config_ids) {
    if (!config_ids || !config_ids.length) return {};

    const rows = await ctx.query(
      `SELECT config_id,
              COUNT(id)        AS entity_count,
              COUNT(embedding) AS vector_count
         FROM entity_mappings
        WHERE config_id::text = ANY($1::text[])
          AND deleted_at IS NULL
        GROUP BY config_id`,
      [config_ids],
    );

    const result = {};
    for (const row of rows) {
      result[row.config_id] = {
        entity_count: Number(row.entity_count) || 0,
        vector_count: Number(row.vector_count) || 0,
      };
    }
    return result;
  }

  /**
   * 批量获取每个配置的实体预览。
   * @param {{query:Function}} ctx
   * @param {Array<string>} config_ids
   * @param {number} [limit_per_config=20]
   * @returns {Promise<Object<string, Array<object>>>}
   */
  static async _batch_get_entity_previews(ctx, config_ids, limit_per_config = 20) {
    if (!config_ids || !config_ids.length) return {};

    const rows = await ctx.query(
      `SELECT config_id, name, meta_data
         FROM entity_mappings
        WHERE config_id::text = ANY($1::text[])
          AND deleted_at IS NULL
        ORDER BY config_id, name`,
      [config_ids],
    );

    const previewsByConfig = {};
    const currentCounts = {};

    for (const row of rows) {
      const configId = row.config_id;

      if (!(configId in previewsByConfig)) {
        previewsByConfig[configId] = [];
        currentCounts[configId] = 0;
      }

      if (currentCounts[configId] >= limit_per_config) continue;

      // 解析 meta_data 获取描述和实际列名
      let description = null;
      let actualColumnName = null;
      let isAlias = false;
      if (row.meta_data) {
        const meta = EntityServiceBase._parse_meta_data(row.meta_data);
        description = meta.description ?? null;
        actualColumnName = meta.column_name ?? null; // 实际的英文列名
        isAlias = meta.is_alias ?? false;
      }

      previewsByConfig[configId].push({
        name: row.name,
        column_name: actualColumnName, // 实际的英文列名
        description,
        is_alias: isAlias, // 是否为中文注释别名
      });
      currentCounts[configId] += 1;
    }

    return previewsByConfig;
  }

  // ==================== 实体搜索（通用） ====================

  /**
   * 搜索相似实体（通用方法）。
   *
   * 召回策略：① 优先真·向量召回（vexdb_cosine_distance，对 entity_mappings.embedding 按余弦距离
   *   升序取 top-N）；② 向量为空（无 EMBEDDING 模型 / 扩展未加载 / 该业务无 embedding 行）时回退
   *   到对 name/meta_data(table_name/column_name/description) 的关键词命中打分。
   *   两条路返回结构完全一致（下游依赖）。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} business_id
   * @param {string} query_text
   * @param {string} project_id 用于 embed（向量召回）
   * @param {object} [opts]
   * @param {Array<string>|null} [opts.config_ids=null] 配置 ID 列表（与 source_id/source_type 二选一）
   * @param {string|null} [opts.source_id=null]
   * @param {string|null} [opts.source_type=null]
   * @param {number} [opts.limit=10]
   * @param {Array<number>|null} [opts.query_embedding=null] 预计算的查询向量（已给则直接用）
   * @returns {Promise<Array<object>>}
   */
  static async search_similar_entities(ctx, business_id, query_text, project_id, {
    config_ids = null, source_id = null, source_type = null, limit = 10, query_embedding = null,
  } = {}) {
    try {
      // 构建查询条件（关键词召回不依赖 embedding，去掉 embedding IS NOT NULL 限制，
      // 否则桌面版无向量将永远返回空）。优先用 config_ids 过滤。
      const conditions = ['em.deleted_at IS NULL'];
      const params = [];

      if (config_ids && config_ids.length) {
        params.push(config_ids);
        conditions.push(`em.config_id = ANY($${params.length})`);
      } else if (business_id) {
        // 向后兼容：没有 config_ids 时回退到 business_id 过滤
        params.push(business_id);
        conditions.push(`em.business_id = $${params.length}`);
      }
      if (source_id) {
        params.push(source_id);
        conditions.push(`em.source_id = $${params.length}`);
      }
      if (source_type) {
        params.push(source_type);
        conditions.push(`em.source_type = $${params.length}`);
      }

      // ① 优先真·向量召回（vexdb_cosine_distance）；失败 / 无 embedding 回退关键词
      let entities = null;
      const qvec = await embedQuestion(query_text, project_id, query_embedding);
      if (qvec) {
        entities = await EntityServiceBase._vectorScoreEntities(ctx, conditions, params, qvec, limit);
        if (entities && entities.length) {
          console.info(`🔍 [EntitySearch] 向量召回(vexdb) '${query_text}' 命中 ${entities.length} 个实体`);
        }
      }

      // ② 关键词兜底（无向量结果时）
      if (!entities || !entities.length) {
        // JOIN 配置取 rule，与原版返回字段对齐
        const rows = await ctx.query(
          `SELECT em.id           AS id,
                  em.name         AS name,
                  em.entity_type  AS entity_type,
                  em.meta_data    AS meta_data,
                  emc.rule        AS rule
             FROM entity_mappings em
             JOIN entity_mapping_configs emc ON em.config_id = emc.id
            WHERE ${conditions.join(' AND ')}`,
          params,
        );
        if (!rows.length) return [];
        entities = EntityServiceBase._keywordScoreEntities(rows, query_text, limit);
        console.info(`🔍 [EntitySearch] 关键词召回(向量为空兜底) '${query_text}' 命中 ${entities.length} 个实体`);
      }

      for (const e of entities.slice(0, 5)) { // 只打印前 5 个
        const simStr = Number(e.similarity).toFixed(3);
        console.info(
          `🔍 [EntitySearch]   - ${e.entity_name} (sim=${simStr}, type=${e.source_type}, table=${e.table_name})`,
        );
      }

      return entities;
    } catch (e) {
      console.error(`搜索相似实体失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * vexdb_cosine_distance 向量召回实体：在已构建的过滤条件上追加 embedding IS NOT NULL，
   * 按余弦距离升序取 top-N。similarity = max(0, 1 - distance)。返回结构与关键词路径一致。
   * @param {{query:Function}} ctx
   * @param {Array<string>} conditions 已构建的 WHERE 条件（含 em.deleted_at IS NULL 等）
   * @param {Array} params 与 conditions 对应的参数
   * @param {number[]} queryVec 查询向量
   * @param {number} limit
   * @returns {Promise<Array<object>>}
   */
  static async _vectorScoreEntities(ctx, conditions, params, queryVec, limit) {
    // 复制条件/参数，避免污染调用方（关键词兜底仍要用原始 conditions/params）
    const vecParams = [JSON.stringify(queryVec), ...params];
    // 原 params 的占位符需整体右移 1 位（$1 留给查询向量）
    const shiftedConditions = conditions.map(
      (c) => c.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + 1}`),
    );
    const limitIdx = vecParams.length + 1;
    vecParams.push(limit);

    const rows = await ctx.query(
      `SELECT em.id           AS id,
              em.name         AS name,
              em.entity_type  AS entity_type,
              em.meta_data    AS meta_data,
              emc.rule        AS rule,
              vexdb_cosine_distance(em.embedding, vexdb_f32($1)) AS distance
         FROM entity_mappings em
         JOIN entity_mapping_configs emc ON em.config_id = emc.id
        WHERE ${shiftedConditions.join(' AND ')}
          AND em.embedding IS NOT NULL
        ORDER BY distance ASC
        LIMIT $${limitIdx}`,
      vecParams,
    ).catch((e) => {
      console.warn(`[EntityServiceBase] 向量召回实体 SQL 失败，回退关键词: ${e?.message ?? e}`);
      return [];
    });

    return rows.map((row) => {
      const metaData = EntityServiceBase._parse_meta_data(row.meta_data);
      const sourceType = metaData.source_type || row.entity_type || 'column_value';
      const columnName = metaData.column_name
        || (sourceType === 'column_name' ? row.name : '');
      const distance = Number(row.distance ?? 1);
      return {
        id: row.id,
        name: row.name,
        entity_name: row.name, // 前端兼容字段
        similarity: Math.max(0, 1.0 - distance),
        distance,
        meta_data: metaData,
        table_name: metaData.table_name || '',
        schema_name: metaData.schema_name || '',
        column_name: columnName,
        source_type: sourceType,
        rule: row.rule ?? null,
      };
    });
  }

  /**
   * 关键词命中给实体打分并按伪 similarity 排序，取前 limit 个，构造与原版一致的返回结构。
   * @param {Array<object>} rows entity_mappings JOIN 行
   * @param {string} query_text
   * @param {number} limit
   * @returns {Array<object>}
   */
  static _keywordScoreEntities(rows, query_text, limit) {
    const tokens = tokenizeQuery(query_text);
    const norm = Math.max(1, Math.min(tokens.length, 5));

    const scored = rows.map((row) => {
      const metaData = EntityServiceBase._parse_meta_data(row.meta_data);

      // 获取 source_type：优先从 meta_data，其次从 entity.entity_type
      const sourceType = metaData.source_type || row.entity_type || 'column_value';

      // 获取 column_name：
      // - column_name 类型实体可能是英文列名或中文注释，统一从 meta_data 获取
      // - column_value 类型实体：从 meta_data 获取
      const columnName = metaData.column_name
        || (sourceType === 'column_name' ? row.name : '');

      // 命中打分：name + meta_data 的 description / column_name / table_name
      const hits = countHits(row.name, tokens)
        + countHits(metaData.description, tokens)
        + countHits(metaData.column_name, tokens)
        + countHits(metaData.table_name, tokens);
      const similarity = tokens.length ? Math.min(1.0, hits / norm) : 0.5;

      return {
        id: row.id,
        name: row.name,
        entity_name: row.name, // 前端兼容字段
        similarity,
        meta_data: metaData,
        table_name: metaData.table_name || '',
        schema_name: metaData.schema_name || '',
        column_name: columnName,
        source_type: sourceType, // column_value（数据名词）或 column_name（字段名词）
        rule: row.rule ?? null,
        _hits: hits,
      };
    });

    scored.sort((a, b) => (b.similarity - a.similarity));
    const limited = scored.slice(0, limit);
    for (const r of limited) delete r._hits;
    return limited;
  }

  // ==================== 批量生成向量 ====================

  /**
   * 拼接实体向量化文本：name + meta_data 里的 description / column_name / table_name。
   * @param {object} row entity_mappings 行（含 name / meta_data）
   * @returns {string}
   */
  static _entityEmbeddingText(row) {
    const meta = EntityServiceBase._parse_meta_data(row.meta_data);
    const parts = [
      row.name,
      meta.description,
      meta.column_name,
      meta.table_name,
    ].filter((s) => s != null && String(s).trim());
    return parts.join(' ').trim();
  }

  /**
   * 批量为实体生成向量嵌入（通用方法）。
   *
   * 对该来源下 embedding IS NULL 的实体，按 ≤16 一批组合文本 → embed() → 逐行 UPDATE
   * embedding/embedding_model/updated_at。无 EMBEDDING 模型 / 向量扩展未就绪 / embed 失败时
   * catch 后保留降级（不抛），processed 计已成功写入的行数。
   *
   * @param {{query:Function, queryOne:Function, execute?:Function}} ctx 注入的 deps
   * @param {string} business_id
   * @param {string} source_id
   * @param {string} source_type
   * @param {string} project_id 用于 embed
   * @param {number} [batch_size=100] 取数上限（实际 embed 每批 ≤16）
   * @returns {Promise<{total:number, processed:number}>}
   */
  static async _generate_embeddings_for_entities(
    ctx, business_id, source_id, source_type, project_id, batch_size = 100,
  ) {
    try {
      if (!vectorReady) {
        console.warn('[EntityServiceBase] 向量扩展未就绪，跳过实体向量生成');
        return { total: 0, processed: 0 };
      }

      // 拉取该来源下待向量化的实体（embedding IS NULL）
      const conditions = ['em.deleted_at IS NULL', 'em.embedding IS NULL'];
      const params = [];
      if (source_id) {
        params.push(source_id);
        conditions.push(`em.source_id = $${params.length}`);
      }
      if (source_type) {
        params.push(source_type);
        conditions.push(`em.source_type = $${params.length}`);
      }
      if (!source_id && business_id) {
        params.push(business_id);
        conditions.push(`em.business_id = $${params.length}`);
      }
      params.push(batch_size);
      const rows = await ctx.query(
        `SELECT em.id AS id, em.name AS name, em.meta_data AS meta_data
           FROM entity_mappings em
          WHERE ${conditions.join(' AND ')}
          LIMIT $${params.length}`,
        params,
      );

      const total = rows.length;
      if (!total) return { total: 0, processed: 0 };

      let processed = 0;
      const EMBED_BATCH = 16;
      for (let i = 0; i < rows.length; i += EMBED_BATCH) {
        const batch = rows.slice(i, i + EMBED_BATCH);
        const texts = batch.map((r) => EntityServiceBase._entityEmbeddingText(r));
        let vecs;
        try {
          vecs = await embed(texts, { project_id });
        } catch (e) {
          console.warn(`[EntityServiceBase] 实体 embed 失败，保留降级: ${e?.message ?? e}`);
          break; // 无 EMBEDDING 模型 / 调用失败：停止本轮，已写入的不回滚
        }
        if (!Array.isArray(vecs) || !vecs.length) break;

        for (let j = 0; j < batch.length; j += 1) {
          const vec = vecs[j];
          if (!Array.isArray(vec) || !vec.length) continue;
          await EntityServiceBase._updateEntityEmbedding(ctx, batch[j].id, vec);
          processed += 1;
        }
      }

      console.info(`[EntityServiceBase] 实体向量生成完成：total=${total}, processed=${processed}`);
      return { total, processed };
    } catch (e) {
      console.error(`实体向量生成失败: ${e?.message ?? e}`);
      return { total: 0, processed: 0 };
    }
  }

  /**
   * 写回单个实体的向量（embedding/embedding_model/updated_at）。优先 ctx.execute，否则 ctx.query。
   * @param {{query:Function, execute?:Function}} ctx
   * @param {string} id
   * @param {number[]} vec
   * @returns {Promise<void>}
   */
  static async _updateEntityEmbedding(ctx, id, vec) {
    const sql = 'UPDATE entity_mappings SET embedding = $1, embedding_model = $2, updated_at = now() WHERE id = $3';
    const sqlParams = [JSON.stringify(vec), EMBEDDING_MODEL, id];
    if (typeof ctx.execute === 'function') {
      await ctx.execute(sql, sqlParams);
    } else {
      await ctx.query(sql, sqlParams);
    }
  }
}

export default EntityServiceBase;
