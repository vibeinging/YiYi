/**
 * 剪贴板操作逻辑
 */
import { notifications } from '@mantine/notifications'
import { t } from '@/lang'

// 复制到剪贴板（支持 fallback）
export const copyToClipboard = async (text: any): Promise<boolean> => {
  // 方案1：使用现代 Clipboard API
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (err) {
      console.warn('Clipboard API 失败，使用 fallback:', err)
    }
  }

  // 方案2：使用传统 execCommand 方法（fallback）
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const success = document.execCommand('copy')
    document.body.removeChild(textarea)
    return success
  } catch (err) {
    console.error('复制失败（两种方法都失败）:', err)
    return false
  }
}

// 复制SQL
export const copySQL = async (sql: any): Promise<void> => {
  const success = await copyToClipboard(sql)
  if (success) {
    notifications.show({ color: 'green', message: t('common.sqlCopied') })
  } else {
    notifications.show({ color: 'red', message: t('common.copyFailedPermission') })
  }
}

// 复制代码块
export const copyCodeBlock = async (code: any): Promise<void> => {
  const success = await copyToClipboard(code)
  if (success) {
    notifications.show({ color: 'green', message: t('common.codeCopied') })
  } else {
    notifications.show({ color: 'red', message: t('common.copyFailedPermission') })
  }
}
