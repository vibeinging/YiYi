// yiw 中栏:Agent 对话流。M2:真实会话(创建/持久化/历史加载),自包含极简渲染。
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  IconAlertTriangle,
  IconArrowUp,
  IconBrain,
  IconChartBar,
  IconCheck,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconPhoto,
  IconPencil,
  IconPlayerStopFilled,
  IconTable,
  IconTerminal2,
  IconTrash,
  IconX
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import ReactECharts from 'echarts-for-react'
import marked from '@/utils/markdownConfig'
import { buildChartOption, isChartDisplayType } from '@/utils/chartRegistry'
import TurnLocator, {
  sameTurnLocatorMarkers,
  type TurnLocatorMarker
} from '@/components/TurnLocator'
import {
  compactAgentSession,
  createAgentSession,
  getAgentMessages,
  getAgentModel,
  resolveAgentPendingAction,
  sendMessageToAgent,
  sendToolDecision
} from '@/api/yiw'
import { eventBus, EVENT_TYPES } from '@/utils/eventBus'
import type { Artifact, PlanStep, SkillTrace, ToolCall } from '@/layout/workstation/Workstation'
import type { Workspace } from './YiWNav'
import WorkspacePicker from './WorkspacePicker'
import CodeView from './CodeView'
import ComposerActions, { type Attachment } from './ComposerActions'
import PermissionPicker, { type Approval } from './PermissionPicker'
import MentionPicker, { type PickItem, type PickMode } from './MentionPicker'
import SlashMenu, { filterSlash } from './SlashMenu'
import { INITIAL_SESSION_ID, shouldSyncSessionSelection } from './sessionSelection'
import { attachmentsFromDroppedFiles, hasDroppedFiles } from './droppedAttachments'
import { loadAgentRuntimeSettings, loadYiWSettings } from './YiWSettings'
import { basename, folderPathOf, workspacePath } from './folders'
import type {
  AgentBlock as Block,
  AgentMessage as Msg,
  AgentStreamPatch,
  DataWorkspaceEvent,
  WorkstationDraft,
  WorkstationPatch
} from './stream/types'
import { consumeAgentStream as consumeAgentStreamRequest } from './stream/consumeAgentStream'
import { mapServerMessage, mergeWorkspaceEvent } from './stream/streamAdapter'
import { applyWorkstationPatch, backfillWorkstationFromMessages, completeOpenPlanSteps } from './stream/reducer'
import { IMAGE_MARKDOWN_RE, imageSrcFromPath, isRenderableImageSrc } from './stream/uiCapabilities'
import { resolveBlockExpanded } from './thinkingExpansion'
import styles from './yiw.module.scss'

export type { DataWorkspaceEvent } from './stream/types'

interface Props {
  projectId: string
  selectedId: string | null
  onRunningChange?: (r: boolean) => void
  onSessionCreated?: (id: string) => void
  onAfterComplete?: () => void
  onWorkstation?: (ws: { tools: ToolCall[]; artifacts: Artifact[]; plan: PlanStep[]; skills: SkillTrace[] }) => void
  /** 暴露「停止」回调给右栏工作台(abort 当前请求) */
  stopRef?: React.MutableRefObject<(() => void) | null>
  /** 是否有对话内容(决定外层是否显示右栏工作台:首页空态=无) */
  onHasContent?: (has: boolean) => void
  /** 新建对话时输入框上方的工作区选择器:全部工作区 + 切换 + 打开文件夹 */
  workspaces?: Workspace[]
  onSelectWorkspace?: (id: string) => void
  onOpenFolder?: () => void
  showThinking?: boolean
  interactionMode?: 'queue' | 'interrupt'
  /** 创建一个问数项目工作区(WorkspacePicker「创建问数项目」入口) */
  onCreateProject?: (name: string) => Promise<void> | void
  /** 后端产品工具发出的工作区事件,例如创建/准备好问数项目 */
  onWorkspaceEvent?: (event: DataWorkspaceEvent) => boolean | void | Promise<boolean | void>
  /** 当前工作区的会话(供输入框「# 会话」引用) */
  conversations?: { id: string; title: string }[]
}

type StructuredField = { key: string; label: string }

type DispatchExtra = Record<string, unknown>
type QueueItem = { id: string; text: string; attachments?: Attachment[]; extra?: DispatchExtra }

const LARGE_PASTE_LIMIT_BYTES = 4000
const LARGE_PASTE_NOTICE = '粘贴内容超过 4000 字节，已自动转换为 txt 附件。'

function textByteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function attachmentFromBlock(block: Block): Attachment | null {
  if (block.type !== 'attachment') return null
  const meta = block.metadata || {}
  const path = String(meta.path || meta.file_path || block.content || '').trim()
  if (!path) return null
  return {
    path,
    name: String(meta.name || block.content || path.split('/').filter(Boolean).pop() || path).trim(),
    isDir: Boolean(meta.is_dir || meta.isDir)
  }
}

function attachmentBlock(attachment: Attachment, index: number): Block {
  return {
    id: `att-${Date.now()}-${index}`,
    type: 'attachment',
    content: attachment.name,
    display_type: 'file',
    metadata: {
      path: attachment.path,
      name: attachment.name,
      is_dir: Boolean(attachment.isDir)
    }
  }
}

function normalizeAttachmentsForRequest(items: Attachment[] = []) {
  return items
    .filter((item) => item?.path)
    .map((item) => ({ path: item.path, name: item.name, is_dir: Boolean(item.isDir) }))
}

type TaskNotificationTone = 'action' | 'success' | 'error'

const TASK_NOTIFICATION_TONES: Record<TaskNotificationTone, Array<{ frequency: number; start: number; duration: number }>> = {
  action: [
    { frequency: 880, start: 0, duration: 0.1 },
    { frequency: 880, start: 0.16, duration: 0.12 }
  ],
  success: [
    { frequency: 660, start: 0, duration: 0.09 },
    { frequency: 920, start: 0.1, duration: 0.13 }
  ],
  error: [
    { frequency: 520, start: 0, duration: 0.11 },
    { frequency: 330, start: 0.13, duration: 0.16 }
  ]
}

function playTaskNotificationSound(tone: TaskNotificationTone = 'success') {
  try {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioContextCtor) return
    const ctx = new AudioContextCtor()
    const now = ctx.currentTime
    const notes = TASK_NOTIFICATION_TONES[tone] || TASK_NOTIFICATION_TONES.success
    for (const note of notes) {
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      const start = now + note.start
      const end = start + note.duration
      oscillator.type = tone === 'error' ? 'triangle' : 'sine'
      oscillator.frequency.setValueAtTime(note.frequency, start)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(tone === 'action' ? 0.07 : 0.052, start + 0.018)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start(start)
      oscillator.stop(end)
    }
    const totalMs = Math.max(...notes.map((note) => note.start + note.duration)) * 1000
    window.setTimeout(() => ctx.close().catch(() => undefined), totalMs + 120)
  } catch {
    /* ignore */
  }
}

function sendTaskNotification(title: string, body: string, tone: TaskNotificationTone = 'success') {
  const settings = loadYiWSettings()
  if (!settings.taskNotify) return
  if (settings.notifySound) playTaskNotificationSound(tone)
  if (!('Notification' in window)) return
  const show = () => {
    try {
      new Notification(title, { body, silent: true })
    } catch {
      /* ignore */
    }
  }
  if (Notification.permission === 'granted') {
    show()
  } else if (Notification.permission === 'default') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') show()
    }).catch(() => undefined)
  }
}

function turnId(index: number) {
  return `turn-${index}`
}

function messageText(message: Msg) {
  return message.blocks
    .map((block) => block.content)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clipText(text: string, max = 116) {
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

function normalizeMarkdownImageSources(text: string) {
  IMAGE_MARKDOWN_RE.lastIndex = 0
  return text.replace(IMAGE_MARKDOWN_RE, (raw, alt: string, src: string) => {
    const nextSrc = imageSrcFromPath(src || '')
    if (!isRenderableImageSrc(nextSrc)) return raw
    return `![${String(alt || '').replace(/]/g, '\\]')}](${nextSrc})`
  })
}

function prettifyStandaloneJsonLines(text: string) {
  const lines = text.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      const trimmed = line.trim()
      if (!/^\{[\s\S]*\}$/.test(trimmed)) return line
      try {
        return `\`\`\`json\n${JSON.stringify(JSON.parse(trimmed), null, 2)}\n\`\`\``
      } catch {
        return line
      }
    })
    .join('\n')
}

