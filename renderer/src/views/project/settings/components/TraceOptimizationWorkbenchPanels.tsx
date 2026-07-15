import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Group, ScrollArea, SegmentedControl, Select, Textarea } from '@mantine/core'
import { IconDownload, IconPlayerPlay, IconPlus, IconSend, IconTrash, IconUpload } from '@tabler/icons-react'
import type {
  AgentTraceRun,
  AgentTraceSpan,
  TraceBenchmarkMaterializeResult,
  TraceBenchmarkNormalizeResult,
  TraceBenchmarkOverview,
  TraceBenchmarkRunResult,
  TraceEvalDraft,
  TraceFailureDiagnosis,
  TraceGoldSolve,
  TraceOptimizationAttempt,
  TraceOptimizationAttemptStatus,
  TraceOptimizationSummary,
  TraceTuningProposal,
  TraceReview
} from '@/api/yiw'
import { Waterfall } from '@/layout/workstation/WorkstationTraceWaterfall'
import { formatDuration, spanKey, statusColor, statusLabel, userQuestionText } from '@/layout/workstation/WorkstationTraceLogic'
import { DraftDetailPanel, ReviewDetailPanel } from './TraceOptimizationDetailPanels'
import { TraceOptimizationBenchmarkWorkspace } from './TraceOptimizationBenchmarkWorkspace'
import { EmptyPanel, StatusBadge, compact, timeText } from './TraceOptimizationSettings.shared'
import shellStyles from './TraceOptimizationTunerShell.module.scss'

type TraceOptimizationBuildSource = 'sessions' | 'drafts' | 'import'
type EditableGoldStatus = Extract<TraceGoldSolve['status'], 'drafted' | 'verified' | 'rejected'>
type TraceDebuggerObservation = NonNullable<NonNullable<TraceFailureDiagnosis['trace_debugger']>['observations']>[number]

const SAMPLE_ASSERTION_OPTIONS = [
  { value: 'text_contains', label: '文本' },
  { value: 'number_approx', label: '数值' },
  { value: 'table_shape', label: '表格' },
  { value: 'sql_result', label: 'SQL 结果' },
  { value: 'llm_judge', label: 'LLM 判分' },
  { value: 'manual', label: '人工复核' }
]

const blankSampleDraft = () => ({
  question: '',
  expectedAnswer: '',
  assertionType: 'text_contains',
  tuningNotes: ''
})

type ManualDraftPayload = ReturnType<typeof blankSampleDraft>

const asRecord = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null

const firstText = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'string' && compact(value)) return compact(value)
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

const spanMatchesId = (span: AgentTraceSpan, spanId: string) => {
  const needle = compact(spanId)
  if (!needle) return false
  return [spanKey(span), span.id, span.externalSpanId].some((value) => compact(value) === needle)
}

const findSpanInRun = (run: AgentTraceRun, spanId: string) =>
  (run.trace?.spans || []).find((span) => spanMatchesId(span, spanId)) || null

const findRunForSpan = (runs: AgentTraceRun[], spanId: string) =>
  runs.find((run) => Boolean(findSpanInRun(run, spanId))) || null

const debuggerObservationSpanId = (item: TraceDebuggerObservation) => {
  const action = asRecord(item.action)
  const result = asRecord(item.result)
  return firstText(action?.span_id, action?.spanId, result?.span_id, result?.spanId, result?.externalSpanId, result?.id)
}

const debuggerObservationLabel = (item: TraceDebuggerObservation) => {
  const action = asRecord(item.action)
  const actionName = firstText(action?.type, action?.name, action?.tool) || 'trace'
  const target = debuggerObservationSpanId(item) || firstText(action?.query)
  return target ? `${actionName} · ${target}` : actionName
}

interface BenchmarkWorkspaceSharedProps {
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
  onInputChange: (value: string) => void
  onFormatChange: (value: string) => void
  onNormalize: () => void
  onNormalizeFolder: () => void
  onCopyNormalized: () => void
  onImport: () => void
  onRunReady: () => void
  onMaterialize: (item: any) => void
  onRun: (item: any) => void
  onCopyCommand: (command: string) => void
  onOpenDraft: (draft: TraceEvalDraft) => void
}

