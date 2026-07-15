import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Group, ScrollArea, SegmentedControl, Select, Stack, TextInput, Textarea } from '@mantine/core'
import { IconChecklist, IconClipboardText, IconDatabaseImport, IconFolderOpen, IconSearch, IconSparkles } from '@tabler/icons-react'
import type {
  TraceBenchmarkCase,
  TraceBenchmarkMaterializeResult,
  TraceBenchmarkNormalizeResult,
  TraceBenchmarkOverview,
  TraceBenchmarkRunResult,
  TraceEvalDraft
} from '@/api/yiw'
import { BenchmarkCaseList } from './TraceOptimizationBenchmarkCases'
import {
  BENCHMARK_CASE_COLOR,
  BENCHMARK_CASE_LABEL,
  BENCHMARK_FORMAT_OPTIONS,
  BenchmarkReportsPanel,
  BenchmarkRunResultPanel,
  BenchmarkTaskArtifactsPanel,
  EmptyPanel,
  MaterializeResultPanel,
  StatusBadge,
  compact
} from './TraceOptimizationSettings.shared'
import styles from './TraceOptimizationSettings.module.scss'

type BenchmarkMode = 'import' | 'cases' | 'runs'

const CASE_STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'ready', label: 'Ready' },
  { value: 'reviewable', label: '可复核' },
  { value: 'draft', label: '草稿' },
  { value: 'converted', label: '已转正式评测' },
  { value: 'invalid', label: '格式无效' },
  { value: 'rejected', label: '已拒绝' }
]

interface Props {
  benchmark: TraceBenchmarkOverview | null
  stats: Array<[string, number]>
  candidates: TraceEvalDraft[]
  input: string
  format: string
  normalizeResult: TraceBenchmarkNormalizeResult | null
  importableCount: number
  folderPath: string
  normalizing: boolean
  folderNormalizing: boolean
  importing: boolean
  materializingId: string
  runningId: string
  batchRunning: boolean
  materializeResult: TraceBenchmarkMaterializeResult | null
  runResult: TraceBenchmarkRunResult | null
  initialMode?: BenchmarkMode
  availableModes?: BenchmarkMode[]
  showToolbar?: boolean
  showCandidates?: boolean
  onInputChange: (value: string) => void
  onFormatChange: (value: string) => void
  onNormalize: () => void
  onNormalizeFolder: () => void
  onCopyNormalized: () => void
  onImport: () => void
  onRunReady: () => void
  onMaterialize: (item: TraceBenchmarkCase) => void
  onRun: (item: TraceBenchmarkCase) => void
  onCopyCommand: (command: string) => void
  onOpenDraft: (draft: TraceEvalDraft) => void
}

