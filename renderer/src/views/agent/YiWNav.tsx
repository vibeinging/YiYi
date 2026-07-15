// yiw-agent 左栏:新建对话 + 置顶区 + 工作区树(工作区/文件夹 → 其下多个对话)+ 设置入口。
// 工作区行、对话行支持右键菜单(置顶 / 重命名 / 移除);置顶项汇总到顶部「置顶」区。
import { useEffect, useMemo, useState } from 'react'
import {
  IconArchive,
  IconChevronRight,
  IconFolder,
  IconFolderOpen,
  IconMessage,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconTrash
} from '@tabler/icons-react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import ContextMenu, { type MenuItem } from './ContextMenu'
import { isPinned, loadPins, savePins, togglePin, type Pins } from './pins'
import { applyWsOrder, loadWsOrder, saveWsOrder } from './wsOrder'
import styles from './yiw.module.scss'
import yiwLogo from '@/assets/yiw-logo.svg'

export interface Workspace {
  id: string
  name: string
}

// 单个可排序工作区行的包装:用 render-prop 把 @dnd-kit 的 ref/样式/拖拽把手交给调用方,
// 既复用已有 DOM 结构,又避免在 map 里直接调用 hook。
function SortableWs({
  id,
  children
}: {
  id: string
  children: (p: {
    setNodeRef: (el: HTMLElement | null) => void
    style: React.CSSProperties
    isDragging: boolean
    handleProps: Record<string, unknown>
  }) => React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  }
  return <>{children({ setNodeRef, style, isDragging, handleProps: { ...attributes, ...listeners } })}</>
}

export interface YiWNavProps {
  workspaces?: Workspace[]
  convByWs?: Record<string, { id: string; title: string }[]>
  archivedConvByWs?: Record<string, { id: string; title: string }[]>
  activeWs?: string
  activeId?: string
  onNewConv?: (wsId: string) => void
  onSelectConv?: (wsId: string, convId: string) => void
  onRenameConv?: (wsId: string, convId: string, title: string) => void
  onArchiveConv?: (wsId: string, convId: string) => void
  onRestoreConv?: (wsId: string, convId: string) => void
  onRemoveConv?: (wsId: string, convId: string) => void
  onRemoveWorkspace?: (wsId: string) => void
  onShowInFinder?: (wsId: string) => void
  /** 打开某个问数项目的配置页(仅项目工作区有) */
  onConfigureWorkspace?: (wsId: string) => void
  onOpenSettings?: () => void
  onOpenSearch?: () => void
  onOpenSkills?: () => void
}

const wsKind = (id: string) => (id === '__chat__' ? 'chat' : id.startsWith('folder:') ? 'folder' : 'project')