interface SetupPanelProps {
  buildSource: TraceOptimizationBuildSource
  reviews: TraceReview[]
  drafts: TraceEvalDraft[]
  selectedReview: TraceReview | null
  selectedDraft: TraceEvalDraft | null
  draftDetail: TraceEvalDraft | null
  attempts: TraceOptimizationAttempt[]
  diagnosis: TraceFailureDiagnosis | null
  saving: boolean
  goldGenerating: boolean
  diagnosing: boolean
  proposalGenerating: boolean
  attemptSaving: boolean
  tuningProposal: TraceTuningProposal | null
  expectedBehavior: string
  draftQuestion: string
  expectedAnswer: string
  assertionType: string
  tagsText: string
  failureCategory: string
  tuningNotes: string
  goldIntent: string
  goldSources: string
  goldMetric: string
  goldSteps: string
  goldSql: string
  goldFinal: string
  goldDiff: string
  attemptStatus: TraceOptimizationAttemptStatus
  attemptHypothesis: string
  attemptChangeSummary: string
  attemptNotes: string
  benchmarkWorkspaceProps: BenchmarkWorkspaceSharedProps
  onBuildSourceChange: (value: TraceOptimizationBuildSource) => void
  onSelectReview: (reviewId: string) => void
  onSelectDraft: (draftId: string) => void
  onCreateDraft: (review: TraceReview) => void
  onCreateManualDraft: (payload: ManualDraftPayload) => Promise<void> | void
  onOpenImport: () => void
  onExportTemplate: () => void
  onDraftQuestionChange: (value: string) => void
  onOpenDraft: (draftId: string) => void
  onExpectedBehaviorChange: (value: string) => void
  onExpectedAnswerChange: (value: string) => void
  onAssertionTypeChange: (value: string) => void
  onTagsTextChange: (value: string) => void
  onFailureCategoryChange: (value: string) => void
  onTuningNotesChange: (value: string) => void
  onGoldIntentChange: (value: string) => void
  onGoldSourcesChange: (value: string) => void
  onGoldMetricChange: (value: string) => void
  onGoldStepsChange: (value: string) => void
  onGoldSqlChange: (value: string) => void
  onGoldFinalChange: (value: string) => void
  onGoldDiffChange: (value: string) => void
  onAttemptStatusChange: (status: TraceOptimizationAttemptStatus) => void
  onAttemptHypothesisChange: (value: string) => void
  onAttemptChangeSummaryChange: (value: string) => void
  onAttemptNotesChange: (value: string) => void
  onSaveDraft: () => void
  onGenerateGold: () => void
  onDiagnoseDraft: () => void
  onGenerateProposal: () => void
  onSaveGold: (status: EditableGoldStatus) => void
  onSaveAttempt: () => void
  onUpdateAttemptStatus: (attempt: TraceOptimizationAttempt, status: TraceOptimizationAttemptStatus) => void
}

interface RunPanelProps {
  benchmarkBatchRunning: boolean
  benchmarkRunningId: string
  operatorApplyMode: 'append_context' | 'pause_and_apply'
  operatorNote: string
  operatorSaving: boolean
  diagnosis: TraceFailureDiagnosis | null
  traceRuns: AgentTraceRun[]
  loopEvents: Array<{ key: string; tone: string; title: string; detail: string }>
  onRunReady: () => void
  onOperatorApplyModeChange: (value: 'append_context' | 'pause_and_apply') => void
  onOperatorNoteChange: (value: string) => void
  onSaveOperatorNote: () => void
}

interface ReviewPanelProps {
  summary: TraceOptimizationSummary | null
  attempts: TraceOptimizationAttempt[]
  drafts: TraceEvalDraft[]
  benchmark: TraceBenchmarkOverview | null
  onOpenDraft: (draftId: string) => void
}

