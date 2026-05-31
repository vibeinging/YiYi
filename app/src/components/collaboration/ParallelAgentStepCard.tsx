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
 * - 每位 participant 通过 `events::emit(Token { step_id, companion_id, delta })`
 *   独立推流;collaborationStore 按 `${step_id}:${companion_id}` 累积。
 * - streams 不在终态清空(注释里说要清,实际从没清过),所以 step.status =
 *   completed 后,每位的最终文本就是其累积的 stream 本体。
 * - 执行器在 ParallelAgents 出第一个失败时整步 abort;UI 在 step.status =
 *   failed 时整体显示失败。
 */

import { Loader2, AlertCircle } from 'lucide-react'
import type { CollaborationId, Step, Participant, StepStatus } from '../../api/collaboration'
import { selectStream, selectReasoning, useCollaborationStore } from '../../stores/collaborationStore'
import { ThinkingBlock, AgentMarkdown } from '../chat/markdownShared'

interface Props {
  collaborationId: CollaborationId
  step: Step
}

export function ParallelAgentStepCard({ collaborationId, step }: Props) {
  if (step.participants.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {step.participants.map(p => (
        <MemberMessageBubble
          key={p.companion_id}
          collaborationId={collaborationId}
          stepId={step.id}
          stepStatus={step.status}
          participant={p}
        />
      ))}
      {step.status === 'failed' && (
        <div className="flex items-center gap-1.5 text-[11px] px-1" style={{ color: 'var(--color-error, #c00)' }}>
          <AlertCircle size={11} />
          有成员没说完整,这一轮中止了
        </div>
      )}
    </div>
  )
}

interface BubbleProps {
  collaborationId: CollaborationId
  stepId: number
  stepStatus: StepStatus
  participant: Participant
}

function MemberMessageBubble({ collaborationId, stepId, stepStatus, participant }: BubbleProps) {
  const stream = useCollaborationStore(
    selectStream(collaborationId, stepId, participant.companion_id),
  )
  const reasoning = useCollaborationStore(
    selectReasoning(collaborationId, stepId, participant.companion_id),
  )
  const accent = participant.color_hex || 'var(--color-text-muted)'
  const text = stream ?? ''
  const thinking = reasoning ?? ''
  // 成员选择"这一轮我不发言"(fused reply-or-`<pass>`,见对话循环引擎):不渲染气泡。
  // 流式中是 `<pass>` 的前缀也先藏,避免哨兵字符闪现(真回复一旦偏离前缀就会显示)。
  const trimmed = text.trim()
  const PASS = '<pass>'
  if (trimmed.length > 0 && PASS.startsWith(trimmed)) return null
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
            <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>等开口…</span>
          )}
          {stepStatus === 'completed' && text && (
            <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>说完</span>
          )}
        </div>
        {/* 思考过程 —— 与主 agent 同一个 ThinkingBlock(可折叠)。 */}
        {thinking && <ThinkingBlock content={thinking} streaming={thinkingStreaming} />}
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
