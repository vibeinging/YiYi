// 迁移自 backend/core/utils/data_utils.py

/**
 * 数据处理工具函数
 */

/**
 * 截断数据结果 — 避免上下文爆炸。
 *
 * - 如果 data 是 object（非数组）：对每个值为 Array 且超出 maxItems 的字段做截断，
 *   并追加 `_<key>_total` 字段记录原始长度。
 * - 如果 data 是 Array 且超出 maxItems：直接截取前 maxItems 个元素。
 * - 其他类型原样返回。
 *
 * @param {*} data 要截断的数据（object 或 Array）
 * @param {number} [maxItems=20] 列表最大保留项数
 * @returns {*} 截断后的数据
 */
export function truncateResult(data, maxItems = 20) {
  if (Array.isArray(data)) {
    return data.length > maxItems ? data.slice(0, maxItems) : data;
  }

  if (data !== null && typeof data === 'object' && !(data instanceof Date)) {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value) && value.length > maxItems) {
        result[key] = value.slice(0, maxItems);
        result[`_${key}_total`] = value.length;
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return data;
}