export function TraceOptimizationBenchmarkWorkspace({
  benchmark,
  stats,
  candidates,
  input,
  format,
  normalizeResult,
  importableCount,
  folderPath,
  normalizing,
  folderNormalizing,
  importing,
  materializingId,
  runningId,
  batchRunning,
  materializeResult,
  runResult,
  initialMode = 'import',
  availableModes = ['import', 'cases', 'runs'],
  showToolbar = true,
  showCandidates = true,
  onInputChange,
  onFormatChange,
  onNormalize,
  onNormalizeFolder,
  onCopyNormalized,
  onImport,
  onRunReady,
  onMaterialize,
  onRun,
  onCopyCommand,
  onOpenDraft
}: Props) {
  const defaultMode = availableModes.includes(initialMode) ? initialMode : availableModes[0] || 'import'
  const [mode, setMode] = useState<BenchmarkMode>(defaultMode)
  const [caseQuery, setCaseQuery] = useState('')
  const [caseStatus, setCaseStatus] = useState('all')
  const cases = benchmark?.cases || []
  const filteredCases = useMemo(() => {
    const query = compact(caseQuery).toLowerCase()
    return cases.filter((item) => {
      const statusMatched = caseStatus === 'all' || item.status === caseStatus || item.latest_run?.status === caseStatus
      if (!statusMatched) return false
      if (!query) return true
      return [
        item.question,
        item.case_key,
        item.expected_behavior,
        item.answer_type,
        item.assertion_type,
        ...(item.tags || [])
      ].some((value) => String(value || '').toLowerCase().includes(query))
    })
  }, [caseQuery, caseStatus, cases])
  const availableModeKey = availableModes.join('|')
  const hasRawInput = Boolean(compact(input) || folderPath)
  const hasPreview = Boolean(normalizeResult?.cases.length)
  const sourceText = folderPath ? '文件夹' : compact(input) ? '粘贴内容' : '待选择'
  const modeTabs = [
    { value: 'import', label: '导入用例' },
    { value: 'cases', label: '用例库' },
    { value: 'runs', label: '运行结果' }
  ].filter((item) => availableModes.includes(item.value as BenchmarkMode))

  useEffect(() => {
    const nextDefault = availableModes.includes(initialMode) ? initialMode : availableModes[0] || 'import'
    if (!availableModes.includes(mode)) setMode(nextDefault)
  }, [availableModeKey, availableModes, initialMode, mode])

  useEffect(() => {
    if ((runResult || materializeResult) && availableModes.includes('runs')) setMode('runs')
  }, [availableModes, materializeResult, runResult])

  return (
    <div className={`${styles.benchmarkShell} ${!showToolbar ? styles.benchmarkShellNoToolbar : ''}`}>
      {showToolbar ? (
        <div className={styles.benchmarkToolbar}>
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={(value) => setMode(value as BenchmarkMode)}
            data={modeTabs}
          />
          <div className={styles.benchmarkStatLine}>
            {stats.map(([label, value]) => (
              <span key={label}><b>{value}</b>{label}</span>
            ))}
          </div>
        </div>
      ) : null}

      {mode === 'import' ? (
        <div className={styles.benchmarkImportPage}>
          <section className={styles.importComposer}>
            <div className={styles.importHeader}>
              <div>
                <h3>导入测试集</h3>
                <p>从文件夹、表格或粘贴内容生成统一 Benchmark 样本。</p>
              </div>
              <Badge size="xs" variant="light" color={hasPreview ? 'teal' : hasRawInput ? 'yellow' : 'gray'}>
                {hasPreview ? '已清洗' : hasRawInput ? '待清洗' : '待导入'}
              </Badge>
            </div>

            <div className={styles.importFlow}>
              <span className={hasRawInput ? styles.importFlowActive : ''}><IconClipboardText size={14} />来源 {sourceText}</span>
              <span className={hasPreview ? styles.importFlowActive : ''}><IconSparkles size={14} />AI 清洗</span>
              <span className={importableCount ? styles.importFlowActive : ''}><IconDatabaseImport size={14} />入库 {importableCount}</span>
            </div>

            <div className={styles.importSourcePanel}>
              <div className={styles.importSourceHead}>
                <div>
                  <strong>原始测试集</strong>
                  <span>支持 JSON、JSONL、CSV、表格文本、自然语言清单或文件夹。</span>
                </div>
                <Group gap={8} wrap="nowrap">
                  <Select
                    size="xs"
                    w={132}
                    data={BENCHMARK_FORMAT_OPTIONS}
                    value={format}
                    onChange={(value) => onFormatChange(value || 'auto')}
                    allowDeselect={false}
                  />
                  <Button size="xs" variant="default" leftSection={<IconFolderOpen size={14} />} loading={folderNormalizing} onClick={onNormalizeFolder}>文件夹</Button>
                  <Button size="xs" leftSection={<IconSparkles size={14} />} loading={normalizing} disabled={!hasRawInput} onClick={onNormalize}>AI 清洗</Button>
                </Group>
              </div>
              <Textarea
                className={styles.benchmarkTextarea}
                minRows={8}
                placeholder="粘贴测试集内容，或点击上方文件夹导入。"
                value={input}
                onChange={(event) => onInputChange(event.currentTarget.value)}
              />
            </div>
            {folderPath ? (
              <div className={styles.folderImportHint}>
                <span>文件夹</span>
                <strong title={folderPath}>{folderPath}</strong>
              </div>
            ) : null}
          </section>

          <section className={styles.importPreviewPane}>
            <Group className={styles.importPreviewHeader} justify="space-between" align="flex-start" gap={8}>
              <div>
                <h3>清洗预览</h3>
                <p>确认 gold、顺序和断言方式后再导入。</p>
              </div>
              <Group gap={6} justify="flex-end">
                <Badge size="xs" color="teal" variant="light">可导入 {normalizeResult?.valid_count || 0}</Badge>
                {!!normalizeResult?.invalid_count && <Badge size="xs" color="red" variant="light">无效 {normalizeResult.invalid_count}</Badge>}
                {!!normalizeResult?.warnings.length && <Badge size="xs" color="yellow" variant="light">警告 {normalizeResult.warnings.length}</Badge>}
                {normalizeResult?.source?.type === 'folder_import' && (
                  <Badge size="xs" color="blue" variant="light">文件 {normalizeResult.source.files?.length || 0}/{normalizeResult.source.total_files || 0}</Badge>
                )}
              </Group>
            </Group>
            <div className={styles.importCommitBar}>
              <span>{hasPreview ? '预览通过后再确认入库，避免污染回归样本。' : '清洗后会在下方展示样本明细。'}</span>
              <Group gap={8} wrap="nowrap">
                <Button size="xs" variant="default" leftSection={<IconChecklist size={14} />} disabled={!normalizeResult?.cases.length} onClick={onCopyNormalized}>复制 JSON</Button>
                <Button size="xs" color="teal" loading={importing} disabled={!importableCount} onClick={onImport}>确认导入</Button>
              </Group>
            </div>
            <ScrollArea className={styles.importPreviewBody} type="hover" scrollbarSize={7}>
              {normalizeResult ? (
                <Stack gap={10} p={2}>
                  {!!normalizeResult.warnings.length && (
                    <div className={styles.warningList}>
                      {normalizeResult.warnings.slice(0, 8).map((warning) => <span key={warning}>{warning}</span>)}
                    </div>
                  )}
                  <div className={styles.casePreviewList}>
                    {normalizeResult.cases.map((item) => (
                      <div key={`${item.case_key}-${item.source_index || item.question}`} className={styles.casePreviewRow}>
                        <Group gap={6} wrap="nowrap">
                          <Badge size="xs" variant="light" color={BENCHMARK_CASE_COLOR[item.status] || 'gray'}>{BENCHMARK_CASE_LABEL[item.status] || item.status}</Badge>
                          <Badge size="xs" variant="light" color="gray">{item.answer_type}</Badge>
                          <Badge size="xs" variant="light" color="gray">{item.assertion_type}</Badge>
                        </Group>
                        <strong>{compact(item.question) || item.case_key}</strong>
                        <span>{compact(item.expected_behavior) || '未填写 expected behavior'}</span>
                      </div>
                    ))}
                  </div>
                </Stack>
              ) : (
                <EmptyPanel title="等待清洗" detail="左侧粘贴内容或选择文件夹后，预览会显示在这里。" />
              )}
            </ScrollArea>
          </section>
        </div>
      ) : null}

      {mode === 'cases' ? (
        <div className={`${styles.benchmarkCasesPage} ${!showCandidates ? styles.benchmarkCasesPageSolo : ''}`}>
          <section className={styles.caseDesk}>
            <div className={styles.paneHeader}>
              <div>
                <h3>已入库用例</h3>
                <p>{filteredCases.length}/{cases.length} 个项目级回归样本</p>
              </div>
              <Button size="xs" variant="default" loading={batchRunning} onClick={onRunReady}>运行 Ready</Button>
            </div>
            <div className={styles.caseToolbar}>
              <TextInput
                size="xs"
                value={caseQuery}
                leftSection={<IconSearch size={13} />}
                placeholder="搜索问题、case key、标签"
                onChange={(event) => setCaseQuery(event.currentTarget.value)}
              />
              <Select
                size="xs"
                w={154}
                data={CASE_STATUS_OPTIONS}
                value={caseStatus}
                allowDeselect={false}
                onChange={(value) => setCaseStatus(value || 'all')}
              />
            </div>
            <ScrollArea className={styles.paneBody} type="hover" scrollbarSize={7}>
              <Stack gap={12} p={14}>
                {filteredCases.length ? (
                  <BenchmarkCaseList
                    cases={filteredCases}
                    materializingId={materializingId}
                    runningId={runningId}
                    batchRunning={batchRunning}
                    onMaterialize={onMaterialize}
                    onRun={onRun}
                  />
                ) : (
                  <EmptyPanel
                    title={cases.length ? '没有匹配用例' : '还没有入库用例'}
                    detail={cases.length ? '调整搜索词或状态筛选。' : '先到用例构建中粘贴内容、选择文件夹，或从会话复盘沉淀。'}
                  />
                )}
              </Stack>
            </ScrollArea>
          </section>

          {showCandidates ? (
            <section className={styles.candidateDesk}>
              <Group justify="space-between" align="center" mb="xs">
                <div>
                  <h3>待确认用例</h3>
                  <p>补齐 expected / 参考解后可进入用例库。</p>
                </div>
                <Badge size="xs" variant="light" color="gray">{candidates.length}</Badge>
              </Group>
              <ScrollArea className={styles.candidateList} type="hover" scrollbarSize={7}>
                {candidates.length ? (
                  <div className={styles.benchmarkList}>
                    {candidates.map((draft) => (
                      <button key={draft.id} type="button" className={styles.benchmarkRow} onClick={() => onOpenDraft(draft)}>
                        <Group gap={6} wrap="nowrap">
                          <StatusBadge type="draft" value={draft.status} />
                          <StatusBadge type="gold" value={draft.gold_solve_status || 'missing'} />
                        </Group>
                        <strong>{compact(draft.question) || draft.run_id}</strong>
                        <span>{draft.assertion_type || 'manual'} · {draft.failure_category || '未分类'}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <EmptyPanel title="暂无候选" detail="从会话复盘沉淀用例后会显示在这里。" />
                )}
              </ScrollArea>
            </section>
          ) : null}
        </div>
      ) : null}

      {mode === 'runs' ? (
        <div className={styles.benchmarkRunsPage}>
          <ScrollArea className={styles.runsHistoryPane} type="hover" scrollbarSize={7}>
            <BenchmarkReportsPanel benchmark={benchmark} />
          </ScrollArea>
          <ScrollArea className={styles.runInspectorPane} type="hover" scrollbarSize={7}>
            <Stack className={styles.runInspectorContent} gap={12}>
              <section className={styles.runInspectorHeader}>
                <div>
                  <h3>运行详情</h3>
                  <p>当前用例的生成、执行结果和诊断固定在这里。</p>
                </div>
                <Group gap={6}>
                  <Badge size="xs" variant="light" color={materializeResult ? 'teal' : 'gray'}>Task {materializeResult ? '已生成' : '待生成'}</Badge>
                  <Badge size="xs" variant="light" color={runResult ? 'teal' : 'gray'}>Run {runResult ? '已执行' : '待执行'}</Badge>
                </Group>
              </section>
              <div className={styles.runInspectorStack}>
                {materializeResult ? <MaterializeResultPanel result={materializeResult} onCopyCommand={onCopyCommand} /> : null}
                {runResult ? <BenchmarkRunResultPanel result={runResult} onCopyCommand={onCopyCommand} /> : null}
                {!materializeResult && !runResult ? (
                  <section className={`${styles.section} ${styles.runInspectorEmpty}`}>
                    <h3>等待运行</h3>
                    <p>从用例库生成 task 或运行用例后，这里会显示报告路径、断言结果和 Trace 诊断。</p>
                  </section>
                ) : null}
              </div>
              <BenchmarkTaskArtifactsPanel benchmark={benchmark} />
            </Stack>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  )
}
