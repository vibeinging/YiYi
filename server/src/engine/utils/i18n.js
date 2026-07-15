// 迁移自 backend/core/i18n.py
// 桌面版只需中文。t(key, ...args) 直接返回中文文案并做 {} 插值。
// get_current_language() 固定返回 'zh'。
// append_language_instruction(prompt) 原样返回 prompt（无多语言支持）。

/**
 * 中文文案 map（键即文案，保留原始中文，供下游用同名 key 查询）
 * 注：本版本 t() 直接对 key 做插值并返回，map 仅作占位/文档用途。
 * 若将来需要英文，可在此 map 中添加英文翻译。
 */
const _messages = {
  // 保留原始中文键（与 Python 版 _zh_to_en 的键相同），值暂填中文自身
  // free_llm 节点 business_meta
  "自由增强节点": "自由增强节点",
  "操作成功": "操作成功",
  "获取列表成功": "获取列表成功",
  "请求失败": "请求失败",
  // 省略其余条目——t() 实现直接返回 key（即中文原文），无需穷举
};

/**
 * 翻译函数：中文版直接返回 key 本身并做 {} 插值。
 * @param {string} key   中文原文，可含 {} 占位符
 * @param {...*}   args  依次替换 {} 占位符
 * @returns {string}
 */
export function t(key, ...args) {
  if (!args.length) return key ?? '';
  let result = String(key ?? '');
  try {
    let i = 0;
    result = result.replace(/\{}/g, () => (i < args.length ? String(args[i++]) : '{}'));
    // 带索引的 {0} {1} 形式
    result = result.replace(/\{(\d+)}/g, (_, idx) => {
      const n = Number(idx);
      return n < args.length ? String(args[n]) : `{${idx}}`;
    });
  } catch (_) {
    // 插值失败时原样返回
  }
  return result;
}

/**
 * 获取当前语言（固定 zh，桌面版单语言）
 * @returns {'zh'}
 */
export function get_current_language() {
  return 'zh';
}

// 与 Python 版保持同名导出（camelCase 别名）
export const getCurrentLanguage = get_current_language;

/**
 * 在 prompt 末尾追加输出语言指令。
 * 桌面版固定中文，直接原样返回 prompt。
 * @param {string} prompt
 * @returns {string}
 */
export function append_language_instruction(prompt) {
  return prompt ?? '';
}

export const appendLanguageInstruction = append_language_instruction;
