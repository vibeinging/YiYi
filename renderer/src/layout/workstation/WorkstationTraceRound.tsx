import { ActionIcon, Badge, Box, Button, Group, Stack, Text } from '@mantine/core'
import { IconChevronRight } from '@tabler/icons-react'
import type { AgentTraceRun, AgentTraceSpan, TraceReview } from '@/api/yiw'
import { eventBus, EVENT_TYPES } from '@/utils/eventBus'
import { TraceReviewInlinePanel, type TraceReviewInlinePayload } from './WorkstationTraceReview'
import { draftBadge, isIssueReview, reviewBadge } from './WorkstationTraceReviewMeta'
import { Waterfall } from './WorkstationTraceWaterfall'
import { formatDuration, formatTime, statusColor, statusLabel, userQuestionText } from './WorkstationTraceLogic'

function locateQuestion(run: AgentTraceRun) {
  const questionNo = Number(run.question?.questionNo || 0)
  if (!questionNo) return
  eventBus.emit(EVENT_TYPES.LOCATE_AGENT_QUESTION, {
    sessionId: run.sessionId,
    questionNo
  })
}

function RoundHeader({
  run,
  review,
  expanded,
  onToggle
}: {
  run: AgentTraceRun
  review?: TraceReview | null
  expanded: boolean
  onToggle: () => void
}) {
  const question = run.question
  const trace = run.trace
  const status = trace?.status || run.status
  const questionText = userQuestionText(run)
  const questionNo = Number(question?.questionNo || 0)
  const meta = [
    trace ? `${trace.spanCount} spans` : '0 spans',
    trace ? formatDuration(trace.durMs) : '',
    formatTime(run.updatedAt || run.createdAt)
  ].filter(Boolean).join(' · ')

  return (
    <>
      <Group gap={9} align="center" wrap="nowrap" px={10} pt={9} pb={6}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr)',
            alignItems: 'center',
            border: 0,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            font: 'inherit',
            padding: 0,
            textAlign: 'left'
          }}
        >
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Group gap={6} wrap="nowrap">
              <Text size="11px" fw={760} c="var(--yiw-text)">
                {questionNo ? `第 ${questionNo} 问` : '用户问题'}
              </Text>
              <Badge size="xs" variant="light" color={statusColor(status)}>
                {statusLabel(status)}
              </Badge>
              {reviewBadge(review)}
              {draftBadge(review)}
            </Group>
            <Text size="12px" fw={620} truncate title={questionText}>
              {questionText}
            </Text>
            {meta && (
              <Text size="10.5px" c="dimmed" truncate>
                {meta}
              </Text>
            )}
          </Stack>
        </button>
        <ActionIcon variant="subtle" color="gray" size="sm" onClick={onToggle} aria-label={expanded ? '折叠本轮 Trace' : '展开本轮 Trace'}>
          <IconChevronRight
            size={15}
            style={{
              transform: expanded ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.14s ease'
            }}
          />
        </ActionIcon>
      </Group>
      {questionNo > 0 && (
        <Box px={10} pb={8}>
          <button
            type="button"
            onClick={() => locateQuestion(run)}
            style={{
              border: 0,
              background: 'transparent',
              color: 'var(--yiw-muted)',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 11,
              lineHeight: 1.4,
              padding: 0,
              textAlign: 'left'
            }}
          >
            定位到用户问题
          </button>
        </Box>
      )}
    </>
  )
}

export function TraceRound({
  run,
  expanded,
  onToggle,
  selectedSpanId,
  onSelectSpan,
  review,
  reviewPanelOpen,
  savingReview,
  creatingDraft,
  spanReviews,
  reviewPanelSpanId,
  savingReviewSpanId,
  creatingDraftSpanId,
  onOpenReview,
  onCancelReview,
  onSaveReview,
  onCreateDraft,
  onOpenSpanReview,
  onCancelSpanReview,
  onSaveSpanReview,
  onCreateSpanDraft
}: {
  run: AgentTraceRun
  expanded: boolean
  onToggle: () => void
  selectedSpanId?: string
  onSelectSpan: (span: AgentTraceSpan | null) => void
  review?: TraceReview | null
  reviewPanelOpen?: boolean
  savingReview?: boolean
  creatingDraft?: boolean
  spanReviews?: Map<string, TraceReview>
  reviewPanelSpanId?: string
  savingReviewSpanId?: string
  creatingDraftSpanId?: string
  onOpenReview: () => void
  onCancelReview: () => void
  onSaveReview: (payload: TraceReviewInlinePayload, createDraft: boolean) => void
  onCreateDraft: () => void
  onOpenSpanReview?: (span: AgentTraceSpan) => void
  onCancelSpanReview?: () => void
  onSaveSpanReview?: (span: AgentTraceSpan, payload: TraceReviewInlinePayload, createDraft: boolean) => void
  onCreateSpanDraft?: (span: AgentTraceSpan, review: TraceReview) => void
}) {
  const canCreateRunDraft = isIssueReview(review)
  return (
    <Box
      style={{
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        border: '1px solid var(--app-border)',
        borderRadius: 8,
        background: 'var(--yiw-surface)',
        overflow: 'hidden'
      }}
    >
      <RoundHeader run={run} review={review} expanded={expanded} onToggle={onToggle} />
      <Group px={10} pb={reviewPanelOpen ? 8 : 10} gap={7} wrap="wrap">
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onOpenReview}>
          本轮结论
        </Button>
        {review?.draft ? (
          <Button size="compact-xs" variant="subtle" color="gray" disabled>
            已生成草稿
          </Button>
        ) : canCreateRunDraft ? (
          <Button size="compact-xs" variant="subtle" color="gray" onClick={onCreateDraft} loading={creatingDraft}>
            生成草稿
          </Button>
        ) : null}
      </Group>
      {reviewPanelOpen && (
        <TraceReviewInlinePanel
          review={review}
          title="本轮结论"
          scopeLabel="run 级"
          saving={savingReview}
          creatingDraft={creatingDraft}
          onCancel={onCancelReview}
          onSave={onSaveReview}
        />
      )}
      <Box
        style={{
          display: 'grid',
          gridTemplateRows: expanded ? '1fr' : '0fr',
          transition: 'grid-template-rows 150ms ease',
          minWidth: 0
        }}
      >
        <Box style={{ overflow: 'hidden', minWidth: 0 }}>
          <Box
            style={{
              boxSizing: 'border-box',
              minWidth: 0,
              width: '100%',
              borderTop: '1px solid var(--app-border)',
              background: 'color-mix(in srgb, var(--yiw-bg) 38%, transparent)'
            }}
          >
            <Waterfall
              run={run}
              selectedSpanId={selectedSpanId}
              onSelectSpan={onSelectSpan}
              spanReviews={spanReviews}
              reviewPanelSpanId={reviewPanelSpanId}
              savingReviewSpanId={savingReviewSpanId}
              creatingDraftSpanId={creatingDraftSpanId}
              onOpenSpanReview={onOpenSpanReview}
              onCancelSpanReview={onCancelSpanReview}
              onSaveSpanReview={onSaveSpanReview}
              onCreateSpanDraft={onCreateSpanDraft}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
