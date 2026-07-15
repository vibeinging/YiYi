import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import mermaid from 'mermaid'
import marked, { extractToc } from '@/utils/markdownConfig'
import styles from './MarkdownRenderer.module.scss'
// 全局样式（teleport→body 的放大模态框，因 portal 到 body，类名保持非 module）
import './MarkdownRenderer.scss'

// 为标题添加 id（注册到共享 marked 实例，对齐原组件 module 级 marked.use）
const renderer = {
  heading(text: any, level: any) {
    const id = text
      .toLowerCase()
      .replace(/[^\w一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return `<h${level} id="${id}">${text}</h${level}>`
  },
}

marked.use({ renderer })

// Mermaid 初始化
const initMermaid = (theme: string) => {
  const isDark = theme === 'github' || theme === 'dark'
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    themeVariables: {
      darkMode: isDark,
      background: 'transparent',
      primaryColor: isDark ? '#334155' : '#e2e8f0',
      primaryTextColor: isDark ? '#ffffff' : '#0f172a',
      primaryBorderColor: isDark ? '#64748b' : '#94a3b8',
      lineColor: isDark ? '#94a3b8' : '#64748b',
      secondaryColor: isDark ? '#475569' : '#f8fafc',
      tertiaryColor: isDark ? '#1e293b' : '#f1f5f9',
      fontSize: '14px',
      textColor: isDark ? '#ffffff' : '#0f172a',
      actorTextColor: isDark ? '#ffffff' : '#0f172a',
      noteTextColor: isDark ? '#ffffff' : '#0f172a',
      noteBkgColor: isDark ? '#1f2937' : '#f8fafc',
      signalTextColor: isDark ? '#ffffff' : '#0f172a',
      labelTextColor: isDark ? '#ffffff' : '#0f172a',
      cycleTextColor: isDark ? '#ffffff' : '#0f172a',
    } as any,
    securityLevel: 'loose',
  })
}

export interface MarkdownRendererProps {
  content?: string
  theme?: 'dark' | 'light' | 'github'
  /** defineEmits(['toc-ready']) → 回调 prop */
  onTocReady?: (toc: any[]) => void
}

export interface MarkdownRendererHandle {
  /** 暴露滚动到指定标题的方法（对齐原 defineExpose） */
  scrollToHeading: (id: string) => void
}

