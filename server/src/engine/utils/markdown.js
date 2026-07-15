// 迁移自 backend/core/utils/markdown.py

/**
 * Markdown 文本清洗工具。
 */

// markdown 图片语法 ![alt](url)
const INLINE_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;

/**
 * 剥离文本里的 markdown 图片语法 ![alt](url)。
 *
 * 用于清洗 LLM 生成的文字答案：模型有时会把中间结果表名 / sandbox 引用当成图片
 * URL 插进答案（如 ![...](sandbox://intermediate_x.r_x)），前端无法解析协议 → 破图。
 * 图表应由专门的可视化通道渲染，文字答案不应内嵌图片。prompt 约束实测不稳定遵守，
 * 故在代码层硬剥离作 guardrail。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripInlineImages(text) {
  if (!text) return text;
  // 注意：RegExp 带 /g 标志需要每次 reset lastIndex，用字符串 replace 即可
  let cleaned = text.replace(INLINE_IMAGE_RE, '');
  // 清理因剥离图片产生的多余空行（3 个及以上换行 → 2 个）
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}
