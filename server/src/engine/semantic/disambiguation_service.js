// 迁移自 backend/agenticdata_kernel/semantic_catalogs/business/disambiguation_service.py
//
// 消歧偏好记忆服务
//
// per-business 共享的"用户选过的字面量 → 真值"映射，给 align_value 提供长期记忆。
// 不存 embedding、不做 similarity；lookup 按 (business, table, column) 拉最近 N 条
// 全丢给 LLM 看文本判断。
//
// ============================ 桌面版迁移要点 ============================
// DB 访问约定（与其它已迁文件一致）：所有需要查库的方法第一个参数为 ctx/deps 对象，
// 形如 { query(sql, params)->Promise<rows>, queryOne(sql, params)->Promise<row|null> }，
// 由上层注入（对齐 Python 版 db: AsyncSession 的位置）。本服务【不直接连库】。
//
// 表名：disambiguation_resolutions（来自 models.DisambiguationResolution.__tablename__）。
// 列：id / project_id / project_id / source_table / source_column / normalized_keyword /
//     chosen_value / chosen_value_meta / hit_count / last_used_at / created_by /
//     created_at / updated_at / deleted_at / deleted_by。
//
// Vastbase 把空串当 NULL：判空一律用 IS NOT NULL，绝不用 <> ''。
// 所有查询带 deleted_at IS NULL 软删过滤。
// partial unique（ux_disambig_res_active）= (project_id, source_table, source_column,
//   normalized_keyword, chosen_value) WHERE deleted_at IS NULL。
//
// 主键 id：桌面版无 ORM 默认值；INSERT 时由本服务用 crypto.randomUUID() 生成（对应
//   Python 端 uuid7 默认值）。created_at/updated_at 显式写入 now。
//
// embedding：本服务本就不用向量，无需降级。
// fastapi_cache @cache → 用已迁 cache.js 的 withCache（120s）。
// IntegrityError 并发 race → 桌面单机 pg 抛唯一键冲突时同样进 fallback 分支；以错误码/
//   消息含 'unique'/'duplicate' 近似判定（见 _isUniqueViolation）。
// =======================================================================

import { randomUUID } from 'crypto';

import { normalize_entity_key } from '../datasources/data_grep.js';
import { invalidate_cache, withCache, service_key_builder } from '../core/cache.js';
import { t } from '../utils/i18n.js';
import { ValidationError, NotFoundError } from '../core/exceptions.js';

const _LOOKUP_LIMIT_DEFAULT = 20;
const _CHOSEN_VALUE_MAX_LEN = 512;

// 时间衰减半衰期（天）：30 天后 hit_count 等效折半。
// 兼顾"团队历史频次"与"近期重选"，让老旧但 hit_count 高的值不再永久霸榜。
const _DECAY_HALF_LIFE_DAYS = 30.0;

const _TABLE = 'disambiguation_resolutions';

/**
 * score = hit_count * exp(-Δdays / half_life)；hit_count<=0 视为 0 分。
 * @param {number} hit_count
 * @param {Date|string|null} last_used_at
 * @param {Date} now
 * @returns {number}
 */
function _decay_score(hit_count, last_used_at, now) {
  if (!hit_count || hit_count <= 0) return 0.0;
  if (last_used_at == null) return Number(hit_count);
  const last = last_used_at instanceof Date ? last_used_at : new Date(last_used_at);
  const delta_days = Math.max(0.0, (now.getTime() - last.getTime()) / 86400000.0);
  return hit_count * Math.exp(-delta_days / _DECAY_HALF_LIFE_DAYS);
}

// session 级"本会话不再问，自动应用 memory"开关。用户在 chip 上勾选后，
// 本 session 内 align_value memory 命中直接 short-circuit；未勾选则正常 ask_user。
const _AUTO_APPLY_KEY_PREFIX = 'session_auto_apply_memory:';
const _AUTO_APPLY_TTL_SECONDS = 86400; // 24h，与 session 典型生命周期对齐

