import { useState } from 'react'
import { Box, Button, Group, SegmentedControl, Select, Stack, Text, Textarea } from '@mantine/core'
import type { TraceReview, TraceReviewSeverity, TraceReviewStatus } from '@/api/yiw'
import { isIssueReviewStatus } from './WorkstationTraceReviewMeta'

const REVIEW_STATUS_OPTIONS: Array<{ value: TraceReviewStatus; label: string }> = [
  { value: 'incorrect', label: '错误' },
  { value: 'incomplete', label: '不完整' },
  { value: 'tool_error', label: '工具问题' },
  { value: 'routing_error', label: '路由问题' },
  { value: 'data_issue', label: '数据口径问题' }
]

const REVIEW_SEVERITY_OPTIONS: Array<{ value: TraceReviewSeverity; label: string }> = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'blocker', label: '阻塞' }
]

const REVIEW_REASON_OPTIONS = [
  { value: 'routing_error', label: '路由错误' },
  { value: 'sql_error', label: 'SQL 错误' },
  { value: 'tool_input_error', label: '工具输入错误' },
  { value: 'tool_output_unused', label: '工具输出未使用' },
  { value: 'data_source_error', label: '数据源/字段错误' },
  { value: 'metric_definition_error', label: '指标口径错误' },
  { value: 'time_range_error', label: '时间范围错误' },
  { value: 'entity_resolution_error', label: '实体识别错误' },
  { value: 'answer_format_error', label: '最终回答格式错误' },
  { value: 'unknown', label: '无法判断' }
]

type ReviewMode = 'correct' | 'issue' | 'needs_review'

function statusToMode(status?: TraceReviewStatus | null): ReviewMode {
  if (status === 'correct') return 'correct'
  if (status === 'needs_review') return 'needs_review'
  return 'issue'
}

export interface TraceReviewInlinePayload {
  status: TraceReviewStatus
  severity: TraceReviewSeverity
  reason_code: string
  reason_text: string
  expected_behavior: string
}

export function TraceReviewInlinePanel({
  review,
  title = '标注结果',
  scopeLabel = 'run 级',
  noOuterMargin = false,
  saving,
  creatingDraft,
  onCancel,
  onSave
}: {
  review?: TraceReview | null
  title?: string
  scopeLabel?: string
  noOuterMargin?: boolean
  saving?: boolean
  creatingDraft?: boolean
  onCancel: () => void
  onSave: (payload: TraceReviewInlinePayload, createDraft: boolean) => void
}) {
  const [mode, setMode] = useState<ReviewMode>(statusToMode(review?.status))
  const [issueStatus, setIssueStatus] = useState<TraceReviewStatus>(isIssueReviewStatus(review?.status) ? review?.status || 'incorrect' : 'incorrect')
  const [severity, setSeverity] = useState<TraceReviewSeverity>(review?.severity || 'medium')
  const [reasonCode, setReasonCode] = useState(review?.reason_code || 'sql_error')
  const [reasonText, setReasonText] = useState(review?.reason_text || '')
  const [expectedBehavior, setExpectedBehavior] = useState(review?.expected_behavior || '')
  const isIssue = mode === 'issue'
  const status = isIssue ? issueStatus : mode
  const saveLabel = mode === 'correct' ? '确认正确' : mode === 'needs_review' ? '保存待复核' : '保存问题'

  const payload = {
    status,
    severity: mode === 'correct' ? 'low' : severity,
    reason_code: isIssue ? reasonCode : mode,
    reason_text: reasonText,
    expected_behavior: isIssue ? expectedBehavior : ''
  }

  return (
    <Box
      mx={noOuterMargin ? 0 : 10}
      mb={noOuterMargin ? 0 : 10}
      p={10}
      style={{
        border: '1px solid color-mix(in srgb, var(--yiw-accent) 24%, var(--app-border))',
        borderRadius: 8,
        background: 'color-mix(in srgb, var(--yiw-bg) 56%, var(--yiw-surface))'
      }}
    >
      <Stack gap={9}>
        <Group justify="space-between" gap={8}>
          <Text size="12px" fw={720}>{title}</Text>
          <Text size="10.5px" c="dimmed">{scopeLabel}</Text>
        </Group>
        <SegmentedControl
          size="xs"
          fullWidth
          value={mode}
          onChange={(value) => setMode(value as ReviewMode)}
          data={[
            { value: 'correct', label: '正确' },
            { value: 'issue', label: '有问题' },
            { value: 'needs_review', label: '待复核' }
          ]}
        />
        {isIssue && (
          <>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 8
              }}
            >
              <Select
                size="xs"
                label="问题类型"
                data={REVIEW_STATUS_OPTIONS}
                value={issueStatus}
                onChange={(value) => setIssueStatus((value as TraceReviewStatus) || 'incorrect')}
                allowDeselect={false}
              />
              <Select
                size="xs"
                label="严重度"
                data={REVIEW_SEVERITY_OPTIONS}
                value={severity}
                onChange={(value) => setSeverity((value as TraceReviewSeverity) || 'medium')}
                allowDeselect={false}
              />
              <Select
                size="xs"
                label="原因"
                data={REVIEW_REASON_OPTIONS}
                value={reasonCode}
                onChange={(value) => setReasonCode(value || 'unknown')}
                allowDeselect={false}
              />
            </Box>
            <Textarea
              size="xs"
              label="期望行为"
              minRows={2}
              maxRows={5}
              autosize
              value={expectedBehavior}
              onChange={(event) => setExpectedBehavior(event.currentTarget.value)}
              placeholder="例如：应按销售额 sum(amount) 聚合客户并倒序排序"
            />
          </>
        )}
        <Textarea
          size="xs"
          label={isIssue ? '补充说明' : '备注'}
          minRows={2}
          maxRows={4}
          autosize
          value={reasonText}
          onChange={(event) => setReasonText(event.currentTarget.value)}
          placeholder={isIssue ? '可补充错因、证据或复现条件' : '可选'}
        />
        <Group justify="flex-end" gap={7}>
          <Button size="xs" variant="subtle" color="gray" onClick={onCancel}>
            取消
          </Button>
          <Button size="xs" variant="default" loading={saving} onClick={() => onSave(payload, false)}>
            {saveLabel}
          </Button>
          {isIssue && (
            <Button size="xs" loading={creatingDraft} onClick={() => onSave(payload, true)}>
              保存并生成草稿
            </Button>
          )}
        </Group>
      </Stack>
    </Box>
  )
}
