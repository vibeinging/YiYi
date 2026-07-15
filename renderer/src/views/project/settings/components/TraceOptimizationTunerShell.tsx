import { type ReactNode } from 'react'
import { Button, SegmentedControl } from '@mantine/core'
import { IconHistory, IconPlus, IconRefresh } from '@tabler/icons-react'
import styles from './TraceOptimizationTunerShell.module.scss'

export type TraceOptimizationMode = 'setup' | 'run' | 'review'

export interface TraceOptimizationMetric {
  label: string
  value: string | number
  tone?: 'default' | 'good' | 'warn' | 'bad'
}

const MODE_ITEMS: Array<{ value: TraceOptimizationMode; label: string }> = [
  { value: 'setup', label: '样本与规则' },
  { value: 'run', label: '运行窗口' },
  { value: 'review', label: '更新记录' }
]

interface TraceOptimizationTunerShellProps {
  loading: boolean
  mode: TraceOptimizationMode
  onModeChange: (mode: TraceOptimizationMode) => void
  onRefresh: () => void
  onOpenHistory: () => void
  onCreateOptimization: () => void
  statusTone: 'default' | 'good' | 'warn' | 'bad'
  metrics: TraceOptimizationMetric[]
  children: ReactNode
}

const toneClass = (tone?: string) => {
  if (tone === 'good') return styles.statusSuccess
  if (tone === 'warn') return styles.statusWarning
  if (tone === 'bad') return styles.statusDanger
  return styles.statusMuted
}

export function TraceOptimizationTunerShell({
  loading,
  mode,
  onModeChange,
  onRefresh,
  onOpenHistory,
  onCreateOptimization,
  statusTone,
  metrics,
  children
}: TraceOptimizationTunerShellProps) {
  return (
    <div className={styles.projectTuner}>
      <header className={styles.tunerCommandbar}>
        <div className={styles.commandSpacer} aria-hidden="true" />
        <div className={styles.commandActions}>
          <Button size="xs" variant="subtle" color="gray" leftSection={<IconRefresh size={14} />} loading={loading} onClick={onRefresh}>
            刷新
          </Button>
          <Button size="xs" variant="subtle" color="gray" leftSection={<IconHistory size={14} />} onClick={onOpenHistory}>
            历史
          </Button>
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={onCreateOptimization}>
            创建优化
          </Button>
        </div>
      </header>

      <section className={styles.sessionStrip}>
        <div className={styles.sessionIdentity}>
          <span className={`${styles.statusDot} ${styles.statusDotLarge} ${toneClass(statusTone)}`} />
          <div>
            <div className={styles.sessionTitle}>优化工作台</div>
            <div className={styles.sessionSubtitle}>Trace 复盘、样本规则、回归运行</div>
          </div>
        </div>
        <div className={styles.sessionMetrics}>
          {metrics.map((item) => (
            <div key={item.label} className={styles.metricCell}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      </section>

      <div className={styles.workflowBar}>
        <SegmentedControl
          className={styles.workflowSwitch}
          size="sm"
          value={mode}
          onChange={(value) => onModeChange(value as TraceOptimizationMode)}
          data={MODE_ITEMS}
        />
      </div>

      <div className={styles.modeContent}>{children}</div>
    </div>
  )
}
