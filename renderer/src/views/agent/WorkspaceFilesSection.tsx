import { useEffect, useMemo, useState } from 'react'
import { IconCode, IconFile, IconPhoto, IconRefresh, IconSearch, IconTable } from '@tabler/icons-react'
import { getAgentFile, listAgentFiles, type FileNode } from '@/api/yiw'
import { artifactKindForPath, imageSrcFromPath } from './stream/uiCapabilities'
import styles from './yiw.module.scss'

type Preview = {
  path: string
  name: string
  kind: ReturnType<typeof artifactKindForPath>
  loading: boolean
  content?: string
  error?: string
}

function normalizeFilesResponse(res: any): { tree: FileNode[]; root: string } {
  const data = res?.data || res || {}
  const tree = data?.tree || []
  return { tree: Array.isArray(tree) ? tree : [], root: String(data?.root || '') }
}

function flattenFiles(tree: FileNode[]) {
  const out: FileNode[] = []
  const walk = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.type === 'dir') walk(node.children || [])
      else out.push(node)
    }
  }
  walk(tree)
  return out
}

function formatSize(size?: number) {
  if (!size || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function fileIcon(path: string) {
  const kind = artifactKindForPath(path)
  if (kind === 'image') return IconPhoto
  if (kind === 'table') return IconTable
  if (kind === 'code') return IconCode
  return IconFile
}

function absolutePath(root: string, rel: string) {
  if (!root || rel.startsWith('/') || /^[a-z]:[\\/]/i.test(rel)) return rel
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.replace(/^[\\/]+/, '')}`
}

export default function WorkspaceFilesSection({
  projectId,
  sessionId
}: {
  projectId: string
  sessionId?: string | null
}) {
  const [files, setFiles] = useState<FileNode[]>([])
  const [root, setRoot] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)
  const [preview, setPreview] = useState<Preview | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    listAgentFiles(projectId, sessionId)
      .then((res: any) => {
        if (!alive) return
        const next = normalizeFilesResponse(res)
        setFiles(flattenFiles(next.tree))
        setRoot(next.root)
      })
      .catch(() => {
        if (alive) {
          setFiles([])
          setRoot('')
        }
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [projectId, refreshTick, sessionId])

  useEffect(() => {
    setPreview(null)
    setQuery('')
  }, [projectId, sessionId])

  const visibleFiles = useMemo(() => {
    const kw = query.trim().toLowerCase()
    if (!kw) return files
    return files.filter((node) => `${node.name} ${node.path}`.toLowerCase().includes(kw))
  }, [files, query])

  const pickFile = (node: FileNode) => {
    const kind = artifactKindForPath(node.path)
    const next: Preview = { path: node.path, name: node.name, kind, loading: kind !== 'image' }
    setPreview(next)
    if (kind === 'image') return
    getAgentFile(projectId, node.path, sessionId)
      .then((res: any) => {
        const data = res?.data || res || {}
        setPreview({ ...next, loading: false, content: String(data?.content || '') })
      })
      .catch((err: any) => {
        setPreview({ ...next, loading: false, error: err?.message || '读取失败' })
      })
  }

  const imagePath = preview?.kind === 'image' ? imageSrcFromPath(absolutePath(root, preview.path)) : ''

  return (
    <div className={styles.wsFilesSection}>
      <div className={styles.wsFilesToolbar}>
        <div className={styles.wsFilesSearch}>
          <IconSearch size={13} stroke={1.7} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="筛选文件" />
        </div>
        <button type="button" title="刷新工作区文件" onClick={() => setRefreshTick((v) => v + 1)}>
          <IconRefresh size={14} stroke={1.8} />
        </button>
      </div>
      {root && (
        <div className={styles.wsFilesRoot} title={root}>
          {root}
        </div>
      )}
      <div className={styles.wsFilesList}>
        {loading ? (
          <div className={styles.wsFilesEmpty}>加载中...</div>
        ) : visibleFiles.length === 0 ? (
          <div className={styles.wsFilesEmpty}>{files.length ? '没有匹配文件' : '工作区还没有文件'}</div>
        ) : (
          visibleFiles.slice(0, 12).map((node) => {
            const Icon = fileIcon(node.path)
            return (
              <button
                key={node.path}
                type="button"
                className={styles.wsFileItem}
                data-active={preview?.path === node.path ? 'true' : undefined}
                title={node.path}
                onClick={() => pickFile(node)}
              >
                <Icon size={15} stroke={1.7} />
                <span className={styles.wsFileName}>{node.name}</span>
                <span className={styles.wsFileSize}>{formatSize(node.size)}</span>
              </button>
            )
          })
        )}
      </div>
      {visibleFiles.length > 12 && <div className={styles.wsFilesMore}>还有 {visibleFiles.length - 12} 个文件,可继续筛选</div>}
      {preview && (
        <div className={styles.wsFilePreview}>
          <div className={styles.wsFilePreviewHead}>
            <span>{preview.name}</span>
            <button type="button" onClick={() => setPreview(null)}>
              收起
            </button>
          </div>
          {preview.kind === 'image' ? (
            <img src={imagePath} alt={preview.name} />
          ) : preview.loading ? (
            <div className={styles.wsFilesEmpty}>读取中...</div>
          ) : preview.error ? (
            <div className={styles.wsFileError}>{preview.error}</div>
          ) : (
            <pre>{preview.content || '文件为空'}</pre>
          )}
        </div>
      )}
    </div>
  )
}
