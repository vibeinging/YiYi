/**
 * ParallelAgentStepCard —— N 位家族成员同框并发回复(L1 群聊感的核心 UI)。
 *
 * 每个 participant 是一行左对齐的消息气泡(avatar + 名字 + 内容),纵向堆叠,
 * 看起来像微信群里的几条独立消息。每个气泡订阅自己的 (step, companion) 流,
 * 真·并发流式。
 *
 * 没有路由卡 —— 用户决策:"路由卡不要"。"谁选的、为什么"沉到 audit / 日志。
 *
 * 数据约定(对照 executor.rs):
 * - 实时:每位 participant 通过 `events::emit(Token{step_id,companion_id,delta})`
 *   独立推流;collaborationStore 按 `${step_id}:${companion_id}` 累积(**内存态**)。
 * - 重开/hydrate 后:内存流是空的,本成员的最终发言要从持久化的
 *   `step.output.full_output`(executor 拼成的「【名字】内容」合并块)里解析回来。
 *   否则重开对话群成员气泡会空(实测 bug)。
 * - 执行器在 ParallelAgents 全员失败才整步 abort;UI 在 step.status=failed 显示失败。
 */

import { memo } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { mutateCollaboration } from '../../api/collaboration'
import type { CollaborationId, Step, Participant, StepStatus } from '../../api/collaboration'
import { selectStream, selectReasoning, selectTools, useCollaborationStore } from '../../stores/collaborationStore'
import { ThinkingBlock, AgentMarkdown } from '../chat/markdownShared'
import { ToolCallPanel } from '../ToolCallPanel'

interface Props {
  collaborationId: CollaborationId
  step: Step
}

/** 从合并的 full_output(「【名字】内容\n\n【名字2】…」)里抠出某成员的段落。
 *  单 participant(如 YiYi 结论,无前缀)→ 整段就是它的。找不到 → 空(该成员没发言)。 */
export function memberPersistedText(full: string, name: string, participantCount: number): string {
  if (!full) return ''
  const marker = `【${name}】`
  const i = full.indexOf(marker)
  if (i >= 0) {
    let rest = full.slice(i + marker.length)
    // 容旧数据:executor 早期会拼出「【名字】【名字】内容」双标记 —— 跳过紧跟的重复同名标记,
    // 否则下面找"下一个标记"会立刻命中重复标记、切出空串(重开后气泡空白的根因)。
    while (rest.startsWith(marker)) rest = rest.slice(marker.length)
    const next = rest.search(/【[^】]{1,24}】/)
    return (next >= 0 ? rest.slice(0, next) : rest).trim()
  }
  return participantCount === 1 ? full.trim() : ''
}

// memo:放养群聊一场几十上百条气泡,hydrate 时整列重渲染(含 markdown 重解析)会 O(n²) 卡。
// 已完成的历史气泡内容不再变(status/output 固定)→ 按内容比较跳过重渲染,只新气泡 / 状态变化的
// 重渲。流式 token 走 MemberMessageBubble 内部的 store 订阅,不受这层 memo 影响。
export const ParallelAgentStepCard = memo(function ParallelAgentStepCard({ collaborationId, step }: Props) {
  if (step.participants.length === 0) return null
  const persistedFull = step.output?.full_output ?? ''
  // step 级事实,算一次(派工任务的等待文案是"等上游交付")。
  const isProjectTask = (step.input?.metadata as { mode?: string } | null)?.mode === 'project_task'

  return (
    <div className="flex flex-col gap-3">
      {step.participants.map(p => (
        <MemberMessageBubble
          key={p.companion_id}
          collaborationId={collaborationId}
          stepId={step.id}
          stepStatus={step.status}
          participant={p}
          persistedText={memberPersistedText(persistedFull, p.name, step.participants.length)}
          isProjectTask={isProjectTask}
        />
      ))}
      {step.status === 'failed' && (
        <div className="flex items-center gap-2 px-1">
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-error, #c00)' }}>
            <AlertCircle size={11} />
            有成员没说完整,这一轮中止了
          </span>
          <button
            onClick={() => { void mutateCollaboration(collaborationId, { kind: 'retry_step', step_id: step.id }) }}
            className="text-[11px] px-2 py-0.5 rounded transition-colors"
            style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
          >
            重叫一次 ↺
          </button>
        </div>
      )}
    </div>
  )
}, (a, b) =>
  a.collaborationId === b.collaborationId &&
  a.step.id === b.step.id &&
  a.step.status === b.step.status &&
  (a.step.output?.full_output ?? '') === (b.step.output?.full_output ?? '') &&
  a.step.participants.length === b.step.participants.length)

