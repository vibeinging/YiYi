import { useMemo, useState } from 'react'
import { ActionIcon, Badge, Box, Button, Group, Stack, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconChartBar, IconChevronLeft, IconChevronRight, IconClock, IconMaximize, IconMinimize } from '@tabler/icons-react'
import type { AgentTraceRun, AgentTraceSpan, TraceReview } from '@/api/yiw'
import { EmptyState } from './WorkstationTraceCommon'
import { TraceReviewInlinePanel, type TraceReviewInlinePayload } from './WorkstationTraceReview'
import { draftBadge, isIssueReview, reviewBadge } from './WorkstationTraceReviewMeta'
import {
  KIND_COLOR,
  KIND_LABEL,
  childSpansOf,
  formatDetailValue,
  formatDuration,
  formatTokenParts,
  isError,
  parentSpanOf,
  rootSpan,
  scopeTokenParts,
  spanKey,
  spanKindCount,
  spanMetricItems,
  spanPath,
  spanRenderKey,
  spanTokenParts,
  statusColor,
  statusLabel,
  tokenMetricItems
} from './WorkstationTraceLogic'

function KindChip({ span }: { span: AgentTraceSpan }) {
  const kind = String(span.kind || 'span')
  const color = isError(span.status) ? 'var(--mantine-color-red-6)' : KIND_COLOR[kind] || 'var(--mantine-color-gray-6)'
  return (
    <Text
      component="span"
      size="9.5px"
      fw={760}
      style={{
        flex: '0 0 auto',
        minWidth: 34,
        color,
        border: `1px solid color-mix(in srgb, ${color} 42%, transparent)`,
        borderRadius: 5,
        padding: '1px 4px',
        textAlign: 'center',
        lineHeight: 1.35
      }}
    >
      {KIND_LABEL[kind] || kind.toUpperCase().slice(0, 5)}
    </Text>
  )
}

export function WaterfallRow({
  run,
  span,
  maxEnd,
  scopeStart,
  depthOffset,
  childCount,
  review,
  active,
  onSelect,
  onDrill
}: {
  run: AgentTraceRun
  span: AgentTraceSpan
  maxEnd: number
  scopeStart: number
  depthOffset: number
  childCount: number
  review?: TraceReview | null
  active: boolean
  onSelect: () => void
  onDrill: () => void
}) {
  const start = Math.max(0, Number(span.startMs || 0) - scopeStart)
  const duration = Number(span.durMs || 0)
  const left = Math.max(0, Math.min(99, (start / maxEnd) * 100))
  const width = Math.max(1.2, Math.min(100 - left, (Math.max(duration, 1) / maxEnd) * 100))
  const color = isError(span.status) ? 'var(--mantine-color-red-6)' : KIND_COLOR[String(span.kind || '')] || 'var(--yiw-accent)'
  const tokens = spanTokenParts(run, span)
  const displayDepth = Math.max(0, Number(span.depth || 0) - depthOffset)

  return (
    <Box style={{ position: 'relative', minWidth: 0 }}>
      {childCount > 0 && (
        <ActionIcon
          variant="subtle"
          color="gray"
          size={22}
          aria-label={`进入 ${span.name} 的子流程`}
          onClick={onDrill}
          style={{
            position: 'absolute',
            zIndex: 2,
            left: Math.min(28, displayDepth * 10) + 4,
            top: 5,
            color: active ? 'var(--yiw-text)' : 'var(--mantine-color-dimmed)',
            border: '1px solid color-mix(in srgb, var(--app-border) 76%, transparent)',
            background: active ? 'color-mix(in srgb, var(--yiw-accent) 12%, transparent)' : 'color-mix(in srgb, var(--yiw-surface) 76%, transparent)'
          }}
        >
          <IconChevronRight size={12} />
        </ActionIcon>
      )}
      <button
        type="button"
        onClick={onSelect}
      style={{
        width: '100%',
        minWidth: 0,
        minHeight: 32,
        display: 'grid',
        gridTemplateColumns: 'minmax(104px, 34%) minmax(86px, 1fr) minmax(44px, auto)',
        alignItems: 'center',
        gap: 8,
        padding: '5px 8px',
        border: 0,
        borderRadius: 7,
        background: active ? 'color-mix(in srgb, var(--yiw-accent) 10%, transparent)' : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left'
      }}
    >
      <Group
        gap={6}
        wrap="nowrap"
        style={{
          minWidth: 0,
          paddingLeft: Math.min(28, displayDepth * 10) + (childCount > 0 ? 22 : 0)
        }}
      >
        <KindChip span={span} />
        <Text size="11.5px" fw={580} truncate title={span.name}>
          {span.name}
        </Text>
        {childCount > 0 && (
          <Badge size="xs" variant="light" color="gray" style={{ flex: '0 0 auto', fontSize: 9, height: 16 }}>
            {childCount} 子调用
          </Badge>
        )}
        {review ? reviewBadge(review) : null}
      </Group>
      <Box
        style={{
          position: 'relative',
          height: 12,
          borderRadius: 4,
          background: 'color-mix(in srgb, var(--app-border) 64%, transparent)',
          overflow: 'hidden'
        }}
      >
        <Box
          style={{
            position: 'absolute',
            left: `${left}%`,
            width: `${width}%`,
            top: 2,
            bottom: 2,
            borderRadius: 4,
            background: color
          }}
        />
      </Box>
      <Stack gap={0} align="flex-end" style={{ minWidth: 0 }}>
        <Text size="10.5px" c="dimmed">
          {formatDuration(span.durMs)}
        </Text>
        <Text size="9.5px" c="dimmed">
          {formatTokenParts(tokens)}
        </Text>
      </Stack>
      </button>
    </Box>
  )
}

