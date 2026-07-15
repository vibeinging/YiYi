/**
 * 剪贴板工具函数
 * 兼容 HTTP 和 HTTPS 环境
 */

/**
 * 复制文本到剪贴板
 * @param {string} text - 要复制的文本
 * @returns {Promise<boolean>} - 是否成功
 */
export const copyToClipboard = async (text: any): Promise<boolean> => {
  // 方案1：使用现代 Clipboard API（仅 HTTPS 环境可用）
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (err) {
      console.warn('Clipboard API 失败，使用 fallback:', err)
    }
  }

  // 方案2：使用传统 execCommand 方法（fallback，兼容 HTTP）
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length) // 兼容移动端
    const success = document.execCommand('copy')
    document.body.removeChild(textarea)
    return success
  } catch (err) {
    console.error('复制失败:', err)
    return false
  }
}
