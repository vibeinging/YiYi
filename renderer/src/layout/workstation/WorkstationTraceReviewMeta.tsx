import { Badge } from '@mantine/core'
import type { TraceReview, TraceReviewStatus } from '@/api/yiw'

const REVIEW_LABEL: Record<TraceReviewStatus, string> = {
  needs_review: '待复核',
  correct: '正确',
  incorrect: '错误',
  incomplete: '不完整',
  tool_error: '工具问题',
  routing_error: '路由问题',
  data_issue: '口径问题'
}

const REVIEW_COLOR: Record<TraceReviewStatus, string> = {
  needs_review: 'yellow',
  correct: 'teal',
  incorrect: 'red',
  incomplete: 'orange',
  tool_error: 'grape',
  routing_error: 'yiw',
  data_issue: 'blue'
}

export function isIssueReviewStatus(status?: TraceReviewStatus | null) {
  return Boolean(status && status !== 'correct' && status !== 'needs_review')
}

export function isIssueReview(review?: Pick<TraceReview, 'status'> | null) {
  return isIssueReviewStatus(review?.status)
}

export function reviewBadge(review?: TraceReview | null) {
  if (!review) return <Badge size="xs" variant="light" color="gray">未复盘</Badge>
  return (
    <Badge size="xs" variant="light" color={REVIEW_COLOR[review.status] || 'gray'}>
      {REVIEW_LABEL[review.status] || review.status}
    </Badge>
  )
}

export function draftBadge(review?: TraceReview | null) {
  const draft = review?.draft
  if (!draft) return null
  const label = draft.status === 'ready' ? '可进 Benchmark' : draft.status === 'reviewable' ? '可复核' : '草稿'
  const color = draft.status === 'ready' ? 'teal' : draft.status === 'reviewable' ? 'cyan' : 'gray'
  return <Badge size="xs" variant="light" color={color}>{label}</Badge>
}