function TraceScopeBar({
  currentSpan,
  breadcrumb,
  mode,
  scopeCount,
  onReset,
  onNavigate,
  onBack
}: {
  currentSpan?: AgentTraceSpan | null
  breadcrumb: AgentTraceSpan[]
  mode: 'list' | 'detail'
  scopeCount: number
  onReset: () => void
  onNavigate: (span: AgentTraceSpan) => void
  onBack: () => void
}) {
  const visiblePath = breadcrumb.filter((span) => Number(span.depth || 0) > 0)
  const crumbButton = (label: string, active: boolean, onClick: () => void, title?: string) => (
    <button
      type="button"
      onClick={onClick}
      title={title || label}
      style={{
        minWidth: 0,
        maxWidth: active ? 220 : 156,
        border: active ? '1px solid color-mix(in srgb, var(--yiw-accent) 32%, var(--app-border))' : '1px solid transparent',
        borderRadius: 6,
        background: active ? 'color-mix(in srgb, var(--yiw-accent) 10%, var(--yiw-surface))' : 'transparent',
        color: active ? 'var(--yiw-text)' : 'var(--yiw-text-soft)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 11,
        fontWeight: active ? 740 : 620,
        lineHeight: '18px',
        padding: '1px 6px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      {label}
    </button>
  )

  return (
    <Group
      justify="space-between"
      gap={8}
      wrap="nowrap"
      px="sm"
      py={6}
      style={{
        minWidth: 0,
        borderBottom: '1px solid var(--app-border)',
        background: 'color-mix(in srgb, var(--yiw-bg) 32%, transparent)'
      }}
    >
      <Group gap={4} wrap="nowrap" style={{ minWidth: 0, flex: '1 1 auto', overflow: 'hidden' }}>
        {crumbButton('全部 Trace', !currentSpan, onReset)}
        {visiblePath.map((span, index) => {
          const current = currentSpan && spanKey(span) === spanKey(currentSpan)
          return (
            <Group key={spanRenderKey(span, index)} gap={4} wrap="nowrap" style={{ minWidth: 0, flex: current ? '1 1 auto' : '0 1 auto' }}>
              <IconChevronRight size={12} color="var(--mantine-color-dimmed)" style={{ flex: '0 0 auto' }} />
              {crumbButton(span.name, Boolean(current), () => onNavigate(span), span.name)}
            </Group>
          )
        })}
      </Group>
      <Group gap={6} wrap="nowrap" style={{ flex: '0 0 auto' }}>
        <Text size="10.5px" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {mode === 'detail' ? '详情' : `${scopeCount} 子调用`}
        </Text>
        {currentSpan && (
          <ActionIcon
            variant="subtle"
            color="gray"
            size={24}
            aria-label="返回上一级 Trace"
            onClick={onBack}
          >
            <IconChevronLeft size={14} />
          </ActionIcon>
        )}
      </Group>
    </Group>
  )
}

export function Waterfall({
  run,
  selectedSpanId,
  onSelectSpan,
  spanReviews,
  reviewPanelSpanId,
  savingReviewSpanId,
  creatingDraftSpanId,
  onOpenSpanReview,
  onCancelSpanReview,
  onSaveSpanReview,
  onCreateSpanDraft
}: {
  run: AgentTraceRun
  selectedSpanId?: string
  onSelectSpan: (span: AgentTraceSpan | null) => void
  spanReviews?: Map<string, TraceReview>
  reviewPanelSpanId?: string
  savingReviewSpanId?: string
  creatingDraftSpanId?: string
  onOpenSpanReview?: (span: AgentTraceSpan) => void
  onCancelSpanReview?: () => void
  onSaveSpanReview?: (span: AgentTraceSpan, payload: TraceReviewInlinePayload, createDraft: boolean) => void
  onCreateSpanDraft?: (span: AgentTraceSpan, review: TraceReview) => void
}) {
  const trace = run.trace
  const spans = trace?.spans || []
  const selectedSpan = selectedSpanId
    ? spans.find((span) => spanKey(span) === selectedSpanId) || null
    : null
  const traceRoot = useMemo(() => rootSpan(run), [run])
  const visibleSpans = useMemo(
    () => {
      const rootChildren = traceRoot ? childSpansOf(run, traceRoot) : []
      return rootChildren.length ? rootChildren : spans
    },
    [run, traceRoot, spans]
  )
  const breadcrumb = useMemo(
    () => (selectedSpan ? spanPath(run, selectedSpan) : []),
    [run, selectedSpan]
  )
  const scopeStart = Number(traceRoot?.startMs || 0)
  const depthOffset = traceRoot ? Number(traceRoot.depth || 0) + 1 : 0
  const maxEnd = useMemo(
    () => Math.max(
      1,
      Number(traceRoot?.durMs || trace?.durMs || 0),
      ...visibleSpans.map((span) => Math.max(0, Number(span.startMs || 0) - scopeStart) + Number(span.durMs || 0))
    ),
    [traceRoot?.durMs, trace?.durMs, visibleSpans, scopeStart]
  )
  const tokenParts = useMemo(
    () => scopeTokenParts(run, visibleSpans),
    [run, visibleSpans]
  )
  const toolCount = spanKindCount(visibleSpans, 'tool')
  const llmCount = spanKindCount(visibleSpans, 'llm')
  const errorCount = visibleSpans.filter((span) => isError(span.status)).length
  const scopeName = '本轮'
  const showDetail = (span: AgentTraceSpan) => {
    onSelectSpan(span)
  }
  const navigateToSpan = (span: AgentTraceSpan) => {
    showDetail(span)
  }
  const resetDrill = () => {
    onSelectSpan(null)
  }
  const drillUp = () => {
    if (!selectedSpan) return
    const parent = parentSpanOf(run, selectedSpan)
    if (!parent || Number(parent.depth || 0) <= 0) {
      onSelectSpan(null)
      return
    }
    onSelectSpan(parent)
  }

  if (!trace) {
    return <EmptyState icon={<IconClock size={18} />} title="这一轮暂无 Trace" />
  }
  if (!spans.length) {
    return <EmptyState icon={<IconChartBar size={18} />} title="这一轮还没有 span" />
  }

  return (
    <Box
      style={{
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden'
      }}
    >
      <TraceScopeBar
        currentSpan={selectedSpan}
        breadcrumb={breadcrumb}
        mode={selectedSpan ? 'detail' : 'list'}
        scopeCount={visibleSpans.length}
        onReset={resetDrill}
        onNavigate={navigateToSpan}
        onBack={drillUp}
      />
      {selectedSpan ? (
        <Box style={{ minWidth: 0 }}>
          <SpanDetail
            run={run}
            span={selectedSpan}
            onSelectSpan={showDetail}
            onDrillSpan={showDetail}
            showChildList
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
      ) : (
        <>
          <Box px="sm" py={8} style={{ borderBottom: '1px solid var(--app-border)', minWidth: 0 }}>
            <Group justify="space-between" gap={8} wrap="nowrap" mb={6} style={{ minWidth: 0 }}>
              <Text size="11px" fw={720} truncate title={scopeName}>
                {scopeName}
              </Text>
              {errorCount > 0 && (
                <Badge size="xs" variant="light" color="red">
                  {errorCount} 错误
                </Badge>
              )}
            </Group>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(62px, 1fr))',
                gap: 7,
                minWidth: 0
              }}
            >
              <Metric label="耗时" value={formatDuration(trace.durMs)} />
              {tokenMetricItems(tokenParts).map((item) => (
                <Metric key={item.label} label={item.label} value={item.value} />
              ))}
              <Metric label="Span" value={String(visibleSpans.length)} />
              <Metric label="Tool" value={String(toolCount)} />
              <Metric label="LLM" value={String(llmCount)} />
            </Box>
          </Box>
          <Box
            px="sm"
            py={5}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(104px, 34%) minmax(86px, 1fr) minmax(44px, auto)',
              gap: 8,
              borderBottom: '1px solid var(--app-border)',
              color: 'var(--mantine-color-dimmed)',
              minWidth: 0
            }}
          >
            <Text size="10.5px">Span</Text>
            <Group justify="space-between" gap={4}>
              {Array.from({ length: 4 }, (_, i) => (
                <Text key={i} size="10px">
                  {formatDuration((maxEnd / 3) * i)}
                </Text>
              ))}
            </Group>
            <Text size="10.5px" ta="right">
              指标
            </Text>
          </Box>
          <Stack gap={4} p={6}>
            {visibleSpans.length === 0 ? (
              <EmptyState icon={<IconChartBar size={18} />} title="这一轮还没有子调用" />
            ) : visibleSpans.map((span, index) => {
              const childCount = childSpansOf(run, span).length
              return (
                <WaterfallRow
                  key={spanRenderKey(span, index)}
                  run={run}
                  span={span}
                  maxEnd={maxEnd}
                  scopeStart={scopeStart}
                  depthOffset={depthOffset}
                  childCount={childCount}
                  review={spanReviews?.get(spanKey(span))}
                  active={false}
                  onSelect={() => navigateToSpan(span)}
                  onDrill={() => showDetail(span)}
                />
              )
            })}
          </Stack>
        </>
      )}
    </Box>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Box style={{ minWidth: 0 }}>
      <Text size="10.5px" c="dimmed">
        {label}
      </Text>
      <Text size="12.5px" fw={720} truncate>
        {value}
      </Text>
    </Box>
  )
}

