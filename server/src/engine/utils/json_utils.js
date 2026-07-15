// 迁移自 backend/core/utils/json_utils.py

/**
 * JSON 工具函数
 *
 * 提供 JSON 序列化相关的工具函数。
 */

/**
 * 清理数据中的 NaN / Infinity 值，使其可以安全序列化为 JSON。
 *
 * PostgreSQL JSON 字段和前端 JSON.parse() 都不支持 NaN、Infinity、-Infinity，
 * 这些值会被转换为 null。
 *
 * 同时处理：
 * - BigInt → Number（对应 Python Decimal → float）
 * - Date → ISO 字符串（对应 Python datetime / date）
 *
 * @param {*} obj 需要清理的对象（object、Array、或其他类型）
 * @returns {*} 清理后的对象，NaN/Infinity 被替换为 null
 */
export function sanitizeForJson(obj) {
  if (obj === null || obj === undefined) return null;

  if (Array.isArray(obj)) {
    return obj.map(sanitizeForJson);
  }

  if (obj instanceof Date) {
    return obj.toISOString();
  }

  if (typeof obj === 'bigint') {
    // 对应 Python Decimal → float：流式事件需要可 JSON 序列化
    return Number(obj);
  }

  if (typeof obj === 'number') {
    if (!isFinite(obj) || isNaN(obj)) return null;
    return obj;
  }

  if (typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = sanitizeForJson(v);
    }
    return result;
  }

  // string / boolean → 原样返回
  return obj;
}
