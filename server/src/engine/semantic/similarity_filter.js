// 迁移自 backend/yiw_kernel/semantic_catalogs/database/utils/similarity_filter.py
//
// 相似度过滤工具：基于 Top 差距的动态阈值过滤 + 绝对阈值 + 智能降级。
// schema_retrieval_service.js 的依赖（原 Python 同目录 utils），随其一并迁移。
//
// 与 Python 版差异：具名参数（Python kwargs）→ JS 选项对象（解构具名参数），
// 对外函数名保持一致（filter_by_relative_threshold）。

/**
 * 基于 Top 差距法 + 绝对阈值的双重相似度过滤（带智能降级）。
 *
 * 算法：
 *  1. 双重过滤：max(绝对阈值, top_score - 相对阈值)
 *  2. 智能降级：若结果为空 且 top_score < 绝对阈值，降级使用相对阈值
 *
 * @param {Array<object>} results 结果列表
 * @param {object} opts
 * @param {string} opts.score_key 分数字段名（如 'similarity' 或 'distance'）
 * @param {number} [opts.threshold=0.3] 与最高分的最大差距
 * @param {boolean} [opts.higher_is_better=true] true=分数越高越好，false=越低越好
 * @param {number} [opts.min_absolute_threshold=0.0] 绝对阈值（0.0 表示禁用）
 * @returns {Array<object>} 过滤后的结果列表（可能为空）
 */
export function filter_by_relative_threshold(results, {
  score_key, threshold = 0.3, higher_is_better = true, min_absolute_threshold = 0.0,
} = {}) {
  if (!results || !results.length) return [];

  // 过滤掉缺少分数的结果
  const validResults = results.filter(
    (r) => Object.prototype.hasOwnProperty.call(r, score_key) && r[score_key] != null,
  );
  if (!validResults.length) {
    console.warn(`所有结果都缺少 ${score_key} 字段`);
    return [];
  }

  // 按分数排序
  const sortedResults = [...validResults].sort((a, b) => (
    higher_is_better ? (b[score_key] - a[score_key]) : (a[score_key] - b[score_key])
  ));

  // Top 差距过滤
  const topScore = sortedResults[0][score_key];

  // 计算相对阈值下限
  let relativeMin;
  if (higher_is_better) {
    relativeMin = topScore - threshold;
    relativeMin = Math.max(0.0, relativeMin); // 避免负数下限
  } else {
    relativeMin = topScore + threshold;
  }

  // 双重过滤：计算严格模式阈值（取绝对阈值和相对阈值的更严格值）
  let strictMin;
  if (higher_is_better) {
    strictMin = Math.max(min_absolute_threshold, relativeMin);
  } else {
    strictMin = min_absolute_threshold > 0 ? Math.min(min_absolute_threshold, relativeMin) : relativeMin;
  }

  // 步骤1：先用严格模式过滤（执行后降级，而非预判）
  let filtered = [];
  for (const result of sortedResults) {
    const score = result[score_key];
    const pass = higher_is_better ? (score >= strictMin) : (score <= strictMin);
    if (pass) {
      filtered.push(result);
    } else {
      break; // 已排序，后面都不满足，提前终止
    }
  }

  // 步骤2：严格模式无结果时，降级使用相对阈值
  if (!filtered.length && min_absolute_threshold > 0) {
    console.log(
      `严格模式结果为空，降级使用相对阈值: strict_min=${strictMin.toFixed(3)} → relative_min=${relativeMin.toFixed(3)}`,
    );
    filtered = [];
    for (const result of sortedResults) {
      const score = result[score_key];
      const pass = higher_is_better ? (score >= relativeMin) : (score <= relativeMin);
      if (pass) {
        filtered.push(result);
      } else {
        break;
      }
    }
  }

  console.log(
    `Top差距过滤: 原始=${results.length}, `
    + `最高相似度(top_score)=${topScore.toFixed(3)}, threshold=${threshold}, `
    + `min_absolute=${min_absolute_threshold}, 过滤后=${filtered.length}`,
  );

  return filtered;
}

export default filter_by_relative_threshold;