interface BubbleProps {
  collaborationId: CollaborationId
  stepId: number
  stepStatus: StepStatus
  participant: Participant
  /** 持久化回落:hydrate 后实时流为空时,从 step.output 解析出的本成员发言。 */
  persistedText: string
  /** 派工任务(project_task,有交接依赖)→ 等待文案是"等上游交付"而非放养的"等开口"。 */
  isProjectTask: boolean
}

function MemberMessageBubble({ collaborationId, stepId, stepStatus, participant, persistedText, isProjectTask }: BubbleProps) {
  const stream = useCollaborationStore(
    selectStream(collaborationId, stepId, participant.companion_id),
  )
  const reasoning = useCollaborationStore(
    selectReasoning(collaborationId, stepId, participant.companion_id),
  )
  const tools = useCollaborationStore(
    selectTools(collaborationId, stepId, participant.companion_id),
  )
  const accent = participant.color_hex || 'var(--color-text-muted)'
  // 实时流优先;空(重开/hydrate 后)则回落持久化文本 → 重开对话也能看到发言。
  const text = (stream && stream.length > 0) ? stream : persistedText
  const thinking = reasoning ?? ''
  // 成员选择"这一轮我不发言"(fused reply-or-`<pass>`,见对话循环引擎):不渲染气泡。
  // 流式中是 `<pass>` 的前缀也先藏,避免哨兵字符闪现(真回复一旦偏离前缀就会显示)。
  const trimmed = text.trim()
  const hasTools = (tools?.length ?? 0) > 0
  const PASS = '<pass>'
  if (trimmed.length > 0 && PASS.startsWith(trimmed)) return null
  // 重开 hydrate 后:这一步已结束(非进行中),且本成员既无正文、无思考、无工具痕迹 →
  // 它这轮没发言(pass / 无产出),不渲染只剩头像的空气泡。(工具流是实时态,hydrate 后为空)
  if ((stepStatus === 'completed' || stepStatus === 'failed') && !trimmed && !thinking.trim() && !hasTools) {
    return null
  }
  // ParallelAgents 不暴露 per-participant 状态(只有整步 step.status)。所以:
  // - step running + 我有 stream → 我正在说
  // - step running + 我没 stream → 等开口 / 别人在说
  // - step completed → 都说完了,显示累积内容
  const isStreaming = stepStatus === 'running' && (text.length > 0 || thinking.length > 0)
  const isWaiting = stepStatus === 'pending' || (stepStatus === 'running' && text.length === 0 && thinking.length === 0)
  // 思考还在流、正文未起 → 思考块标记 streaming(自动展开 + 贴底)。
  const thinkingStreaming = stepStatus === 'running' && text.length === 0

  return (
    <div className="flex items-start gap-2.5">
      {/* avatar 圆头像,带成员主色淡底 */}
      <div
        className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-[18px]"
        style={{ background: `${accent}22` }}
      >
        {participant.avatar_emoji}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium" style={{ color: 'var(--color-text)' }}>
            {participant.name}
          </span>
          {isStreaming && (
            <span className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
              <Loader2 size={9} className="animate-spin" />
              正在说…
            </span>
          )}
          {isWaiting && (
            <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
              {isProjectTask ? '等上游交付…' : '等开口…'}
            </span>
          )}
          {stepStatus === 'completed' && text && (
            <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>说完</span>
          )}
        </div>
        {/* 思考过程 —— 与主 agent 同一个 ThinkingBlock(可折叠)。 */}
        {thinking && <ThinkingBlock content={thinking} streaming={thinkingStreaming} />}
        {/* 工具调用 —— 与主精灵复用同一个 ToolCallPanel(伙伴动手痕迹结构化展示,
            取代早期 🔧 文本)。isHistory 避免读 chatStreamStore 的 YiYi 专属 claudeCode 态。 */}
        {hasTools && <ToolCallPanel tools={tools!} isHistory />}
        {/* 正文气泡 —— 与主 agent 同结构(markdown-body + 共享 markdown 渲染 + 流式光标),
            只是背景按成员主色。这是用户要的"消息框一样,只背景不同"。 */}
        {(text || isWaiting) && (
          <div
            className={`py-2 px-3 rounded-2xl rounded-tl-md text-[13px] leading-relaxed break-words markdown-body${isStreaming && text ? ' yiyi-stream-cursor' : ''}`}
            style={{
              background: `${accent}1a`,
              border: `1px solid ${accent}29`,
              color: 'var(--color-text)',
            }}
          >
            {text ? <AgentMarkdown>{text}</AgentMarkdown> : <span style={{ color: 'var(--color-text-muted)' }}>…</span>}
          </div>
        )}
      </div>
    </div>
  )
}