export function TraceOptimizationSetupPanel({
  buildSource,
  reviews,
  drafts,
  selectedReview,
  selectedDraft,
  draftDetail,
  attempts,
  diagnosis,
  saving,
  goldGenerating,
  diagnosing,
  proposalGenerating,
  attemptSaving,
  tuningProposal,
  expectedBehavior,
  draftQuestion,
  expectedAnswer,
  assertionType,
  tagsText,
  failureCategory,
  tuningNotes,
  goldIntent,
  goldSources,
  goldMetric,
  goldSteps,
  goldSql,
  goldFinal,
  goldDiff,
  attemptStatus,
  attemptHypothesis,
  attemptChangeSummary,
  attemptNotes,
  benchmarkWorkspaceProps,
  onBuildSourceChange,
  onSelectReview,
  onSelectDraft,
  onCreateDraft,
  onCreateManualDraft,
  onOpenImport,
  onExportTemplate,
  onDraftQuestionChange,
  onOpenDraft,
  onExpectedBehaviorChange,
  onExpectedAnswerChange,
  onAssertionTypeChange,
  onTagsTextChange,
  onFailureCategoryChange,
  onTuningNotesChange,
  onGoldIntentChange,
  onGoldSourcesChange,
  onGoldMetricChange,
  onGoldStepsChange,
  onGoldSqlChange,
  onGoldFinalChange,
  onGoldDiffChange,
  onAttemptStatusChange,
  onAttemptHypothesisChange,
  onAttemptChangeSummaryChange,
  onAttemptNotesChange,
  onSaveDraft,
  onGenerateGold,
  onDiagnoseDraft,
  onGenerateProposal,
  onSaveGold,
  onSaveAttempt,
  onUpdateAttemptStatus
}: SetupPanelProps) {
  const sourceCount = buildSource === 'sessions' ? reviews.length : buildSource === 'drafts' ? drafts.length : 0
  const sourceSwitch = (
    <div className={shellStyles.sourceBar}>
      <SegmentedControl
        size="xs"
        value={buildSource}
        onChange={(value) => onBuildSourceChange(value as TraceOptimizationBuildSource)}
        data={[
          { value: 'sessions', label: '会话复盘' },
          { value: 'drafts', label: '样本优化' },
          { value: 'import', label: '导入用例' }
        ]}
      />
      <Badge size="xs" variant="light" color="gray">
        {buildSource === 'import' ? `${benchmarkWorkspaceProps.importableCount} 待导入` : `${sourceCount} 条`}
      </Badge>
    </div>
  )

  if (buildSource === 'import') {
    return (
      <div className={shellStyles.setupStage}>
        {sourceSwitch}
        <div className={shellStyles.setupGrid}>
          <section className={`${shellStyles.workspaceSection} ${shellStyles.importBuildSection}`}>
            <div className={shellStyles.importBuildBody}>
              <TraceOptimizationBenchmarkWorkspace
                {...benchmarkWorkspaceProps}
                initialMode="import"
                availableModes={['import']}
                showToolbar={false}
                showCandidates={false}
              />
            </div>
          </section>
        </div>
      </div>
    )
  }

  if (buildSource === 'drafts') {
    return (
      <div className={shellStyles.setupStage}>
        <TraceOptimizationSamplePanel
          drafts={drafts}
          selectedDraft={selectedDraft}
          draftDetail={draftDetail}
          saving={saving}
          draftQuestion={draftQuestion}
          expectedAnswer={expectedAnswer}
          assertionType={assertionType}
          tuningNotes={tuningNotes}
          onSelectDraft={onSelectDraft}
          onDraftQuestionChange={onDraftQuestionChange}
          onExpectedAnswerChange={onExpectedAnswerChange}
          onAssertionTypeChange={onAssertionTypeChange}
          onTuningNotesChange={onTuningNotesChange}
          onCreateManualDraft={onCreateManualDraft}
          onSaveDraft={onSaveDraft}
          onOpenImport={onOpenImport}
          onExportTemplate={onExportTemplate}
        />
      </div>
    )
  }

  return (
    <div className={shellStyles.setupStage}>
      {sourceSwitch}
      <div className={shellStyles.setupGrid}>
        <aside className={shellStyles.buildSidebar}>
          <div className={shellStyles.buildListHeader}>
            <span>{buildSource === 'sessions' ? '会话复盘' : '样本列表'}</span>
            <Badge size="xs" variant="light" color="gray">{sourceCount}</Badge>
          </div>

          <ScrollArea className={shellStyles.buildListScroll} type="hover" scrollbarSize={7}>
            <div className={shellStyles.savedSamples}>
              {buildSource === 'sessions' ? (
                reviews.length ? reviews.map((review) => (
                  <button
                    key={review.id}
                    type="button"
                    className={`${shellStyles.savedItemButton} ${selectedReview?.id === review.id ? shellStyles.savedItemActive : ''}`}
                    onClick={() => onSelectReview(review.id)}
                  >
                    <StatusBadge type="review" value={review.status} />
                    <div>
                      <div className={shellStyles.savedQ}>{compact(review.question) || review.run_id}</div>
                      <div className={shellStyles.savedGold}>
                        {review.reason_code || '未分类'} · {review.draft ? '已有用例草稿' : '未沉淀'} · {timeText(review.updated_at)}
                      </div>
                    </div>
                  </button>
                )) : (
                  <EmptyPanel title="还没有复盘记录" detail="从会话或 Trace 详情中标注问题轮次后，会出现在这里。" />
                )
              ) : (
                drafts.length ? drafts.map((draft) => (
                  <button
                    key={draft.id}
                    type="button"
                    className={`${shellStyles.savedItemButton} ${selectedDraft?.id === draft.id ? shellStyles.savedItemActive : ''}`}
                    onClick={() => onSelectDraft(draft.id)}
                  >
                    <StatusBadge type="draft" value={draft.status} />
                    <div>
                      <div className={shellStyles.savedQ}>{compact(draft.question) || draft.run_id}</div>
                      <div className={shellStyles.savedGold}>
                        标准答案：{compact(draft.expected_answer) || draft.assertion_type || 'manual'}
                      </div>
                      <div className={shellStyles.savedGold}>
                        参考解法：{draft.gold_solve_status || 'missing'} · {timeText(draft.updated_at)}
                      </div>
                    </div>
                  </button>
                )) : (
                  <EmptyPanel title="还没有样本" detail="从会话复盘沉淀问题，或导入测试集后，会出现在这里。" />
                )
              )}
            </div>
          </ScrollArea>
        </aside>

        <section className={shellStyles.buildDetailPane}>
          {buildSource === 'sessions' ? (
            <ReviewDetailPanel
              review={selectedReview}
              saving={saving}
              onCreateDraft={onCreateDraft}
              onOpenDraft={onOpenDraft}
            />
          ) : (
            <DraftDetailPanel
              draftDetail={draftDetail}
              attempts={attempts}
              diagnosis={diagnosis}
              saving={saving}
              goldGenerating={goldGenerating}
              diagnosing={diagnosing}
              proposalGenerating={proposalGenerating}
              attemptSaving={attemptSaving}
              tuningProposal={tuningProposal}
              expectedBehavior={expectedBehavior}
              expectedAnswer={expectedAnswer}
              assertionType={assertionType}
              tagsText={tagsText}
              failureCategory={failureCategory}
              tuningNotes={tuningNotes}
              goldIntent={goldIntent}
              goldSources={goldSources}
              goldMetric={goldMetric}
              goldSteps={goldSteps}
              goldSql={goldSql}
              goldFinal={goldFinal}
              goldDiff={goldDiff}
              attemptStatus={attemptStatus}
              attemptHypothesis={attemptHypothesis}
              attemptChangeSummary={attemptChangeSummary}
              attemptNotes={attemptNotes}
              onExpectedBehaviorChange={onExpectedBehaviorChange}
              onExpectedAnswerChange={onExpectedAnswerChange}
              onAssertionTypeChange={onAssertionTypeChange}
              onTagsTextChange={onTagsTextChange}
              onFailureCategoryChange={onFailureCategoryChange}
              onTuningNotesChange={onTuningNotesChange}
              onGoldIntentChange={onGoldIntentChange}
              onGoldSourcesChange={onGoldSourcesChange}
              onGoldMetricChange={onGoldMetricChange}
              onGoldStepsChange={onGoldStepsChange}
              onGoldSqlChange={onGoldSqlChange}
              onGoldFinalChange={onGoldFinalChange}
              onGoldDiffChange={onGoldDiffChange}
              onAttemptStatusChange={onAttemptStatusChange}
              onAttemptHypothesisChange={onAttemptHypothesisChange}
              onAttemptChangeSummaryChange={onAttemptChangeSummaryChange}
              onAttemptNotesChange={onAttemptNotesChange}
              onSaveDraft={onSaveDraft}
              onGenerateGold={onGenerateGold}
              onDiagnoseDraft={onDiagnoseDraft}
              onGenerateProposal={onGenerateProposal}
              onSaveGold={onSaveGold}
              onSaveAttempt={onSaveAttempt}
              onUpdateAttemptStatus={onUpdateAttemptStatus}
            />
          )}
        </section>
      </div>
    </div>
  )
}