function DetailBlock({ label, value, empty }: { label: string; value?: unknown; empty: string }) {
  const [expanded, setExpanded] = useState(false)
  const [rawMode, setRawMode] = useState(false)
  const { text, rawText, format } = formatDetailValue(value)
  const displayText = rawMode ? rawText : text
  const longText = displayText.length > 900 || displayText.split('\n').length > 14
  const copyText = async () => {
    if (!displayText) return
    try {
      await navigator.clipboard?.writeText(displayText)
      notifications.show({ color: 'teal', message: `${label}已复制` })
    } catch {
      notifications.show({ color: 'red', message: '复制失败' })
    }
  }
  return (
    <Stack gap={5} style={{ minWidth: 0 }}>
      <Group justify="space-between" gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="10.5px" fw={680} c="dimmed">
            {label}
          </Text>
          {format && (
            <Badge size="xs" variant="light" color="gray" style={{ fontSize: 9, height: 16 }}>
              {format}
            </Badge>
          )}
        </Group>
        {displayText && (
          <Group gap={3} wrap="nowrap">
            {format === 'JSON' && (
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setRawMode((value) => !value)}>
                {rawMode ? '格式化' : '原始'}
              </Button>
            )}
            <Button size="compact-xs" variant="subtle" color="gray" onClick={copyText}>
              复制
            </Button>
            {(longText || expanded) && (
              <ActionIcon
                variant="subtle"
                color="gray"
                size={22}
                aria-label={expanded ? `收起${label}` : `展开${label}`}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? <IconMinimize size={13} /> : <IconMaximize size={13} />}
              </ActionIcon>
            )}
          </Group>
        )}
      </Group>
      {displayText ? (
        <Box
          component="pre"
          style={{
            boxSizing: 'border-box',
            width: '100%',
            maxWidth: '100%',
            maxHeight: expanded ? 'min(68vh, 760px)' : 220,
            margin: 0,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            borderRadius: 7,
            background: 'var(--yiw-bg)',
            border: '1px solid color-mix(in srgb, var(--app-border) 72%, transparent)',
            color: 'var(--yiw-text-soft)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 11,
            lineHeight: 1.55,
            padding: '8px 9px'
          }}
        >
          {displayText}
        </Box>
      ) : (
        <Text size="11.5px" c="dimmed" py={4}>
          {empty}
        </Text>
      )}
    </Stack>
  )
}