const AssistantMarkdown = memo(function AssistantMarkdown({ content }: { content: string }) {
  const html = useMemo(() => {
    const normalized = normalizeMarkdownImageSources(prettifyStandaloneJsonLines(content || ''))
    try {
      return marked.parse(normalized) as string
    } catch {
      return marked.parse(String(content || '')) as string
    }
  }, [content])

  return <div className={styles.blkText} dangerouslySetInnerHTML={{ __html: html }} />
})

function parseJsonObject(value: unknown): any | null {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function parseUserInputPayload(content: unknown) {
  const payload = parseJsonObject(content) || {}
  const context = payload.disambiguation_context || {}
  const memoryValues = new Set(
    (Array.isArray(context.memory_values) ? context.memory_values : [])
      .map((item: any) => String(item?.value || item || '').trim())
      .filter(Boolean)
  )
  const optionItems = [
    ...(Array.isArray(payload.options) ? payload.options : []),
    ...(Array.isArray(context.memory_values) ? context.memory_values : []),
    ...(Array.isArray(context.candidates) ? context.candidates : [])
  ]
  const seenOptions = new Set<string>()
  const options = optionItems
    .map((item: any) => {
      const label = String(item?.label || item?.value || item || '').trim()
      return label ? { label, isMemory: memoryValues.has(label) } : null
    })
    .filter((item): item is { label: string; isMemory: boolean } => {
      if (!item || seenOptions.has(item.label)) return false
      seenOptions.add(item.label)
      return true
    })
  return {
    requestId: String(payload.request_id || ''),
    runId: String(payload.run_id || payload.resume_handle?.run_id || ''),
    resumeHandle: payload.resume_handle && typeof payload.resume_handle === 'object' ? payload.resume_handle : null,
    prompt: String(payload.prompt || ''),
    options,
    allowMultiple: Boolean(payload.allow_multiple)
  }
}

const UserInputBlock = memo(function UserInputBlock({
  block,
  disabled,
  resolved,
  selectedValue,
  onPick
}: {
  block: Block
  disabled?: boolean
  resolved?: boolean
  selectedValue?: string
  onPick: (payload: ReturnType<typeof parseUserInputPayload>, value: string) => void
}) {
  const payload = useMemo(() => parseUserInputPayload(block.content), [block.content])
  const promptHtml = useMemo(() => {
    try {
      return marked.parse(payload.prompt || '需要您确认') as string
    } catch {
      return payload.prompt || '需要您确认'
    }
  }, [payload.prompt])

  return (
    <div className={styles.userInputCard}>
      <div className={styles.userInputTitle}>
        <IconAlertTriangle size={15} stroke={1.8} />
        需要确认
      </div>
      <div className={styles.userInputPrompt} dangerouslySetInnerHTML={{ __html: promptHtml }} />
      {payload.options.length > 0 && (
        <div className={styles.userInputOptions}>
          {payload.options.map((option) => (
            <button
              key={option.label}
              type="button"
              className={styles.userInputOption}
              data-memory={option.isMemory ? 'true' : undefined}
              disabled={disabled}
              onClick={() => onPick(payload, option.label)}
            >
              <span>{option.label}</span>
              {option.isMemory && <small>记忆</small>}
            </button>
          ))}
        </div>
      )}
      {resolved && (
        <div className={styles.userInputDone}>
          {selectedValue ? `已选择「${selectedValue}」` : '已选择'}
        </div>
      )}
    </div>
  )
})

function fieldKey(field: any) {
  return String(field?.expression || field?.name || field?.key || field?.field || '').trim()
}

function fieldLabel(field: any) {
  return String(field?.alias || field?.label || field?.title || fieldKey(field)).trim()
}

function tableRowsFromPayload(payload: any): any[] {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.rows)) return payload.rows
  if (Array.isArray(payload?.records)) return payload.records
  return []
}

function tableFieldsFromPayload(payload: any, rows: any[]): StructuredField[] {
  const fields = Array.isArray(payload?.fields) ? payload.fields : Array.isArray(payload?.columns) ? payload.columns : []
  if (fields.length) return fields.map((field: any) => ({ key: fieldKey(field), label: fieldLabel(field) })).filter((field: any) => field.key)
  const first = rows.find((row) => row && typeof row === 'object' && !Array.isArray(row))
  return first ? Object.keys(first).map((key) => ({ key, label: key })) : []
}

function numericFields(rows: any[], fields: StructuredField[], exclude: string[] = []) {
  return fields
    .map((field) => field.key)
    .filter((key) => !exclude.includes(key))
    .filter((key) => rows.some((row) => typeof row?.[key] === 'number' || (row?.[key] !== '' && Number.isFinite(Number(row?.[key])))))
}

function inferXAxisField(rows: any[], fields: StructuredField[], yFields: string[]) {
  const firstRow = rows[0] || {}
  return (
    fields.find((field) => !yFields.includes(field.key) && typeof firstRow[field.key] !== 'number')?.key ||
    fields.find((field) => !yFields.includes(field.key))?.key ||
    fields[0]?.key ||
    ''
  )
}

function structuredDisplayType(block: Block, payload: any) {
  return String(
    payload?.display_type ||
      payload?.chart_type ||
      block.metadata?.display_type ||
      (block as any).display_type ||
      (block.type === 'table' ? 'table' : block.type === 'chart' ? 'bar' : block.type)
  )
}

function imageSourceFromStructuredBlock(block: Block, payload: any) {
  const raw =
    payload?.src ||
    payload?.url ||
    payload?.path ||
    payload?.image ||
    (typeof block.content === 'string' ? block.content.trim() : '')
  const markdownMatch = typeof raw === 'string' ? raw.match(/^!\[[^\]]*]\(([^)]+)\)$/) : null
  const src = imageSrcFromPath(markdownMatch?.[1] || String(raw || ''))
  return isRenderableImageSrc(src) ? src : ''
}

function canRenderStructuredBlock(block: Block) {
  const payload = parseJsonObject(block.content)
  const displayType = structuredDisplayType(block, payload)
  return block.type === 'table' || block.type === 'image' || block.type === 'chart' || block.type === 'json' || isChartDisplayType(displayType)
}

