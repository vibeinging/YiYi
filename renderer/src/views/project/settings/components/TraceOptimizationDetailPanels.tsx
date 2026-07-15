import { Accordion, Badge, Button, Group, ScrollArea, Select, TextInput, Textarea } from '@mantine/core'
import type {
  TraceEvalDraft,
  TraceFailureDiagnosis,
  TraceGoldSolve,
  TraceOptimizationAttempt,
  TraceOptimizationAttemptStatus,
  TraceReview,
  TraceTuningProposal
} from '@/api/yiw'
import {
  ASSERTION_OPTIONS,
  ATTEMPT_COLOR,
  ATTEMPT_LABEL,
  ATTEMPT_STATUS_OPTIONS,
  EmptyPanel,
  ReadinessChecklist,
  StatusBadge,
  compact,
  readiness,
  timeText
} from './TraceOptimizationSettings.shared'
import styles from './TraceOptimizationDetailPanels.module.scss'

type EditableGoldStatus = Extract<TraceGoldSolve['status'], 'drafted' | 'verified' | 'rejected'>

interface ReviewDetailPanelProps {
  review: TraceReview | null
  saving: boolean
  onCreateDraft: (review: TraceReview) => void
  onOpenDraft: (draftId: string) => void
}

interface DraftDetailPanelProps {
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

function MetaCell({ label, value }: { label: string; value?: string | null }) {
  return (
    <span className={styles.metaCell}>
      <small>{label}</small>
      <strong title={value || undefined}>{compact(value) || '-'}</strong>
    </span>
  )
}

function DetailList({ title, items, empty }: { title: string; items?: string[]; empty: string }) {
  const values = (items || []).filter(Boolean)
  return (
    <div className={styles.detailList}>
      <strong>{title}</strong>
      {values.length ? values.map((item) => <span key={item}>{item}</span>) : <span>{empty}</span>}
    </div>
  )
}

export function ReviewDetailPanel({ review, saving, onCreateDraft, onOpenDraft }: ReviewDetailPanelProps) {
  if (!review) {
    return (
      <div className={styles.emptyDetail}>
        <EmptyPanel title="请选择一条会话复盘" detail="左侧列表为空时，请先在右侧工作台标注一轮回答。" />
        <div className={styles.emptyGuide}>
          <span>1. 标注会话中的问题轮次</span>
          <span>2. 在这里补齐期望行为</span>
          <span>3. 沉淀为用例并补参考解</span>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.reviewDetail}>
      <section className={styles.detailHero}>
        <div className={styles.heroMain}>
          <span className={styles.kicker}>用户问题</span>
          <h2>{compact(review.question) || '用户问题缺失'}</h2>
          {review.reason_text ? <p>{review.reason_text}</p> : null}
        </div>
        <Group gap={6} wrap="nowrap">
          <StatusBadge type="review" value={review.status} />
          {review.draft ? <StatusBadge type="draft" value={review.draft.status} /> : null}
        </Group>
      </section>

      <div className={styles.metaGrid}>
        <MetaCell label="来源 Run" value={review.run_id} />
        <MetaCell label="Session" value={review.session_id} />
        <MetaCell label="问题类型" value={review.reason_code || '未分类'} />
        <MetaCell label="更新时间" value={timeText(review.updated_at)} />
      </div>

      <section className={styles.compareGrid}>
        <div className={styles.comparePane}>
          <div className={styles.sectionTitle}>
            <span>当时回答</span>
            <small>Actual output snapshot</small>
          </div>
          <pre className={styles.detailPre}>{review.actual_output || '没有回答快照'}</pre>
        </div>
        <div className={styles.comparePane}>
          <div className={styles.sectionTitle}>
            <span>期望行为</span>
            <small>用于生成可回归样本</small>
          </div>
          <pre className={styles.detailPre}>{review.expected_behavior || '尚未填写 expected'}</pre>
        </div>
      </section>

      <div className={styles.actionBar}>
        <span>{review.draft ? '这条会话复盘已经沉淀为用例。' : '确认问题后沉淀为用例，继续补参考解和断言。'}</span>
        {review.draft ? (
          <Button size="xs" onClick={() => onOpenDraft(review.draft?.id || '')}>
            打开用例
          </Button>
        ) : (
          <Button size="xs" loading={saving} onClick={() => onCreateDraft(review)}>
            沉淀为用例
          </Button>
        )}
      </div>
    </div>
  )
}

export function DraftDetailPanel({
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
}: DraftDetailPanelProps) {
  if (!draftDetail) {
    return (
      <div className={styles.emptyDetail}>
        <EmptyPanel title="请选择一条用例" detail="从左侧选择构建中的用例后编辑 expected、参考解和调试轮次。" />
        <div className={styles.emptyGuide}>
          <span>1. 补齐答案契约</span>
          <span>2. 生成或人工确认参考解</span>
          <span>3. 记录调优 attempt 并回归</span>
        </div>
      </div>
    )
  }

  const canGenerateGold = Boolean(compact(expectedBehavior) || compact(expectedAnswer))
  const attemptSummary = attempts.length ? `${attempts.length} 轮` : '未开始'

  return (
    <div className={styles.draftDetail}>
      <ScrollArea className={styles.primaryPane} type="hover" scrollbarSize={7}>
        <div className={styles.primaryContent}>
          <section className={styles.sampleSummary}>
            <div className={styles.heroMain}>
              <span className={styles.kicker}>当前样本</span>
              <h2>{draftDetail.question || '用户问题缺失'}</h2>
              <p>{draftDetail.session_id || '-'} · {draftDetail.run_id}</p>
            </div>
            <div className={styles.sampleStateGrid}>
              <span>
                <small>用例状态</small>
                <StatusBadge type="draft" value={draftDetail.status} />
              </span>
              <span>
                <small>参考解</small>
                <StatusBadge type="gold" value={draftDetail.gold_solve?.status || 'missing'} />
              </span>
              <MetaCell label="断言方式" value={assertionType || draftDetail.assertion_type} />
              <MetaCell label="调试轮次" value={attemptSummary} />
            </div>
          </section>

          <section className={styles.editorSection}>
            <div className={styles.sectionTitle}>
              <span>样本契约</span>
              <small>定义问题、期望答案和断言方式，决定后续回归是否通过。</small>
            </div>
            <div className={styles.answerGrid}>
              <Textarea label="期望行为" minRows={4} autosize value={expectedBehavior} onChange={(event) => onExpectedBehaviorChange(event.currentTarget.value)} />
              <Textarea label="期望答案" minRows={4} autosize value={expectedAnswer} onChange={(event) => onExpectedAnswerChange(event.currentTarget.value)} />
              <Select label="断言方式" data={ASSERTION_OPTIONS} value={assertionType} onChange={(value) => onAssertionTypeChange(value || 'manual')} allowDeselect={false} />
              <TextInput label="失败分类" value={failureCategory} onChange={(event) => onFailureCategoryChange(event.currentTarget.value)} />
              <TextInput label="标签" value={tagsText} onChange={(event) => onTagsTextChange(event.currentTarget.value)} placeholder="kdd, sql, metric" />
              <Textarea
                className={styles.notesField}
                label="补充说明"
                description="选择或创建用例后，在这里记录业务口径、失败原因或下一步调优方向。"
                minRows={3}
                autosize
                value={tuningNotes}
                placeholder="例如：这题按自然年统计；答案顺序无关；失败原因可能是工具没有下钻到明细。"
                onChange={(event) => onTuningNotesChange(event.currentTarget.value)}
              />
            </div>
            <Group justify="flex-end" mt="sm">
              <Button size="xs" variant="default" loading={saving} onClick={onSaveDraft}>
                保存样本
              </Button>
            </Group>
          </section>

          <section className={styles.editorSection}>
            <div className={styles.sectionTitle}>
              <span>原始输出</span>
              <small>用于和期望答案对比。</small>
            </div>
            <pre className={styles.detailPre}>{draftDetail.actual_output || '没有输出快照'}</pre>
          </section>
        </div>
      </ScrollArea>

      <ScrollArea className={styles.railPane} type="hover" scrollbarSize={7}>
        <div className={styles.railContent}>
          <Accordion
            className={styles.railAccordion}
            variant="separated"
            chevronPosition="right"
            defaultValue="gold"
          >
            <Accordion.Item className={styles.railAccordionItem} value="gold">
              <Accordion.Control className={styles.railAccordionControl}>
                <div className={styles.railAccordionLabel}>
                  <span className={styles.railAccordionTitle}>参考解</span>
                  <StatusBadge type="gold" value={draftDetail.gold_solve?.status || 'missing'} />
                </div>
              </Accordion.Control>
              <Accordion.Panel className={styles.railAccordionPanel}>
                <div className={styles.evidenceSteps}>
                  <span className={compact(goldFinal || expectedAnswer) ? styles.evidenceStepDone : ''}>1. 正确答案</span>
                  <span className={draftDetail.gold_solve?.status === 'verified' ? styles.evidenceStepDone : ''}>2. 参考解确认</span>
                  <span className={diagnosis ? styles.evidenceStepDone : ''}>3. Trace 诊断</span>
                </div>
                <div className={styles.railForm}>
                  <Textarea label="正确意图" minRows={2} autosize value={goldIntent} onChange={(event) => onGoldIntentChange(event.currentTarget.value)} />
                  <TextInput label="数据源/表/字段" value={goldSources} onChange={(event) => onGoldSourcesChange(event.currentTarget.value)} placeholder="orders, customers" />
                  <TextInput label="指标口径" value={goldMetric} onChange={(event) => onGoldMetricChange(event.currentTarget.value)} />
                  <Textarea label="计算步骤" minRows={4} autosize value={goldSteps} onChange={(event) => onGoldStepsChange(event.currentTarget.value)} />
                  <Textarea label="参考 SQL" minRows={5} autosize value={goldSql} onChange={(event) => onGoldSqlChange(event.currentTarget.value)} />
                  <Textarea label="最终答案口径" minRows={2} autosize value={goldFinal} onChange={(event) => onGoldFinalChange(event.currentTarget.value)} />
                  <Textarea label="与 Trace 差异" minRows={2} autosize value={goldDiff} onChange={(event) => onGoldDiffChange(event.currentTarget.value)} />
                </div>
                <div className={styles.buttonRow}>
                  <Button size="xs" variant="default" loading={goldGenerating} disabled={!canGenerateGold} onClick={onGenerateGold}>生成参考解</Button>
                  <Button size="xs" variant="default" loading={saving} onClick={() => onSaveGold('drafted')}>保存</Button>
                  <Button size="xs" color="teal" loading={saving} onClick={() => onSaveGold('verified')}>确认</Button>
                </div>
              </Accordion.Panel>
            </Accordion.Item>

            {diagnosis ? (
              <Accordion.Item className={styles.railAccordionItem} value="diagnosis">
                <Accordion.Control className={styles.railAccordionControl}>
                  <div className={styles.railAccordionLabel}>
                    <span className={styles.railAccordionTitle}>Trace 诊断</span>
                    <Badge size="xs" variant="light" color="red">{diagnosis.failure_stage || 'unknown'}</Badge>
                  </div>
                </Accordion.Control>
                <Accordion.Panel className={styles.railAccordionPanel}>
                  <div className={styles.diagnosisHead}>{compact(diagnosis.summary) || '已生成诊断结果'}</div>
                  <div className={styles.diagnosisMatrix}>
                    <DetailList title="证据" items={(diagnosis.evidence || []).map((item) => `${item.source}: ${item.observation}`)} empty="暂无证据" />
                    <DetailList title="证据路径" items={(diagnosis.evidence_path || []).map((item) => `${item.span_id}: ${item.observation}`)} empty="暂无路径" />
                    <DetailList title="下钻记录" items={(diagnosis.trace_debugger?.observations || []).map((item) => {
                      const action = item.action || {}
                      return `R${item.round || '-'} ${action.type || 'trace'} ${action.span_id || action.query || ''}: ${item.observation || ''}`
                    })} empty="暂无下钻" />
                    <DetailList title="Trace 缺口" items={diagnosis.trace_gaps} empty="暂无缺口" />
                    <DetailList title="建议动作" items={diagnosis.recommended_actions} empty="暂无建议" />
                    <DetailList title="回归重点" items={diagnosis.next_benchmark_focus} empty="暂无重点" />
                  </div>
                  <div className={styles.buttonRow}>
                    <Button size="xs" variant="default" loading={diagnosing} disabled={!canGenerateGold} onClick={onDiagnoseDraft}>重新诊断</Button>
                    <Button size="xs" variant="default" loading={proposalGenerating} onClick={onGenerateProposal}>生成调优方案</Button>
                  </div>
                </Accordion.Panel>
              </Accordion.Item>
            ) : (
              <Accordion.Item className={styles.railAccordionItem} value="diagnosis">
                <Accordion.Control className={styles.railAccordionControl}>
                  <div className={styles.railAccordionLabel}>
                    <span className={styles.railAccordionTitle}>Trace 诊断</span>
                    <Badge size="xs" variant="light" color="gray">未生成</Badge>
                  </div>
                </Accordion.Control>
                <Accordion.Panel className={styles.railAccordionPanel}>
                  <div className={styles.diagnosisHead}>先确认参考解，再生成诊断定位失败点。</div>
                  <div className={styles.buttonRow}>
                    <Button size="xs" variant="default" loading={diagnosing} disabled={!canGenerateGold} onClick={onDiagnoseDraft}>诊断 Trace</Button>
                  </div>
                </Accordion.Panel>
              </Accordion.Item>
            )}

            <Accordion.Item className={styles.railAccordionItem} value="proposal">
              <Accordion.Control className={styles.railAccordionControl}>
                <div className={styles.railAccordionLabel}>
                  <span className={styles.railAccordionTitle}>调优方案</span>
                  {tuningProposal ? (
                    <Badge size="xs" variant="light" color="yiw">{tuningProposal.change_type || '已生成'}</Badge>
                  ) : (
                    <Badge size="xs" variant="light" color="gray">未生成</Badge>
                  )}
                </div>
              </Accordion.Control>
              {tuningProposal ? (
                <Accordion.Panel className={styles.railAccordionPanel}>
                  <div className={styles.diagnosisHead}>{compact(tuningProposal.proposal) || '已生成下一轮调优方案，确认后可保存为调试记录。'}</div>
                  <div className={styles.diagnosisMatrix}>
                    <DetailList title="目标" items={[tuningProposal.target, tuningProposal.hypothesis].filter(Boolean)} empty="暂无目标" />
                    <DetailList title="原因" items={[tuningProposal.why].filter(Boolean)} empty="暂无原因" />
                    <DetailList title="风险" items={[tuningProposal.risk].filter(Boolean)} empty="暂无风险" />
                    <DetailList title="验证计划" items={[tuningProposal.validation_plan].filter(Boolean)} empty="暂无验证计划" />
                    <DetailList title="操作步骤" items={tuningProposal.manual_steps} empty="暂无步骤" />
                    <DetailList title="回归重点" items={tuningProposal.benchmark_focus} empty="暂无重点" />
                  </div>
                  <div className={styles.buttonRow}>
                    <Button size="xs" variant="default" loading={proposalGenerating} disabled={!diagnosis} onClick={onGenerateProposal}>重新生成</Button>
                  </div>
                </Accordion.Panel>
              ) : (
                <Accordion.Panel className={styles.railAccordionPanel}>
                  <div className={styles.diagnosisHead}>先完成 Trace 诊断后，再生成调优方案。</div>
                  <div className={styles.buttonRow}>
                    <Button size="xs" variant="default" loading={proposalGenerating} disabled={!diagnosis} onClick={onGenerateProposal}>生成调优方案</Button>
                  </div>
                </Accordion.Panel>
              )}
            </Accordion.Item>

            <Accordion.Item className={styles.railAccordionItem} value="attempts">
              <Accordion.Control className={styles.railAccordionControl}>
                <div className={styles.railAccordionLabel}>
                  <span className={styles.railAccordionTitle}>调试记录</span>
                  <Badge size="xs" variant="light" color="yiw">{attempts.length} 轮</Badge>
                </div>
              </Accordion.Control>
              <Accordion.Panel className={styles.railAccordionPanel}>
                <div className={styles.attemptForm}>
                  <Select
                    label="状态"
                    data={ATTEMPT_STATUS_OPTIONS}
                    value={attemptStatus}
                    onChange={(value) => onAttemptStatusChange((value || 'planned') as TraceOptimizationAttemptStatus)}
                    allowDeselect={false}
                  />
                  <Textarea
                    label="调试假设"
                    minRows={2}
                    autosize
                    value={attemptHypothesis}
                    onChange={(event) => onAttemptHypothesisChange(event.currentTarget.value)}
                    placeholder="例如：失败发生在 tool_input，sql_scan_operator 没拿到排序和 limit"
                  />
                  <Textarea
                    label="计划改动"
                    minRows={2}
                    autosize
                    value={attemptChangeSummary}
                    onChange={(event) => onAttemptChangeSummaryChange(event.currentTarget.value)}
                    placeholder="例如：调整工具 schema，强制记录最终 SQL 和 TopN 条件"
                  />
                  <Textarea
                    label="备注"
                    minRows={2}
                    autosize
                    value={attemptNotes}
                    onChange={(event) => onAttemptNotesChange(event.currentTarget.value)}
                  />
                </div>
                <Group justify="flex-end" mt="sm">
                  <Button size="xs" variant="default" loading={attemptSaving} onClick={onSaveAttempt}>
                    {diagnosis ? '保存诊断为调试记录' : '记录调试'}
                  </Button>
                </Group>

                {attempts.length ? (
                  <div className={styles.attemptList}>
                    {attempts.map((attempt) => {
                      const attemptDiagnosis = (attempt.diagnosis || {}) as Partial<TraceFailureDiagnosis>
                      return (
                        <div key={attempt.id} className={styles.attemptItem}>
                          <div className={styles.attemptHeader}>
                            <Group gap={6} wrap="nowrap">
                              <Badge size="xs" variant="light" color="gray">第 {attempt.attempt_index} 轮</Badge>
                              <Badge size="xs" variant="light" color={ATTEMPT_COLOR[attempt.status] || 'gray'}>{ATTEMPT_LABEL[attempt.status] || attempt.status}</Badge>
                              <Badge size="xs" variant="light" color="grape">{attempt.source}</Badge>
                              {attemptDiagnosis.failure_stage ? <Badge size="xs" variant="light" color="red">{attemptDiagnosis.failure_stage}</Badge> : null}
                            </Group>
                            <Select
                              size="xs"
                              w={112}
                              data={ATTEMPT_STATUS_OPTIONS}
                              value={attempt.status}
                              onChange={(value) => value && onUpdateAttemptStatus(attempt, value as TraceOptimizationAttemptStatus)}
                              allowDeselect={false}
                            />
                          </div>
                          <strong>{compact(attempt.hypothesis) || compact(attemptDiagnosis.summary) || '未填写调试假设'}</strong>
                          <span>{compact(attempt.change_summary) || '未填写计划改动'}</span>
                          <small>{timeText(attempt.updated_at)} · {attempt.run_id || '未绑定新 run'}</small>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className={styles.emptyInline}>还没有调试轮次。先诊断 Trace 或填写调试假设后保存。</div>
                )}
              </Accordion.Panel>
            </Accordion.Item>

            {(() => {
              const items = readiness(draftDetail)
              const done = items.filter((item) => item.ok).length
              return (
                <Accordion.Item className={styles.railAccordionItem} value="readiness">
                  <Accordion.Control className={styles.railAccordionControl}>
                    <div className={styles.railAccordionLabel}>
                      <span className={styles.railAccordionTitle}>入库检查</span>
                      <Badge size="xs" variant="light" color={done === items.length ? 'teal' : 'yellow'}>{done}/{items.length}</Badge>
                    </div>
                  </Accordion.Control>
                  <Accordion.Panel className={styles.railAccordionPanel}>
                    <ReadinessChecklist draft={draftDetail} />
                  </Accordion.Panel>
                </Accordion.Item>
              )
            })()}
          </Accordion>
        </div>
      </ScrollArea>
    </div>
  )
}