function MarkdownRenderer(
  { content = '', theme = 'dark', onTocReady }: MarkdownRendererProps,
  ref: React.Ref<MarkdownRendererHandle>,
) {
  const { t } = useTranslation()
  const contentRef = useRef<HTMLDivElement | null>(null)

  const [zoomedSvg, setZoomedSvg] = useState<string | null>(null)

  // 拖动状态
  const isDraggingRef = useRef(false)
  const dragOffsetRef = useRef({ x: 0, y: 0 })
  const [position, setPosition] = useState({ x: 0, y: 0 })

  // 关闭放大
  const closeZoom = useCallback(() => {
    setZoomedSvg(null)
    setPosition({ x: 0, y: 0 })
  }, [])

  // 拖动中
  const onDrag = useCallback((e: MouseEvent) => {
    if (!isDraggingRef.current) return
    setPosition({
      x: e.clientX - dragOffsetRef.current.x,
      y: e.clientY - dragOffsetRef.current.y,
    })
  }, [])

  // 停止拖动
  const stopDrag = useCallback(() => {
    isDraggingRef.current = false
    document.removeEventListener('mousemove', onDrag)
    document.removeEventListener('mouseup', stopDrag)
  }, [onDrag])

  // 开始拖动
  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('.mermaid-zoom-close')) return
      isDraggingRef.current = true
      dragOffsetRef.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      }
      document.addEventListener('mousemove', onDrag)
      document.addEventListener('mouseup', stopDrag)
    },
    [position.x, position.y, onDrag, stopDrag],
  )

  // 键盘事件：ESC 关闭（对应 watch(zoomedSvg) 绑定/解绑 keydown）
  useEffect(() => {
    if (!zoomedSvg) return
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeZoom()
      }
    }
    document.addEventListener('keydown', handleKeydown)
    return () => {
      document.removeEventListener('keydown', handleKeydown)
    }
  }, [zoomedSvg, closeZoom])

  // 组件卸载时清理可能残留的拖动监听
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', onDrag)
      document.removeEventListener('mouseup', stopDrag)
    }
  }, [onDrag, stopDrag])

  // 渲染 Markdown → HTML（computed → useMemo）
  const renderedContent = useMemo(() => {
    if (!content) return ''
    try {
      return marked.parse(content) as string
    } catch (error) {
      console.error('Markdown render error:', error)
      return content.replace(/\n/g, '<br>')
    }
  }, [content])

  // 提取目录并通知父组件（原在 computed 内 emit，React 中移到副作用避免渲染期触发回调）
  useEffect(() => {
    if (!content) return
    try {
      const toc = extractToc(content)
      onTocReady?.(toc)
    } catch (error) {
      console.error('Markdown toc error:', error)
    }
    // 仅在 content 变化时重新提取目录
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content])

  // 为代码块添加复制按钮
  const addCopyButtons = useCallback(() => {
    if (!contentRef.current) return

    const codeBlocks = contentRef.current.querySelectorAll('pre:not(.has-copy-button)')

    codeBlocks.forEach((pre) => {
      pre.classList.add('has-copy-button')

      const code = pre.querySelector('code')
      if (!code) return

      const codeText = code.textContent || ''
      if (!codeText) return

      const copyButton = document.createElement('button')
      copyButton.className = 'code-copy-button'
      copyButton.type = 'button'
      copyButton.title = t('common.copyCode')
      copyButton.innerHTML = `
        <svg viewBox="0 0 1024 1024" width="14" height="14">
          <path fill="currentColor" d="M768 832a128 128 0 0 1-128 128H192A128 128 0 0 1 64 832V384a128 128 0 0 1 128-128v64a64 64 0 0 0-64 64v448a64 64 0 0 0 64 64h448a64 64 0 0 0 64-64h64z"></path>
          <path fill="currentColor" d="M384 128a64 64 0 0 0-64 64v448a64 64 0 0 0 64 64h448a64 64 0 0 0 64-64V192a64 64 0 0 0-64-64H384zm0-64h448a128 128 0 0 1 128 128v448a128 128 0 0 1-128 128H384a128 128 0 0 1-128-128V192A128 128 0 0 1 384 64z"></path>
        </svg>
      `

      copyButton.addEventListener('click', async (e) => {
        e.preventDefault()
        e.stopPropagation()

        try {
          await navigator.clipboard.writeText(codeText)
          copyButton.classList.add('copied')
          copyButton.innerHTML = `
            <svg viewBox="0 0 1024 1024" width="14" height="14">
              <path fill="currentColor" d="M406.656 706.944L195.84 496.256a32 32 0 1 0-45.248 45.248l256 256 512-512a32 32 0 0 0-45.248-45.248L406.592 706.944z"></path>
            </svg>
          `

          setTimeout(() => {
            copyButton.classList.remove('copied')
            copyButton.innerHTML = `
              <svg viewBox="0 0 1024 1024" width="14" height="14">
                <path fill="currentColor" d="M768 832a128 128 0 0 1-128 128H192A128 128 0 0 1 64 832V384a128 128 0 0 1 128-128v64a64 64 0 0 0-64 64v448a64 64 0 0 0 64 64h448a64 64 0 0 0 64-64h64z"></path>
                <path fill="currentColor" d="M384 128a64 64 0 0 0-64 64v448a64 64 0 0 0 64 64h448a64 64 0 0 0 64-64V192a64 64 0 0 0-64-64H384zm0-64h448a128 128 0 0 1 128 128v448a128 128 0 0 1-128 128H384a128 128 0 0 1-128-128V192A128 128 0 0 1 384 64z"></path>
              </svg>
            `
          }, 2000)
        } catch (err) {
          console.error('Copy failed:', err)
        }
      })

      pre.appendChild(copyButton)
    })
  }, [t])

  // 渲染 Mermaid 图表
  const renderMermaidDiagrams = useCallback(async () => {
    if (!contentRef.current) return

    const mermaidBlocks = contentRef.current.querySelectorAll('pre code.language-mermaid')

    for (const block of mermaidBlocks) {
      const code = block.textContent || ''
      const pre = block.parentElement as HTMLElement | null
      if (!pre) continue

      try {
        const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`
        const { svg } = await mermaid.render(id, code)

        const container = document.createElement('div')
        container.className = 'mermaid-diagram'
        container.innerHTML = svg

        // 添加放大镜按钮
        const zoomButton = document.createElement('button')
        zoomButton.className = 'mermaid-zoom-button'
        zoomButton.type = 'button'
        zoomButton.title = t('common.zoomView')
        zoomButton.innerHTML = `
          <svg viewBox="0 0 1024 1024" width="16" height="16">
            <path fill="currentColor" d="M945.088 258.752a64 64 0 0 0-90.496-90.56l-167.872 167.872-67.776-67.776a64 64 0 0 0-90.496 90.496l67.776 67.776-246.272 246.272a64 64 0 0 0-18.752 45.248l-17.856 177.92a64 64 0 0 0 70.528 70.528l177.92-17.856a64 64 0 0 0 45.248-18.752l246.272-246.272 67.776 67.776a64 64 0 0 0 90.496-90.496l-67.776-67.776 167.872-167.872z m-287.36 287.36-67.776-67.776 167.872-167.872 67.776 67.776-167.872 167.872z"></path>
          </svg>
        `
        zoomButton.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          setZoomedSvg(svg)
        })

        container.appendChild(zoomButton)
        pre.replaceWith(container)
      } catch (error: any) {
        console.error('Mermaid render error:', error)
        pre.classList.add('mermaid-error')
        pre.setAttribute('data-error', error?.message ?? '')
      }
    }
  }, [t])

  // 内容渲染后：添加复制按钮 + 渲染 mermaid（对应 watch(renderedContent)+onMounted+nextTick）
  useEffect(() => {
    queueMicrotask(() => {
      addCopyButtons()
      renderMermaidDiagrams()
    })
  }, [renderedContent, addCopyButtons, renderMermaidDiagrams])

  // 初始化 Mermaid 并监听主题变化（对应 watch(theme, { immediate: true })）
  useEffect(() => {
    initMermaid(theme)
    queueMicrotask(() => renderMermaidDiagrams())
  }, [theme, renderMermaidDiagrams])

  // 暴露滚动到指定标题的方法（defineExpose）
  useImperativeHandle(
    ref,
    () => ({
      scrollToHeading(id: string) {
        const element = document.getElementById(id)
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      },
    }),
    [],
  )

  return (
    <div className={`${styles.markdownRenderer} ${styles[theme] ?? ''}`}>
      <div
        ref={contentRef}
        className={styles.markdownContent}
        dangerouslySetInnerHTML={{ __html: renderedContent }}
      />
      {/* 放大模态框（teleport to body → createPortal） */}
      {zoomedSvg &&
        createPortal(
          <div className="mermaid-zoom-modal" onClick={closeZoom}>
            <div
              className="mermaid-zoom-content"
              style={{ left: `calc(50% + ${position.x}px)`, top: `calc(50% + ${position.y}px)` }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={startDrag}
            >
              <button className="mermaid-zoom-close" onClick={closeZoom}>
                <svg viewBox="0 0 1024 1024" width="20" height="20">
                  <path
                    fill="currentColor"
                    d="M764.288 214.592 512 466.88 259.712 214.592a31.936 31.936 0 0 0-45.12 45.12L466.752 512 214.528 764.224a31.936 31.936 0 1 0 45.12 45.184L512 557.184l252.288 252.288a31.936 31.936 0 0 0 45.12-45.12L557.12 512.064l252.288-252.352a31.936 31.936 0 1 0-45.12-45.184z"
                  ></path>
                </svg>
              </button>
              <div
                className="mermaid-zoom-svg"
                dangerouslySetInnerHTML={{ __html: zoomedSvg }}
              ></div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

export default forwardRef<MarkdownRendererHandle, MarkdownRendererProps>(MarkdownRenderer)