/**
 * 读 session-level auto-apply 标志。Redis 不可用时返回 false（安全降级）。
 * @param {string} session_id
 * @returns {Promise<boolean>}
 */
export async function is_session_auto_apply_memory(session_id) {
  if (!session_id) return false;
  try {
    const { get_cache_redis_client } = await import('../core/redis_manager.js');
    const client = await get_cache_redis_client();
    const value = await client.get(_AUTO_APPLY_KEY_PREFIX + session_id);
    return value === '1' || value === 1 || value === true;
  } catch (e) {
    console.warn(`[auto_apply_memory] 读 flag 失败（按未启用处理）: ${e}`);
    return false;
  }
}

/**
 * 写 session-level auto-apply 标志。enabled=false 时直接删 key。
 * @param {string} session_id
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
export async function set_session_auto_apply_memory(session_id, enabled) {
  if (!session_id) return;
  try {
    const { get_cache_redis_client } = await import('../core/redis_manager.js');
    const client = await get_cache_redis_client();
    const key = _AUTO_APPLY_KEY_PREFIX + session_id;
    if (enabled) {
      await client.set(key, '1', { ex: _AUTO_APPLY_TTL_SECONDS });
    } else {
      await client.delete(key);
    }
  } catch (e) {
    console.warn(`[auto_apply_memory] 写 flag 失败: ${e}`);
  }
}

// 复用 data_grep 的同一份归一化口径——双写口径漂会导致 align_value 召回到的值
// 与记忆 lookup 的 key 不一致（同一实体两条独立记忆 / lookup miss 等诡异）。
export const normalize_keyword = normalize_entity_key;

/**
 * 精确粒度失效：按 (project_id, source_table, source_column) 三元组清。
 * @param {string} project_id
 * @param {string} source_table
 * @param {string} source_column
 * @returns {Promise<void>}
 */
async function _invalidate_lookup_cache(project_id, source_table, source_column) {
  await invalidate_cache('lookup_by_keyword', {
    project_id,
    source_table,
    source_column,
  });
}

/**
 * 近似判定唯一键冲突（对应 SQLAlchemy IntegrityError）。
 * pg 唯一约束违例 SQLSTATE=23505；不同驱动消息文案兼容兜底。
 * @param {any} e
 * @returns {boolean}
 */
function _isUniqueViolation(e) {
  if (!e) return false;
  if (e.code === '23505') return true;
  const msg = String(e.message || e).toLowerCase();
  return msg.includes('unique') || msg.includes('duplicate') || msg.includes('23505');
}

