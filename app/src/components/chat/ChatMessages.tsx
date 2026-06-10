/**
 * ChatMessages — Message list rendering, streaming display, and task-specific streaming.
 * Extracted from Chat.tsx for readability.
 */

import { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import {
  User,
  Loader2,
  ChevronDown,
  ChevronRight,
  ZoomIn,
  FileText,
  FolderOpen,
  CheckCircle2,
  Brain,
  Clock,
  X,
  ShieldAlert,
} from 'lucide-react';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import { CollapsibleContent } from './CollapsibleContent';
import { AskUserCard } from './AskUserCard';
import { ProjectPlanCard } from './ProjectPlanCard';
import { ThinkingBlock, markdownComponents } from './markdownShared';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { open } from '@tauri-apps/plugin-shell';

import { ToolCallPanel, HistorySpawnAgentsPanel, getToolLabel } from '../ToolCallPanel';
import { TaskCard } from '../TaskCard';
import { FileCard, isMediaFilename, isMediaMime, type SentFile } from '../FileCard';
import { LongTaskProgressPanel, RoundDivider } from '../LongTaskPanel';
import { RetryStatusBar } from './RetryStatusBar';
import { SpawnAgentPanel } from '../SpawnAgentPanel';
import { CanvasRenderer } from '../canvas/CanvasRenderer';
import type { CanvasActionHandler } from '../../api/canvas';
import { CronJobSessionView } from '../CronJobSessionView';
import { useChatStreamStore, type LastUsage } from '../../stores/chatStreamStore';
import { useTaskStore } from '../../stores/taskStore';
import { cancelTask, pauseTask, openTaskFolder } from '../../api/tasks';
import type { ChatMessage, Attachment, ToolArtifact } from '../../api/agent';
import { ToolArtifactCard } from '../ToolArtifactCard';
import { CollaborationMessageCard } from '../collaboration/CollaborationMessageCard';
import { CompanionDraftCard } from '../companions/CompanionDraftCard';

import type { SpawnAgent, TaskStreamState } from '../../stores/chatStreamStore';
import logoFaceRight from '../../assets/yiyi-logo-face-right.png';

const PtyTerminal = lazy(() => import('../PtyTerminal'));

const TASK_CARD_TOOLS = ['create_task', 'inline_task', 'detach_to_background'];

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface PtySessionInfo {
  sessionId: string;
  command: string;
}

export interface ProcessedMsg {
  msg: ChatMessage;
  historyTools?: { id: number; name: string; status: 'done'; preview?: string; resultPreview?: string }[];
  historyAgents?: { name: string; result: string; is_error?: boolean }[];
  taskIds?: string[];
  ptySessions?: PtySessionInfo[];
  sentFiles?: SentFile[];
  /** Tool-produced visual artifacts collected from preceding `tool` role
   *  messages while merging the assistant's tool-call chain. */
  historyArtifacts?: ToolArtifact[];
}

/* ------------------------------------------------------------------ */
/*  ThinkingBlock                                                      */
/* ------------------------------------------------------------------ */

function UsageFooter({ usage }: { usage: LastUsage }) {
  const { inputTokens, outputTokens, cacheReadTokens } = usage;
  // Hit ratio is over total input — DeepSeek's `prompt_cache_hit_tokens` is
  // the portion of input served from prefix cache (priced ~10x cheaper).
  const hitPct = inputTokens > 0 ? Math.round((cacheReadTokens / inputTokens) * 100) : 0;
  return (
    <div
      className="text-[11px] flex items-center gap-2 px-1"
      style={{ color: 'var(--color-text-muted)' }}
    >
      <span>↑ {inputTokens.toLocaleString()}</span>
      <span>↓ {outputTokens.toLocaleString()}</span>
      {cacheReadTokens > 0 && (
        <span
          className="px-1.5 py-0.5 rounded"
          style={{
            background: 'var(--color-bg-muted)',
            color: 'var(--color-primary)',
          }}
          title={`${cacheReadTokens.toLocaleString()} of ${inputTokens.toLocaleString()} input tokens served from DeepSeek prefix cache`}
        >
          缓存命中 {hitPct}%
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  processMessages — merge ReAct chains                               */
/* ------------------------------------------------------------------ */

export function processMessages(messages: ChatMessage[]): ProcessedMsg[] {
  const result: ProcessedMsg[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'tool') { i++; continue; }

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const allTools: ProcessedMsg['historyTools'] & {} = [];
      const allArtifacts: ToolArtifact[] = [];
      let toolIdCounter = 0;
      let j = i;

      while (j < messages.length) {
        const cur = messages[j];
        if (cur.role === 'assistant' && cur.tool_calls && cur.tool_calls.length > 0) {
          for (const tc of cur.tool_calls) {
            toolIdCounter++;
            const toolMsg = messages.slice(j + 1).find(
              (m) => m.role === 'tool' && m.tool_call_id === tc.id,
            );
            allTools.push({
              id: toolIdCounter,
              name: tc.name,
              status: 'done' as const,
              preview: tc.arguments.length > 100 ? tc.arguments.slice(0, 100) + '...' : tc.arguments,
              // 2000 chars: enough to keep small structured JSON payloads intact
              // (create_task / pty_spawn_interactive etc. produce ~260-byte JSON
              // blobs that must round-trip through JSON.parse for inline cards).
              resultPreview: toolMsg?.content?.slice(0, 2000),
            });
            if (toolMsg?.tool_artifacts?.length) {
              allArtifacts.push(...toolMsg.tool_artifacts);
            }
          }
          j++;
        } else if (cur.role === 'tool') {
          j++;
        } else {
          break;
        }
      }

      const taskIds: string[] = [];
      const ptySessions: PtySessionInfo[] = [];
      const sentFiles: SentFile[] = [];
      const regularTools = allTools.filter((tool) => {
        if (TASK_CARD_TOOLS.includes(tool.name) && tool.resultPreview) {
          try {
            const parsed = JSON.parse(tool.resultPreview);
            const tid = parsed.id || parsed.task_id;
            if (tid) {
              if (!taskIds.includes(tid)) taskIds.push(tid);
              return false;
            }
          } catch { /* keep */ }
        }
        if (tool.name === 'pty_spawn_interactive' && tool.resultPreview) {
          try {
            const parsed = JSON.parse(tool.resultPreview);
            if (parsed.__type === 'pty_session' && parsed.session_id) {
              ptySessions.push({ sessionId: parsed.session_id, command: parsed.command || 'shell' });
              return false;
            }
          } catch { /* keep */ }
        }
        if (tool.name === 'send_file_to_user' && tool.resultPreview) {
          try {
            const parsed = JSON.parse(tool.resultPreview);
            if (parsed.__type === 'file_sent' && parsed.path && parsed.filename) {
              sentFiles.push({
                path: parsed.path,
                filename: parsed.filename,
                description: parsed.description,
                size: typeof parsed.size === 'number' ? parsed.size : 0,
              });
              return false;
            }
          } catch { /* keep */ }
        }
        return true;
      });

      const finalMsg = (j < messages.length && messages[j].role === 'assistant' && !messages[j].tool_calls?.length)
        ? messages[j] : null;

      if (finalMsg) {
        result.push({
          msg: finalMsg,
          historyTools: regularTools,
          historyAgents: finalMsg.spawn_agents?.length ? finalMsg.spawn_agents : undefined,
          taskIds: taskIds.length > 0 ? taskIds : undefined,
          ptySessions: ptySessions.length > 0 ? ptySessions : undefined,
          sentFiles: sentFiles.length > 0 ? sentFiles : undefined,
          historyArtifacts: allArtifacts.length > 0 ? allArtifacts : undefined,
        });
        i = j + 1;
      } else {
        result.push({
          msg: messages[j - 1],
          historyTools: regularTools,
          taskIds: taskIds.length > 0 ? taskIds : undefined,
          ptySessions: ptySessions.length > 0 ? ptySessions : undefined,
          sentFiles: sentFiles.length > 0 ? sentFiles : undefined,
          historyArtifacts: allArtifacts.length > 0 ? allArtifacts : undefined,
        });
        i = j;
      }
      continue;
    }

    if (msg.role === 'assistant' && msg.spawn_agents && msg.spawn_agents.length > 0) {
      result.push({ msg, historyAgents: msg.spawn_agents });
    } else {
      result.push({ msg });
    }
    i++;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  ChatMessages Component                                             */
/* ------------------------------------------------------------------ */

interface ChatMessagesProps {
  messages: ChatMessage[];
  currentSessionId: string;
  isTaskSession: boolean;
  isCronSession: boolean;
  cronJobId: string;
  aiName: string;
  loading: boolean;
  onOpenLightbox: (att: Attachment) => void;
  onUnfocus: () => void;
  onSendPrompt: (prompt: string) => void;
  /** render @mention pills in user messages */
  renderUserContent: (text: string) => React.ReactNode;
  /** callback when user interacts with a canvas component (button click / form submit) */
  onCanvasAction?: CanvasActionHandler;
  /** 回答流内 ask_user 提问气泡(点选项 chip 时触发);文本回答走主输入框 */
  onAnswerQuestion?: (requestId: string, answer: string) => void;
}

export interface ChatMessagesHandle {
  scrollToBottom: () => void;
}

export const ChatMessages = forwardRef<ChatMessagesHandle, ChatMessagesProps>(function ChatMessages(
  {
    messages,
    currentSessionId,
    isTaskSession,
    isCronSession,
    cronJobId,
    aiName,
    loading,
    onOpenLightbox,
    onUnfocus,
    onSendPrompt,
    onCanvasAction,
    renderUserContent,
    onAnswerQuestion,
  },
  ref,
) {
  const { t } = useTranslation();
  const processedMessages = useMemo(() => processMessages(messages), [messages]);

  // Custom markdown components: open links in external browser
  // Stream state from store
  const streamLoading = useChatStreamStore((s) => s.loading);
  const streamingContent = useChatStreamStore((s) => s.streamingContent);
  // ask_user 待答问题:作为对话流末尾的一条气泡渲染(F1)。
  const activeQuestion = useChatStreamStore((s) => s.questionQueue[0] ?? null);
  // PM 发来的开工方案:作为对话流末尾的一张卡渲染(S2③)。
  const streamingThinking = useChatStreamStore((s) => s.streamingThinking);
  const lastUsage = useChatStreamStore((s) => s.lastUsage);
  const streamingArtifacts = useChatStreamStore((s) => s.streamingArtifacts);
  const activeTools = useChatStreamStore((s) => s.activeTools);
  const claudeCode = useChatStreamStore((s) => s.claudeCode);
  const spawnAgents = useChatStreamStore((s) => s.spawnAgents);
  const collapsedAgents = useChatStreamStore((s) => s.collapsedAgents);
  const toggleCollapseAgent = useChatStreamStore((s) => s.toggleCollapseAgent);
  const streamError = useChatStreamStore((s) => s.errorMessage);
  const longTask = useChatStreamStore((s) => s.longTask);
  const taskStreams = useChatStreamStore((s) => s.taskStreams);
  const canvases = useChatStreamStore((s) => s.canvases);

  // Task-specific streaming
  const allTasks = useTaskStore((s) => s.tasks);
  const currentTask = useMemo(
    () => isTaskSession ? allTasks.find(t => t.sessionId === currentSessionId) : undefined,
    [allTasks, currentSessionId, isTaskSession],
  );
  const currentTaskStream = currentTask ? taskStreams.get(currentTask.id) : undefined;
  const taskIsActive = currentTask?.status === 'running' || currentTask?.status === 'pending';

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const isImageMime = (mime: string) => mime.startsWith('image/');

  useImperativeHandle(ref, () => ({
    scrollToBottom: () => {
      isAtBottomRef.current = true;
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    },
  }));

  // Scroll tracking
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 80;
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // 唯一的自动滚动机制:MutationObserver 观察聊天容器内**任意** DOM 变化(新气泡 / 流式
  // 文本增长,含主精灵流、群成员逐字、工具卡等),贴底时跟着滚到底(rAF 去抖,避免每个
  // token 都 reflow)。比"按 React state 依赖数组触发"更稳 —— 协作流式走 collaborationStore
  // 不在 messages 里,旧的依赖数组 effect 漏了它(也省了每加一种流就要补依赖的维护陷阱)。
  // 用户主动发消息时的 smooth 滚动走 imperative scrollToBottom(handleSend 调)。
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let raf = 0;
    const mo = new MutationObserver(() => {
      if (!isAtBottomRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      });
    });
    mo.observe(container, { childList: true, subtree: true, characterData: true });
    return () => { mo.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  const spawnRunning = spawnAgents.some((a) => a.status === 'running');
  const isStreaming = streamLoading || spawnRunning;

  return (
    <>
      {/* Task status bar — Claude Code style (minimal) */}
      {isTaskSession && currentTask && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-1.5"
          style={{ background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)' }}
        >
          {taskIsActive ? (
            <Loader2 size={12} className="animate-spin shrink-0" style={{ color: 'var(--color-primary)' }} />
          ) : currentTask.status === 'completed' ? (
            <CheckCircle2 size={12} className="shrink-0" style={{ color: 'var(--color-success)' }} />
          ) : currentTask.status === 'failed' ? (
            <X size={12} className="shrink-0" style={{ color: 'var(--color-error, #ef4444)' }} />
          ) : (
            <Clock size={12} className="shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          )}
          <span className="text-[11px] font-medium" style={{
            color: taskIsActive ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            fontFamily: 'var(--font-mono)',
          }}>
            {currentTask.status === 'running' ? '执行中' : currentTask.status === 'completed' ? '已完成' : currentTask.status === 'failed' ? '失败' : currentTask.status === 'paused' ? '已暂停' : currentTask.status === 'cancelled' ? '已取消' : '等待中'}
          </span>
          {currentTask.errorMessage && (
            <span className="text-[10px] truncate" style={{ color: 'var(--color-error, #ef4444)' }}>
              {currentTask.errorMessage}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={() => openTaskFolder(currentTask.id).catch(() => {})}
            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-muted)'; }}
            title="在系统文件管理器中打开任务工作空间"
          >
            <FolderOpen size={12} />
            <span>任务空间</span>
          </button>
          {taskIsActive && (
            <>
              <button
                onClick={() => pauseTask(currentTask.id).catch(() => {})}
                className="text-[11px] px-2 py-0.5 rounded transition-colors font-medium"
                style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-muted)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
              >
                暂停
              </button>
              <button
                onClick={() => cancelTask(currentTask.id).catch(() => {})}
                className="text-[11px] px-2 py-0.5 rounded transition-colors font-medium"
                style={{ color: 'var(--color-error, #ef4444)', background: 'rgba(255,69,58,0.08)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,69,58,0.15)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,69,58,0.08)'; }}
              >
                取消
              </button>
            </>
          )}
        </div>
      )}

      {/* Cron job info */}
      {isCronSession && cronJobId && (
        <CronJobSessionView jobId={cronJobId} onUnfocus={onUnfocus} />
      )}

      {/* Messages area */}
      <div ref={scrollContainerRef} role="log" aria-live="polite" aria-label="Chat messages" className="flex-1 overflow-y-auto" style={{ background: 'var(--color-bg)' }}>
        {messages.length === 0 && !loading && !(isTaskSession && currentTaskStream?.loading) ? (
          (isTaskSession || isCronSession) ? (
            <div className="h-full flex flex-col items-center justify-center px-6">
              <div className="text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto"
                  style={{ background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)' }}>
                  <Clock size={22} style={{ color: 'var(--color-primary)' }} />
                </div>
                <p className="text-[15px] font-medium" style={{ color: 'var(--color-text)' }}>
                  {isCronSession ? '定时任务尚未执行' : currentTask?.title || '任务'}
                </p>
                <p className="text-[13px]" style={{ color: 'var(--color-text-muted)' }}>
                  {isCronSession ? '任务将在预定时间自动执行，请耐心等待' : '暂无对话记录，发送消息开始交互'}
                </p>
              </div>
            </div>
          ) : null // Welcome screen handled by parent
        ) : (
          <div className="w-full py-6 px-8 space-y-6">
            {processedMessages.map(({ msg, historyTools, historyAgents, taskIds, ptySessions, sentFiles, historyArtifacts }, idx) => {
              if (msg.role === 'context_reset') {
                return (
                  <div key={idx} className="flex items-center gap-3 py-3 px-4">
                    <div className="flex-1 h-px" style={{ background: 'var(--color-border)' }} />
                    <span className="text-[11px] font-medium shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                      上下文已重置
                    </span>
                    <div className="flex-1 h-px" style={{ background: 'var(--color-border)' }} />
                  </div>
                );
              }
              // R4:开工方案锚点(context_type=work_plan,propose_work_plan 落库)→
              // **持久化**开工卡:不在场/切页/重启不丢,替代易失的一次性事件单槽。
              if (msg.context_type === 'work_plan' && msg.work_plan) {
                const wpTasks = (msg.work_plan.plan?.tasks ?? []).map((t) => ({
                  role: t.role,
                  objective: t.objective,
                  depends_on: t.depends_on ?? [],
                }));
                if (wpTasks.length > 0) {
                  return (
                    <div key={idx} className="w-full">
                      <ProjectPlanCard
                        plan={{
                          requestId: msg.work_plan.request_id ?? `msg-${msg.id ?? idx}`,
                          summary: msg.work_plan.summary ?? '',
                          tasks: wpTasks,
                        }}
                      />
                    </div>
                  );
                }
              }
              if (msg.role === 'collaboration' && msg.collaboration_id !== undefined) {
                // 协作消息(家族会话 / @召唤)直接铺整宽,不外贴 YiYi 头像 ——
                // 头像由 Step 卡片里每位 participant 自己出(群里 N 个独立账号
                // 的感觉)。L1 多成员同框靠 ParallelAgentStepCard。
                // R4:work 终态(✅ 交付完成 / 失败 / 中止,context_type=work_job)在协作卡
                // 上方加一条**交付横幅** —— 终态文本此前被渲染器丢弃,交付时刻不可见。
                const workVerdict =
                  msg.context_type === 'work_job' &&
                  (msg.content.startsWith('✅') || msg.content.startsWith('（工作'))
                    ? msg.content
                    : null;
                return (
                  <div key={idx} className="w-full">
                    {workVerdict && (
                      <div
                        className="my-2 rounded-xl px-3.5 py-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap border"
                        style={{
                          background: workVerdict.startsWith('✅')
                            ? 'color-mix(in srgb, var(--color-success) 8%, var(--color-bg-elevated))'
                            : 'var(--color-bg-subtle)',
                          borderColor: workVerdict.startsWith('✅')
                            ? 'color-mix(in srgb, var(--color-success) 30%, var(--color-border))'
                            : 'var(--color-border)',
                          color: 'var(--color-text)',
                        }}
                      >
                        {workVerdict.length > 800 ? `${workVerdict.slice(0, 800)}…` : workVerdict}
                      </div>
                    )}
                    <CollaborationMessageCard collaborationId={msg.collaboration_id} />
                  </div>
                );
              }
              if (msg.role === 'companion_draft' && msg.companion_draft) {
                return (
                  <div key={idx} className="flex gap-3 justify-start">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                      <img src={logoFaceRight} alt="YiYi" width={28} height={28} />
                    </div>
                    <div className="max-w-[80%] flex-1">
                      <CompanionDraftCard messageId={msg.id} envelope={msg.companion_draft} />
                    </div>
                  </div>
                );
              }
              // Media (image / video / audio) renders INSIDE the assistant
              // bubble so it visually belongs to the message ("here is the
              // screenshot I took"). Non-media stays as sibling cards — those
              // carry their own metadata + actions UI that doesn't fit inside
              // a chat bubble.
              const mediaFiles: SentFile[] = [];
              const docFiles: SentFile[] = [];
              for (const f of sentFiles ?? []) {
                (isMediaFilename(f.filename) ? mediaFiles : docFiles).push(f);
              }
              const mediaArtifacts: ToolArtifact[] = [];
              const docArtifacts: ToolArtifact[] = [];
              for (const a of historyArtifacts ?? []) {
                (isMediaMime(a.mime_type) ? mediaArtifacts : docArtifacts).push(a);
              }
              const hasInlineMedia = mediaFiles.length > 0 || mediaArtifacts.length > 0;

              return (
                <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'} group`}>
                  {msg.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                      <img src={logoFaceRight} alt="YiYi" width={28} height={28} />
                    </div>
                  )}

                  <div className={`max-w-[80%] space-y-2`}>
                    {historyTools && historyTools.length > 0 && (
                      <ToolCallPanel tools={historyTools} isHistory />
                    )}
                    {taskIds && taskIds.length > 0 && (
                      <div className="space-y-2">
                        {taskIds.map((tid) => <TaskCard key={tid} taskId={tid} />)}
                      </div>
                    )}
                    {docFiles.length > 0 && (
                      <div className="space-y-2">
                        {docFiles.map((f, i) => <FileCard key={`${f.path}-${i}`} file={f} />)}
                      </div>
                    )}
                    {docArtifacts.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {docArtifacts.map((a, i) => (
                          <ToolArtifactCard key={`${a.path}-${i}`} artifact={a} />
                        ))}
                      </div>
                    )}
                    {ptySessions && ptySessions.length > 0 && ptySessions.map((pty) => (
                      <div key={pty.sessionId} className="rounded-xl overflow-hidden" style={{
                        height: '300px', border: '1px solid var(--color-border)', background: 'var(--color-bg)',
                      }}>
                        <Suspense fallback={<div className="p-4 text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading terminal...</div>}>
                          <PtyTerminal sessionId={pty.sessionId} />
                        </Suspense>
                      </div>
                    ))}
                    {historyAgents && historyAgents.length > 0 && (
                      <HistorySpawnAgentsPanel agents={historyAgents} />
                    )}
                    {msg.role === 'assistant' && msg.thinking && (
                      <ThinkingBlock content={msg.thinking} />
                    )}

                    {/* Mark assistant replies that are just an echoed tool
                     *   error trace — model shouldn't be doing this, but
                     *   when it slips through we surface it as an error
                     *   card instead of styling it like normal prose. */}
                    {(() => {
                      const isErrorEcho =
                        msg.role === 'assistant' &&
                        /^\s*(Error:|Python error:|Python script error:|Script error:|Traceback)/i.test(msg.content);
                      return (
                    <div
                      className="py-2.5 px-4 rounded-2xl text-[14px] leading-relaxed"
                      style={msg.role === 'user' ? {
                        background: 'var(--color-primary)', color: '#FFFFFF', borderBottomRightRadius: '6px',
                      } : isErrorEcho ? {
                        background: 'color-mix(in srgb, var(--color-error) 8%, var(--color-bg-elevated))',
                        color: 'var(--color-text)',
                        border: '1px solid color-mix(in srgb, var(--color-error) 35%, var(--color-border))',
                        borderBottomLeftRadius: '6px',
                      } : {
                        background: 'var(--color-bg-elevated)', color: 'var(--color-text)',
                        border: '1px solid var(--color-border)', borderBottomLeftRadius: '6px',
                      }}
                    >
                      {isErrorEcho && (
                        <div
                          className="flex items-center gap-1.5 mb-2 text-[11.5px] font-medium uppercase tracking-wider"
                          style={{ color: 'var(--color-error)' }}
                        >
                          <ShieldAlert size={12} />
                          工具错误
                        </div>
                      )}
                      {/* Inline media (screenshots, generated images) belongs
                       *   inside the bubble: visually anchored to the
                       *   assistant message that's about to describe them. */}
                      {msg.role === 'assistant' && hasInlineMedia && (
                        <div className={`flex flex-wrap gap-2 ${msg.content ? 'mb-2.5' : ''}`}>
                          {mediaFiles.map((f, i) => (
                            <FileCard key={`mf-${f.path}-${i}`} file={f} />
                          ))}
                          {mediaArtifacts.map((a, i) => (
                            <ToolArtifactCard key={`ma-${a.path}-${i}`} artifact={a} />
                          ))}
                        </div>
                      )}
                      {/* Attachments */}
                      {msg.attachments && msg.attachments.length > 0 && (() => {
                        const images = msg.attachments.filter(a => isImageMime(a.mimeType));
                        const files = msg.attachments.filter(a => !isImageMime(a.mimeType));
                        return (
                          <div className={`${msg.content ? 'mb-2' : ''}`}>
                            {images.length > 0 && (
                              <div
                                className={`${images.length === 1 ? '' : 'grid gap-1.5'} ${files.length > 0 ? 'mb-2' : ''}`}
                                style={images.length > 1 ? { gridTemplateColumns: `repeat(${Math.min(images.length, 3)}, 1fr)` } : undefined}
                              >
                                {images.map((att, i) => (
                                  <div
                                    key={i}
                                    className="relative group/att rounded-lg overflow-hidden cursor-pointer"
                                    style={images.length === 1 ? { maxWidth: 'min(320px, 60vw)' } : { aspectRatio: '1', maxHeight: '160px' }}
                                    onClick={() => onOpenLightbox(att)}
                                  >
                                    <img
                                      src={`data:${att.mimeType};base64,${att.data}`}
                                      className="w-full h-full rounded-lg"
                                      style={{ objectFit: images.length === 1 ? 'contain' : 'cover' }}
                                      alt={att.name || 'image'}
                                      loading="lazy"
                                    />
                                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/att:opacity-100 transition-opacity"
                                      style={{ background: 'rgba(0,0,0,0.3)' }}>
                                      <ZoomIn size={20} className="text-white drop-shadow" />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {files.length > 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                {files.map((att, i) => (
                                  <div key={i} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px]"
                                    style={{
                                      background: msg.role === 'user' ? 'rgba(255,255,255,0.15)' : 'var(--color-bg-muted)',
                                      color: msg.role === 'user' ? 'rgba(255,255,255,0.9)' : 'var(--color-text-secondary)',
                                    }}>
                                    <FileText size={14} className="shrink-0" />
                                    <span className="truncate" style={{ maxWidth: 'min(180px, 40vw)' }}>{att.name || 'file'}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {msg.role === 'user' ? (
                        <div className="whitespace-pre-wrap break-words">
                          {renderUserContent(
                            msg.content.replace(/\n\n\[用户上传了文件:.*?\]/g, '').replace(/\[用户引用了文件:.*?\]\n```[\s\S]*?```\n?\n?/g, '').trim(),
                          )}
                        </div>
                      ) : (
                        <div className="markdown-body">
                          <CollapsibleContent>
                            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                              {msg.content}
                            </ReactMarkdown>
                          </CollapsibleContent>
                        </div>
                      )}
                    </div>
                      );
                    })()}

                    {/* Meta */}
                    <div className={`flex items-center gap-2 mt-1 px-1 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                      <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                        {msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                      </span>
                      {msg.source?.via === 'bot' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{
                          background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)',
                          border: '1px solid var(--color-border)',
                        }}>
                          {msg.role === 'user'
                            ? `${msg.source.sender_name || msg.source.sender_id || ''} via ${msg.source.bot_name || msg.source.platform}`
                            : `via ${msg.source.bot_name || msg.source.platform}`}
                        </span>
                      )}
                    </div>
                  </div>

                  {msg.role === 'user' && (
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                      style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}>
                      <User size={16} />
                    </div>
                  )}
                </div>
              );
            })}

            {/* Active tool calls + streaming response */}
            {isStreaming && (
              <div className="flex gap-3 justify-start">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                  <img src={logoFaceRight} alt="YiYi" width={28} height={28} />
                </div>
                <div className="max-w-[80%] space-y-2">
                  {(activeTools.length > 0 || claudeCode) && (() => {
                    const taskCards: string[] = [];
                    const streamPtySessions: PtySessionInfo[] = [];
                    const streamSentFiles: SentFile[] = [];
                    const filteredTools = activeTools.filter((t) => {
                      if (TASK_CARD_TOOLS.includes(t.name) && t.status === 'done' && t.resultPreview) {
                        try {
                          const parsed = JSON.parse(t.resultPreview);
                          if (parsed.id || parsed.task_id) { taskCards.push(parsed.id || parsed.task_id); return false; }
                        } catch { /* keep */ }
                      }
                      if (t.name === 'pty_spawn_interactive' && t.status === 'done' && t.resultPreview) {
                        try {
                          const parsed = JSON.parse(t.resultPreview);
                          if (parsed.__type === 'pty_session' && parsed.session_id) {
                            streamPtySessions.push({ sessionId: parsed.session_id, command: parsed.command || 'shell' });
                            return false;
                          }
                        } catch { /* keep */ }
                      }
                      if (t.name === 'send_file_to_user' && t.status === 'done' && t.resultPreview) {
                        try {
                          const parsed = JSON.parse(t.resultPreview);
                          if (parsed.__type === 'file_sent' && parsed.path && parsed.filename) {
                            streamSentFiles.push({
                              path: parsed.path,
                              filename: parsed.filename,
                              description: parsed.description,
                              size: typeof parsed.size === 'number' ? parsed.size : 0,
                            });
                            return false;
                          }
                        } catch { /* keep */ }
                      }
                      return true;
                    });
                    return (
                      <>
                        {(filteredTools.length > 0 || claudeCode) && <ToolCallPanel tools={filteredTools} />}
                        {taskCards.map((tid) => <TaskCard key={tid} taskId={tid} />)}
                        {streamSentFiles.map((f, i) => <FileCard key={`${f.path}-${i}`} file={f} />)}
                        {streamPtySessions.map((pty) => (
                          <div key={pty.sessionId} className="rounded-xl overflow-hidden" style={{
                            height: '300px', border: '1px solid var(--color-border)', background: 'var(--color-bg)',
                          }}>
                            <Suspense fallback={<div className="p-4 text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading terminal...</div>}>
                              <PtyTerminal sessionId={pty.sessionId} />
                            </Suspense>
                          </div>
                        ))}
                      </>
                    );
                  })()}

                  {streamingArtifacts.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {streamingArtifacts.map((a, i) => (
                        <ToolArtifactCard key={`${a.path}-${i}`} artifact={a} />
                      ))}
                    </div>
                  )}

                  {streamingThinking && <ThinkingBlock content={streamingThinking} streaming />}

                  {streamingContent ? (
                    <div className="py-2.5 px-4 rounded-2xl text-[14px] leading-relaxed markdown-body yiyi-stream-cursor"
                      style={{
                        background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
                        borderBottomLeftRadius: '6px', color: 'var(--color-text)',
                      }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                        {streamingContent}
                      </ReactMarkdown>
                    </div>
                  ) : !streamingThinking ? (
                    <div className="py-2.5 px-4 rounded-2xl inline-flex items-center gap-2"
                      style={{
                        background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
                        borderBottomLeftRadius: '6px',
                      }}>
                      {/* IM 风"正在输入…"打字指示 —— 配左侧 YiYi 头像就看得出是谁在回复,
                          取代旧的匿名骨骼屏(用户反馈:看不出谁)。 */}
                      <span className="yiyi-typing"><span /><span /><span /></span>
                      <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>正在输入…</span>
                    </div>
                  ) : null}

                  {lastUsage && lastUsage.inputTokens > 0 && <UsageFooter usage={lastUsage} />}
                </div>
              </div>
            )}

            {/* Retry Status */}
            {streamLoading && <RetryStatusBar />}

            {/* Error */}
            {streamError && !streamLoading && (
              <div className="flex gap-3 justify-start">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                  <img src={logoFaceRight} alt="YiYi" width={28} height={28} style={{ opacity: 0.6 }} />
                </div>
                <div className="py-2.5 px-4 rounded-2xl text-[13px] leading-relaxed max-w-[80%]"
                  style={{
                    background: 'rgba(var(--color-error-rgb, 255,69,58), 0.08)',
                    border: '1px solid var(--color-error)', borderBottomLeftRadius: '6px', color: 'var(--color-error)',
                  }}>
                  <div className="font-semibold mb-1">出错了</div>
                  <div style={{ color: 'var(--color-text-secondary)', wordBreak: 'break-word' }}>{streamError?.replace(/^Error:\s*/i, '')}</div>
                </div>
              </div>
            )}

            {longTask.status !== 'idle' && longTask.currentRound > 1 && (
              <RoundDivider round={longTask.currentRound} maxRounds={longTask.maxRounds} />
            )}
            {longTask.status !== 'idle' && (
              <div className="flex gap-3 justify-start px-2">
                <div className="shrink-0" style={{ width: '32px' }} />
                <div className="flex-1 min-w-0"><LongTaskProgressPanel /></div>
              </div>
            )}

            {spawnAgents.length > 0 && (
              <SpawnAgentPanel agents={spawnAgents} collapsedAgents={collapsedAgents} onToggleCollapse={toggleCollapseAgent} />
            )}

            {/* Live Canvas: render structured UI components from Agent */}
            {canvases.length > 0 && (
              <div style={{ maxWidth: '80%' }}>
                {canvases.map((c) => (
                  <CanvasRenderer
                    key={c.canvas_id}
                    canvasId={c.canvas_id}
                    title={c.title}
                    components={c.components}
                    onAction={onCanvasAction}
                  />
                ))}
              </div>
            )}

            {/* Task-specific streaming: tool calls + content from taskStreams */}
            {isTaskSession && currentTaskStream && (currentTaskStream.loading || currentTaskStream.activeTools.length > 0 || currentTaskStream.streamingContent) && (
              <div className="flex gap-3 justify-start">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                  <img src={logoFaceRight} alt="YiYi" width={28} height={28} />
                </div>
                <div className="max-w-[80%] space-y-2">
                  {currentTaskStream.activeTools.length > 0 && (
                    <div className="rounded-xl px-3 py-2" style={{
                      background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
                      fontFamily: 'var(--font-mono)', fontSize: '11px',
                    }}>
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>工具调用</span>
                        <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>
                          {currentTaskStream.activeTools.filter(t => t.status === 'done').length}/{currentTaskStream.activeTools.length}
                        </span>
                      </div>
                      {currentTaskStream.activeTools.map((tool) => {
                        const isRunning = tool.status === 'running';
                        return (
                          <div key={tool.id} className="flex items-center gap-2 py-[2px]" style={{ lineHeight: '18px' }}>
                            <div className="shrink-0" style={{
                              width: '5px', height: '5px', borderRadius: '50%',
                              background: isRunning ? 'var(--color-primary)' : 'var(--color-success)',
                              boxShadow: isRunning ? '0 0 6px var(--color-primary)' : 'none',
                            }} />
                            <span style={{ color: isRunning ? 'var(--color-text)' : 'var(--color-text-secondary)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                              {getToolLabel(tool.name, tool.status)}
                            </span>
                            {tool.preview && (
                              <span className="truncate" style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}>
                                {tool.preview.replace(/\n/g, ' ').slice(0, 50)}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {currentTaskStream.streamingContent ? (
                    <div className="py-2.5 px-4 rounded-2xl text-[14px] leading-relaxed markdown-body"
                      style={{
                        background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
                        borderBottomLeftRadius: '6px', color: 'var(--color-text)',
                      }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                        {currentTaskStream.streamingContent}
                      </ReactMarkdown>
                      {currentTaskStream.loading && <span className="yiyi-cursor" />}
                    </div>
                  ) : currentTaskStream.loading && currentTaskStream.activeTools.length === 0 ? (
                    <div className="py-2.5 px-4 rounded-2xl inline-flex items-center gap-2"
                      style={{
                        background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
                        borderBottomLeftRadius: '6px',
                      }}>
                      <span className="yiyi-typing"><span /><span /><span /></span>
                      <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>正在输入…</span>
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {activeQuestion && (
              <AskUserCard
                question={activeQuestion}
                onAnswer={(answer) => onAnswerQuestion?.(activeQuestion.requestId, answer)}
              />
            )}


            <div ref={messagesEndRef} />
          </div>
        )}
      </div>
    </>
  );
});
