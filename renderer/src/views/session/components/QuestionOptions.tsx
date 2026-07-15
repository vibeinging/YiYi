import { useMemo } from 'react'
import marked, { sanitizeMarkdownHtml } from '@/utils/markdownConfig'
import styles from './QuestionOptions.module.scss'

// Markdown 渲染函数（对齐 composables/useMarkdown.js 的 renderMarkdown）
const renderMarkdown = (content: string) => {
  if (!content) return ''
  try {
    return marked.parse(content) as string
  } catch (error) {
    console.error('Markdown 渲染失败:', error)
    return sanitizeMarkdownHtml(content.replace(/\n/g, '<br>'))
  }
}

// 解析内容块对象（对齐 composables/useContentBlock.js 的 parseBlockContentObject）
const parseBlockContentObject = (content: any): any => {
  if (content && typeof content === 'object') {
    return content
  }

  if (typeof content === 'string') {
    try {
      return JSON.parse(content || '{}')
    } catch {
      return {}
    }
  }

  return {}
}

export interface QuestionOptionsProps {
  content: string | Record<string, any>
  dismissed?: boolean
}

// 仅渲染问题文本；选项渲染在输入区上方（chip bar），让输入框
// 既能选也能自由输入，更接近自然对话。
export default function QuestionOptions({ content, dismissed = false }: QuestionOptionsProps) {
  const renderedPrompt = useMemo(() => {
    const prompt = parseBlockContentObject(content)?.prompt || ''
    return renderMarkdown(prompt)
  }, [content])

  if (dismissed || !renderedPrompt) return null

  return (
    <div
      className={`${styles.questionPrompt} markdown-content`}
      dangerouslySetInnerHTML={{ __html: renderedPrompt }}
    />
  )
}
