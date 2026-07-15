import { Badge, Button, Group } from '@mantine/core'
import type { TraceBenchmarkCase } from '@/api/yiw'
import {
  BENCHMARK_CASE_COLOR,
  BENCHMARK_CASE_LABEL,
  BenchmarkRunBadge,
  compact,
  timeText
} from './TraceOptimizationSettings.shared'
import styles from './TraceOptimizationSettings.module.scss'

export function BenchmarkCaseList({
  cases,
  materializingId,
  runningId,
  batchRunning,
  onMaterialize,
  onRun
}: {
  cases: TraceBenchmarkCase[]
  materializingId: string
  runningId: string
  batchRunning: boolean
  onMaterialize: (item: TraceBenchmarkCase) => void
  onRun: (item: TraceBenchmarkCase) => void
}) {
  return (
    <div className={styles.caseList}>
      {cases.map((item) => (
        <div key={item.id || item.case_key} className={styles.caseRow}>
          <Group gap={6} wrap="nowrap">
            <Badge size="xs" variant="light" color={BENCHMARK_CASE_COLOR[item.status] || 'gray'}>
              {BENCHMARK_CASE_LABEL[item.status] || item.status}
            </Badge>
            <Badge size="xs" variant="light" color="gray">{item.answer_type}</Badge>
            <Badge size="xs" variant="light" color="gray">{item.assertion_type}</Badge>
            <BenchmarkRunBadge run={item.latest_run} />
          </Group>
          <strong>{compact(item.question) || item.case_key}</strong>
          <span>
            {item.latest_run?.updated_at
              ? `最近运行 ${timeText(item.latest_run.updated_at)}`
              : item.tags?.length
                ? item.tags.join(', ')
                : timeText(item.updated_at)}
          </span>
          <Group gap={4} wrap="nowrap" justify="flex-end">
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              loading={materializingId === item.id}
              disabled={!item.id}
              onClick={() => onMaterialize(item)}
            >
              生成 task
            </Button>
            <Button
              size="compact-xs"
              variant="filled"
              loading={runningId === item.id}
              disabled={!item.id || Boolean(runningId || batchRunning)}
              onClick={() => onRun(item)}
            >
              运行
            </Button>
          </Group>
        </div>
      ))}
    </div>
  )
}