function ChildSpanList({
  run,
  parent,
  spans,
  spanReviews,
  onSelectSpan,
  onDrillSpan
}: {
  run: AgentTraceRun
  parent: AgentTraceSpan
  spans: AgentTraceSpan[]
  spanReviews?: Map<string, TraceReview>
  onSelectSpan?: (span: AgentTraceSpan) => void
  onDrillSpan?: (span: AgentTraceSpan) => void
}) {
  if (!spans.length) return null
  const scopeStart = Number(parent.startMs || 0)
  const depthOffset = Number(parent.depth || 0) + 1
  const maxEnd = Math.max(
    1,
    Number(parent.durMs || 0),
    ...spans.map((span) => Math.max(0, Number(span.startMs || 0) - scopeStart) + Number(span.durMs || 0))
  )
  return (
    <Stack gap={6} style={{ minWidth: 0 }}>
      <Text size="10.5px" fw={680} c="dimmed">
        子调用
      </Text>
      <Box
        px={2}
        py={4}
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(104px, 34%) minmax(86px, 1fr) minmax(44px, auto)',
          gap: 8,
          color: 'var(--mantine-color-dimmed)',
          minWidth: 0
        }}
      >
        <Text size="10.5px">Span</Text>
        <Group justify="space-between" gap={4}>
          {Array.from({ length: 4 }, (_, i) => (
            <Text key={i} size="10px">
              {formatDuration((maxEnd / 3) * i)}
            </Text>
          ))}
        </Group>
        <Text size="10.5px" ta="right">
          指标
        </Text>
      </Box>
      <Stack gap={4} style={{ minWidth: 0 }}>
        {spans.map((span, index) => {
          const childCount = childSpansOf(run, span).length
          return (
            <WaterfallRow
              key={spanRenderKey(span, index)}
              run={run}
              span={span}
              maxEnd={maxEnd}
              scopeStart={scopeStart}
              depthOffset={depthOffset}
              childCount={childCount}
              review={spanReviews?.get(spanKey(span))}
              active={false}
              onSelect={() => onSelectSpan?.(span)}
              onDrill={() => onDrillSpan?.(span)}
            />
          )
        })}
      </Stack>
    </Stack>
  )
}

