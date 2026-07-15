// 工作区文件树(递归)。点文件 → onPick(path)(用于 @ 引用进输入框)。
import { useState } from 'react'
import { IconChevronRight, IconFile, IconFolder } from '@tabler/icons-react'
import type { FileNode } from '@/api/yiw'
import styles from './yiw.module.scss'

function Node({ node, depth, onPick }: { node: FileNode; depth: number; onPick?: (p: string) => void }) {
  const [open, setOpen] = useState(depth < 1)
  const pad = { paddingLeft: 8 + depth * 12 }
  if (node.type === 'dir') {
    return (
      <>
        <div className={styles.ftRow} style={pad} onClick={() => setOpen((o) => !o)}>
          <IconChevronRight size={12} className={open ? styles.ftChevOpen : styles.ftChev} />
          <IconFolder size={13} className={styles.ftDir} />
          <span className={styles.ftName}>{node.name}</span>
        </div>
        {open && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} onPick={onPick} />)}
      </>
    )
  }
  return (
    <div className={styles.ftRow} style={pad} onClick={() => onPick?.(node.path)} title={`@${node.path}`}>
      <span style={{ width: 12 }} />
      <IconFile size={13} className={styles.ftFile} />
      <span className={styles.ftName}>{node.name}</span>
    </div>
  )
}

export default function FileTree({ tree, onPick }: { tree: FileNode[]; onPick?: (p: string) => void }) {
  if (!tree || tree.length === 0) {
    return <div className={styles.ftEmpty}>工作区还没有文件</div>
  }
  return (
    <div className={styles.ftWrap}>
      {tree.map((n) => (
        <Node key={n.path} node={n} depth={0} onPick={onPick} />
      ))}
    </div>
  )
}
