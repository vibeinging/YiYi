import { Badge, Button, Group } from '@mantine/core'
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react'
import type { TraceBenchmarkMaterializeResult, TraceBenchmarkOverview, TraceBenchmarkRun, TraceBenchmarkRunResult, TraceEvalDraft, TraceOptimizationSummary } from '@/api/yiw'
import styles from './TraceOptimizationSettings.module.scss'

const REVIEW_LABEL: Record<string, string> = {
  needs_review: '待复核',
  correct: '正确',
  incorrect: '错误',
  incomplete: '不完整',
  tool_error: '工具问题',
  routing_error: '路由问题',
  data_issue: '口径问题'
}

const REVIEW_COLOR: Record<string, string> = {
  needs_review: 'yellow',
  correct: 'teal',
  incorrect: 'red',
  incomplete: 'orange',
  tool_error: 'grape',
  routing_error: 'yiw',
  data_issue: 'blue'
}

const DRAFT_LABEL: Record<string, string> = {
  draft: '构建中',
  reviewable: '可复核',
  ready: '可运行',
  converted: '已入库',
  discarded: '已丢弃'
}

const DRAFT_COLOR: Record<string, string> = {
  draft: 'gray',
  reviewable: 'cyan',
  ready: 'teal',
  converted: 'yiw',
  discarded: 'dark'
}

const GOLD_LABEL: Record<string, string> = {
  missing: '参考解缺失',
  drafted: '参考解草稿',
  verified: '参考解已确认',
  rejected: '参考解已驳回'
}

export const ASSERTION_OPTIONS = [
  { value: 'manual', label: '人工复核' },
  { value: 'text_contains', label: '文本包含' },
  { value: 'number_approx', label: '数值近似' },
  { value: 'table_shape', label: '表格结构' },
  { value: 'table_cell', label: '表格单元格' },
  { value: 'sql_result', label: 'SQL 结果' },
  { value: 'llm_judge', label: 'LLM 判分' }
]

export const BENCHMARK_FORMAT_OPTIONS = [
  { value: 'auto', label: '自动识别' },
  { value: 'json', label: 'JSON' },
  { value: 'jsonl', label: 'JSONL' },
  { value: 'csv', label: 'CSV/表格' },
  { value: 'text', label: '自然语言' }
]

export const BENCHMARK_CASE_COLOR: Record<string, string> = {
  draft: 'gray',
  reviewable: 'cyan',
  ready: 'teal',
  invalid: 'red',
  converted: 'yiw',
  rejected: 'dark'
}

export const BENCHMARK_CASE_LABEL: Record<string, string> = {
  draft: '草稿',
  reviewable: '可复核',
  ready: 'Ready',
  invalid: '格式无效',
  converted: '已转正式评测',
  rejected: '已拒绝'
}

export const BENCHMARK_RUN_COLOR: Record<string, string> = {
  running: 'yiw',
  passed: 'teal',
  failed: 'red',
  error: 'red',
  blocked: 'yellow'
}

export const BENCHMARK_RUN_LABEL: Record<string, string> = {
  running: '运行中',
  passed: '通过',
  failed: '失败',
  error: '异常',
  blocked: '阻塞'
}

export const ATTEMPT_LABEL: Record<string, string> = {
  planned: '计划中',
  running: '调试中',
  passed: '已通过',
  failed: '仍失败',
  blocked: '阻塞',
  abandoned: '放弃'
}

export const ATTEMPT_COLOR: Record<string, string> = {
  planned: 'gray',
  running: 'yiw',
  passed: 'teal',
  failed: 'red',
  blocked: 'yellow',
  abandoned: 'dark'
}

export const ATTEMPT_STATUS_OPTIONS = [
  { value: 'planned', label: '计划中' },
  { value: 'running', label: '调试中' },
  { value: 'passed', label: '已通过' },
  { value: 'failed', label: '仍失败' },
  { value: 'blocked', label: '阻塞' },
  { value: 'abandoned', label: '放弃' }
]

export function compact(value?: string | null) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function timeText(value?: string | null) {
  if (!value) return ''
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return ''
  return time.toLocaleString([], { hour12: false })
}

export function splitTags(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

export function joinTags(value?: string[]) {
  return (value || []).join(', ')
}

export function percent(value?: number | null) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '0%'
  return `${Math.round(n * 1000) / 10}%`
}

export function score(value?: number | null) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '0.000'
  return n.toFixed(3)
}

export function readiness(draft?: TraceEvalDraft | null) {
  const replay = draft?.replay_requirements || {}
  const traceSnapshot = draft?.trace_snapshot || {}
  return [
    { label: '用户问题', ok: Boolean(compact(draft?.question)) },
    { label: 'Expected', ok: Boolean(compact(draft?.expected_behavior) || compact(draft?.expected_answer)) },
    { label: '断言方式', ok: Boolean(draft?.assertion_type) },
    { label: '来源 Trace', ok: Boolean(draft?.trace_id || draft?.run_id) },
    { label: 'Gold Solve 已确认', ok: draft?.gold_solve?.status === 'verified' },
    { label: 'Trace snapshot', ok: Boolean(Object.keys(traceSnapshot).length) },
    { label: 'Schema fingerprint', ok: Boolean((replay as any).schema_fingerprint) },
    { label: 'Data source snapshot', ok: Boolean((replay as any).data_source_snapshot) }
  ]
}