const StructuredResultBlock = memo(function StructuredResultBlock({ block }: { block: Block }) {
  const payload = useMemo(() => parseJsonObject(block.content) || {}, [block.content])
  const displayType = structuredDisplayType(block, payload)
  const rows = useMemo(() => tableRowsFromPayload(payload), [payload])
  const fields = useMemo(() => tableFieldsFromPayload(payload, rows), [payload, rows])
  const [page, setPage] = useState(1)
  const pageSize = 10
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const visibleRows = rows.slice((Math.min(page, totalPages) - 1) * pageSize, Math.min(page, totalPages) * pageSize)

  const chartOption = useMemo(() => {
    if (!isChartDisplayType(displayType) || !rows.length || !fields.length) return null
    const payloadYFields = Array.isArray(payload?.y_axis_fields) ? payload.y_axis_fields.filter(Boolean) : []
    const yFields = payloadYFields.length ? payloadYFields : numericFields(rows, fields, [payload?.x_axis_field, payload?.group_field].filter(Boolean))
    const xField = payload?.x_axis_field || inferXAxisField(rows, fields, yFields)
    if (!xField || !yFields.length) return null
    return buildChartOption(
      displayType,
      {
        data: rows,
        x_axis_field: xField,
        y_axis_fields: yFields,
        group_field: payload?.group_field || null,
        title: payload?.title || block.title || ''
      },
      block.id
    )
  }, [block.id, block.title, displayType, fields, payload, rows])

  if (block.type === 'image' || displayType === 'image') {
    const src = imageSourceFromStructuredBlock(block, payload)
    if (!src) return <AssistantMarkdown content={block.content} />
    return (
      <figure className={styles.structuredImage}>
        <img src={src} alt={payload?.alt || block.title || '图片'} />
        {(block.title || payload?.title) && <figcaption>{payload?.title || block.title}</figcaption>}
      </figure>
    )
  }

  if (isChartDisplayType(displayType) && chartOption) {
    return (
      <section className={styles.structuredBlock}>
        <div className={styles.structuredHeader}>
          <IconChartBar size={15} stroke={1.8} />
          <span>{payload?.title || block.title || '图表'}</span>
        </div>
        {payload?.fallback_hint && <div className={styles.structuredHint}>{payload.fallback_hint}</div>}
        <div className={styles.structuredChart}>
          <ReactECharts option={chartOption} notMerge lazyUpdate style={{ width: '100%', height: '100%' }} opts={{ renderer: 'canvas' }} />
        </div>
      </section>
    )
  }

  if ((displayType === 'table' || block.type === 'table' || block.type === 'json') && rows.length && fields.length) {
    return (
      <section className={styles.structuredBlock}>
        <div className={styles.structuredHeader}>
          <IconTable size={15} stroke={1.8} />
          <span>{payload?.title || block.title || '表格'}</span>
          <small>{payload?.total_row_count || rows.length} 行</small>
        </div>
        {payload?.truncate_hint && <div className={styles.structuredHint}>{payload.truncate_hint}</div>}
        <div className={styles.structuredTableWrap}>
          <table className={styles.structuredTable}>
            <thead>
              <tr>
                {fields.map((field) => (
                  <th key={field.key}>{field.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {fields.map((field) => (
                    <td key={field.key} title={String(row?.[field.key] ?? '')}>
                      {String(row?.[field.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className={styles.structuredPager}>
            <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>
              上一页
            </button>
            <span>
              {Math.min(page, totalPages)} / {totalPages}
            </span>
            <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages}>
              下一页
            </button>
          </div>
        )}
      </section>
    )
  }

  if (block.type === 'chart' || isChartDisplayType(displayType)) {
    return (
      <section className={styles.structuredBlock}>
        <div className={styles.structuredHeader}>
          <IconPhoto size={15} stroke={1.8} />
          <span>{payload?.title || block.title || '结果'}</span>
        </div>
        <AssistantMarkdown content={`\`\`\`json\n${JSON.stringify(payload || block.content, null, 2)}\n\`\`\``} />
      </section>
    )
  }

  return <AssistantMarkdown content={block.content} />
})

function applyBlockToMessages(prev: Msg[], b: Block) {
  const next = [...prev]
  const last = next[next.length - 1]
  if (!last || last.role !== 'assistant') return next
  const blocks = [...last.blocks]
  const i = blocks.findIndex((x) => x.id === b.id)
  if (i >= 0) {
    const prevBlock = blocks[i]
    if (b.metadata?.mode === 'append') {
      blocks[i] = { ...prevBlock, ...b, content: (prevBlock.content || '') + (b.content || '') }
    } else if ((b.type === 'confirm' || b.type === 'user_input') && !b.content) {
      blocks[i] = { ...prevBlock, ...b, content: prevBlock.content }
    } else {
      blocks[i] = b
    }
  } else {
    blocks.push(b)
  }
  next[next.length - 1] = { ...last, blocks }
  return next
}

type BlockViewProps = {
  block: Block
  busy: boolean
  expanded: boolean
  showThinking: boolean
  decision?: 'approved' | 'rejected'
  onDecide: (toolCallId: string, approved: boolean) => void
  onToggleExpand: (id: string, defaultExpanded?: boolean) => void
  onPickUserInput: (payload: ReturnType<typeof parseUserInputPayload>, value: string) => void
}

const BlockView = memo(
  function BlockView({
    block: b,
    busy,
    expanded,
    showThinking,
    decision,
    onDecide,
    onToggleExpand,
    onPickUserInput
  }: BlockViewProps) {
    if (b.type === 'plan') return null
    if (b.type === 'compact') {
      return (
        <div className={styles.compactRow} data-running={b.title === 'running' ? 'true' : undefined}>
          <span className={styles.compactLine} />
          <span className={styles.compactLabel}>
            {b.title === 'running' ? '压缩上下文中…' : b.content || '上下文已压缩'}
          </span>
          <span className={styles.compactLine} />
        </div>
      )
    }
    if (b.type === 'confirm') {
      const tcid = b.id.replace(/^confirm:/, '')
      const state =
        b.title === 'approved' || b.title === 'rejected'
          ? (b.title as 'approved' | 'rejected')
          : decision
      return (
        <div className={styles.govCard}>
          <div className={styles.govHd}>
            <IconAlertTriangle size={15} stroke={1.8} /> 需要确认 · 写入 / 执行
          </div>
          <div className={styles.govBody}>
            <code>{b.content}</code>
          </div>
          {state ? (
            <div className={state === 'rejected' ? styles.govRejected : styles.govApproved}>
              {state === 'rejected' ? '已拒绝' : '已确认'}
            </div>
          ) : (
            <div className={styles.govBtns}>
              <button className={styles.govOk} onClick={() => onDecide(tcid, true)}>
                确认执行
              </button>
              <button className={styles.govNo} onClick={() => onDecide(tcid, false)}>
                拒绝
              </button>
            </div>
          )}
        </div>
      )
    }
    if (b.type === 'user_input') {
      const payload = parseUserInputPayload(b.content)
      const resolved = Boolean(b.title === 'resolved' || b.metadata?.status === 'resolved')
      const selectedValue = String(b.metadata?.response || '')
      return (
        <UserInputBlock
          block={b}
          disabled={Boolean(busy || resolved)}
          resolved={resolved}
          selectedValue={selectedValue}
          onPick={onPickUserInput}
        />
      )
    }
    if (b.type === 'thinking') {
      if (!showThinking) return null
      return (
        <div className={styles.blkThink} data-expanded={expanded ? 'true' : undefined}>
          <button
            type="button"
            className={styles.thinkToggle}
            aria-expanded={expanded}
            onClick={() => onToggleExpand(b.id, expanded)}
          >
            <IconChevronRight size={13} className={expanded ? styles.thinkChevronOpen : styles.thinkChevron} />
            <IconBrain size={15} stroke={1.7} />
            <span>思考过程</span>
          </button>
          {expanded && <div className={styles.thinkBody}>{b.content}</div>}
        </div>
      )
    }
    if (b.type === 'tool') {
      return (
        <div className={styles.blkTool}>
          <IconTerminal2 size={14} stroke={1.7} className={styles.toolIcon} />
          <span className={styles.toolName}>{b.content}</span>
          <span className={styles.toolStatus}>
            {b.title === 'running' ? (
              <span className={styles.typing} />
            ) : b.title === 'error' ? (
              <IconX size={13} stroke={2.2} />
            ) : (
              <IconCheck size={13} stroke={2.2} />
            )}
          </span>
        </div>
      )
    }
    if (b.type === 'tool_result') {
      const toolName = String(b.metadata?.tool_name || b.title || '')
      const defaultExpanded = Boolean(b.metadata?.auto_expand)
      return (
        <div className={styles.toolResult}>
          <div className={styles.trHead} onClick={() => onToggleExpand(b.id, defaultExpanded)}>
            <IconChevronRight size={13} className={expanded ? styles.trChevOpen : styles.trChev} />
            <span className={styles.trName}>{b.title} 结果</span>
            <span className={styles.trHint}>{expanded ? '收起' : '展开'}</span>
          </div>
          {expanded &&
            (toolName === 'read' ? (
              <CodeView code={b.content} max={320} />
            ) : (
              <pre className={styles.trBody}>
                {toolName === 'edit' || toolName === 'write'
                  ? b.content.split('\n').map((ln, i) => (
                      <div
                        key={i}
                        className={
                          ln.startsWith('+')
                            ? styles.diffAdd
                            : ln.startsWith('-')
                              ? styles.diffDel
                              : undefined
                        }
                      >
                        {ln || ' '}
                      </div>
                    ))
                  : b.content}
              </pre>
            ))}
        </div>
      )
    }
    if (b.type === 'error') {
      return <div className={styles.blkErr}>{b.content}</div>
    }
    if (canRenderStructuredBlock(b)) {
      return <StructuredResultBlock block={b} />
    }
    return <AssistantMarkdown content={b.content} />
  },
  (prev, next) =>
    prev.block === next.block &&
    prev.busy === next.busy &&
    prev.expanded === next.expanded &&
    prev.showThinking === next.showThinking &&
    prev.decision === next.decision
)

const UserTurn = memo(
  function UserTurn({
    id,
    message,
    setTurnRef
  }: {
    id: string
    message: Msg
    setTurnRef: (id: string) => (node: HTMLDivElement | null) => void
  }) {
    const attachments = useMemo(() => message.blocks.map(attachmentFromBlock).filter(Boolean) as Attachment[], [message.blocks])
    const content = useMemo(
      () => message.blocks.filter((b) => b.type !== 'attachment').map((b) => b.content).join(''),
      [message.blocks]
    )
    return (
      <div className={styles.turnUser} ref={setTurnRef(id)}>
        <div className={styles.bubbleUser}>
          {attachments.length > 0 && (
            <div className={styles.userAttachList}>
              {attachments.map((attachment, index) => (
                <div key={`${attachment.path}-${index}`} className={styles.userAttachChip} title={attachment.path}>
                  {attachment.isDir ? <IconFolder size={14} stroke={1.7} /> : <IconFile size={14} stroke={1.7} />}
                  <span>{attachment.name}</span>
                </div>
              ))}
            </div>
          )}
          {content && <div>{content}</div>}
        </div>
      </div>
    )
  },
  (prev, next) => prev.id === next.id && prev.message === next.message
)

const AssistantTurn = memo(
  function AssistantTurn({
    id,
    message,
    busy,
    isLast,
    expanded,
    showThinking,
    confirmDecided,
    setTurnRef,
    onDecide,
    onToggleExpand,
    onPickUserInput
  }: {
    id: string
    message: Msg
    busy: boolean
    isLast: boolean
    expanded: Record<string, boolean>
    showThinking: boolean
    confirmDecided: Record<string, 'approved' | 'rejected'>
    setTurnRef: (id: string) => (node: HTMLDivElement | null) => void
    onDecide: (toolCallId: string, approved: boolean) => void
    onToggleExpand: (id: string, defaultExpanded?: boolean) => void
    onPickUserInput: (payload: ReturnType<typeof parseUserInputPayload>, value: string) => void
  }) {
    return (
      <div className={styles.turnAsst} ref={setTurnRef(id)}>
        {message.blocks.length === 0 && busy && isLast && showThinking && (
          <div className={styles.blkThinkBusy}>
            <IconBrain size={15} stroke={1.7} />
            <span>
              思考中<span className={styles.typing} />
            </span>
          </div>
        )}
        {message.blocks.map((block, blockIndex) => (
          <BlockView
            key={block.id}
            block={block}
            busy={busy}
            expanded={resolveBlockExpanded(
              block,
              blockIndex,
              message.blocks.length,
              busy,
              isLast,
              expanded
            )}
            showThinking={showThinking}
            decision={confirmDecided[block.id.replace(/^confirm:/, '')]}
            onDecide={onDecide}
            onToggleExpand={onToggleExpand}
            onPickUserInput={onPickUserInput}
          />
        ))}
      </div>
    )
  },
  (prev, next) =>
    prev.id === next.id &&
    prev.message === next.message &&
    prev.busy === next.busy &&
    prev.isLast === next.isLast &&
    prev.expanded === next.expanded &&
    prev.showThinking === next.showThinking &&
    prev.confirmDecided === next.confirmDecided
)

function hasOpenPlanSteps(plan: PlanStep[]) {
  return plan.some((step) => step.state !== 'done')
}

export default function YiWConversation({
  projectId,
  selectedId,
  onRunningChange,
  onSessionCreated,
  onAfterComplete,
  onWorkstation,
  stopRef,
  onHasContent,
  workspaces = [],
  onSelectWorkspace,
  onOpenFolder,
  showThinking = true,
  interactionMode = 'queue',
  onCreateProject,
  onWorkspaceEvent,
  conversations = []
}: Props) {
  const wsTools = useRef<Map<string, ToolCall>>(new Map())
  const wsArtifacts = useRef<Map<string, Artifact>>(new Map())
  const wsSkills = useRef<Map<string, SkillTrace>>(new Map())
  const wsPlan = useRef<PlanStep[]>([])
  const pushWorkstation = () =>
    onWorkstation?.({
      tools: [...wsTools.current.values()],
      artifacts: [...wsArtifacts.current.values()],
      skills: [...wsSkills.current.values()],
      plan: wsPlan.current
    })
  const [messages, setMessages] = useState<Msg[]>([])
  const persistedMessageCountRef = useRef(0)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [draggingFiles, setDraggingFiles] = useState(false)
  const dragDepthRef = useRef(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // 输入框内联触发(@文件 / #会话):记录触发字符位置与查询词
  const [trigger, setTrigger] = useState<{ mode: PickMode; start: number; query: string } | null>(null)
  // 斜杠命令(/compact 等):输入以 / 开头且还在敲命令名时弹出
  const [slash, setSlash] = useState<{ query: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDecided, setConfirmDecided] = useState<Record<string, 'approved' | 'rejected'>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // 历史会话可能在组件挂载前就已选中。初始值必须为空，首次 effect 才会真正读取消息。
  const [sessionId, setSessionId] = useState<string | null>(INITIAL_SESSION_ID)
  // null 表示正在读取；空字符串表示读取完成但尚未配置模型。
  const [model, setModel] = useState<string | null>(null)
  const pendingWorkspaceEventRef = useRef<DataWorkspaceEvent | null>(null)

  // 权限模式(治理确认):请求批准 ask / 替我审批 auto / 完全访问 full(全局偏好,localStorage)
  const [approval, setApprovalState] = useState<Approval>(
    () => ((localStorage.getItem('yiw-approval') as Approval) || 'ask')
  )
  const approvalRef = useRef<Approval>(approval)
  const setApproval = (v: Approval) => {
    setApprovalState(v)
    approvalRef.current = v
    try {
      localStorage.setItem('yiw-approval', v)
    } catch {
      /* ignore */
    }
  }

  // ── 任务进行中的消息队列(运行时输入排队;可编辑/删除/拖拽/立即)──
  const [queue, setQueueState] = useState<QueueItem[]>([])
  const queueRef = useRef<QueueItem[]>([])
  const setQueue = (u: QueueItem[] | ((p: QueueItem[]) => QueueItem[])) =>
    setQueueState((p) => {
      const next = typeof u === 'function' ? (u as (p: typeof queue) => typeof queue)(p) : u
      queueRef.current = next
      return next
    })
  const nextPromptRef = useRef<QueueItem | null>(null) // 「立即」指定的下一条
  const stoppedRef = useRef(false) // 手动停止标记:停止后不自动发送队列
  const [qEditing, setQEditing] = useState<string | null>(null)
  const [qDraft, setQDraft] = useState('')
  const mkQ = (text: string, attachments?: Attachment[], extra?: DispatchExtra): QueueItem => ({
    id: 'q' + Date.now() + Math.random().toString(36).slice(2, 6),
    text,
    attachments,
    extra
  })
  const appendAttachments = useCallback((files: Attachment[]) => {
    setAttachments((prev) => {
      const seen = new Set(prev.map((p) => p.path))
      return [...prev, ...files.filter((f) => f?.path && !seen.has(f.path))]
    })
  }, [])

  const onDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDroppedFiles(event.dataTransfer.types)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDraggingFiles(true)
  }

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDroppedFiles(event.dataTransfer.types)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDroppedFiles(event.dataTransfer.types)) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDraggingFiles(false)
  }

  const onDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDraggingFiles(false)
    const files = Array.from(event.dataTransfer.files || [])
    if (!files.length) {
      notifications.show({ color: 'yellow', message: '没有读取到本地文件，请直接从 Finder 拖入' })
      return
    }
    const api = (window as any).electronAPI
    const droppedAttachments: Attachment[] = []
    const dropErrors: string[] = []
    for (const file of files) {
      const local = attachmentsFromDroppedFiles([file], api)[0]
      if (local) {
        if (typeof api?.isDirectoryPath === 'function') {
          try {
            local.isDir = Boolean(await api.isDirectoryPath(local.path))
          } catch {
            // 已拿到有效路径；判断失败时仍按普通文件加入。
          }
        }
        droppedAttachments.push(local)
        continue
      }
      if (typeof api?.saveDroppedFileAttachment !== 'function') {
        dropErrors.push('preload 未加载保存方法')
        continue
      }
      try {
        if (typeof file.arrayBuffer !== 'function') throw new Error('拖入对象不支持读取内容')
        const bytes = new Uint8Array(await file.arrayBuffer())
        const saved = await api.saveDroppedFileAttachment({ projectId, sessionId, name: file.name, bytes })
        const path = String(saved?.path || '').trim()
        if (path) droppedAttachments.push({ path, name: String(saved?.name || file.name), isDir: false })
        else dropErrors.push('保存接口没有返回文件路径')
      } catch (error: any) {
        dropErrors.push(error?.message || `无法保存「${file.name}」`)
      }
    }
    if (!droppedAttachments.length) {
      notifications.show({
        color: 'red',
        message: `拖入失败：${[...new Set(dropErrors)].join('；') || '未知原因'}`
      })
    } else {
      appendAttachments(droppedAttachments)
    }
  }

  useEffect(() => {
    if (!projectId) return undefined
    const api = (window as any).electronAPI
    if (typeof api?.registerLocalFileRoot !== 'function') return undefined
    let cancelled = false
    ;(async () => {
      const root = folderPathOf(projectId) || (await workspacePath(projectId))
      if (!cancelled && root) {
        await api.registerLocalFileRoot(root).catch(() => {})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId])

  // 当前工作区生效的模型名(展示在输入条胶囊)
  useEffect(() => {
    if (!projectId) return
    let alive = true
    setModel(null)
    getAgentModel(projectId)
      .then((res: any) => {
        if (alive) setModel(res?.data?.model_name || '')
      })
      .catch(() => {
        if (alive) setModel('')
      })
    return () => {
      alive = false
    }
  }, [projectId])

  const toggleExpand = useCallback(
    (id: string, defaultExpanded = false) =>
      setExpanded((m) => ({ ...m, [id]: !(m[id] ?? defaultExpanded) })),
    []
  )

  // 上报是否有对话内容(首页空态=无 → 外层隐藏右栏工作台)
  useEffect(() => {
    onHasContent?.(messages.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  const decide = useCallback((toolCallId: string, approved: boolean) => {
    setConfirmDecided((m) => ({ ...m, [toolCallId]: approved ? 'approved' : 'rejected' }))
    sendToolDecision(toolCallId, approved).catch(() => {})
  }, [])
  const scrollRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const turnRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const blockQueueRef = useRef<Block[]>([])
  const blockFlushTimerRef = useRef<number | null>(null)
  const notifiedBlockIdsRef = useRef<Set<string>>(new Set())
  const loadedProjectIdRef = useRef(projectId)
  const [threadMarkers, setThreadMarkers] = useState<TurnLocatorMarker[]>([])
  const [activeMarkerId, setActiveMarkerId] = useState('')
  const markerBase = useMemo(
    () => {
      let questionNo = 0
      return messages.flatMap((message, index) => {
        if (message.role !== 'user') return []
        questionNo += 1
        const text = messageText(message)
        return [{
          id: turnId(index),
          title: `第 ${questionNo} 问`,
          excerpt: clipText(text || '空问题'),
          meta: '定位到用户问题'
        }]
      })
    },
    [messages]
  )
  const setTurnRef = useCallback(
    (id: string) => (node: HTMLDivElement | null) => {
      if (node) turnRefs.current.set(id, node)
      else turnRefs.current.delete(id)
    },
    []
  )

  const rebuildThreadMap = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller || markerBase.length === 0) {
      setThreadMarkers([])
      setActiveMarkerId('')
      return
    }
    const markers = markerBase
    const probeY = scroller.scrollTop + scroller.clientHeight * 0.34
    let active = markers[0]?.id || ''
    for (const marker of markers) {
      const node = turnRefs.current.get(marker.id)
      if (node && node.offsetTop <= probeY) active = marker.id
    }
    setThreadMarkers((prev) => (sameTurnLocatorMarkers(prev, markers) ? prev : markers))
    setActiveMarkerId(active)
  }, [markerBase])

  const scrollToMarker = useCallback((id: string) => {
    const scroller = scrollRef.current
    const node = turnRefs.current.get(id)
    if (!scroller || !node) return
    scroller.scrollTo({ top: Math.max(0, node.offsetTop - 28), behavior: 'smooth' })
    setActiveMarkerId(id)
  }, [])

  useEffect(() => {
    const locateQuestion = (payload?: { sessionId?: string | null; questionNo?: number | null }) => {
      if (payload?.sessionId && payload.sessionId !== selectedId) return
      const questionNo = Number(payload?.questionNo || 0)
      const marker = questionNo > 0 ? markerBase[questionNo - 1] : markerBase[markerBase.length - 1]
      if (marker) scrollToMarker(marker.id)
    }
    eventBus.on(EVENT_TYPES.LOCATE_AGENT_QUESTION, locateQuestion)
    return () => eventBus.off(EVENT_TYPES.LOCATE_AGENT_QUESTION, locateQuestion)
  }, [markerBase, scrollToMarker, selectedId])

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(rebuildThreadMap)
    return () => cancelAnimationFrame(frame)
  }, [rebuildThreadMap])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return undefined
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(rebuildThreadMap)
    }
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    if (observer) {
      observer.observe(scroller)
      if (threadRef.current) observer.observe(threadRef.current)
    }
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
    }
  }, [rebuildThreadMap])

  useEffect(
    () => () => {
      if (blockFlushTimerRef.current !== null) window.clearTimeout(blockFlushTimerRef.current)
    },
    []
  )

  const scrollBottom = () => {
    const run = () => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    // 双 rAF:等 React 提交 + 绘制后再滚,scrollHeight 才是最新(否则高块如确认卡会滚不到底)
    requestAnimationFrame(() => requestAnimationFrame(run))
  }

  // 历史回填:打开历史对话时,从持久化的块里重建右栏工作台(计划 / 工具调用 / 产物)
  const backfillWorkstation = (msgs: Msg[]) => {
    const draft = backfillWorkstationFromMessages(msgs)
    wsTools.current = draft.tools
    wsArtifacts.current = draft.artifacts
    wsSkills.current = draft.skills
    wsPlan.current = draft.plan
    pushWorkstation()
  }

  // 选择/新建会话:selectedId 变化时同步(自己刚创建的跳过,避免清空在途消息)
  useEffect(() => {
    const projectChanged = projectId !== loadedProjectIdRef.current
    if (!shouldSyncSessionSelection(selectedId, sessionId, projectChanged)) return
    loadedProjectIdRef.current = projectId
    setSessionId(selectedId)
    // 切换/新建会话:清空右栏工作台累积
    wsTools.current.clear()
    wsArtifacts.current.clear()
    wsSkills.current.clear()
    wsPlan.current = []
    notifiedBlockIdsRef.current.clear()
    pushWorkstation()
    if (!selectedId) {
      persistedMessageCountRef.current = 0
      setMessages([])
      return
    }
    ;(async () => {
      try {
        const res: any = await getAgentMessages(projectId, selectedId)
        const raw = res?.data?.messages || res?.data || []
        const mapped = Array.isArray(raw) ? raw.map(mapServerMessage) : []
        persistedMessageCountRef.current = mapped.length
        setMessages(mapped)
        backfillWorkstation(mapped)
        scrollBottom()
      } catch {
        setMessages([])
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, selectedId])

  // 后台任务可能在当前流式请求结束后才完成。空闲时轻量刷新当前会话，
  // 让持久化的 background_job 消息无需切换会话就能出现。
  useEffect(() => {
    if (!selectedId || busy) return
    let stopped = false
    const refresh = async () => {
      try {
        const res: any = await getAgentMessages(projectId, selectedId)
        const raw = res?.data?.messages || res?.data || []
        const mapped = Array.isArray(raw) ? raw.map(mapServerMessage) : []
        if (stopped || mapped.length <= persistedMessageCountRef.current) return
        const added = mapped.slice(persistedMessageCountRef.current)
        persistedMessageCountRef.current = mapped.length
        setMessages(mapped)
        backfillWorkstation(mapped)
        const jobBlock = added.flatMap((message) => message.blocks).find(
          (block) => block.metadata?.type === 'background_job_event'
        )
        if (jobBlock) {
          const status = String(jobBlock.metadata?.status || '')
          sendTaskNotification(
            status === 'completed' ? '后台任务已完成' : status === 'blocked_configuration' ? '后台任务需要配置' : '后台任务失败',
            jobBlock.content || '后台任务状态已更新。',
            status === 'completed' ? 'success' : status === 'blocked_configuration' ? 'action' : 'error'
          )
        }
        scrollBottom()
      } catch {
        // 后台刷新失败不影响当前会话。
      }
    }
    const timer = window.setInterval(refresh, 2000)
    void refresh()
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
    // backfillWorkstation / scrollBottom 为组件内稳定动作，不作为轮询重建条件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, selectedId, busy])

  const flushQueuedBlocks = () => {
    blockFlushTimerRef.current = null
    const queued = blockQueueRef.current
    if (!queued.length) return
    blockQueueRef.current = []
    setMessages((prev) => queued.reduce(applyBlockToMessages, prev))
    scrollBottom()
  }

  const applyBlock = (b: Block, options?: { immediate?: boolean; skipScroll?: boolean }) => {
    if ((b.type === 'confirm' || b.type === 'user_input') && !notifiedBlockIdsRef.current.has(b.id)) {
      notifiedBlockIdsRef.current.add(b.id)
      sendTaskNotification(
        b.type === 'confirm' ? 'YiW需要确认' : 'YiW需要补充信息',
        b.type === 'confirm' ? '当前任务需要你确认后继续执行。' : '当前任务需要你选择或填写信息后继续。',
        'action'
      )
    }
    if (options?.immediate) {
      if (blockFlushTimerRef.current !== null) {
        window.clearTimeout(blockFlushTimerRef.current)
        blockFlushTimerRef.current = null
      }
      const queued = blockQueueRef.current
      blockQueueRef.current = []
      setMessages((prev) => [...queued, b].reduce(applyBlockToMessages, prev))
      if (!options.skipScroll) scrollBottom()
      return
    }
    blockQueueRef.current.push(b)
    if (blockFlushTimerRef.current === null) {
      blockFlushTimerRef.current = window.setTimeout(flushQueuedBlocks, 24)
    }
  }

  const applyWorkstation = (patch: WorkstationPatch | undefined) => {
    const draft: WorkstationDraft = {
      tools: wsTools.current,
      artifacts: wsArtifacts.current,
      skills: wsSkills.current,
      plan: wsPlan.current
    }
    const changed = applyWorkstationPatch(patch, draft)
    wsTools.current = draft.tools
    wsArtifacts.current = draft.artifacts
    wsSkills.current = draft.skills
    wsPlan.current = draft.plan
    if (changed) pushWorkstation()
    return changed
  }

  const completePlan = () => {
    if (!hasOpenPlanSteps(wsPlan.current)) return
    wsPlan.current = completeOpenPlanSteps(wsPlan.current)
    pushWorkstation()
  }

  const applyStreamPatch = (patch: AgentStreamPatch) => {
    if (patch.workspaceEvent) {
      pendingWorkspaceEventRef.current = mergeWorkspaceEvent(pendingWorkspaceEventRef.current, patch.workspaceEvent)
    }
    if (patch.block) {
      const immediate = ['confirm', 'user_input', 'error', 'tool', 'tool_result', 'compact'].includes(patch.block.type)
      applyBlock(patch.block, { immediate })
    }
    applyWorkstation(patch.workstation)
    if (patch.scrollDelayMs) setTimeout(scrollBottom, patch.scrollDelayMs)
  }

  const consumeAgentStream = async (req: ReturnType<typeof sendMessageToAgent>) => {
    return consumeAgentStreamRequest(req, {
      onPatch: applyStreamPatch,
      flushQueuedBlocks
    })
  }

  const dispatch = async (q: string, extra?: DispatchExtra) => {
    if (!q || !projectId) return
    const requestAttachments = Array.isArray(extra?.attachments) ? (extra.attachments as Attachment[]) : []
    const displayMessage = typeof extra?.display_message === 'string' ? extra.display_message : q
    setBusy(true)
    onRunningChange?.(true)
    pendingWorkspaceEventRef.current = null
    wsSkills.current.clear()
    pushWorkstation()

    // 确保会话存在(首条消息时创建真实 session)
    let sid = sessionId
    if (!sid) {
      try {
        const title = displayMessage || requestAttachments[0]?.name || q
        const res: any = await createAgentSession(projectId, title)
        sid = res?.data?.id || res?.data?.session?.id || null
        if (sid) {
          setSessionId(sid)
          onSessionCreated?.(sid)
        }
      } catch {
        /* 创建失败仍走流(本轮不持久化) */
      }
      if (!sid) sid = 'agent-' + Date.now()
    }

    setMessages((m) => [
      ...m,
      {
        role: 'user',
        blocks: [
          ...requestAttachments.map(attachmentBlock),
          ...(displayMessage ? [{ id: 'u' + Date.now(), type: 'text', content: displayMessage }] : [])
        ]
      },
      { role: 'assistant', blocks: [] }
    ])
    scrollBottom()

    const controller = new AbortController()
    if (stopRef) stopRef.current = () => controller.abort()
    let runCompleted = false
    let runFailed = false
    try {
      const req = sendMessageToAgent(projectId, sid, q, controller.signal, {
        ...(extra || {}),
        approval: approvalRef.current,
        settings: loadAgentRuntimeSettings(),
        attachments: normalizeAttachmentsForRequest(requestAttachments),
        display_message: displayMessage
      })
      // 行级订阅:取流/缓冲/切行由 subscribeStream 统一(Electron 走 ipc,浏览器走 fetch)
      const streamResult = await consumeAgentStream(req)
      runCompleted = streamResult.runCompleted
      runFailed = streamResult.runFailed
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        applyBlock({ id: 'stop' + Date.now(), type: 'error', content: '⏹ 已停止' })
      } else {
        runFailed = true
        applyBlock({ id: 'err' + Date.now(), type: 'error', content: '⚠️ ' + (e?.message || e) })
      }
    } finally {
      if (runCompleted && !runFailed) completePlan()
      if (runCompleted && !runFailed) {
        sendTaskNotification('YiW任务已完成', q.slice(0, 96) || '任务已完成。', 'success')
      } else if (runFailed) {
        sendTaskNotification('YiW任务失败', q.slice(0, 96) || '任务执行失败。', 'error')
      }
      setBusy(false)
      onRunningChange?.(false)
      if (stopRef) stopRef.current = null
      onAfterComplete?.()
      const workspaceEvent = pendingWorkspaceEventRef.current
      pendingWorkspaceEventRef.current = null
      if (workspaceEvent) {
        let switchedWorkspace = false
        try {
          switchedWorkspace = (await onWorkspaceEvent?.(workspaceEvent)) === true
        } catch {
          switchedWorkspace = false
        }
        if (switchedWorkspace) return
      }
      scrollBottom()
      processQueue()
    }
  }

  // 任务结束 → 处理队列:手动停止则不自动发;否则先发「立即」指定的那条,再否则把整条队列合并发送
  const processQueue = () => {
    if (stoppedRef.current) {
      stoppedRef.current = false
      return
    }
    const np = nextPromptRef.current
    nextPromptRef.current = null
    if (np != null) {
      dispatch(np.text, { ...(np.extra || {}), attachments: np.attachments || [] })
      return
    }
    const q = queueRef.current
    if (q.length) {
      const [next, ...rest] = q
      setQueue(rest)
      dispatch(next.text, { ...(next.extra || {}), attachments: next.attachments || [] })
    }
  }

  // 用户发送:任务进行中 → 入队;空闲 → 直接发。附件以结构化字段传给后端,界面只渲染文件卡片。
  const send = (text?: string, extra?: DispatchExtra) => {
    const typed = (text ?? input).trim()
    const atts = text == null ? attachments : []
    if (!typed && !atts.length) return
    const q = typed || '请处理附件。'
    if (!q) return
    const sendExtra = {
      ...(extra || {}),
      attachments: atts,
      display_message: typed
    }
    setInput('')
    setAttachments([])
    setTrigger(null)
    if (busy) {
      if (interactionMode === 'interrupt') {
        nextPromptRef.current = mkQ(q, atts, sendExtra)
        stopRef?.current?.()
      } else {
        setQueue((qu) => [...qu, mkQ(q, atts, sendExtra)])
      }
    } else dispatch(q, sendExtra)
  }

  const resolvePendingAction = async (payload: ReturnType<typeof parseUserInputPayload>, value: string) => {
    const requestId = payload.requestId
    if (!requestId || !projectId || !sessionId) return
    if (busy) return
    setBusy(true)
    onRunningChange?.(true)
    pendingWorkspaceEventRef.current = null
    setMessages((m) => [...m, { role: 'assistant', blocks: [] }])
    scrollBottom()

    const controller = new AbortController()
    if (stopRef) stopRef.current = () => controller.abort()
    let runCompleted = false
    let runFailed = false
    try {
      const req = resolveAgentPendingAction(
        projectId,
        sessionId,
        requestId,
        {
          value,
          run_id: payload.runId || undefined,
          resume_handle: payload.resumeHandle || undefined,
          settings: loadAgentRuntimeSettings(),
          approval: approvalRef.current
        },
        controller.signal
      )
      const streamResult = await consumeAgentStream(req)
      runCompleted = streamResult.runCompleted
      runFailed = streamResult.runFailed
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        applyBlock({ id: 'stop' + Date.now(), type: 'error', content: '⏹ 已停止' })
      } else {
        runFailed = true
        applyBlock({ id: 'err' + Date.now(), type: 'error', content: '⚠️ ' + (e?.message || e) })
      }
    } finally {
      if (runCompleted && !runFailed) completePlan()
      if (runCompleted && !runFailed) {
        sendTaskNotification('YiW任务已继续', '补充信息已处理，任务执行完成。', 'success')
      } else if (runFailed) {
        sendTaskNotification('YiW任务失败', '补充信息后的任务继续执行失败。', 'error')
      }
      setBusy(false)
      onRunningChange?.(false)
      if (stopRef) stopRef.current = null
      onAfterComplete?.()
      scrollBottom()
      processQueue()
    }
  }

  const pickUserInputOption = (payload: ReturnType<typeof parseUserInputPayload>, value: string) => {
    if (busy) return
    void resolvePendingAction(payload, value)
  }

  // 在光标处插入文本(供「+ 菜单」的引用面板命中插入)
  const insertAtCursor = (snippet: string) => {
    const ta = taRef.current
    const at = ta ? ta.selectionStart : input.length
    const next = input.slice(0, at) + snippet + input.slice(ta ? ta.selectionEnd : input.length)
    setInput(next)
    requestAnimationFrame(() => {
      const el = taRef.current
      if (el) {
        const pos = at + snippet.length
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  const insertTextRange = (text: string, start: number, end: number) => {
    const pos = start + text.length
    setInput((prev) => {
      const from = Math.max(0, Math.min(start, prev.length))
      const to = Math.max(from, Math.min(end, prev.length))
      return prev.slice(0, from) + text + prev.slice(to)
    })
    requestAnimationFrame(() => {
      const el = taRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData('text/plain')
    if (!pasted) return
    const bytes = textByteLength(pasted)
    if (bytes <= LARGE_PASTE_LIMIT_BYTES) return
    const api = (window as any).electronAPI
    if (typeof api?.savePastedTextAttachment !== 'function') return
    const start = e.currentTarget.selectionStart ?? input.length
    const end = e.currentTarget.selectionEnd ?? input.length
    e.preventDefault()
    try {
      const saved = await api.savePastedTextAttachment({ projectId, sessionId, content: pasted })
      if (!saved?.path) throw new Error('保存粘贴附件失败')
      const path = String(saved.path)
      appendAttachments([{ path, name: String(saved.name || basename(path)), isDir: false }])
      setInput((current) => {
        const from = Math.max(0, Math.min(start, current.length))
        const to = Math.max(from, Math.min(end, current.length))
        const kept = current.slice(0, from) + current.slice(to)
        return kept.trim() ? kept : LARGE_PASTE_NOTICE
      })
      setTrigger(null)
      setSlash(null)
      requestAnimationFrame(() => {
        const el = taRef.current
        if (el) {
          const pos = Math.max(0, Math.min(start, el.value.length))
          el.focus()
          el.setSelectionRange(pos, pos)
        }
      })
      notifications.show({
        color: 'green',
        title: '已转换为 TXT 附件',
        message: `${formatBytes(bytes)} 粘贴内容已添加到附件。`
      })
    } catch {
      insertTextRange(pasted, start, end)
      notifications.show({
        color: 'red',
        title: '粘贴转换失败',
        message: '已按普通文本粘贴。'
      })
    }
  }

  // 输入框内容变化:更新值 + 探测斜杠命令(行首 /) / 内联引用触发(@ #)
  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    // 斜杠命令:仅在「/ 开头 + 还在敲命令名(无空格)」时弹出;与 @/# 互斥
    if (/^\/[a-zA-Z]*$/.test(val)) {
      setSlash({ query: val.slice(1) })
      if (trigger) setTrigger(null)
      return
    }
    if (slash) setSlash(null)
    const caret = e.target.selectionStart ?? val.length
    // 从光标往前找触发字符,字符与触发符之间不能有空白/换行
    let i = caret - 1
    while (i >= 0 && !/\s/.test(val[i]) && !'@#'.includes(val[i])) i--
    const ch = val[i]
    const triggerable = (ch === '@' || ch === '#') && (i === 0 || /\s/.test(val[i - 1]))
    if (triggerable) {
      const mode: PickMode = ch === '@' ? 'file' : 'conv'
      setTrigger({ mode, start: i, query: val.slice(i + 1, caret) })
    } else if (trigger) {
      setTrigger(null)
    }
  }

  // 执行斜杠命令(操作,不插入文本)
  const runSlash = async (name: string) => {
    setSlash(null)
    setInput('')
    if (name === 'compact') {
      if (!sessionId) {
        notifications.show({ color: 'gray', message: '新对话还没有可压缩的上下文' })
        return
      }
      // 立刻在消息流末尾插入「压缩中」分割线(带动画)
      const divId = 'compact' + Date.now()
      setMessages((m) => [...m, { role: 'assistant', blocks: [{ id: divId, type: 'compact', content: '', title: 'running' }] }])
      scrollBottom()
      const settle = (content: string, drop = false) =>
        setMessages((m) =>
          drop
            ? m.filter((msg) => !(msg.blocks.length === 1 && msg.blocks[0].id === divId))
            : m.map((msg) =>
                msg.blocks.length === 1 && msg.blocks[0].id === divId
                  ? { ...msg, blocks: [{ id: divId, type: 'compact', content, title: 'done' }] }
                  : msg
              )
        )
      try {
        const res: any = await compactAgentSession(projectId, sessionId)
        if (res?.data?.compacted) {
          const { before, after } = res.data
          settle(before && after ? `上下文已压缩 · ${before} → ${after}` : '上下文已压缩')
        } else {
          settle('', true) // 无需压缩 → 撤掉分割线
          notifications.show({ color: 'gray', message: res?.message || '无需压缩' })
        }
      } catch {
        settle('', true) // 失败 → 撤掉分割线(错误已由拦截器提示)
      }
    }
  }

  // 内联触发命中:用所选项替换「触发符+查询词」
  const applyTrigger = (it: PickItem) => {
    if (!trigger) return
    const ta = taRef.current
    const caret = ta ? ta.selectionStart : trigger.start + 1 + trigger.query.length
    const repl = `${trigger.mode === 'file' ? '@' : '#'}${it.value} `
    const next = input.slice(0, trigger.start) + repl + input.slice(caret)
    setInput(next)
    setTrigger(null)
    requestAnimationFrame(() => {
      const el = taRef.current
      if (el) {
        const pos = trigger.start + repl.length
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  // ── 队列项操作 ──
  const removeQ = (id: string) => setQueue((qu) => qu.filter((x) => x.id !== id))
  const startQEdit = (item: { id: string; text: string }) => {
    setQEditing(item.id)
    setQDraft(item.text)
  }
  const commitQEdit = () => {
    if (qEditing) {
      const id = qEditing
      const t = qDraft.trim()
      setQueue((qu) => qu.map((x) => (x.id === id ? { ...x, text: t || x.text } : x)))
    }
    setQEditing(null)
  }
  // 停止:中止当前任务(队列保留,不自动发送)
  const stop = () => {
    stoppedRef.current = true
    stopRef?.current?.()
  }

  // 立即:停当前任务,该条作为下一条发送(从队列移除;其余仍排队)
  const sendNow = (item: QueueItem) => {
    setQueue((qu) => qu.filter((x) => x.id !== item.id))
    if (busy) {
      nextPromptRef.current = item
      stopRef?.current?.()
    } else {
      dispatch(item.text, { ...(item.extra || {}), attachments: item.attachments || [] })
    }
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && (trigger || slash)) {
      e.preventDefault()
      setTrigger(null)
      setSlash(null)
      return
    }
    // 斜杠命令面板打开时:Enter 执行第一个匹配命令(不当聊天发送)
    if (e.key === 'Enter' && !e.shiftKey && slash) {
      const top = filterSlash(slash.query, { hasSession: messages.length > 0 })[0]
      if (top) {
        e.preventDefault()
        runSlash(top.name)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const composer = (
    <div className={styles.composer}>
      {messages.length === 0 && workspaces.length > 0 && onSelectWorkspace && (
        <div className={styles.composerTop}>
          <WorkspacePicker
            workspaces={workspaces}
            activeWs={projectId}
            onSelect={onSelectWorkspace}
            onOpenFolder={onOpenFolder || (() => {})}
            onCreateProject={onCreateProject}
          />
        </div>
      )}
      {queue.length > 0 && (
        <div className={styles.queueList}>
          {queue.map((item) => (
            <div key={item.id} className={styles.queueItem}>
              {qEditing === item.id ? (
                <input
                  className={styles.queueEdit}
                  autoFocus
                  value={qDraft}
                  onChange={(e) => setQDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitQEdit()
                    else if (e.key === 'Escape') setQEditing(null)
                  }}
                  onBlur={commitQEdit}
                />
              ) : (
                <span className={styles.queueText}>{item.text}</span>
              )}
              <button className={styles.queueNow} onClick={() => sendNow(item)} title="立即发送(停止当前任务)">
                <IconArrowUp size={13} stroke={2} />
                立即
              </button>
              <button className={styles.queueIcon} onClick={() => startQEdit(item)} title="编辑">
                <IconPencil size={14} stroke={1.7} />
              </button>
              <button className={styles.queueIcon} onClick={() => removeQ(item.id)} title="删除">
                <IconTrash size={14} stroke={1.7} />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className={styles.attachList}>
          {attachments.map((a, i) => (
            <span key={`${a.path}-${i}`} className={styles.attachChip} title={a.path}>
              {a.isDir ? (
                <IconFolder size={13} stroke={1.7} className={styles.attachIcon} />
              ) : (
                <IconFile size={13} stroke={1.7} className={styles.attachIcon} />
              )}
              <span className={styles.attachName}>{a.name}</span>
              <button
                type="button"
                className={styles.attachX}
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                title="移除附件"
              >
                <IconX size={12} stroke={2} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={styles.taWrap}>
        {trigger && (
          <MentionPicker
            mode={trigger.mode}
            projectId={projectId}
            sessionId={sessionId}
            conversations={conversations}
            query={trigger.query}
            onPick={applyTrigger}
            onClose={() => setTrigger(null)}
          />
        )}
        {slash && <SlashMenu query={slash.query} hasSession={messages.length > 0} onRun={runSlash} />}
        <textarea
          data-testid="agent-message-input"
          ref={taRef}
          className={styles.ta}
          placeholder={busy ? '继续输入，消息会排队执行…' : '问数据、处理文件，或安排一个多步任务…'}
          value={input}
          onChange={onInputChange}
          onPaste={onPaste}
          onKeyDown={onKey}
        />
      </div>
      <div className={styles.composerBar}>
        <ComposerActions
          projectId={projectId}
          sessionId={sessionId}
          conversations={conversations}
          disabled={busy}
          onAddAttachments={appendAttachments}
          onInsert={insertAtCursor}
        />
        <PermissionPicker value={approval} onChange={setApproval} />
        <div className={styles.spacer} />
        <span
          className={styles.modelChip}
          title={model === null ? '正在读取当前工作区的模型配置' : model || '请先在设置中配置主模型'}
        >
          {model === null ? '读取模型…' : model || '未配置模型'}
        </span>
        <button
          data-testid="agent-send-button"
          className={styles.sendBtn}
          onClick={() => (busy ? stop() : send())}
          disabled={!busy && !input.trim() && attachments.length === 0}
          title={busy ? '停止当前任务' : '发送'}
        >
          {busy ? <IconPlayerStopFilled size={15} /> : <IconArrowUp size={17} stroke={2} />}
        </button>
      </div>
    </div>
  )

  return (
    <div
      className={styles.conversationDropSurface}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {draggingFiles && (
        <div className={styles.dropOverlay} aria-hidden="true">
          <IconFile size={22} stroke={1.7} />
          <strong>松开以添加文件或文件夹</strong>
        </div>
      )}
      {messages.length === 0 ? (
        <div className={styles.emptyWrap}>
          <div className={styles.hero}>
            <div className={styles.heroPrompt}>
              <span className={styles.heroYiW}>YiW</span>
              <span className={styles.heroCaret}>❯</span>
            </div>
            <div className={styles.heroSub}>连接数据源 · 处理文件 · 追踪工具执行 · 沉淀工作区</div>
          </div>
          <div style={{ width: 'min(760px, 92%)' }}>{composer}</div>
        </div>
      ) : (
        <>
          <div className={styles.scroll} ref={scrollRef}>
            {threadMarkers.length > 1 && (
              <TurnLocator
                markers={threadMarkers}
                activeId={activeMarkerId}
                ariaLabel="对话轮次导航"
                showPreview
                onSelect={scrollToMarker}
              />
            )}
            <div className={styles.thread} ref={threadRef}>
              {messages.map((m, mi) => {
                const id = turnId(mi)
                return m.role === 'user' ? (
                  <UserTurn key={id} id={id} message={m} setTurnRef={setTurnRef} />
                ) : (
                  <AssistantTurn
                    key={id}
                    id={id}
                    message={m}
                    busy={busy}
                    isLast={mi === messages.length - 1}
                    expanded={expanded}
                    showThinking={showThinking}
                    confirmDecided={confirmDecided}
                    setTurnRef={setTurnRef}
                    onDecide={decide}
                    onToggleExpand={toggleExpand}
                    onPickUserInput={pickUserInputOption}
                  />
                )
              })}
            </div>
          </div>
          <div className={styles.dock}>{composer}</div>
        </>
      )}
    </div>
  )
}