export default function YiWNav({
  workspaces = [],
  convByWs = {},
  archivedConvByWs = {},
  activeWs,
  activeId,
  onNewConv,
  onSelectConv,
  onRenameConv,
  onArchiveConv,
  onRestoreConv,
  onRemoveConv,
  onRemoveWorkspace,
  onShowInFinder,
  onConfigureWorkspace,
  onOpenSettings,
  onOpenSearch,
  onOpenSkills
}: YiWNavProps) {
  // 展开状态:当前工作区默认展开
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (activeWs) setExpanded((e) => (e[activeWs] ? e : { ...e, [activeWs]: true }))
  }, [activeWs])
  const isOpen = (id: string) => expanded[id] ?? id === activeWs
  const toggle = (id: string) => setExpanded((e) => ({ ...e, [id]: !isOpen(id) }))

  // 置顶 + 右键菜单 + 行内改名
  const [pins, setPins] = useState<Pins>(loadPins)
  const applyPins = (p: Pins) => {
    setPins(p)
    savePins(p)
  }
  const [ctx, setCtx] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<{ wsId: string; convId: string } | null>(null)
  const [draft, setDraft] = useState('')

  // 工作区拖动排序(@dnd-kit):自定义顺序持久化到 localStorage;未拖过的回落自然序(创建时间)。纯聊天恒置顶不可拖。
  const [wsOrder, setWsOrder] = useState<string[]>(loadWsOrder)
  const orderedWs = useMemo(() => applyWsOrder(workspaces, wsOrder), [workspaces, wsOrder])
  const sortableIds = useMemo(
    () => orderedWs.filter((w) => wsKind(w.id) !== 'chat').map((w) => w.id),
    [orderedWs]
  )
  // distance 激活约束:移动 5px 才进入拖拽,保证单击(展开/折叠、齿轮、+)照常触发。
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const onWsDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIndex = sortableIds.indexOf(String(active.id))
    const newIndex = sortableIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(sortableIds, oldIndex, newIndex)
    setWsOrder(next)
    saveWsOrder(next)
  }

  // 所有对话索引:convId → { wsId, title }(供置顶区解析名称)
  const convIndex = useMemo(() => {
    const m: Record<string, { wsId: string; title: string }> = {}
    for (const ws of workspaces) {
      for (const c of convByWs[ws.id] || []) m[c.id] = { wsId: ws.id, title: c.title }
      for (const c of archivedConvByWs[ws.id] || []) m[c.id] = { wsId: ws.id, title: c.title }
    }
    return m
  }, [workspaces, convByWs, archivedConvByWs])

  const startRename = (wsId: string, convId: string, cur: string) => {
    setExpanded((e) => ({ ...e, [wsId]: true }))
    setRenaming({ wsId, convId })
    setDraft(cur)
  }
  const commitRename = () => {
    if (renaming && draft.trim()) onRenameConv?.(renaming.wsId, renaming.convId, draft)
    setRenaming(null)
  }

  const openWsMenu = (e: React.MouseEvent, ws: Workspace) => {
    e.preventDefault()
    e.stopPropagation()
    const pinned = isPinned(pins, 'ws', ws.id)
    const kind = wsKind(ws.id)
    const removable = kind !== 'chat' // 纯聊天不可移除;文件夹=移出列表,项目=删除
    const isProject = kind === 'project'
    setCtx({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: 'pin',
          icon: pinned ? <IconPinnedOff size={16} stroke={1.7} /> : <IconPin size={16} stroke={1.7} />,
          label: pinned ? '取消置顶' : '置顶工作区',
          onClick: () => applyPins(togglePin(pins, 'ws', ws.id))
        },
        ...(isProject
          ? [
              {
                key: 'configure',
                icon: <IconSettings size={16} stroke={1.7} />,
                label: '项目配置',
                onClick: () => onConfigureWorkspace?.(ws.id)
              } as MenuItem
            ]
          : []),
        {
          key: 'finder',
          icon: <IconFolderOpen size={16} stroke={1.7} />,
          label: '在 Finder 中显示',
          disabled: wsKind(ws.id) === 'chat',
          onClick: () => onShowInFinder?.(ws.id)
        },
        {
          key: 'remove',
          icon: <IconTrash size={16} stroke={1.7} />,
          label: isProject ? '删除项目' : '移除',
          danger: true,
          dividerBefore: true,
          disabled: !removable,
          onClick: () => onRemoveWorkspace?.(ws.id)
        }
      ]
    })
  }

  const openConvMenu = (e: React.MouseEvent, wsId: string, c: { id: string; title: string }, archived = false) => {
    e.preventDefault()
    e.stopPropagation()
    const pinned = isPinned(pins, 'conv', c.id)
    setCtx({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(archived
          ? []
          : [
              {
                key: 'pin',
                icon: pinned ? <IconPinnedOff size={16} stroke={1.7} /> : <IconPin size={16} stroke={1.7} />,
                label: pinned ? '取消置顶' : '置顶对话',
                onClick: () => applyPins(togglePin(pins, 'conv', c.id))
              } as MenuItem
            ]),
        {
          key: 'rename',
          icon: <IconPencil size={16} stroke={1.7} />,
          label: '重命名',
          onClick: () => startRename(wsId, c.id, c.title)
        },
        archived
          ? {
              key: 'restore',
              icon: <IconArchive size={16} stroke={1.7} />,
              label: '恢复到工作区',
              dividerBefore: true,
              onClick: () => onRestoreConv?.(wsId, c.id)
            }
          : {
              key: 'archive',
              icon: <IconArchive size={16} stroke={1.7} />,
              label: '归档',
              dividerBefore: true,
              onClick: () => onArchiveConv?.(wsId, c.id)
            },
        {
          key: 'remove',
          icon: <IconTrash size={16} stroke={1.7} />,
          label: '移除',
          danger: true,
          onClick: () => onRemoveConv?.(wsId, c.id)
        }
      ]
    })
  }

  // 单个对话行(树 / 置顶区共用渲染;改名输入仅在此出现)
  const convRow = (wsId: string, c: { id: string; title: string }, keyPrefix = '', archived = false) => {
    const editing = renaming?.convId === c.id
    return (
      <div
        key={keyPrefix + c.id}
        className={`${styles.convItem} ${c.id === activeId && wsId === activeWs ? styles.convItemActive : ''}`}
        data-agent-conv-id={c.id}
        data-agent-ws-id={wsId}
        onClick={() => !editing && onSelectConv?.(wsId, c.id)}
        onContextMenu={(e) => openConvMenu(e, wsId, c, archived)}
        title={c.title}
      >
        <IconMessage size={13} stroke={1.7} />
        {editing ? (
          <input
            className={styles.renameInput}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') setRenaming(null)
            }}
            onBlur={commitRename}
          />
        ) : (
          <span className={styles.convTitle}>{c.title || '新对话'}</span>
        )}
      </div>
    )
  }

  // 工作区行内容(折叠头 + 嵌套对话);可排序行把 @dnd-kit 的拖拽把手透传到折叠头上。
  const wsInner = (
    ws: Workspace,
    open: boolean,
    convs: { id: string; title: string }[],
    archivedConvs: { id: string; title: string }[],
    handleProps?: Record<string, unknown>
  ) => (
    <>
      <div
        className={`${styles.wsFolder} ${ws.id === activeWs ? styles.wsFolderActive : ''}`}
        onClick={() => toggle(ws.id)}
        onContextMenu={(e) => openWsMenu(e, ws)}
        title={ws.name}
        {...(handleProps || {})}
      >
        <IconChevronRight size={13} className={open ? styles.wsCaretOpen : styles.wsCaret} />
        <IconFolder size={15} stroke={1.7} className={styles.wsFolderIcon} />
        <span className={styles.wsName}>{ws.name}</span>
        {convs.length > 0 && <span className={styles.wsCount}>{convs.length}</span>}
        {wsKind(ws.id) === 'project' && onConfigureWorkspace && (
          <IconSettings
            size={14}
            className={styles.wsGear}
            onClick={(e) => {
              e.stopPropagation()
              onConfigureWorkspace(ws.id)
            }}
            title="项目配置"
          />
        )}
        <IconPlus
          size={14}
          className={styles.wsPlus}
          onClick={(e) => {
            e.stopPropagation()
            onNewConv?.(ws.id)
          }}
          title="新建对话"
        />
      </div>
      {open && (
        <div className={styles.convNest}>
          {convs.length === 0 && archivedConvs.length === 0 ? (
            <div className={styles.convNestEmpty}>暂无对话</div>
          ) : (
            convs.map((c) => convRow(ws.id, c))
          )}
          {archivedConvs.length > 0 && (
            <>
              <div className={styles.archiveLabel}>
                <IconArchive size={12} stroke={1.7} />
                <span>归档</span>
                <span>{archivedConvs.length}</span>
              </div>
              {archivedConvs.map((c) => convRow(ws.id, c, 'archived-', true))}
            </>
          )}
        </div>
      )}
    </>
  )

  const hasPins = pins.ws.length > 0 || pins.conv.length > 0

  return (
    <>
      <div className={styles.navActionList}>
        <button
          type="button"
          className={styles.navAction}
          onClick={() => activeWs && onNewConv?.(activeWs)}
          disabled={!activeWs}
          title="新建对话"
        >
          <IconPlus size={16} stroke={1.9} />
          <span>新建对话</span>
          <kbd className={styles.navActionKbd}>⌘N</kbd>
        </button>
        <button type="button" className={styles.navAction} onClick={() => onOpenSearch?.()} title="搜索工作区或对话">
          <IconSearch size={16} stroke={1.7} />
          <span>搜索</span>
          <kbd className={styles.navActionKbd}>⌘K</kbd>
        </button>
        <button type="button" className={styles.navAction} onClick={() => onOpenSkills?.()} title="技能">
          <IconSparkles size={16} stroke={1.7} />
          <span>技能</span>
        </button>
      </div>

      {hasPins && (
        <>
          <div className={styles.secLabel}>置顶</div>
          <div className={styles.pinList}>
            {pins.ws.map((id) => {
              const ws = workspaces.find((w) => w.id === id)
              if (!ws) return null
              return (
                <div
                  key={'pw' + id}
                  className={`${styles.convItem} ${id === activeWs ? styles.convItemActive : ''}`}
                  onClick={() => toggle(id)}
                  onContextMenu={(e) => openWsMenu(e, ws)}
                  title={ws.name}
                >
                  {wsKind(id) === 'chat' ? (
                    <IconMessage size={13} stroke={1.7} />
                  ) : (
                    <IconFolder size={13} stroke={1.7} />
                  )}
                  <span className={styles.convTitle}>{ws.name}</span>
                  <IconPin size={12} stroke={1.7} />
                </div>
              )
            })}
            {pins.conv.map((id) => {
              const info = convIndex[id]
              if (!info) return null
              return convRow(info.wsId, { id, title: info.title }, 'pc')
            })}
          </div>
        </>
      )}

      <div className={styles.secLabel}>工作区</div>
      <div className={styles.wsTree}>
        {orderedWs.length === 0 ? (
          <div className={styles.convNestEmpty}>没有工作区。</div>
        ) : (
          <>
            {/* 纯聊天恒置顶,不参与拖拽排序 */}
            {orderedWs
              .filter((ws) => wsKind(ws.id) === 'chat')
              .map((ws) => (
                <div key={ws.id} className={styles.wsGroup}>
                  {wsInner(ws, isOpen(ws.id), convByWs[ws.id] || [], archivedConvByWs[ws.id] || [])}
                </div>
              ))}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragEnd={onWsDragEnd}
            >
              <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                {orderedWs
                  .filter((ws) => wsKind(ws.id) !== 'chat')
                  .map((ws) => (
                    <SortableWs key={ws.id} id={ws.id}>
                      {({ setNodeRef, style, isDragging, handleProps }) => (
                        <div
                          ref={setNodeRef}
                          style={style}
                          className={`${styles.wsGroup} ${isDragging ? styles.wsDragging : ''}`}
                        >
                          {wsInner(ws, isOpen(ws.id), convByWs[ws.id] || [], archivedConvByWs[ws.id] || [], handleProps)}
                        </div>
                      )}
                    </SortableWs>
                  ))}
              </SortableContext>
            </DndContext>
          </>
        )}
      </div>

      <div className={styles.railFoot}>
        <div className={styles.brand}>
          <img className={styles.brandMark} src={yiwLogo} alt="" />
          <span className={styles.brandName}>YiW</span>
        </div>
        <button type="button" className={styles.settingsBtn} onClick={() => onOpenSettings?.()} title="设置">
          <IconSettings size={17} stroke={1.7} className={styles.settingsGear} />
          <span>设置</span>
        </button>
      </div>

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
    </>
  )
}
