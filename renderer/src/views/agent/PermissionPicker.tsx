// 对话内权限模式选择器(输入框左下角芯片 + 上弹面板)。
// 控制写/执行类工具的治理确认:请求批准 / 替我审批 / 完全访问。随会话发给后端 beforeToolCall。
import { useEffect, useRef, useState } from 'react'
import { IconCheck, IconHandStop, IconLockOpen, IconShieldCheck, type TablerIcon } from '@tabler/icons-react'
import styles from './yiw.module.scss'

export type Approval = 'ask' | 'auto' | 'full'

const MODES: { value: Approval; Icon: TablerIcon; label: string; desc: string }[] = [
  { value: 'ask', Icon: IconHandStop, label: '请求批准', desc: '编辑文件 / 执行命令前都询问' },
  { value: 'auto', Icon: IconShieldCheck, label: '替我审批', desc: '仅对执行命令等风险操作询问' },
  { value: 'full', Icon: IconLockOpen, label: '完全访问', desc: '不询问,直接读写 / 执行' }
]

export default function PermissionPicker({ value, onChange }: { value: Approval; onChange: (v: Approval) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = MODES.find((m) => m.value === value) || MODES[0]

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const ActiveIcon = active.Icon
  return (
    <div className={styles.permPick} ref={ref}>
      <button type="button" className={styles.permBtn} onClick={() => setOpen((o) => !o)} title="批准方式">
        <ActiveIcon size={14} stroke={1.7} />
        <span>{active.label}</span>
      </button>

      {open && (
        <div className={styles.permPanel}>
          <div className={styles.permHd}>应如何批准操作?</div>
          {MODES.map((m) => {
            const Icon = m.Icon
            return (
              <button
                key={m.value}
                type="button"
                className={styles.permItem}
                onClick={() => {
                  onChange(m.value)
                  setOpen(false)
                }}
              >
                <Icon size={17} stroke={1.6} className={styles.permItemIcon} />
                <span className={styles.permItemBody}>
                  <span className={styles.permItemLabel}>{m.label}</span>
                  <span className={styles.permItemDesc}>{m.desc}</span>
                </span>
                {m.value === value && <IconCheck size={15} stroke={2} className={styles.permCheck} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
