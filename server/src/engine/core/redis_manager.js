/**
 * 迁移自 backend/core/redis_manager.py
 *
 * 桌面单机版内存化实现：
 * - 不依赖真实 Redis，所有数据存储在进程内存（Map / 事件）
 * - 保留全部对外方法签名，供下游模块 1:1 import
 * - 注释标注已内存化的部分
 */

// ============================================================
// 内存存储结构
// ============================================================

/** @type {Map<string, string>} KV 存储（模拟 hash / string） */
const _kvStore = new Map();

/** @type {Map<string, Array<{id: string, data: Object}>>} Stream 存储 */
const _streams = new Map();

/** @type {Map<string, Map<string, string>>} Hash 存储（模拟 HSET/HGETALL） */
const _hashStore = new Map();

/** @type {Map<string, number>} TTL 到期时间戳（ms） */
const _ttlStore = new Map();

/** @type {Map<string, Array<Function>>} PubSub 订阅回调 */
const _pubsubListeners = new Map();

let _streamSeq = 0;

function _nextStreamId() {
  const ts = Date.now();
  _streamSeq++;
  return `${ts}-${_streamSeq}`;
}

/** 检查 key 是否已过期，过期则清除并返回 true */
function _isExpired(key) {
  const exp = _ttlStore.get(key);
  if (exp !== undefined && Date.now() > exp) {
    _kvStore.delete(key);
    _streams.delete(key);
    _hashStore.delete(key);
    _ttlStore.delete(key);
    return true;
  }
  return false;
}

// ============================================================
// 内存 Redis 客户端（模拟 redis.asyncio.Redis 接口）
// ============================================================

class InMemoryRedisClient {
  /** 模拟 PING */
  async ping() {
    return 'PONG';
  }

  /** 模拟 GET */
  async get(key) {
    if (_isExpired(key)) return null;
    return _kvStore.get(key) ?? null;
  }

  /** 模拟 SET */
  async set(key, value, options) {
    _kvStore.set(key, String(value));
    if (options?.ex) {
      _ttlStore.set(key, Date.now() + options.ex * 1000);
    }
    return 'OK';
  }

  /** 模拟 DEL（支持多 key） */
  async delete(...keys) {
    let count = 0;
    for (const key of keys.flat()) {
      if (_kvStore.has(key) || _streams.has(key) || _hashStore.has(key)) count++;
      _kvStore.delete(key);
      _streams.delete(key);
      _hashStore.delete(key);
      _ttlStore.delete(key);
    }
    return count;
  }