/** ISO 字符串（null-safe）。 */
function _iso(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** lookup_by_keyword 未缓存内核。 */
async function _lookup_by_keyword_impl(ctx, project_id, source_table, source_column, keyword) {
  if (!(project_id && source_table && source_column && keyword)) return [];

  const normalized = normalize_keyword(keyword);
  if (!normalized) return [];

  const rows = await ctx.query(
    `SELECT id, normalized_keyword, chosen_value, hit_count, last_used_at, created_at, created_by
       FROM ${_TABLE}
      WHERE project_id = $1
        AND source_table = $2
        AND source_column = $3
        AND normalized_keyword = $4
        AND deleted_at IS NULL`,
    [project_id, source_table, source_column, normalized],
  );

  const now = new Date();
  // 同 keyword 下最多几条（partial unique by chosen_value），JS sort 性能无忧。
  // PG 兼容版部分不支持 exp() in ORDER BY，这里统一在应用层算。
  const rows_sorted = [...(rows || [])].sort((a, b) => {
    const sa = _decay_score(Number(a.hit_count || 0), a.last_used_at, now);
    const sb = _decay_score(Number(b.hit_count || 0), b.last_used_at, now);
    if (sa !== sb) return sb - sa;
    const ta = a.last_used_at ? new Date(a.last_used_at).getTime() : now.getTime();
    const tb = b.last_used_at ? new Date(b.last_used_at).getTime() : now.getTime();
    return tb - ta;
  });

  return rows_sorted.map((r) => ({
    id: r.id,
    normalized_keyword: r.normalized_keyword,
    chosen_value: r.chosen_value,
    hit_count: Number(r.hit_count || 0),
    last_used_at: _iso(r.last_used_at),
    created_at: _iso(r.created_at),
    created_by: r.created_by,
  }));
}

// @cache(expire=120, key_builder=service_key_builder) → withCache（内存化，120s）。
// 关键：ctx 是【每请求不同】的注入对象（plain object，service_key_builder 不会自动排除），
// 若进 key 会让缓存恒不命中、且污染 invalidate 匹配。故这里自定义 keyBuilder：
// 用具名 kwargs（project_id/source_table/source_column/keyword）构 key，显式跳过 ctx，
// 让 key = 'lookup_by_keyword:project_id=..:keyword=..:source_column=..:source_table=..'
// 与 invalidate_cache('lookup_by_keyword', {project_id, source_table, source_column}) 的
// 子串 needle 精确对齐（与 Python 排除 AsyncSession 等价）。
const _LOOKUP_KEY_FN = Object.assign(function lookup_by_keyword() {}, {});

function _lookup_key_builder(_fn, _ns, { args = [] } = {}) {
  const [, project_id, source_table, source_column, keyword] = args;
  return service_key_builder(_LOOKUP_KEY_FN, '', {
    kwargs: { project_id, source_table, source_column, keyword },
  });
}

const _lookup_by_keyword_cached = withCache({ expire: 120, keyBuilder: _lookup_key_builder })(
  function lookup_by_keyword(ctx, project_id, source_table, source_column, keyword) {
    return _lookup_by_keyword_impl(ctx, project_id, source_table, source_column, keyword);
  },
);


export class DisambiguationService {
  /**
   * 按 (business, table, column, normalize(keyword)) 精确拉历史记忆。
   *
   * 只返回 normalized_keyword 等于当前 keyword 归一化结果的条目——同表/列下
   * 别的 keyword 的历史不会污染候选。
   *
   * 排序：时间衰减分 score = hit_count * exp(-Δdays / 30)，应用层排序。
   * 老旧但 hit_count 高的值会被新鲜选择超过，避免霸榜。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} project_id
   * @param {string} source_table
   * @param {string} source_column
   * @param {string} keyword
   * @returns {Promise<Array<object>>}
   */
  static async lookup_by_keyword(ctx, project_id, source_table, source_column, keyword) {
    return _lookup_by_keyword_cached(ctx, project_id, source_table, source_column, keyword);
  }

  /**
   * ask_user 用户答复后写入或 upsert 一条消歧记忆。
   *
   * - chosen_value 必须出现在 candidates 中（P0-10 反 prompt injection）
   * - 超长（>512）直接拒绝写入（不静默截断）
   * - 同 (business, table, column, keyword, chosen_value) → hit_count++
   * - 同 keyword 不同 chosen_value → 新插一条（累积，不覆盖）
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @returns {Promise<string|null>} 写入行 id；校验失败 / 写库失败返回 null
   */
  static async record_resolution(
    ctx,
    {
      project_id,
      source_table,
      source_column,
      keyword,
      chosen_value,
      candidates = null,
      created_by = null,
    } = {},
  ) {
    if (!(project_id && source_table && source_column)) return null;

    const normalized = normalize_keyword(keyword);
    const chosen = (chosen_value || '').trim();
    if (!normalized || !chosen) return null;
    if (chosen.length > _CHOSEN_VALUE_MAX_LEN) {
      console.warn(`[DisambiguationService] chosen_value 超长 (${chosen.length})，拒绝写入`);
      return null;
    }

    if (candidates != null) {
      const candidate_values = new Set(
        (candidates || []).map((c) =>
          c && typeof c === 'object' && !Array.isArray(c) ? c.value : String(c),
        ),
      );
      if (!candidate_values.has(chosen)) {
        console.warn(
          `[DisambiguationService] record rejected: chosen_value ${JSON.stringify(chosen)} not in candidates`,
        );
        return null;
      }
    }

    let meta = null;
    if (candidates) {
      for (const c of candidates) {
        if (c && typeof c === 'object' && !Array.isArray(c) && c.value === chosen) {
          try {
            meta = JSON.stringify(c);
          } catch (_) {
            meta = null;
          }
          break;
        }
      }
    }

    const now = new Date();
    // 应用层 upsert：部分 PG 兼容版本（含国产兼容库）不支持
    // `ON CONFLICT ... WHERE` partial index upsert，改走 SELECT-then-INSERT/UPDATE
    // + 唯一键冲突并发 race fallback。
    const row_id = await DisambiguationService._upsert_active_row(ctx, {
      project_id,
      source_table,
      source_column,
      normalized,
      chosen,
      meta,
      created_by,
      now,
    });
    if (row_id == null) return null;

    await _invalidate_lookup_cache(project_id, source_table, source_column);
    return row_id;
  }

  /**
   * SELECT-then-INSERT/UPDATE upsert，partial unique 命中即更新。
   *
   * 同 (business, table, column, keyword, chosen_value) 命中 → hit_count++；
   * 同 keyword 不同 chosen_value → 插入新行（累积多个历史选择，不覆盖）。
   * 并发场景：两个进程同时 INSERT → 唯一键冲突 → fallback 再 SELECT + UPDATE。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @returns {Promise<string|null>}
   */
  static async _upsert_active_row(
    ctx,
    { project_id, source_table, source_column, normalized, chosen, meta, created_by, now },
  ) {
    const selectExisting = () =>
      ctx.queryOne(
        `SELECT id, hit_count
           FROM ${_TABLE}
          WHERE project_id = $1
            AND source_table = $2
            AND source_column = $3
            AND normalized_keyword = $4
            AND chosen_value = $5
            AND deleted_at IS NULL`,
        [project_id, source_table, source_column, normalized, chosen],
      );

    const doUpdate = async (existing) => {
      await ctx.query(
        `UPDATE ${_TABLE}
            SET chosen_value_meta = $1,
                hit_count = COALESCE(hit_count, 0) + 1,
                last_used_at = $2,
                updated_at = $2
          WHERE id = $3`,
        [meta, now, existing.id],
      );
      return existing.id;
    };

    let existing = await selectExisting();
    if (existing != null) {
      try {
        return await doUpdate(existing);
      } catch (e) {
        console.error(`[DisambiguationService] update 失败: ${e}`, e);
        return null;
      }
    }

    // INSERT 新行（桌面版手动生成 uuid 主键，对应 Python 端 uuid7 默认值）。
    const newId = randomUUID();
    try {
      await ctx.query(
        `INSERT INTO ${_TABLE}
           (id, project_id, source_table, source_column,
            normalized_keyword, chosen_value, chosen_value_meta, hit_count,
            last_used_at, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $8, $8)`,
        [
          newId,
          project_id,
          source_table,
          source_column,
          normalized,
          chosen,
          meta,
          now,
          created_by,
        ],
      );
      return newId;
    } catch (e) {
      if (_isUniqueViolation(e)) {
        // 并发 race：另一个进程刚 insert 了同唯一键 → 回退 UPDATE。
        existing = await selectExisting();
        if (existing == null) {
          console.error(
            '[DisambiguationService] 唯一键冲突后仍找不到 existing 行，' +
              '可能是 partial unique 约束之外的字段冲突',
          );
          return null;
        }
        try {
          return await doUpdate(existing);
        } catch (e2) {
          console.error(`[DisambiguationService] race fallback update 失败: ${e2}`, e2);
          return null;
        }
      }
      console.error(`[DisambiguationService] insert 失败: ${e}`, e);
      return null;
    }
  }

  /**
   * 命中识别：把多条 (table, column, chosen_value) 一条 SQL 批量 hit++。
   *
   * 与 record_resolution 一致：service 内提交 + 精确失效。返回更新的行数。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @param {string} opts.project_id
   * @param {Array<{table:string, column:string, value:string}>} opts.hits
   * @returns {Promise<number>}
   */
  static async update_hit_on_reuse(ctx, { project_id, hits } = {}) {
    if (!project_id || !hits || !hits.length) return 0;

    const keys = hits
      .filter((h) => h && h.table && h.column && h.value)
      .map((h) => [h.table, h.column, h.value]);
    if (!keys.length) return 0;

    const now = new Date();
    // tuple IN → 用 (col1,col2,col3) IN (VALUES ...) 参数化展开。
    const valueTuples = [];
    const params = [project_id];
    let p = params.length;
    for (const [tbl, col, val] of keys) {
      valueTuples.push(`($${p + 1}, $${p + 2}, $${p + 3})`);
      params.push(tbl, col, val);
      p += 3;
    }

    let rows;
    try {
      rows = await ctx.query(
        `UPDATE ${_TABLE}
            SET hit_count = hit_count + 1,
                last_used_at = $${params.length + 1},
                updated_at = $${params.length + 1}
          WHERE project_id = $1
            AND deleted_at IS NULL
            AND (source_table, source_column, chosen_value) IN (${valueTuples.join(', ')})
        RETURNING source_table, source_column`,
        [...params, now],
      );
    } catch (e) {
      console.warn(`[DisambiguationService] update_hit_on_reuse 失败（忽略）: ${e}`);
      return 0;
    }

    rows = rows || [];
    const seen = new Set();
    for (const r of rows) {
      const k = `${r.source_table} ${r.source_column}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await _invalidate_lookup_cache(project_id, r.source_table, r.source_column);
    }
    return rows.length;
  }

  /**
   * 管理 UI 列表查询：按业务下所有未删除的记忆，按 last_used_at DESC 排序。
   *
   * LEFT JOIN users 把 created_by 解析成显示名（full_name 优先，fallback username）。
   * search 命中 keyword / chosen_value / source_table / source_column 任一字段（ILIKE）。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} project_id
   * @param {{limit?:number, offset?:number, search?:string|null}} [opts]
   * @returns {Promise<{items:Array<object>, total:number}>}
   */
  static async list_resolutions(ctx, project_id, { limit = 200, offset = 0, search = null } = {}) {
    if (!project_id) return { items: [], total: 0 };

    limit = Math.max(1, Math.min(Number(limit || 200), 1000));
    offset = Math.max(0, Number(offset || 0));

    const filters = ['d.project_id = $1', 'd.deleted_at IS NULL'];
    const params = [project_id];
    if (search && String(search).trim()) {
      const kw = `%${String(search).trim()}%`;
      params.push(kw);
      const i = params.length;
      filters.push(
        `(d.normalized_keyword ILIKE $${i} OR d.chosen_value ILIKE $${i} ` +
          `OR d.source_table ILIKE $${i} OR d.source_column ILIKE $${i})`,
      );
    }
    const whereClause = filters.join(' AND ');

    const countRow = await ctx.queryOne(
      `SELECT COUNT(*) AS cnt FROM ${_TABLE} d WHERE ${whereClause}`,
      params,
    );
    const total = Number(countRow?.cnt || 0);

    const rows = await ctx.query(
      `SELECT d.id, d.project_id, d.project_id, d.source_table, d.source_column,
              d.normalized_keyword, d.chosen_value, d.hit_count, d.last_used_at,
              d.created_at, d.created_by,
              u.username AS username, u.full_name AS full_name
         FROM ${_TABLE} d
         LEFT JOIN users u ON u.id = d.created_by AND u.deleted_at IS NULL
        WHERE ${whereClause}
        ORDER BY d.last_used_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    const items = (rows || []).map((r) => ({
      id: r.id,
      project_id: r.project_id,
      project_id: r.project_id,
      source_table: r.source_table,
      source_column: r.source_column,
      normalized_keyword: r.normalized_keyword,
      chosen_value: r.chosen_value,
      hit_count: Number(r.hit_count || 0),
      last_used_at: _iso(r.last_used_at),
      created_at: _iso(r.created_at),
      created_by: r.created_by,
      created_by_name: r.full_name || r.username || null,
    }));
    return { items, total: Number(total) };
  }

  /**
   * 从 Excel 批量导入消歧记忆。
   *
   * 桌面版无 pandas/xlsx 解析依赖：本方法接受调用方【已解析】的行数组 rows
   * （每行对象含 source_table / source_column / keyword / chosen_value 列），
   * 优先用 rows；仅当 rows 缺失而传了 file_bytes 时抛错提示需上层解析（TODO(excel)）。
   * 每行独立 upsert（同唯一键则更新 chosen_value + hit++）；不走 candidates 校验
   * （业务方手动录入信任）。失败行收集到 errors 返回。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @param {string} opts.project_id
   * @param {string} opts.project_id
   * @param {Array<object>} [opts.rows] - 已解析的 Excel 行（推荐）
   * @param {Buffer|Uint8Array} [opts.file_bytes] - 原始 Excel 字节（桌面版需上层先解析）
   * @param {string|null} [opts.created_by]
   * @param {boolean} [opts.overwrite=true]
   * @returns {Promise<object>}
   */
  static async bulk_import_from_excel(
    ctx,
    { project_id, rows = null, file_bytes = null, created_by = null, overwrite = true } = {},
  ) {
    if (!project_id) {
      throw new ValidationError(t('缺少 project_id'));
    }

    if (rows == null) {
      if (file_bytes != null) {
        // TODO(excel): 桌面 Node 端未引入 xlsx 解析库；由上层把 Excel 解析为行数组传入 rows。
        throw new ValidationError(
          t('Excel 解析失败: {}', '桌面版需由上层解析 Excel 后传入 rows 数组'),
        );
      }
      rows = [];
    }
    if (!Array.isArray(rows)) {
      throw new ValidationError(t('Excel 解析失败: {}', 'rows 必须是行数组'));
    }

    const required = ['source_table', 'source_column', 'keyword', 'chosen_value'];
    // 校验首行（若有）是否含必需列；空表跳过列校验。
    if (rows.length) {
      const first = rows[0] || {};
      const missing = required.filter((c) => !(c in first));
      if (missing.length) {
        throw new ValidationError(
          t('Excel 缺少必需列: {}', missing.join(', ')) +
            t('（必需列: source_table / source_column / keyword / chosen_value）'),
        );
      }
    }

    let success_count = 0;
    let updated_count = 0;
    let skipped_count = 0;
    /** @type {Array<{row:number, error:string}>} */
    const error_rows = [];
    /** @type {Set<string>} */
    const affected_invalidations = new Set();

    const _cell = (value) => {
      if (value == null || (typeof value === 'number' && Number.isNaN(value))) return '';
      return String(value).trim();
    };

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx] || {};
      const row_num = idx + 2; // Excel 1-based + 跳过表头
      try {
        const src_table = _cell(row.source_table);
        const src_column = _cell(row.source_column);
        const keyword = _cell(row.keyword);
        const chosen = _cell(row.chosen_value);

        if (!(src_table && src_column && keyword && chosen)) {
          error_rows.push({ row: row_num, error: '四个字段都必须非空' });
          continue;
        }
        if (chosen.length > _CHOSEN_VALUE_MAX_LEN) {
          error_rows.push({
            row: row_num,
            error: `chosen_value 超长（${chosen.length} > ${_CHOSEN_VALUE_MAX_LEN}）`,
          });
          continue;
        }

        const normalized = normalize_keyword(keyword);
        if (!normalized) {
          error_rows.push({ row: row_num, error: 'keyword 规范化后为空' });
          continue;
        }

        // 检查是否已存在（用于区分新增 vs 覆盖统计 / overwrite=false 时跳过）。
        const existing = await ctx.queryOne(
          `SELECT id FROM ${_TABLE}
            WHERE project_id = $1
              AND source_table = $2
              AND source_column = $3
              AND normalized_keyword = $4
              AND deleted_at IS NULL`,
          [project_id, src_table, src_column, normalized],
        );

        if (existing && !overwrite) {
          skipped_count += 1;
          continue;
        }

        const row_id = await DisambiguationService._upsert_active_row(ctx, {
          project_id,
          source_table: src_table,
          source_column: src_column,
          normalized,
          chosen,
          meta: null,
          created_by,
          now: new Date(),
        });

        if (row_id == null) {
          error_rows.push({ row: row_num, error: '数据库写入失败' });
          continue;
        }
        if (existing) updated_count += 1;
        else success_count += 1;
        affected_invalidations.add(`${src_table} ${src_column}`);
      } catch (e) {
        error_rows.push({ row: row_num, error: String(e?.message || e) });
      }
    }

    // 批量精确失效缓存（每个 (table, column) 一次）。
    for (const tc of affected_invalidations) {
      const [tbl, col] = tc.split(' ');
      await _invalidate_lookup_cache(project_id, tbl, col);
    }

    return {
      total: rows.length,
      success_count,
      updated_count,
      skipped_count,
      error_count: error_rows.length,
      errors: error_rows,
      message: t(
        '导入完成：新增 {}，覆盖 {}，跳过 {}，失败 {}',
        success_count,
        updated_count,
        skipped_count,
        error_rows.length,
      ),
    };
  }

  /**
   * 软删除一条记忆。原子 UPDATE，避免 TOCTOU。
   * 前端"取消重选"也走此端点（不再单独提供 dispute 路径）。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} resolution_id
   * @param {{deleted_by?:string|null}} [opts]
   * @returns {Promise<boolean>}
   */
  static async delete_resolution(ctx, resolution_id, { deleted_by = null } = {}) {
    if (!resolution_id) return false;

    const now = new Date();
    const row = await ctx.queryOne(
      `UPDATE ${_TABLE}
          SET deleted_at = $1, deleted_by = $2, updated_at = $1
        WHERE id = $3 AND deleted_at IS NULL
      RETURNING project_id, source_table, source_column`,
      [now, deleted_by, resolution_id],
    );
    if (!row) return false;

    await _invalidate_lookup_cache(row.project_id, row.source_table, row.source_column);
    return true;
  }

  /**
   * 批量软删除。返回实际删除条数。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @param {string[]} opts.ids
   * @param {string} opts.project_id
   * @param {string|null} [opts.deleted_by]
   * @returns {Promise<number>}
   */
  static async bulk_delete_resolutions(ctx, { ids, project_id, deleted_by = null } = {}) {
    if (!ids || !ids.length || !project_id) return 0;

    const now = new Date();
    const rows = await ctx.query(
      `UPDATE ${_TABLE}
          SET deleted_at = $1, deleted_by = $2, updated_at = $1
        WHERE id::text = ANY($3::text[])
          AND project_id = $4
          AND deleted_at IS NULL
      RETURNING source_table, source_column`,
      [now, deleted_by, ids, project_id],
    );

    const list = rows || [];
    const seen = new Set();
    for (const r of list) {
      const k = `${r.source_table} ${r.source_column}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await _invalidate_lookup_cache(project_id, r.source_table, r.source_column);
    }
    return list.length;
  }

  /**
   * 手动创建一条记忆（管理 UI 用）。不走 candidates 校验——业务方手动录入信任。
   * 同唯一键已存在 → 走 upsert（hit++ + 更新 chosen_value），与 Excel 导入一致。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @returns {Promise<string|null>}
   */
  static async create_manual(
    ctx,
    { project_id, source_table, source_column, keyword, chosen_value, created_by = null } = {},
  ) {
    if (!(project_id && source_table && source_column)) {
      throw new ValidationError(t('project_id / source_table / source_column 必填'));
    }

    const normalized = normalize_keyword(keyword);
    const chosen = (chosen_value || '').trim();
    if (!normalized) throw new ValidationError(t('keyword 规范化后为空'));
    if (!chosen) throw new ValidationError(t('chosen_value 不能为空'));
    if (chosen.length > _CHOSEN_VALUE_MAX_LEN) {
      throw new ValidationError(t('chosen_value 超长（{} > {}）', chosen.length, _CHOSEN_VALUE_MAX_LEN));
    }

    const st = source_table.trim();
    const sc = source_column.trim();
    const row_id = await DisambiguationService._upsert_active_row(ctx, {
      project_id,
      source_table: st,
      source_column: sc,
      normalized,
      chosen,
      meta: null,
      created_by,
      now: new Date(),
    });
    if (row_id != null) {
      await _invalidate_lookup_cache(project_id, st, sc);
    }
    return row_id;
  }

  /**
   * 更新一条记忆。支持改 chosen_value / source_table / source_column / keyword 中任一字段。
   * 改 keyword/table/column 时若与其他记忆冲突（partial unique 命中），抛 ValidationError。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @returns {Promise<boolean>}
   */
  static async update_resolution(
    ctx,
    {
      resolution_id,
      project_id,
      chosen_value = null,
      source_table = null,
      source_column = null,
      keyword = null,
    } = {},
  ) {
    const existing = await ctx.queryOne(
      `SELECT id, source_table, source_column, normalized_keyword, chosen_value
         FROM ${_TABLE}
        WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
      [resolution_id, project_id],
    );
    if (!existing) throw new NotFoundError(t('记忆不存在或已被删除'));

    const old_table = existing.source_table;
    const old_column = existing.source_column;
    const now = new Date();
    let changed = false;

    // 累积要 UPDATE 的字段。
    const sets = [];
    const params = [];
    const next = { source_table: old_table, source_column: old_column };

    if (chosen_value != null) {
      const chosen = String(chosen_value).trim();
      if (!chosen) throw new ValidationError(t('chosen_value 不能为空'));
      if (chosen.length > _CHOSEN_VALUE_MAX_LEN) {
        throw new ValidationError(t('chosen_value 超长（{} > {}）', chosen.length, _CHOSEN_VALUE_MAX_LEN));
      }
      params.push(chosen);
      sets.push(`chosen_value = $${params.length}`);
      params.push(null);
      sets.push(`chosen_value_meta = $${params.length}`);
      changed = true;
    }

    if (source_table != null) {
      const st = String(source_table).trim();
      params.push(st);
      sets.push(`source_table = $${params.length}`);
      next.source_table = st;
      changed = true;
    }
    if (source_column != null) {
      const sc = String(source_column).trim();
      params.push(sc);
      sets.push(`source_column = $${params.length}`);
      next.source_column = sc;
      changed = true;
    }
    if (keyword != null) {
      const normalized = normalize_keyword(keyword);
      if (!normalized) throw new ValidationError(t('keyword 规范化后为空'));
      params.push(normalized);
      sets.push(`normalized_keyword = $${params.length}`);
      changed = true;
    }

    if (!changed) return false;

    params.push(now);
    sets.push(`updated_at = $${params.length}`);
    params.push(resolution_id);

    try {
      await ctx.query(`UPDATE ${_TABLE} SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    } catch (e) {
      if (_isUniqueViolation(e)) {
        throw new ValidationError(t('更新后的 (table, column, keyword) 与已有记忆冲突'));
      }
      throw e;
    }

    // 老 + 新 (table, column) 都需失效。
    await _invalidate_lookup_cache(project_id, old_table, old_column);
    if (next.source_table !== old_table || next.source_column !== old_column) {
      await _invalidate_lookup_cache(project_id, next.source_table, next.source_column);
    }
    return true;
  }
}

export default DisambiguationService;
