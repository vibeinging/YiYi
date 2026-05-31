/**
 * markdownShared — 主 agent 与子 agent(群成员)共用的渲染原语。
 *
 * 抽出来是为了"子 agent 气泡和主 agent 结构一致,只背景色不同"(用户诉求):
 * - `ThinkingBlock`:可折叠的思考过程块(流式时自动展开 + 贴底滚动)。
 * - `markdownComponents`:ReactMarkdown 的组件覆写(链接外开 / 代码块带复制 /
 *   空表格行剔除)。模块级常量(纯,无组件状态),两边共享同一份。
 * - `AgentMarkdown`:包好 remark-gfm + rehype-highlight + 上述 components 的便捷组件。
 */

import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { ChevronRight, ChevronDown, Brain } from 'lucide-react'
import { open } from '@tauri-apps/plugin-shell'

const THINKING_STICK_THRESHOLD_PX = 16

/** 可折叠思考块 —— 主/子 agent 共用。流式时默认展开并贴底滚动,完成后默认折叠。 */
export function ThinkingBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  const [collapsed, setCollapsed] = useState(!streaming)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    if (!streaming || collapsed) return
    const el = scrollRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [content, streaming, collapsed])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < THINKING_STICK_THRESHOLD_PX
  }

  return (
    <div
      className="rounded-xl text-[13px] overflow-hidden"
      style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
    >
      <button
        onClick={() => setCollapsed(v => !v)}
        className="flex items-center gap-1.5 w-full px-3 py-2 text-left"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <Brain size={14} />
        <span>{streaming ? '思考中…' : '思考过程'}</span>
      </button>
      {!collapsed && (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={`px-3 pb-2 whitespace-pre-wrap break-words leading-relaxed${streaming ? ' yiyi-stream-cursor' : ''}`}
          style={{ color: 'var(--color-text-muted)', maxHeight: '200px', overflowY: 'auto' }}
        >
          {content}
        </div>
      )}
    </div>
  )
}

const nodeText = (nodes: React.ReactNode): string => {
  if (nodes == null || typeof nodes === 'boolean') return ''
  if (typeof nodes === 'string' || typeof nodes === 'number') return String(nodes)
  if (Array.isArray(nodes)) return nodes.map(nodeText).join('')
  if (React.isValidElement(nodes))
    return nodeText((nodes.props as { children?: React.ReactNode }).children)
  return ''
}

// 快路径:遇到第一个非空白字符即返回,不必走完整棵子树。
const hasNonBlankText = (nodes: React.ReactNode): boolean => {
  if (nodes == null || typeof nodes === 'boolean') return false
  if (typeof nodes === 'string') return /\S/.test(nodes)
  if (typeof nodes === 'number') return true
  if (Array.isArray(nodes)) return nodes.some(hasNonBlankText)
  if (React.isValidElement(nodes))
    return hasNonBlankText((nodes.props as { children?: React.ReactNode }).children)
  return false
}

/** ReactMarkdown 组件覆写 —— 主/子 agent 共享同一份。 */
export const markdownComponents = {
  a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...props}
      href={href}
      onClick={e => {
        e.preventDefault()
        if (href) open(href)
      }}
      style={{ cursor: 'pointer' }}
    >
      {children}
    </a>
  ),
  tr: (props: React.HTMLAttributes<HTMLTableRowElement>) => {
    // 剔除全空单元格的 tr —— 模型偶尔吐出尾随的 "|  |  |" 被 GFM 渲成可见空行。
    return hasNonBlankText(props.children) ? <tr {...props} /> : null
  },
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => {
    const child = React.Children.toArray(props.children)[0] as React.ReactElement<any> | undefined
    const childClass = (child?.props?.className as string | undefined) ?? ''
    const lang = childClass.match(/language-(\w+)/)?.[1]
    const rawText = nodeText(child?.props?.children)
    return (
      <div className="code-block">
        <div className="code-block-bar">
          <span className="code-block-lang">{lang || 'text'}</span>
          <button
            className="code-block-copy"
            onClick={() => {
              navigator.clipboard?.writeText(rawText).catch(() => {})
            }}
            title="复制"
            aria-label="复制代码块"
          >
            ⧉
          </button>
        </div>
        <pre {...props} />
      </div>
    )
  },
}

/** 包好 remark-gfm + rehype-highlight + 共享 components 的 markdown 渲染。 */
export function AgentMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
      {children}
    </ReactMarkdown>
  )
}