  /** 模拟 EXPIRE */
  async expire(key, seconds) {
    _ttlStore.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  /** 模拟 HSET */
  async hset(key, options) {
    if (_isExpired(key)) _hashStore.delete(key);
    if (!_hashStore.has(key)) _hashStore.set(key, new Map());
    const h = _hashStore.get(key);
    if (options?.mapping) {
      for (const [k, v] of Object.entries(options.mapping)) {
        h.set(String(k), String(v));
      }
    }
    return 1;
  }

  /** 模拟 HGETALL */
  async hgetall(key) {
    if (_isExpired(key)) return {};
    const h = _hashStore.get(key);
    if (!h) return {};
    const result = {};
    for (const [k, v] of h) result[k] = v;
    return result;
  }

  /** 模拟 XADD（Redis Stream） */
  async xadd(streamKey, fields, options) {
    if (!_streams.has(streamKey)) _streams.set(streamKey, []);
    const stream = _streams.get(streamKey);
    const id = _nextStreamId();
    stream.push({ id, fields: { ...fields } });

    // 模拟 MAXLEN 裁剪
    const maxlen = options?.maxlen;
    if (maxlen && stream.length > maxlen) {
      stream.splice(0, stream.length - maxlen);
    }

    return id;
  }

  /**
   * 模拟 XREAD
   * @param {Object} streams - { streamKey: lastId }
   * @param {Object} options - { count, block }
   */
  async xread(streams, options = {}) {
    const result = [];
    for (const [streamKey, lastId] of Object.entries(streams)) {
      if (_isExpired(streamKey)) continue;
      const stream = _streams.get(streamKey) ?? [];
      const filtered = stream.filter(msg => msg.id > lastId);
      const count = options.count ?? filtered.length;
      const slice = filtered.slice(0, count);
      if (slice.length > 0) {
        result.push([streamKey, slice.map(m => [m.id, m.fields])]);
      }
    }
    return result.length > 0 ? result : null;
  }

  /** 模拟 PUBLISH */
  async publish(channel, message) {
    const listeners = _pubsubListeners.get(channel) ?? [];
    for (const fn of listeners) {
      try { fn(message); } catch (_) { /* ignore */ }
    }
    return listeners.length;
  }

  /**
   * 模拟 SCAN（按前缀/pattern 简易扫描）
   * 返回 [cursor, keys]，cursor=0 表示完成
   */
  async scan(cursor, options = {}) {
    const pattern = options.match ?? '*';
    // 将 glob pattern 转换为 RegExp（仅支持 * 通配符）
    const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    const re = new RegExp(regexStr);

    const allKeys = [
      ..._kvStore.keys(),
      ..._streams.keys(),
      ..._hashStore.keys(),
    ];
    const unique = [...new Set(allKeys)].filter(k => !_isExpired(k) && re.test(k));
    // 内存实现一次返回所有匹配 key，cursor 始终为 0
    return [0, unique];
  }

  /** 模拟 INFO（返回简化结构） */
  async info(_section) {
    return {
      redis_version: 'in-memory',
      redis_mode: 'standalone',
    };
  }
}

// ============================================================
// 模块级状态（内存化，无真实连接池）
// ============================================================

let _closed = false;
const _sharedClient = new InMemoryRedisClient();

// ============================================================
// 公共 API（与 Python 版同名）
// ============================================================

/**
 * 获取连接池（内存化：返回 null 占位，调用方不直接使用 pool）
 * 保留接口供兼容
 */
async function get_pool() {
  if (_closed) throw new Error('Redis管理器已关闭');
  return null; // 内存化：无真实连接池
}

/**
 * 获取 Redis 客户端（内存实现）
 * @returns {InMemoryRedisClient}
 */
async function get_redis_client() {
  if (_closed) throw new Error('Redis管理器已关闭');
  return _sharedClient;
}

/**
 * 初始化（内存化：直接返回 true，无需真实连接）
 * @returns {Promise<boolean>}
 */
async function init_redis() {
  try {
    await _sharedClient.ping();
    console.log('[redis_manager] 内存化 Redis 初始化成功（桌面单机模式）');
    return true;
  } catch (e) {
    console.error('[redis_manager] 内存化 Redis 初始化失败:', e);
    return false;
  }
}

/**
 * 关闭（内存化：清空存储，标记 closed）
 */
async function close_redis() {
  _closed = true;
  _kvStore.clear();
  _streams.clear();
  _hashStore.clear();
  _ttlStore.clear();
  _pubsubListeners.clear();
  console.log('[redis_manager] 内存化 Redis 已关闭，存储已清空');
}

/**
 * 获取 Redis 配置（内存化：返回空配置占位）
 * @returns {Object}
 */
function get_redis_config() {
  // 内存化：无真实 Redis，返回兼容结构
  return {
    host: 'localhost',
    port: 6379,
    password: null,
    database: 0,
    conn_timeout: 5,
    conn_retries: 3,
    conn_retry_delay: 1,
  };
}

/**
 * 获取用于缓存的 Redis 客户端（内存化：与主客户端共享）
 * 对应 Python 的 get_cache_redis_client（decode_responses=False 场景）
 * @returns {Promise<InMemoryRedisClient>}
 */
async function get_cache_redis_client() {
  return _sharedClient;
}

// ============================================================
// RedisStreamManager（内存化 Stream 管理器）
// ============================================================

class RedisStreamManager {
  /** @type {number} Stream 最大长度 */
  static MAX_STREAM_LEN = 1000;
  /** @type {number} Stream TTL（秒）—— 内存化中仅作参考，用 _ttlStore 模拟 */
  static STREAM_TTL = 86400;
  static _TTL_TRACK_MAX = 50000;

  constructor() {
    /** @type {Set<string>} 已设过 TTL 的 key（内存化保留同样优化逻辑） */
    this._ttlSetKeys = new Set();
  }

