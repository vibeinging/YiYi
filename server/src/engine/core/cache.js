/**
 * 迁移自 backend/core/cache.py
 *
 * 桌面单机版内存化实现：
 * - 不依赖 fastapi-cache2 / Redis，缓存存储在进程内存（Map）
 * - 保留全部对外方法签名：service_key_builder、invalidate_cache
 * - get_cache_redis_client 来自内存化的 redis_manager，无真实 Redis 连接
 * - 注释标注已内存化的部分
 */

import crypto from 'crypto';
import { get_cache_redis_client } from './redis_manager.js';

// ============================================================
// 内存缓存存储（内存化：替代 Redis 做 KV 缓存）
// ============================================================

/** @type {Map<string, {value: any, expireAt: number|null}>} */
const _memCache = new Map();

/**
 * 从内存缓存中读取（内部工具）
 * @param {string} key
 * @returns {any|undefined}
 */
function _memGet(key) {
  const entry = _memCache.get(key);
  if (!entry) return undefined;
  if (entry.expireAt !== null && Date.now() > entry.expireAt) {
    _memCache.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * 写入内存缓存（内部工具）
 * @param {string} key
 * @param {any} value
 * @param {number|null} ttlSeconds
 */
function _memSet(key, value, ttlSeconds = null) {
  _memCache.set(key, {
    value,
    expireAt: ttlSeconds !== null ? Date.now() + ttlSeconds * 1000 : null,
  });
}

// ============================================================
// 需要从缓存 key 中排除的参数类型名（与 Python 版保持一致）
// ============================================================

const _EXCLUDED_TYPE_NAMES = new Set(['AsyncSession', 'Session', 'Connection', 'Engine']);

/**
 * 判断值是否为"基本可序列化"类型（对应 Python isinstance check）
 * @param {any} v
 * @returns {boolean}
 */
function _isPrimitive(v) {
  return (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    Array.isArray(v) ||
    (v !== null && typeof v === 'object' && v.constructor === Object)
  );
}

// ============================================================
// service_key_builder
// ============================================================

/**
 * Service 层缓存 key 构建器
 *
 * key 格式: {funcName}:{param1}={value1}:{param2}={value2}
 * 自动排除 DB session 等不可序列化的参数
 *
 * @param {Function} func - 被缓存的函数
 * @param {string} namespace - 命名空间（可选，与 fastapi-cache2 签名兼容）
 * @param {Object} options
 * @param {Object} [options.request] - HTTP request（排除）
 * @param {Object} [options.response] - HTTP response（排除）
 * @param {Array}  [options.args] - 位置参数
 * @param {Object} [options.kwargs] - 关键字参数
 * @returns {string} 缓存 key
 */
function service_key_builder(func, namespace = '', { request = null, response = null, args = null, kwargs = null } = {}) {
  // 合并关键字参数（兼容 Python 版 fastapi-cache 包装方式）
  const actualKwargs = { ...(kwargs ?? {}) };
  const actualArgs = args ?? [];

  // 将位置参数映射到参数名（JS 无 inspect.signature，此处保留兼容逻辑但 JS 中无法获取形参名）
  // TODO: 如需精确形参名映射，可在 func 上挂 __paramNames 属性
  const paramNames = func.__paramNames ?? [];
  for (let i = 0; i < actualArgs.length; i++) {
    const paramName = paramNames[i];
    if (paramName && !(paramName in actualKwargs)) {
      actualKwargs[paramName] = actualArgs[i];
    }
  }

  const keyParts = [];
  for (const k of Object.keys(actualKwargs).sort()) {
    const v = actualKwargs[k];
    if (v === null || v === undefined) continue;
    const typeName = v?.constructor?.name ?? 'Unknown';
    if (_EXCLUDED_TYPE_NAMES.has(typeName)) continue;
    // 排除复杂对象（有自定义原型，但不是基础类型）
    if (!_isPrimitive(v)) continue;
    keyParts.push(`${k}=${v}`);
  }

  const paramsStr = keyParts.length > 0 ? keyParts.join(':') : '_';
  let key = `${func.name}:${paramsStr}`;

  // key 超长时 MD5 截断（与 Python 版保持 200 字符阈值）
  if (key.length > 200) {
    const hash = crypto.createHash('md5').update(paramsStr).digest('hex');
    key = `${func.name}:${hash}`;
  }

  console.debug(`[缓存] key: ${key}`);
  return key;
}

// ============================================================
// invalidate_cache（内存化）
// ============================================================

/**
 * 清除函数缓存（内存化）
 *
 * 支持两种模式：
 * 1. 无参数：清除该函数的所有缓存
 * 2. 有参数：只清除 key 中包含这些参数的缓存
 *
 * 内存化说明：直接遍历 _memCache，无需 Redis SCAN。
 * 同时也尝试通过 get_cache_redis_client 清除（若将来切回真实 Redis 时自动生效）。
 *
 * @param {string} funcName - 函数名
 * @param {Object} matchParams - 要匹配的参数（key 中包含即匹配）
 * @returns {Promise<number>} 删除的缓存条数
 */
async function invalidate_cache(funcName, matchParams = {}) {
  const basePrefix = `${funcName}:`;

  if (Object.keys(matchParams).length === 0) {
    return _clearByPrefix(basePrefix);
  }

  // 有参数：匹配 key 中任意位置包含 "k=v" 的条目
  try {
    let deletedCount = 0;

    // 内存化：遍历 _memCache
    for (const [k, v] of Object.entries(matchParams)) {
      if (v === null || v === undefined) continue;
      const needle = `${k}=${v}`;
      for (const cacheKey of [..._memCache.keys()]) {
        if (cacheKey.startsWith(basePrefix) && cacheKey.includes(needle)) {
          _memCache.delete(cacheKey);
          deletedCount++;
        }
      }
    }

    // 同时尝试通过 redis_manager 清除（内存化版本等效于上面的操作，仅作接口兼容）
    try {
      const redisClient = await get_cache_redis_client();
      for (const [k, v] of Object.entries(matchParams)) {
        if (v === null || v === undefined) continue;
        const pattern = `${funcName}:*${k}=${v}*`;
        let cursor = 0;
        do {
          const [nextCursor, keys] = await redisClient.scan(cursor, { match: pattern, count: 100 });
          if (keys.length > 0) {
            deletedCount += await redisClient.delete(...keys);
          }
          cursor = nextCursor;
        } while (cursor !== 0);
      }
    } catch (_) {
      // 内存化：redis_manager 是内存实现，不会真正失败；此处 catch 留作安全兜底
    }

    if (deletedCount > 0) {
      console.info(`[缓存清除] ${funcName}, 参数: ${JSON.stringify(matchParams)}, 删除: ${deletedCount} 个`);
    }
    return deletedCount;
  } catch (e) {
    console.warn('[缓存清除] 清除缓存失败:', e);
    return 0;
  }
}

// ============================================================
// _clearByPrefix（内部）
// ============================================================

/**
 * 按前缀清除缓存（内存化：遍历 _memCache + redis_manager）
 * @param {string} prefix
 * @returns {Promise<number>}
 */
async function _clearByPrefix(prefix) {
  try {
    let deletedCount = 0;

    // 内存化：直接遍历 _memCache
    for (const cacheKey of [..._memCache.keys()]) {
      if (cacheKey.startsWith(prefix)) {
        _memCache.delete(cacheKey);
        deletedCount++;
      }
    }

    // 同时尝试通过 redis_manager 清除（兼容未来切回真实 Redis）
    try {
      const redisClient = await get_cache_redis_client();
      const pattern = `${prefix}*`;
      let cursor = 0;
      do {
        const [nextCursor, keys] = await redisClient.scan(cursor, { match: pattern, count: 100 });
        if (keys.length > 0) {
          deletedCount += await redisClient.delete(...keys);
        }
        cursor = nextCursor;
      } while (cursor !== 0);
    } catch (_) {
      // 内存化兜底
    }

    if (deletedCount > 0) {
      console.info(`[缓存清除] ${prefix}*, 删除: ${deletedCount} 个`);
    }
    return deletedCount;
  } catch (e) {
    console.warn('[缓存清除] 清除缓存失败:', e);
    return 0;
  }
}

// ============================================================
// 内存缓存装饰器（对应 @cache，内存化替代 fastapi-cache2）
// ============================================================

/**
 * 内存缓存装饰器工厂
 *
 * 对应 Python @cache(expire=xxx, key_builder=service_key_builder)
 * 用法：将异步函数包裹，自动缓存结果
 *
 * @param {Object} options
 * @param {number} [options.expire=300] - TTL（秒）
 * @param {Function} [options.keyBuilder] - key 构建函数，默认用 service_key_builder
 * @returns {Function} 装饰器（接受函数，返回缓存包裹版本）
 *
 * @example
 * const cachedFn = withCache({ expire: 60 })(async (arg) => { ... });
 */
function withCache({ expire = 300, keyBuilder = null } = {}) {
  return function decorator(fn) {
    async function cached(...args) {
      const kb = keyBuilder ?? service_key_builder;
      const key = kb(fn, '', { args, kwargs: {} });
      const hit = _memGet(key);
      if (hit !== undefined) {
        console.debug(`[缓存] hit: ${key}`);
        return hit;
      }
      const result = await fn(...args);
      _memSet(key, result, expire);
      return result;
    }
    // 透传函数名（供 service_key_builder 使用）
    Object.defineProperty(cached, 'name', { value: fn.name });
    cached.__paramNames = fn.__paramNames ?? [];
    return cached;
  };
}

export {
  service_key_builder,
  invalidate_cache,
  withCache,
  // 内部暴露（供测试）
  _memCache,
  _memGet,
  _memSet,
  _clearByPrefix,
};