function TraceOptimizationSamplePanel({
  drafts,
  selectedDraft,
  draftDetail,
  saving,
  draftQuestion,
  expectedAnswer,
  assertionType,
  tuningNotes,
  onSelectDraft,
  onDraftQuestionChange,
  onExpectedAnswerChange,
  onAssertionTypeChange,
  onTuningNotesChange,
  onCreateManualDraft,
  onSaveDraft,
  onOpenImport,
  onExportTemplate
}: {
  drafts: TraceEvalDraft[]
  selectedDraft: TraceEvalDraft | null
  draftDetail: TraceEvalDraft | null
  saving: boolean
  draftQuestion: string
  expectedAnswer: string
  assertionType: string
  tuningNotes: string
  onSelectDraft: (draftId: string) => void
  onDraftQuestionChange: (value: string) => void
  onExpectedAnswerChange: (value: string) => void
  onAssertionTypeChange: (value: string) => void
  onTuningNotesChange: (value: string) => void
  onCreateManualDraft: (payload: ManualDraftPayload) => Promise<void> | void
  onSaveDraft: () => void
  onOpenImport: () => void
  onExportTemplate: () => void
}) {
  const [newSampleOpen, setNewSampleOpen] = useState(false)
  const [newSample, setNewSample] = useState(blankSampleDraft)

  useEffect(() => {
    if (draftDetail?.id) setNewSampleOpen(false)
  }, [draftDetail?.id])

  const editingDraft = newSampleOpen ? null : draftDetail
  const hasEditor = newSampleOpen || Boolean(editingDraft)
  const editorQuestion = newSampleOpen ? newSample.question : draftQuestion
  const editorAnswer = newSampleOpen ? newSample.expectedAnswer : expectedAnswer
  const editorAssertionType = newSampleOpen ? newSample.assertionType : assertionType
  const editorNotes = newSampleOpen ? newSample.tuningNotes : tuningNotes

  const updateNewSample = (patch: Partial<ManualDraftPayload>) => {
    setNewSample((current) => ({ ...current, ...patch }))
  }

  const updateQuestion = (value: string) => {
    if (newSampleOpen) updateNewSample({ question: value })
    else onDraftQuestionChange(value)
  }

  const updateAnswer = (value: string) => {
    if (newSampleOpen) updateNewSample({ expectedAnswer: value })
    else onExpectedAnswerChange(value)
  }

  const updateAssertionType = (value: string) => {
    if (newSampleOpen) updateNewSample({ assertionType: value })
    else onAssertionTypeChange(value)
  }

  const updateNotes = (value: string) => {
    if (newSampleOpen) updateNewSample({ tuningNotes: value })
    else onTuningNotesChange(value)
  }

  const startNewSample = () => {
    setNewSample(blankSampleDraft())
    setNewSampleOpen(true)
  }

  const clearEditor = () => {
    if (newSampleOpen) {
      setNewSample(blankSampleDraft())
      return
    }
    if (draftDetail) {
      onDraftQuestionChange(draftDetail.question || '')
      onExpectedAnswerChange(draftDetail.expected_answer || '')
      onAssertionTypeChange(draftDetail.assertion_type || 'manual')
      onTuningNotesChange(draftDetail.tuning_notes || '')
    }
  }

  const closeNewSample = () => {
    setNewSample(blankSampleDraft())
    setNewSampleOpen(false)
  }

  const saveEditor = async () => {
    if (newSampleOpen) {
      await onCreateManualDraft(newSample)
      setNewSample(blankSampleDraft())
      setNewSampleOpen(false)
      return
    }
    onSaveDraft()
  }

  const selectDraft = (draftId: string) => {
    setNewSampleOpen(false)
    onSelectDraft(draftId)
  }

  return (
    <section className={`${shellStyles.workspaceSection} ${shellStyles.sampleWorkspace}`}>
      <div className={shellStyles.sectionHead}>
        <div>
          <h3>问答样本</h3>
          <p>样本决定优化目标，建议覆盖高频问题和容易出错的问题。</p>
        </div>
        <div className={shellStyles.sectionActions}>
          <Button size="xs" variant="subtle" color="gray" leftSection={<IconUpload size={14} />} onClick={onOpenImport}>
            导入测试集
          </Button>
          <Button size="xs" variant="subtle" color="gray" leftSection={<IconDownload size={14} />} onClick={onExportTemplate}>
            导出格式
          </Button>
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={startNewSample}>
            添加问题
          </Button>
        </div>
      </div>

      {drafts.length ? (
        <div className={shellStyles.savedSampleStrip}>
          {drafts.slice(0, 8).map((draft, index) => (
            <button
              key={draft.id}
              type="button"
              className={`${shellStyles.savedSampleRow} ${!newSampleOpen && selectedDraft?.id === draft.id ? shellStyles.savedSampleRowActive : ''}`}
              onClick={() => selectDraft(draft.id)}
            >
              <StatusBadge type="draft" value={draft.status} />
              <div>
                <div className={shellStyles.savedQ}>{compact(draft.question) || `样本 ${index + 1}`}</div>
                <div className={shellStyles.savedGold}>标准答案：{compact(draft.expected_answer) || draft.assertion_type || '未填写'}</div>
                {draft.gold_solve_status ? <div className={shellStyles.savedGold}>参考解：{draft.gold_solve_status}</div> : null}
              </div>
            </button>
          ))}
        </div>
      ) : !hasEditor ? (
        <div className={shellStyles.sampleEmpty}>
          <EmptyPanel title="还没有样本" detail="添加问题，或从测试集导入一批可回归样本。" />
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={startNewSample}>添加问题</Button>
        </div>
      ) : null}

      {hasEditor ? (
        <div className={shellStyles.sampleEditor}>
          <div className={shellStyles.sampleCardHead}>
            <div className={shellStyles.sampleCardMainline}>
              <span className={shellStyles.sampleNum}>#1</span>
              {editingDraft ? <StatusBadge type="draft" value={editingDraft.status} /> : <Badge size="xs" variant="light" color="gray">草稿</Badge>}
            </div>
            <Button
              size="xs"
              variant="light"
              color="red"
              leftSection={<IconTrash size={13} />}
              onClick={newSampleOpen ? closeNewSample : clearEditor}
            >
              {newSampleOpen ? '删除' : '重置'}
            </Button>
          </div>

          <Textarea
            minRows={2}
            autosize
            value={editorQuestion}
            placeholder="输入自然语言问题"
            onChange={(event) => updateQuestion(event.currentTarget.value)}
          />

          <div className={`${shellStyles.answerBlock} ${shellStyles.variantsBlock}`}>
            <div className={shellStyles.variantTitleRow}>
              <label>可接受答案</label>
              <Button size="xs" onClick={() => updateAnswer(editorAnswer ? `${editorAnswer}\n` : '')}>添加答案</Button>
            </div>
            <div className={shellStyles.variantCard}>
              <div className={shellStyles.variantHead}>
                <span>答案 1</span>
                <Select
                  size="xs"
                  className={shellStyles.variantTypeSelect}
                  data={SAMPLE_ASSERTION_OPTIONS}
                  value={editorAssertionType || 'text_contains'}
                  allowDeselect={false}
                  onChange={(value) => updateAssertionType(value || 'text_contains')}
                />
                <Button size="xs" variant="light" color="red" onClick={() => updateAnswer('')}>删除</Button>
              </div>
              <Textarea
                minRows={1}
                autosize
                value={editorAnswer}
                placeholder={editorAssertionType === 'number_approx' ? '标准数值' : editorAssertionType === 'table_shape' ? '表格答案' : '文本答案'}
                onChange={(event) => updateAnswer(event.currentTarget.value)}
              />
            </div>
          </div>

          <div className={shellStyles.answerBlock}>
            <label>参考解法/口径说明（可选）</label>
            <Textarea
              minRows={3}
              autosize
              value={editorNotes}
              placeholder="可粘贴查询语句、推导过程、业务口径或容易踩错的点。只帮助优化分析，不用于判定答案是否正确。"
              onChange={(event) => updateNotes(event.currentTarget.value)}
            />
          </div>

          <div className={shellStyles.stickyActions}>
            <Button size="xs" variant="default" onClick={clearEditor}>清空草稿</Button>
            <Button size="xs" loading={saving} disabled={!compact(editorQuestion)} onClick={() => void saveEditor()}>
              保存 1 个样本
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export function TraceOptimizationRunPanel({
  benchmarkBatchRunning,
  benchmarkRunningId,
  operatorApplyMode,
  operatorNote,
  operatorSaving,
  diagnosis,
  traceRuns,
  loopEvents,
  onRunReady,
  onOperatorApplyModeChange,
  onOperatorNoteChange,
  onSaveOperatorNote
}: RunPanelProps) {
  return (
    <div className={shellStyles.runLayout}>
      <section className={shellStyles.runConsole}>
        <div className={shellStyles.runHeader}>
          <div>
            <h3>优化过程</h3>
            <p>{benchmarkBatchRunning || benchmarkRunningId ? '正在查看运行进度，可在下方补充说明。' : '下方用例库可批量回归 Ready 用例，失败项沉淀为后续调试依据。'}</p>
          </div>
          <Group className={shellStyles.runActions} gap={8} wrap="nowrap">
            <Button
              size="xs"
              leftSection={<IconPlayerPlay size={14} />}
              loading={benchmarkBatchRunning}
              disabled={Boolean(benchmarkRunningId)}
              onClick={onRunReady}
            >
              运行 Ready
            </Button>
          </Group>
        </div>

        <div className={`${shellStyles.currentStep} ${benchmarkBatchRunning || benchmarkRunningId ? shellStyles.currentStepActive : ''}`}>
          <span>{benchmarkBatchRunning ? '批量运行 Ready 用例' : benchmarkRunningId ? `运行 ${benchmarkRunningId}` : '尚未运行'}</span>
        </div>

        <TraceOptimizationTraceDrilldown traceRuns={traceRuns} loopEvents={loopEvents} diagnosis={diagnosis} />

        <div className={shellStyles.operatorInput}>
          <div className={shellStyles.inputHead}>
            <strong>补充说明</strong>
            <span>内容会追加到选中样本</span>
          </div>
          <SegmentedControl
            className={shellStyles.operatorMode}
            size="xs"
            value={operatorApplyMode}
            onChange={(value) => onOperatorApplyModeChange(value as 'append_context' | 'pause_and_apply')}
            data={[
              { value: 'append_context', label: '后续参考' },
              { value: 'pause_and_apply', label: '暂停先处理' }
            ]}
          />
          <Textarea
            minRows={4}
            autosize
            value={operatorNote}
            placeholder="补充字段含义、业务口径、错误归因，或说明应该重跑哪类题。"
            onChange={(event) => onOperatorNoteChange(event.currentTarget.value)}
          />
          <Group className={shellStyles.inputActions} justify="flex-end" gap={8}>
            <Button size="xs" leftSection={<IconSend size={14} />} loading={operatorSaving} disabled={!compact(operatorNote)} onClick={onSaveOperatorNote}>补充并保存</Button>
          </Group>
        </div>

      </section>
    </div>
  )
}

function TraceOptimizationTraceDrilldown({
  traceRuns,
  loopEvents,
  diagnosis
}: {
  traceRuns: AgentTraceRun[]
  loopEvents: Array<{ key: string; tone: string; title: string; detail: string }>
  diagnosis: TraceFailureDiagnosis | null
}) {
  const runsWithTrace = useMemo(
    () => (traceRuns || []).filter((run) => Boolean(run.trace?.spans?.length)),
    [traceRuns]
  )
  const [activeRunId, setActiveRunId] = useState('')
  const [selectedSpanIds, setSelectedSpanIds] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!runsWithTrace.length) {
      setActiveRunId('')
      return
    }
    if (!activeRunId || !runsWithTrace.some((run) => run.runId === activeRunId)) {
      setActiveRunId(runsWithTrace[runsWithTrace.length - 1]?.runId || runsWithTrace[0]?.runId || '')
    }
  }, [activeRunId, runsWithTrace])

  const activeRun = runsWithTrace.find((run) => run.runId === activeRunId) || runsWithTrace[runsWithTrace.length - 1] || null
  const selectSpan = (runId: string, span: AgentTraceSpan | null) => {
    setSelectedSpanIds((current) => ({ ...current, [runId]: span?.externalSpanId || span?.id || '' }))
  }
  const selectDiagnosisSpan = (spanId: string) => {
    const targetRun = findRunForSpan(runsWithTrace, spanId)
    const targetSpan = targetRun ? findSpanInRun(targetRun, spanId) : null
    if (!targetRun || !targetSpan) return
    setActiveRunId(targetRun.runId)
    selectSpan(targetRun.runId, targetSpan)
  }
  const runOptions = runsWithTrace.map((run, index) => {
    const questionNo = Number(run.question?.questionNo || 0)
    const question = userQuestionText(run)
    return {
      value: run.runId,
      label: `${questionNo ? `第 ${questionNo} 问` : `Trace ${index + 1}`} · ${question.slice(0, 42)}`
    }
  })

  return (
    <div className={shellStyles.traceDrilldown}>
      <div className={shellStyles.traceDrilldownHeader}>
        <div>
          <h4>Trace 下钻</h4>
          <p>点击火焰图中的 span 查看输入、输出、日志、属性和子调用；面包屑可逐层返回。</p>
        </div>
        <Group gap={8} wrap="nowrap">
          {activeRun?.trace ? (
            <>
              <Badge size="xs" variant="light" color={statusColor(activeRun.trace.status || activeRun.status)}>
                {statusLabel(activeRun.trace.status || activeRun.status)}
              </Badge>
              <Badge size="xs" variant="light" color="gray">
                {activeRun.trace.spanCount || activeRun.trace.spans.length} spans
              </Badge>
              <Badge size="xs" variant="light" color="gray">
                {formatDuration(activeRun.trace.durMs)}
              </Badge>
            </>
          ) : null}
          {runsWithTrace.length > 1 ? (
            <Select
              size="xs"
              w={240}
              data={runOptions}
              value={activeRun?.runId || ''}
              allowDeselect={false}
              onChange={(value) => setActiveRunId(value || '')}
            />
          ) : null}
        </Group>
      </div>

      {diagnosis ? (
        <TraceDiagnosisPathPanel
          diagnosis={diagnosis}
          runs={runsWithTrace}
          activeSpanId={activeRun ? selectedSpanIds[activeRun.runId] : ''}
          onSelectSpan={selectDiagnosisSpan}
        />
      ) : null}

      {activeRun ? (
        <ScrollArea className={shellStyles.traceWaterfallBody} type="hover" scrollbarSize={7}>
          <Waterfall
            run={activeRun}
            selectedSpanId={selectedSpanIds[activeRun.runId]}
            onSelectSpan={(span) => selectSpan(activeRun.runId, span)}
          />
        </ScrollArea>
      ) : (
        <div className={shellStyles.traceFallback}>
          <EmptyPanel title="暂无可下钻 Trace" detail="运行用例或选择有 Trace 的样本后，这里会展示火焰图和 span 详情。" />
          {loopEvents.length ? (
            <div className={shellStyles.loopStream}>
              {loopEvents.map((event) => (
                <div key={event.key} className={`${shellStyles.loopEvent} ${shellStyles[`loopEvent_${event.tone}`] || ''}`}>
                  <span className={shellStyles.eventMarker} />
                  <div>
                    <strong>{event.title}</strong>
                    <p>{event.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function TraceDiagnosisPathPanel({
  diagnosis,
  runs,
  activeSpanId,
  onSelectSpan
}: {
  diagnosis: TraceFailureDiagnosis
  runs: AgentTraceRun[]
  activeSpanId?: string
  onSelectSpan: (spanId: string) => void
}) {
  const evidencePath = (diagnosis.evidence_path || []).filter((item) => compact(item.span_id) || compact(item.observation))
  const observations = (diagnosis.trace_debugger?.observations || []).filter(Boolean)
  const hasPath = evidencePath.length > 0
  const hasObservations = observations.length > 0

  if (!hasPath && !hasObservations && !compact(diagnosis.summary)) return null

  return (
    <div className={shellStyles.diagnosisPathPanel}>
      <div className={shellStyles.diagnosisPathHeader}>
        <div>
          <h4>诊断证据</h4>
          <p>{compact(diagnosis.summary) || '已生成 Trace 诊断。点击 span 证据可定位到火焰图。'}</p>
        </div>
        <Group gap={6} wrap="nowrap">
          <Badge size="xs" variant="light" color="red">{diagnosis.failure_stage || 'unknown'}</Badge>
          <Badge size="xs" variant="light" color="gray">{Math.round((diagnosis.confidence || 0) * 100)}%</Badge>
          {diagnosis.trace_debugger?.rounds ? (
            <Badge size="xs" variant="light" color="grape">{diagnosis.trace_debugger.rounds} 轮下钻</Badge>
          ) : null}
        </Group>
      </div>

      {hasPath ? (
        <div className={shellStyles.diagnosisPathList}>
          {evidencePath.map((item, index) => {
            const matched = Boolean(item.span_id && findRunForSpan(runs, item.span_id))
            const active = Boolean(item.span_id && activeSpanId && compact(activeSpanId) === compact(item.span_id))
            return (
              <button
                key={`${item.span_id || 'evidence'}-${index}`}
                type="button"
                className={[
                  shellStyles.diagnosisPathItem,
                  active ? shellStyles.diagnosisPathItemActive : '',
                  !matched ? shellStyles.diagnosisPathItemMissing : ''
                ].filter(Boolean).join(' ')}
                disabled={!matched}
                onClick={() => item.span_id && onSelectSpan(item.span_id)}
              >
                <span className={shellStyles.pathIndex}>{index + 1}</span>
                <span className={shellStyles.pathMain}>
                  <strong>{compact(item.span_id) || '未绑定 span'}</strong>
                  <small>{compact(item.observation) || (matched ? '点击定位到火焰图' : '当前 Trace 中未匹配到这个 span')}</small>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}

      {hasObservations ? (
        <div className={shellStyles.diagnosisObservationList}>
          {observations.slice(-6).map((item, index) => {
            const spanId = debuggerObservationSpanId(item)
            const matched = Boolean(spanId && findRunForSpan(runs, spanId))
            return (
              <button
                key={`${item.round || 0}-${debuggerObservationLabel(item)}-${index}`}
                type="button"
                className={`${shellStyles.diagnosisObservation} ${!matched ? shellStyles.diagnosisObservationMuted : ''}`}
                disabled={!matched}
                onClick={() => spanId && onSelectSpan(spanId)}
              >
                <span>R{item.round || '-'}</span>
                <strong>{debuggerObservationLabel(item)}</strong>
                <small>{compact(item.observation) || (item.ok === false ? '未取到结果' : '已读取')}</small>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function TraceOptimizationReviewPanel({
  summary,
  attempts,
  drafts,
  benchmark,
  onOpenDraft
}: ReviewPanelProps) {
  const changes: Array<{
    key: string
    tag: string
    tagColor: string
    reason: string
    body: string
    meta: string
    onClick?: () => void
  }> = [
    ...attempts.map((attempt) => ({
      key: `attempt-${attempt.id}`,
      tag: attempt.status,
      tagColor: attempt.status === 'passed' ? 'teal' : attempt.status === 'failed' ? 'red' : attempt.status === 'blocked' ? 'yellow' : 'gray',
      reason: compact(attempt.hypothesis) || `调试轮次 #${attempt.attempt_index || 1}`,
      body: compact(attempt.change_summary || attempt.notes) || '暂无改动说明',
      meta: timeText(attempt.updated_at)
    })),
    ...drafts.slice(0, 8).map((draft) => ({
      key: `draft-${draft.id}`,
      tag: draft.gold_solve_status || 'missing',
      tagColor: draft.gold_solve_status === 'verified' ? 'teal' : draft.gold_solve_status === 'rejected' ? 'red' : 'yellow',
      reason: compact(draft.question) || draft.run_id,
      body: draft.failure_category || draft.assertion_type || 'manual',
      meta: '参考解状态',
      onClick: () => onOpenDraft(draft.id)
    })),
    ...(benchmark?.reports || []).slice(0, 8).map((report) => ({
      key: `report-${report.file}`,
      tag: report.status,
      tagColor: report.status === 'passed' ? 'teal' : report.status === 'failed' ? 'red' : 'yellow',
      reason: `通过 ${report.passed}/${report.total}`,
      body: report.file,
      meta: report.filter || report.run_id || timeText(report.updated_at)
    }))
  ]

  return (
    <section className={shellStyles.workspaceSection}>
      <div className={shellStyles.sectionHead}>
        <div>
          <h3>已更新内容</h3>
        </div>
        <Badge size="xs" variant="light" color="gray">{changes.length}</Badge>
      </div>

      {changes.length ? (
        <div className={shellStyles.changeList}>
          {changes.map((item) => (
            <article key={item.key} className={shellStyles.changeCard}>
              <div className={shellStyles.changeHead}>
                <Badge variant="light" color={item.tagColor}>{item.tag}</Badge>
                <span className={shellStyles.changeConf}>{item.meta}</span>
                {item.onClick ? <Button size="compact-xs" variant="subtle" color="gray" onClick={item.onClick}>查看</Button> : null}
              </div>
              <div className={shellStyles.changeReason}>{item.reason}</div>
              <div className={shellStyles.changeBody}>{item.body}</div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyPanel title="暂无更新记录" detail={`还有 ${summary?.gold_solves.unverified || 0} 条参考解待确认。`} />
      )}
    </section>
  )
}