  /**
   * 添加消息到 Stream（内存化）
   * @param {string} streamKey
   * @param {Object} data
   * @returns {Promise<string|null>} 消息 ID
   */
  async add_to_stream(streamKey, data) {
    try {
      const client = await get_redis_client();
      const fields = { data: JSON.stringify(data) };
      const messageId = await client.xadd(streamKey, fields, {
        maxlen: RedisStreamManager.MAX_STREAM_LEN,
        approximate: true,
      });

      if (!this._ttlSetKeys.has(streamKey)) {
        await client.expire(streamKey, RedisStreamManager.STREAM_TTL);
        if (this._ttlSetKeys.size >= RedisStreamManager._TTL_TRACK_MAX) {
          this._ttlSetKeys.clear();
        }
        this._ttlSetKeys.add(streamKey);
      }

      console.debug(`[RedisStream] xadd 成功: key=${streamKey}, msg_id=${messageId}`);
      return messageId;
    } catch (e) {
      console.error('[RedisStream] 添加消息到Stream失败:', e);
      return null;
    }
  }

  /**
   * 从 Stream 读取消息（内存化）
   * @param {string} streamKey
   * @param {string} lastId - 上次读取的消息ID，'0' 表示从头
   * @param {number} count - 最多读取消息数
   * @param {number} block - 阻塞等待时间(ms)，0 表示不阻塞（内存化忽略 block）
   * @returns {Promise<Array<[string, Object]>>} [(messageId, data), ...]
   */
  async read_stream(streamKey, lastId = '0', count = 100, block = 0) {
    try {
      const client = await get_redis_client();
      // 内存化：忽略 block 参数（无阻塞等待）
      const result = await client.xread({ [streamKey]: lastId }, { count });

      if (!result) {
        console.debug(`[RedisStream] xread 返回空: key=${streamKey}, last_id=${lastId}`);
        return [];
      }

      const messages = [];
      for (const [_streamName, streamMessages] of result) {
        for (const [msgId, fields] of streamMessages) {
          try {
            const data = JSON.parse(fields.data ?? '{}');
            messages.push([msgId, data]);
          } catch (_) {
            console.warn('[RedisStream] JSON解析失败:', fields);
          }
        }
      }

      console.debug(`[RedisStream] xread 成功: key=${streamKey}, last_id=${lastId}, count=${messages.length}`);
      return messages;
    } catch (e) {
      console.error('[RedisStream] 读取Stream失败:', e);
      return [];
    }
  }

  /**
   * 发布事件到 PubSub（内存化）
   * @param {string} channel
   * @param {Object} data
   * @returns {Promise<boolean>}
   */
  async publish_event(channel, data) {
    try {
      const client = await get_redis_client();
      const message = JSON.stringify(data);
      await client.publish(channel, message);
      return true;
    } catch (e) {
      console.error('[RedisStream] 发布事件失败:', e);
      return false;
    }
  }

  /**
   * 获取客户端状态（内存化）
   * @param {string} sessionId
   * @returns {Promise<Object>}
   */
  async get_client_state(sessionId) {
    try {
      const client = await get_redis_client();
      const stateKey = `client_state:${sessionId}`;
      const state = await client.hgetall(stateKey);
      if (!state || Object.keys(state).length === 0) return {};
      return {
        current_task_id: state.current_task_id ?? null,
        last_message_id: state.last_message_id ?? '0',
        client_id: state.client_id ?? null,
        created_at: parseFloat(state.created_at ?? '0'),
        updated_at: parseFloat(state.updated_at ?? '0'),
      };
    } catch (e) {
      console.error('[RedisStream] 获取客户端状态失败:', e);
      return {};
    }
  }

  /**
   * 更新客户端状态（内存化）
   * @param {string} sessionId
   * @param {Object} kwargs
   */
  async update_client_state(sessionId, kwargs = {}) {
    try {
      const client = await get_redis_client();
      const stateKey = `client_state:${sessionId}`;
      const updated = { ...kwargs, updated_at: String(Date.now() / 1000) };
      const mapping = {};
      for (const [k, v] of Object.entries(updated)) {
        mapping[k] = String(v);
      }
      if (Object.keys(mapping).length > 0) {
        await client.hset(stateKey, { mapping });
        await client.expire(stateKey, 3600);
      }
    } catch (e) {
      console.error('[RedisStream] 更新客户端状态失败:', e);
    }
  }
}

// 全局 Stream 管理器（与 Python 版 stream_manager 同名）
const stream_manager = new RedisStreamManager();

export {
  // 内存客户端类（供测试或高级用途）
  InMemoryRedisClient,
  // 公共 API
  get_pool,
  get_redis_client,
  get_cache_redis_client,
  init_redis,
  close_redis,
  get_redis_config,
  // Stream 管理器
  RedisStreamManager,
  stream_manager,
};
