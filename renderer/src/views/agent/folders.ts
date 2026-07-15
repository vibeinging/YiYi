// 工作区身份编码进 pid(与后端 workspace_agent.resolveWorkspace 对应):
//   '__chat__'             → 纯聊天 namespace(执行时后端按 session_id 隔离到 __chat__/<session_id>/)
//   'folder:' + base64url  → 用户「打开文件夹」选择的本地目录
//   UUID                   → 项目工作区
import type { Workspace } from './YiWNav'

export const CHAT_WS: Workspace = { id: '__chat__', name: '纯聊天' }

export interface FolderWs extends Workspace {
  path: string
}

const KEY = 'yiw-folders'

const b64url = (s: string) =>
  btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

export const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

export const folderToWs = (path: string): FolderWs => ({
  id: 'folder:' + b64url(path),
  name: basename(path),
  path
})

const b64urlDecode = (s: string) => {
  try {
    return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))
  } catch {
    return ''
  }
}

// 工作区 pid → 本地目录(同步,仅 folder: 可解出;项目/纯聊天返回 null,需走 workspacePath 异步解析)
export const folderPathOf = (wsId: string): string | null =>
  wsId.startsWith('folder:') ? b64urlDecode(wsId.slice(7)) || null : null

export const loadFolders = (): FolderWs[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export const saveFolders = (folders: FolderWs[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(folders))
  } catch {
    /* ignore */
  }
}

// 原生目录选择(Electron 内,经 preload 暴露的 window.electronAPI.pickFolder → dialog.showOpenDialog)。
// 浏览器内无 electronAPI → 返回 null(调用方静默处理)。
export async function pickFolder(): Promise<string | null> {
  const fn = (window as any).electronAPI?.pickFolder
  if (typeof fn !== 'function') return null
  try {
    const res = await fn()
    return typeof res === 'string' ? res : null
  } catch {
    return null
  }
}

export interface PickedPath {
  path: string
  isDir: boolean
}

// 单一原生对话框,文件 + 文件夹都能选(可多选;默认目录 = 当前工作区)。
// Electron 经 ipc → dialog.showOpenDialog({properties:['openFile','openDirectory','multiSelections']})。浏览器内 → []。
export async function pickFilesOrFolders(defaultPath?: string | null): Promise<PickedPath[]> {
  const fn = (window as any).electronAPI?.pickPaths
  if (typeof fn !== 'function') return []
  try {
    const res = await fn(defaultPath || null)
    return Array.isArray(res) ? res.filter((x: any) => x && typeof x.path === 'string') : []
  } catch {
    return []
  }
}

// 是否运行在桌面壳内(Electron)。
export const isDesktop = () => typeof (window as any).electronAPI !== 'undefined'

// 工作区的本地目录路径:文件夹工作区直接用 path;项目 = ~/.yiw/projects/<id>;纯聊天需 session_id,这里返回 null。
export async function workspacePath(wsId: string, folderPath?: string): Promise<string | null> {
  if (wsId === CHAT_WS.id) return null
  if (folderPath) return folderPath
  const fn = (window as any).electronAPI?.workspacePath
  if (typeof fn !== 'function') return null
  try {
    return await fn(wsId)
  } catch {
    return null
  }
}

// 在 Finder / 文件管理器中显示该目录(Electron 经 shell.showItemInFolder)。
export async function revealInFinder(path: string): Promise<boolean> {
  const fn = (window as any).electronAPI?.revealInFinder
  if (typeof fn !== 'function') return false
  try {
    return (await fn(path)) !== false
  } catch {
    return false
  }
}