export function StatusBadge({ type, value }: { type: 'review' | 'draft' | 'gold'; value?: string | null }) {
  const v = value || (type === 'gold' ? 'missing' : 'draft')
  if (type === 'review') {
    return <Badge size="xs" variant="light" color={REVIEW_COLOR[v] || 'gray'}>{REVIEW_LABEL[v] || v}</Badge>
  }
  if (type === 'gold') {
    return <Badge size="xs" variant="light" color={v === 'verified' ? 'teal' : v === 'rejected' ? 'red' : v === 'drafted' ? 'yellow' : 'gray'}>{GOLD_LABEL[v] || v}</Badge>
  }
  return <Badge size="xs" variant="light" color={DRAFT_COLOR[v] || 'gray'}>{DRAFT_LABEL[v] || v}</Badge>
}

export function SummaryStrip({ summary }: { summary: TraceOptimizationSummary | null }) {
  const items = [
    ['待复盘', summary?.reviews.pending || 0],
    ['构建中', summary?.drafts.total || 0],
    ['可运行', summary?.drafts.ready || 0],
    ['参考解待确认', summary?.gold_solves.unverified || 0],
    ['运行', summary?.benchmark_runs?.total || 0],
    ['调试轮次', summary?.attempts?.total || 0]
  ]
  return (
    <div className={styles.summaryStrip}>
      {items.map(([label, value]) => (
        <span key={label} className={styles.summaryItem}>
          <span>{label}</span>
          <strong>{value}</strong>
        </span>
      ))}
    </div>
  )
}

export function BenchmarkRunBadge({ run }: { run?: Partial<TraceBenchmarkRun> | null }) {
  if (!run?.status) return <Badge size="xs" variant="light" color="gray">未运行</Badge>
  return (
    <Badge size="xs" variant="light" color={BENCHMARK_RUN_COLOR[run.status] || 'gray'}>
      {BENCHMARK_RUN_LABEL[run.status] || run.status}
    </Badge>
  )
}

export function EmptyPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <div className={styles.emptyPanel}>
      <IconAlertTriangle size={18} />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  )
}