function SpanDetail({
  run,
  span,
  onSelectSpan,
  onDrillSpan,
  showChildList = false,
  spanReviews,
  reviewPanelSpanId,
  savingReviewSpanId,
  creatingDraftSpanId,
  onOpenSpanReview,
  onCancelSpanReview,
  onSaveSpanReview,
  onCreateSpanDraft
}: {
  run: AgentTraceRun
  span?: AgentTraceSpan | null
  onSelectSpan?: (span: AgentTraceSpan) => void
  onDrillSpan?: (span: AgentTraceSpan) => void
  showChildList?: boolean
  spanReviews?: Map<string, TraceReview>
  reviewPanelSpanId?: string
  savingReviewSpanId?: string
  creatingDraftSpanId?: string
  onOpenSpanReview?: (span: AgentTraceSpan) => void
  onCancelSpanReview?: () => void
  onSaveSpanReview?: (span: AgentTraceSpan, payload: TraceReviewInlinePayload, createDraft: boolean) => void
  onCreateSpanDraft?: (span: AgentTraceSpan, review: TraceReview) => void
}) {
  const trace = run.trace
  if (!trace) return <EmptyState icon={<IconClock size={18} />} title="这一轮暂无 Trace" />
  if (!span) return <EmptyState icon={<IconChartBar size={18} />} title="选择一个 span 查看详情" />

  const childSpans = childSpansOf(run, span)
  const metrics = spanMetricItems(run, span)
  const currentSpanKey = spanKey(span)
  const reviewStateKey = `${run.runId}:${currentSpanKey}`
  const review = spanReviews?.get(currentSpanKey) || null
  const reviewPanelOpen = reviewPanelSpanId === reviewStateKey
  const canCreateDraft = isIssueReview(review)
  return (
    <Stack gap={10} p={10} style={{ minWidth: 0 }}>
      <Group justify="space-between" gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <KindChip span={span} />
          <Text size="12px" fw={700} truncate title={span.name}>
            {span.name}
          </Text>
        </Group>
        <Badge size="xs" variant="light" color={statusColor(span.status)}>
          {statusLabel(span.status)}
        </Badge>
      </Group>
      <Group justify="space-between" gap={7} wrap="wrap" style={{ minWidth: 0 }}>
        <Group gap={6} wrap="wrap">
          {reviewBadge(review)}
          {draftBadge(review)}
        </Group>
        <Group gap={7} wrap="wrap">
          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => onOpenSpanReview?.(span)}>
            标注此步
          </Button>
          {review?.draft ? (
            <Button size="compact-xs" variant="subtle" color="gray" disabled>
              已生成草稿
            </Button>
          ) : canCreateDraft ? (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              loading={creatingDraftSpanId === reviewStateKey}
              onClick={() => review && onCreateSpanDraft?.(span, review)}
            >
              生成草稿
            </Button>
          ) : null}
        </Group>
      </Group>
      {reviewPanelOpen && (
        <TraceReviewInlinePanel
          review={review}
          title="标注此步"
          scopeLabel="span 级"
          noOuterMargin
          saving={savingReviewSpanId === reviewStateKey}
          creatingDraft={creatingDraftSpanId === reviewStateKey}
          onCancel={() => onCancelSpanReview?.()}
          onSave={(payload, createDraft) => onSaveSpanReview?.(span, payload, createDraft)}
        />
      )}
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))',
          gap: 8,
          minWidth: 0
        }}
      >
        {metrics.map((item) => (
          <Metric key={item.label} label={item.label} value={item.value} />
        ))}
      </Box>
      <DetailBlock label="输入" value={span.input} empty="没有输入快照" />
      <DetailBlock label="输出" value={span.output} empty="没有输出快照" />
      {showChildList && (
        <ChildSpanList
          run={run}
          parent={span}
          spans={childSpans}
          spanReviews={spanReviews}
          onSelectSpan={onSelectSpan}
          onDrillSpan={onDrillSpan}
        />
      )}
      <DetailBlock label="日志" value={span.logs} empty="没有日志" />
      <DetailBlock label="属性" value={span.attrs} empty="没有属性" />
    </Stack>
  )
}