export function ReadinessChecklist({ draft }: { draft: TraceEvalDraft }) {
  return (
    <div className={styles.checklist}>
      {readiness(draft).map((item) => (
        <div key={item.label} className={`${styles.checkItem} ${item.ok ? styles.checkOk : ''}`}>
          {item.ok ? <IconCheck size={13} /> : <IconAlertTriangle size={13} />}
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  )
}

export function MaterializeResultPanel({
  result,
  onCopyCommand
}: {
  result: TraceBenchmarkMaterializeResult
  onCopyCommand: (command: string) => void
}) {
  return (
    <div className={styles.materializeResult}>
      <Group justify="space-between" align="center" gap={8}>
        <Group gap={6}>
          <Badge size="xs" color={result.formalized ? 'teal' : result.written ? 'yellow' : 'gray'} variant="light">
            {result.formalized ? '正式评测' : result.written ? '草稿' : '预览'}
          </Badge>
          <Badge size="xs" color="gray" variant="light">{result.task_id}</Badge>
          {result.skill?.name && <Badge size="xs" color="grape" variant="light">{result.skill.name}</Badge>}
          {result.runnable === false && <Badge size="xs" color="orange" variant="light">不可直接运行</Badge>}
          {!!result.context_requirements.length && <Badge size="xs" color="yellow" variant="light">上下文缺口 {result.context_requirements.length}</Badge>}
        </Group>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={() => onCopyCommand(result.command)}>复制命令</Button>
      </Group>
      <code>{result.command}</code>
      {result.files ? (
        <div className={styles.materializeFiles}>
          <span>{result.files.task_path}</span>
          <span>{result.files.payload_path}</span>
        </div>
      ) : null}
      {!!result.context_requirements.length && (
        <div className={styles.warningList}>
          {result.context_requirements.map((item) => <span key={item}>{item}</span>)}
        </div>
      )}
    </div>
  )
}

export function BenchmarkRunResultPanel({
  result,
  onCopyCommand
}: {
  result: TraceBenchmarkRunResult
  onCopyCommand: (command: string) => void
}) {
  const run = result.run
  const metrics = (run.metrics || {}) as Record<string, any>
  const diagnosis = (run.diagnosis || {}) as Record<string, any>
  const failedChecks = Array.isArray((run.result as any)?.checks)
    ? (run.result as any).checks.filter((item: any) => !item?.ok).map((item: any) => item.msg).filter(Boolean)
    : []
  return (
    <div className={styles.runResult}>
      <Group justify="space-between" align="center" gap={8}>
        <Group gap={6}>
          <BenchmarkRunBadge run={run} />
          <Badge size="xs" color="gray" variant="light">{run.task_id}</Badge>
          {run.eval_run_id && <Badge size="xs" color="gray" variant="light">{run.eval_run_id}</Badge>}
          {metrics.checks_total != null && <Badge size="xs" color={Number(metrics.checks_failed || 0) ? 'red' : 'teal'} variant="light">断言 {Number(metrics.checks_total || 0) - Number(metrics.checks_failed || 0)}/{metrics.checks_total}</Badge>}
        </Group>
        {run.report_file ? (
          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => onCopyCommand(run.report_file || '')}>复制报告路径</Button>
        ) : null}
      </Group>

      <div className={styles.runMetaGrid}>
        <span><strong>耗时</strong>{metrics.ms ? `${(Number(metrics.ms) / 1000).toFixed(1)}s` : '-'}</span>
        <span><strong>CDP</strong>{metrics.cdp_port || '-'}</span>
        <span><strong>Trace</strong>{run.run_id || run.trace_id || '-'}</span>
        <span><strong>完成</strong>{timeText(run.finished_at)}</span>
      </div>

      {diagnosis.summary ? (
        <div className={styles.diagnosisBox}>
          <Group gap={6} mb={4}>
            <Badge size="xs" color="grape" variant="light">{diagnosis.failure_stage || 'unknown'}</Badge>
            {diagnosis.confidence != null && <Badge size="xs" color="gray" variant="light">置信 {Math.round(Number(diagnosis.confidence || 0) * 100)}%</Badge>}
          </Group>
          <strong>{diagnosis.summary}</strong>
          {Array.isArray(diagnosis.recommended_actions) && diagnosis.recommended_actions.length ? (
            <div className={styles.warningList}>
              {diagnosis.recommended_actions.slice(0, 5).map((item: string) => <span key={item}>{item}</span>)}
            </div>
          ) : null}
        </div>
      ) : null}

      {failedChecks.length ? (
        <div className={styles.warningList}>
          {failedChecks.slice(0, 6).map((item: string) => <span key={item}>{item}</span>)}
        </div>
      ) : null}
    </div>
  )
}

export function BenchmarkTaskArtifactsPanel({
  benchmark
}: {
  benchmark: TraceBenchmarkOverview | null
}) {
  const tasks = (benchmark?.tasks || []).slice(0, 12)
  return (
    <details className={`${styles.section} ${styles.advancedDetails}`}>
      <summary>Eval task 产物</summary>
      <Group justify="space-between" align="center" mt="xs" mb="xs">
        <div>
          <p>{benchmark?.tasks_dir || 'app/eval/tasks'}</p>
        </div>
        <Group gap={6}>
          {Object.entries(benchmark?.groups || {}).slice(0, 6).map(([group, count]) => (
            <Badge key={group} size="xs" variant="light" color="gray">{group} {count}</Badge>
          ))}
        </Group>
      </Group>
      {tasks.length ? (
        <div className={styles.taskGrid}>
          {tasks.map((task) => (
            <div key={`${task.file}-${task.id}`} className={styles.taskItem}>
              <Group gap={6} wrap="nowrap">
                <Badge size="xs" variant="light" color={task.group === 'KDD' ? 'blue' : task.group === 'Trace' ? 'grape' : 'gray'}>{task.group}</Badge>
                <strong>{task.id}</strong>
              </Group>
              <span>{task.desc || task.file}</span>
            </div>
          ))}
        </div>
      ) : (
        <p>暂无 eval task 产物。</p>
      )}
    </details>
  )
}

export function BenchmarkReportsPanel({ benchmark }: { benchmark: TraceBenchmarkOverview | null }) {
  return (
    <section className={styles.section}>
      <Group justify="space-between" align="center" mb="xs">
        <div>
          <h3>运行历史</h3>
          <p>{benchmark?.results_dir || 'app/eval/results'}</p>
        </div>
      </Group>
      {(benchmark?.reports || []).length ? (
        <div className={styles.reportList}>
          {(benchmark?.reports || []).slice(0, 30).map((report) => (
            <div key={report.file} className={styles.reportRow}>
              <Group gap={8} wrap="nowrap">
                <Badge size="xs" variant="light" color={report.status === 'passed' ? 'teal' : report.status === 'failed' ? 'red' : 'yellow'}>{report.status}</Badge>
                <strong>{report.filter || 'all'}</strong>
                <span>{timeText(report.updated_at)}</span>
              </Group>
              <div className={styles.reportMetrics}>
                <span>通过 {report.passed}/{report.total}</span>
                <span>Pass {percent(report.pass_rate)}</span>
                <span>Score {score(report.avg_score)}</span>
                <span>Recall {score(report.avg_recall)}</span>
              </div>
              <code>{report.file}</code>
            </div>
          ))}
        </div>
      ) : (
        <EmptyPanel title="还没有历史报告" detail="运行 app/eval 后，JSON 报告会展示在这里。" />
      )}
    </section>
  )
}
