/**
 * Chat Page — orchestrates session tabs, messages, and input.
 * UI components extracted to components/chat/.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Clock } from 'lucide-react';
import { TimelinePanel } from '../components/TimelinePanel';
import {
  chatStreamStart,
  chatStreamStop,
  onChatComplete,
  onChatError,
  listSessions,
  ensureSession,
  getHistory,
  clearHistory,
  createCompanionSession,
  type ChatMessage,
  type Attachment,
} from '../api/agent';
import { setSessionGroup, getSessionGroup } from '../api/groups';
import { listWorkspaceFiles, loadWorkspaceFile, getWorkspacePath, type WorkspaceFile } from '../api/workspace';
import { listSkills } from '../api/skills';
import { type MentionTag } from '../components/MentionInput';
import { SLASH_COMMANDS, type SlashCommand } from '../components/SlashCommandPicker';
import { listAllTasksBrief, getTaskByName } from '../api/tasks';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useChatStreamStore } from '../stores/chatStreamStore';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useTaskStore } from '../stores/taskStore';
import { useSessionStore } from '../stores/sessionStore';
import { useDragRegion } from '../hooks/useDragRegion';
import { toast } from '../components/Toast';

import { ChatWelcome } from '../components/chat/ChatWelcome';
import { ChatMessages, type ChatMessagesHandle } from '../components/chat/ChatMessages';
import { ChatInput, type ChatInputHandle } from '../components/chat/ChatInput';
import { FamilyHeader } from '../components/chat/FamilyHeader';
import { SessionThinkingControl } from '../components/ThinkingModeControl';
import { PermissionCard } from '../components/chat/PermissionCard';
import { VoiceOverlay } from '../components/voice/VoiceOverlay';
import { useBuddyStore } from '../stores/buddyStore';
import {
  planSingleCompanion,
  submitCollaboration,
  type Participant,
} from '../api/collaboration';
import { getCompanion, getCompanionPersona, type Companion } from '../api/companions';

import logoImg from '../assets/yiyi-logo.png';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ChatPageProps {
  consumeNotifContext?: () => Record<string, unknown> | null;
  healthStatus?: 'ok' | 'error' | 'checking';
}

/* ------------------------------------------------------------------ */
/*  ChatPage Component                                                 */
/* ------------------------------------------------------------------ */

export function ChatPage({ consumeNotifContext, healthStatus = 'checking' }: ChatPageProps) {
  const { t, i18n } = useTranslation();
  const lang: 'zh' | 'en' = i18n.language?.startsWith('zh') ? 'zh' : 'en';
  const drag = useDragRegion();

  // --- Session store ---
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const chatSessions = useSessionStore((s) => s.chatSessions);
  const initialized = useSessionStore((s) => s.initialized);

  // --- Core state ---
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // --- Refs ---
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const messagesRef = useRef<ChatMessagesHandle>(null);
  const inputRef = useRef<ChatInputHandle>(null);
  // 草稿发首条消息切到新会话时,跳过一次 activeSessionId effect 的 loadMessages(防乐观消息被空历史覆盖)。
  const skipLoadRef = useRef(false);

  // --- 群聊状态:familyGroupId 决定一切(IM 心智)---
  // group_id = null  → 单聊主精灵。
  // group_id = N     → 群聊群 N,记忆桶 family_shared_<N>,主精灵让位给群成员。
  // 旧的 family_mode 字段已退役 —— 前后端一律只认 group_id,不再读写 family_mode。
  const [familyGroupId, setFamilyGroupId] = useState<number | null>(null);

  // 私聊某个伙伴时(session 绑了 companion_id 且非群聊)的当前伙伴 —— 给 ChatWelcome 换头像+介绍。
  // 草稿态(点好友落空会话、还没发消息)优先用草稿好友 —— 欢迎页/顶栏即时显示 ta;
  // 会话自身 companion_id 要等发首条消息归属后才有(见 sessionStore.draftCompanionId)。
  const draftCompanionId = useSessionStore((s) => s.draftCompanionId);
  const activeCompanionId = draftCompanionId ?? (chatSessions.find(s => s.id === activeSessionId)?.companion_id ?? null);
  const [activeCompanion, setActiveCompanion] = useState<Companion | null>(null);
  const [companionPersona, setCompanionPersona] = useState<string | null>(null);
  useEffect(() => {
    if (activeCompanionId == null) { setActiveCompanion(null); setCompanionPersona(null); return; }
    let cancelled = false;
    getCompanion(activeCompanionId).then(c => { if (!cancelled) setActiveCompanion(c); }).catch(() => setActiveCompanion(null));
    getCompanionPersona(activeCompanionId).then(p => { if (!cancelled) setCompanionPersona(p); }).catch(() => setCompanionPersona(null));
    return () => { cancelled = true; };
  }, [activeCompanionId]);

  // --- AI name ---
  const [aiName, setAiName] = useState('YiYi');
  const refreshAiName = () => {
    loadWorkspaceFile('SOUL.md').then((content) => {
      const match = content.match(/^---\s*\nname:\s*(.+)\s*\n/m);
      if (match?.[1]) {
        const name = match[1].trim();
        setAiName(name);
        useBuddyStore.getState().setAiName(name);
      }
    }).catch(() => {});
  };

  useEffect(() => {
    refreshAiName();
    const unlisten = listen<{ type: string; name: string; preview: string }>('chat://tool_status', (event) => {
      const { type, name, preview } = event.payload;
      if (type === 'end' && (name === 'write_file' || name === 'edit_file') && preview.includes('SOUL')) {
        refreshAiName();
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // --- Workspace files ---
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceBasePath, setWorkspaceBasePath] = useState('');

  const fetchWorkspaceFiles = useCallback(async () => {
    try {
      const [files, basePath] = await Promise.all([listWorkspaceFiles(), getWorkspacePath()]);
      setWorkspaceFiles(files.filter(f => !f.is_dir));
      setWorkspaceBasePath(basePath);
    } catch { /* ignore */ }
  }, []);

  // --- Session / tab management ---
  const pendingSessionId = useTaskSidebarStore((s) => s.pendingSessionId);

  const navigateToSession = useCallback(async (targetSessionId: string) => {
    try {
      const isCron = targetSessionId.startsWith('cron:');
      const jobId = isCron ? targetSessionId.slice(5) : targetSessionId;

      let displayName: string;
      if (isCron) {
        displayName = jobId;
      } else {
        const matchedTask = useTaskStore.getState().tasks.find((t) => t.sessionId === targetSessionId);
        displayName = matchedTask?.title ?? targetSessionId;
      }

      const sessionName = isCron ? `[Cron] ${displayName}` : displayName;
      await ensureSession(targetSessionId, sessionName, isCron ? 'cronjob' : 'chat', isCron ? jobId : undefined);

      // Add to session store tabs and switch
      useSessionStore.getState().switchToSession(targetSessionId);
      useChatStreamStore.getState().focusTask(targetSessionId, displayName, targetSessionId);
    } catch (err) {
      console.error('Failed to navigate to session:', err);
    }
  }, []);

  const handleGoToRecentChat = useCallback(() => {
    useChatStreamStore.getState().unfocusTask();
    const { chatSessions, activeSessionId, switchToSession, createNewChat } = useSessionStore.getState();
    if (chatSessions.length > 0) {
      // Switch to the most recent chat session
      switchToSession(chatSessions[0].id);
    } else {
      createNewChat();
    }
  }, []);

  // --- Session initialization ---
  useEffect(() => {
    (async () => {
      await useSessionStore.getState().initialize();
      const ctx = consumeNotifContext?.();
      if (ctx?.page === 'chat' && ctx?.session_id) {
        useSessionStore.getState().switchToSession(ctx.session_id as string);
        return;
      }
      const pending = useTaskSidebarStore.getState().consumePendingSession();
      if (pending) await navigateToSession(pending);
    })();
  }, []);

  useEffect(() => {
    if (!pendingSessionId || !initialized) return;
    useTaskSidebarStore.getState().consumePendingSession();
    navigateToSession(pendingSessionId);
  }, [pendingSessionId, navigateToSession, initialized]);

  // Consume pending new tab: add task session tab without switching away
  const pendingNewTab = useTaskSidebarStore((s) => s.pendingNewTab);
  useEffect(() => {
    if (!pendingNewTab || !initialized) return;
    const { id, name } = pendingNewTab;
    useTaskSidebarStore.getState().consumePendingNewTab();
    // Ensure the session exists in DB, then add to tab list silently
    ensureSession(id, name, 'task').then(() => {
      // Use setState callback to avoid stale closure
      useSessionStore.setState((state) => {
        if (state.chatSessions.some(s => s.id === id)) return state;
        return {
          chatSessions: [{ id, name, createdAt: Date.now(), updatedAt: Date.now(), source: 'task' } as any, ...state.chatSessions],
        };
      });
    }).catch(() => {});
  }, [pendingNewTab, initialized]);

  // --- Message loading ---
  const loadMessages = async (sessionId: string) => {
    try {
      const msgs = await getHistory(sessionId);
      setMessages(msgs);
    } catch (error) {
      console.error('Failed to load messages:', error);
      setMessages([]);
    }
  };

  useEffect(() => {
    if (!activeSessionId) { setMessages([]); return; }  // 草稿/空态:清残留消息,让欢迎页出来
    useChatStreamStore.getState().setSessionId(activeSessionId);
    if (skipLoadRef.current) {
      // 草稿刚切到新私聊:乐观消息已在手,别用空历史覆盖。其余初始化照走。
      skipLoadRef.current = false;
    } else {
      loadMessages(activeSessionId);
    }
    getSessionGroup(activeSessionId).then(setFamilyGroupId).catch(() => setFamilyGroupId(null));

    invoke('chat_stream_state', { sessionId: activeSessionId })
      .then((snapshot: any) => {
        if (snapshot && snapshot.is_active) {
          useChatStreamStore.getState().recoverFromSnapshot(snapshot);
        } else {
          useChatStreamStore.getState().resetStream();
        }
      })
      .catch(() => { useChatStreamStore.getState().resetStream(); });
  }, [activeSessionId]);

  // Tray new session
  const handleNewSession = async () => {
    await useSessionStore.getState().createNewChat();
  };

  // 群聊会话切换:IM 心智下只有两态 —— group_id=null 单聊 / group_id=N 群聊。
  // group_id 是唯一真相,旧的 family_mode 字段已退役不再写(修复 P3 双写脏列)。
  // 乐观更新 group_id + 失败回滚。
  const handleSetFamily = async (groupId: number | null) => {
    if (!activeSessionId) return;
    const prevGid = familyGroupId;
    setFamilyGroupId(groupId);
    try {
      await setSessionGroup(activeSessionId, groupId);
      toast.info(groupId != null ? '已切换到这个群' : '已退回单聊');
    } catch (e) {
      setFamilyGroupId(prevGid);
      toast.error(`切换群聊失败: ${e}`);
    }
  };

  useEffect(() => {
    const unlisten = listen('tray://new-session', () => handleNewSession());
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Sidebar "聊天" click → switch to most recent chat session
  useEffect(() => {
    const handler = () => handleGoToRecentChat();
    window.addEventListener('chat:go-main', handler);
    return () => window.removeEventListener('chat:go-main', handler);
  }, [handleGoToRecentChat]);

  // Spawn complete
  useEffect(() => {
    const unlisten = listen<{ session_id: string }>('chat://spawn_complete', (event) => {
      if (event.payload.session_id === activeSessionId) loadMessages(activeSessionId);
    });
    return () => { unlisten.then(fn => fn()); };
  }, [activeSessionId]);

  // --- Streaming chat ---
  const streamLoading = useChatStreamStore((s) => s.loading);
  const spawnAgents = useChatStreamStore((s) => s.spawnAgents);
  const activePermission = useChatStreamStore((s) => s.activePermission);
  const isPermissionPending = activePermission?.status === 'pending';
  const spawnRunning = spawnAgents.some((a) => a.status === 'running');
  const loading = streamLoading || spawnRunning;

  const runStreamingChat = async (text: string, sessionId: string, attachments?: Attachment[], forcedCompanionIds?: number[]): Promise<string> => {
    let resolveComplete: (reply: string) => void;
    let rejectComplete: (err: Error) => void;
    const completePromise = new Promise<string>((resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    });
    const unComplete = await onChatComplete((reply) => { resolveComplete(reply); });
    const unError = await onChatError((err) => { rejectComplete(new Error(err)); });
    try {
      await chatStreamStart(text, sessionId, attachments, forcedCompanionIds);
      const reply = await completePromise;
      return reply;
    } finally {
      unComplete();
      unError();
    }
  };

  const handleSend = async (plainText: string, mentions: MentionTag[], attachments: Attachment[]) => {
    messagesRef.current?.scrollToBottom();

    // 草稿态(点好友进来、零会话 activeSessionId='')发首条消息 → 这时才建一段全新私聊会话并切过去。
    // skipLoadRef 让随之而来的 activeSessionId 变更 effect 跳过一次 loadMessages,避免空历史
    // 覆盖下面的乐观插入(消息闪一下)。
    let sid = activeSessionId;
    const draftCid = useSessionStore.getState().draftCompanionId;
    if (!sid) {
      // 草稿态发首条消息才真正建会话:有草稿好友 → 建私聊;否则(YiYi 草稿)→ 建普通会话。
      // skipLoadRef 让随之的 activeSessionId effect 跳过一次 loadMessages,防空历史覆盖乐观插入。
      try {
        sid = draftCid != null
          ? await createCompanionSession(draftCid)
          : await useSessionStore.getState().createNewChat();
        // 新建会话立即用第一句话当标题(私聊也一样:头像已示意是谁,标题留给对话内容)。
        // 私聊走 companion 路由、后端不 rename → 正好保留这里设的;YiYi 会话后端随后会用
        // 首条消息再 rename 一次(同样第一句话),不冲突。
        const snippet = plainText.trim().replace(/\s+/g, ' ').slice(0, 30);
        if (snippet) await useSessionStore.getState().renameSession(sid, snippet);
        skipLoadRef.current = true;
        useSessionStore.getState().switchToSession(sid); // 切到新会话 + 清 draft
        await useSessionStore.getState().refreshSessions();
      } catch (e) {
        console.error('create session on send failed', e);
        toast.error(`建会话失败: ${e}`);
        return;
      }
    }
    if (!sid) return;

    let userMessage = plainText;

    // Load @-referenced file contents
    const fileMentions = mentions.filter(m => m.type === 'file');
    if (fileMentions.length > 0) {
      const fileContents = await Promise.all(
        fileMentions.map(async (m) => {
          try {
            const content = await loadWorkspaceFile(m.name);
            const truncated = content.length > 100_000 ? content.slice(0, 100_000) + '\n... (truncated)' : content;
            const absPath = workspaceBasePath ? `${workspaceBasePath}/${m.name}` : m.id;
            return `[用户引用了文件: ${m.name}，路径: ${absPath}]\n\`\`\`\n${truncated}\n\`\`\``;
          } catch { return `[用户引用了文件: ${m.name}] (读取失败)`; }
        }),
      );
      userMessage = fileContents.join('\n\n') + '\n\n' + userMessage;
    }

    // Bind @mentioned agents — prepend agent context for backend routing
    const agentMentions = mentions.filter(m => m.type === 'agent');

    const companionMentions = agentMentions.filter(m => m.id.startsWith('companion:'));

    // 群会话里 @ 群成员 = 点名必答:收集 forced ids,走下面正常群派遣流(后端强制
    // 这些成员上场,跳过智能路由)。可 @ 多位。不在这里 early-return。
    let forcedCompanionIds: number[] | undefined;
    if (familyGroupId != null && companionMentions.length >= 1) {
      forcedCompanionIds = companionMentions
        .map(m => parseInt(m.id.slice('companion:'.length), 10))
        .filter(n => Number.isFinite(n));
    } else if (companionMentions.length === 1 && agentMentions.length === 1) {
      // 单聊里 @ 一位 companion → 单独召唤(走独立协作,不是群派遣)。
      const companionIdStr = companionMentions[0].id.slice('companion:'.length);
      const companionId = parseInt(companionIdStr, 10);
      if (Number.isFinite(companionId)) {
        try {
          const companion = await getCompanion(companionId);
          if (!companion) {
            toast.error(`${companionMentions[0].name} 已不在群里`);
            return;
          }
          const participant: Participant = {
            companion_id: companion.id,
            name: companion.name,
            avatar_emoji: companion.avatar_emoji,
            color_hex: companion.color_hex,
            memory_scope: 'private',
          };
          const plan = planSingleCompanion(participant, plainText);
          const id = await submitCollaboration(
            sid,
            plainText,
            plan,
            { kind: 'manual' },
          );
          setMessages(prev => [
            ...prev,
            {
              role: 'user' as const,
              content: plainText,
              timestamp: Date.now(),
              attachments: undefined,
            },
            {
              role: 'collaboration' as const,
              content: '',
              collaboration_id: id,
              timestamp: Date.now(),
            },
          ]);
          return;
        } catch (e) {
          toast.error(`派遣 ${companionMentions[0].name} 失败: ${e}`);
          return;
        }
      }
    } else if (companionMentions.length >= 2) {
      toast.info('多位伙伴同聊暂未开放，目前先单独 @ 一位');
      return;
    }

    // 只给非 companion 的 agent mention 加 [agent:] 前缀;群里 @ 的 companion 走
    // forcedCompanionIds 结构化派遣,不污染消息文本。
    const nonCompanionAgents = agentMentions.filter(m => !m.id.startsWith('companion:'));
    if (nonCompanionAgents.length > 0) {
      const agentNames = nonCompanionAgents.map(m => m.name).join(', ');
      userMessage = `[agent: ${agentNames}]\n${userMessage}`;
    }

    // Bind @mentioned bots
    const botMentions = mentions.filter(m => m.type === 'bot');

    const userAttachments = attachments.length > 0 ? attachments : undefined;
    useChatStreamStore.getState().startStream();

    setMessages(prev => [...prev, {
      role: 'user' as const,
      content: userMessage,
      timestamp: Date.now(),
      attachments: userAttachments,
    }]);

    try {
      await runStreamingChat(userMessage, sid, userAttachments, forcedCompanionIds);
      await loadMessages(sid);
      // Refresh session list to pick up auto-generated title
      await useSessionStore.getState().refreshSessions();
      // Trigger buddy observer (non-blocking)
      // Use messagesRef or re-read state to avoid stale closure
      const currentMessages = await getHistory(sid);
      const recentMsgs = (currentMessages || []).slice(-5).map((m: any) => `${m.role}: ${(m.content || '').slice(0, 200)}`);
      recentMsgs.push(`user: ${userMessage.slice(0, 200)}`);
      useBuddyStore.getState().triggerObserve(recentMsgs).catch(() => {});
    } catch (error) {
      console.error('Chat error:', error);
      // If stream error wasn't already set by chat://error event, show it now
      const store = useChatStreamStore.getState();
      if (!store.errorMessage) {
        const msg = String(error).replace(/^Error:\s*/i, '');
        store.endStreamWithError(msg);
      }
    } finally {
      useChatStreamStore.getState().clearStreamState();
      useChatStreamStore.getState().endStream();
      useChatStreamStore.getState().longTaskReset();
    }
  };

  // Canvas action handler: injects user interaction as a chat message
  const handleCanvasAction = useCallback(
    (_canvasId: string, componentId: string, action: string, value?: unknown) => {
      const valueStr = value !== undefined ? JSON.stringify(value) : '';
      const prompt = `[Canvas Action] ${componentId}: ${action}${valueStr ? ' — ' + valueStr : ''}`;
      sendQuickPrompt(prompt);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, loading],
  );

  const sendQuickPrompt = async (prompt: string) => {
    if (loading) return;
    useChatStreamStore.getState().startStream();
    setMessages(prev => [...prev, { role: 'user' as const, content: prompt, timestamp: Date.now() }]);
    try {
      await runStreamingChat(prompt, activeSessionId);
      useChatStreamStore.getState().clearStreamState();
      await loadMessages(activeSessionId);
      await useSessionStore.getState().refreshSessions();
    } catch (error) {
      console.error('Failed to send quick prompt:', error);
      useChatStreamStore.getState().clearStreamState();
      setMessages(prev => [...prev, { role: 'assistant' as const, content: `Error: ${String(error)}`, timestamp: Date.now() }]);
    } finally {
      useChatStreamStore.getState().endStream();
    }
  };

  /** Fill prompt into input box (instead of sending directly) so user can review/add attachments */
  const fillQuickPrompt = useCallback((prompt: string) => {
    inputRef.current?.clear();
    setTimeout(() => {
      inputRef.current?.insertText(prompt);
      inputRef.current?.focus();
      inputRef.current?.shake();
    }, 0);
  }, []);

  const handleStop = useCallback(() => {
    chatStreamStop();
    useChatStreamStore.getState().endStream();
    useChatStreamStore.getState().spawnComplete();
  }, []);

  // --- Slash command execution ---
  const executeCommand = useCallback(async (cmd: SlashCommand, args?: string) => {
    const showSystemMsg = (content: string) => {
      setMessages((prev) => [...prev, { role: 'assistant' as const, content, timestamp: Date.now() }]);
    };

    switch (cmd.name) {
      case 'clear':
        await clearHistory(activeSessionId);
        setMessages((prev) => [...prev, { role: 'context_reset' as any, content: '', timestamp: Date.now() }]);
        break;
      case 'skills': {
        try {
          const skills = await listSkills({ enabledOnly: true });
          if (skills.length === 0) {
            showSystemMsg(t('chat.command.noSkills'));
          } else {
            const lines = skills.map((s) => `- ${s.emoji || '📦'} **${s.name}** — ${s.description}`).join('\n');
            showSystemMsg(`**${t('chat.command.enabledSkills')}** (${skills.length})\n\n${lines}`);
          }
        } catch { showSystemMsg(t('chat.command.noSkills')); }
        break;
      }
      case 'task': {
        if (!args?.trim()) { showSystemMsg(t('chat.command.taskUsage')); break; }
        try {
          const task = await getTaskByName(args.trim());
          if (task) {
            navigateToSession(task.sessionId);
          } else {
            try {
              const allTasks = await listAllTasksBrief();
              if (allTasks.length > 0) {
                const taskNames = allTasks.map((tk) => `  · ${tk.title}`).join('\n');
                showSystemMsg(`${t('chat.command.taskNotFound')}: "${args.trim()}"\n\n可用任务:\n${taskNames}`);
              } else {
                showSystemMsg(`${t('chat.command.taskNotFound')}: "${args.trim()}"\n\n当前没有任何任务`);
              }
            } catch { showSystemMsg(`${t('chat.command.taskNotFound')}: "${args.trim()}"`); }
          }
        } catch (err) {
          showSystemMsg(`${t('chat.command.taskNotFound')}: "${args.trim()}" (${err})`);
        }
        break;
      }
    }
  }, [activeSessionId, navigateToSession, handleGoToRecentChat, t]);

  // --- Render user content with @mention pills ---
  const renderUserContent = useCallback((text: string) => {
    const parts: React.ReactNode[] = [text];
    return <>{parts}</>;
  }, []);

  // --- Lightbox ---
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  useEffect(() => {
    if (!lightboxSrc) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxSrc(null); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [lightboxSrc]);

  const openLightbox = useCallback((att: Attachment) => {
    setLightboxSrc(`data:${att.mimeType};base64,${att.data}`);
  }, []);

  // --- Meditation status ---
  const [meditationStatus, setMeditationStatus] = useState<'idle' | 'running' | 'completed' | null>(null);

  useEffect(() => {
    // Listen for meditation-complete event instead of polling every 30s
    const unlisten = listen<any>('meditation-complete', (event) => {
      setMeditationStatus('completed');
      const { showBubble } = useBuddyStore.getState();
      const data = event.payload;
      const summary = data?.sessions_reviewed
        ? `整理了 ${data.sessions_reviewed} 个对话，更新了 ${data.memories_updated} 条记忆 ✨`
        : '记忆整理好啦！✨';
      showBubble(summary);
      setTimeout(() => setMeditationStatus(null), 5000);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const isCronSession = activeSessionId.startsWith('cron:');
  const cronJobId = isCronSession ? activeSessionId.slice(5) : '';
  const allTasks = useTaskStore((s) => s.tasks);
  const isTaskSession = useMemo(
    () => allTasks.some(t => t.sessionId === activeSessionId),
    [allTasks, activeSessionId],
  );
  // Determine if current session is a chat session (not task/cron)
  const isChatSession = !isTaskSession && !isCronSession;
  // 群会话从创建起就是对话页面 —— 不走欢迎页(欢迎页只给私聊/YiYi 的草稿空态)。
  // 用同步的 session.group_id 判断,不等异步的 familyGroupId,避免切群瞬间闪一下 YiYi 欢迎页。
  const activeGroupId = chatSessions.find(s => s.id === activeSessionId)?.group_id ?? null;
  const showWelcome = isChatSession && messages.length === 0 && !loading && activeGroupId == null;

  // --- Render ---
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Drag region — replaces the tab bar */}
      <div
        data-tauri-drag-region
        className="shrink-0 app-drag-region relative"
        style={{ background: 'var(--color-bg)', height: '38px' }}
      >
        {activeSessionId && (
          <button
            className="absolute right-3 top-1.5 w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--color-hover)]"
            style={{ color: 'var(--color-text-secondary)' }}
            onClick={() => setTimelineOpen(true)}
            aria-label="时间线"
            title="时间线"
          >
            <Clock size={15} />
          </button>
        )}
      </div>

      {/* 顶栏:私聊 = 显示"和 X 私聊"条;群/单聊 = FamilyHeader(管理群/邀请入口) */}
      {activeSessionId && !isTaskSession && !isCronSession && (
        (() => {
          const sess = chatSessions.find(s => s.id === activeSessionId);
          const companionId = draftCompanionId ?? (sess?.companion_id ?? null);
          if (companionId != null) {
            const accent = activeCompanion?.color_hex || 'var(--color-primary)';
            return (
              <div
                className="shrink-0 flex items-center gap-2.5 px-3 py-2"
                style={{ background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)' }}
              >
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-[16px] shrink-0"
                  style={{ background: `${accent}26` }}
                >
                  {activeCompanion?.avatar_emoji || '🤖'}
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium leading-tight truncate" style={{ color: 'var(--color-text)' }}>
                    {activeCompanion?.name || sess?.name}
                  </div>
                  <div className="text-[11px] leading-tight truncate" style={{ color: 'var(--color-text-muted)' }}>
                    {activeCompanion?.role_label || '和它单独聊天'}
                  </div>
                </div>
                <div className="flex-1" />
                <SessionThinkingControl sessionId={activeSessionId} lang={lang} />
              </div>
            );
          }
          return (
            <FamilyHeader
              sessionId={activeSessionId}
              familyGroupId={familyGroupId}
              onSetFamily={handleSetFamily}
            />
          );
        })()
      )}

      {/* Messages or Welcome */}
      {showWelcome ? (
        <div className="flex-1 overflow-y-auto" style={{ background: 'var(--color-bg)' }}>
          <ChatWelcome
            aiName={aiName}
            onSendPrompt={fillQuickPrompt}
            companion={familyGroupId || !activeCompanion ? null : {
              name: activeCompanion.name,
              avatar_emoji: activeCompanion.avatar_emoji,
              color_hex: activeCompanion.color_hex,
              role_label: activeCompanion.role_label,
              intro: companionPersona,
            }}
          />
        </div>
      ) : (
        <ChatMessages
          ref={messagesRef}
          messages={messages}
          currentSessionId={activeSessionId}
          isTaskSession={isTaskSession}
          isCronSession={isCronSession}
          cronJobId={cronJobId}
          aiName={aiName}
          loading={loading}
          onOpenLightbox={openLightbox}
          onUnfocus={handleGoToRecentChat}
          onSendPrompt={sendQuickPrompt}
          onCanvasAction={handleCanvasAction}
          renderUserContent={renderUserContent}
        />
      )}


      {/* Bottom dock: permission request takes over when pending */}
      {isPermissionPending ? (
        <div className="shrink-0 px-4 pt-2 pb-3 animate-in slide-in-from-bottom-2 duration-200"
          style={{ background: 'var(--color-bg)', borderTop: '1px solid var(--color-border)' }}>
          <PermissionCard request={activePermission!} />
        </div>
      ) : (
        <ChatInput
          ref={inputRef}
          loading={loading}
          workspaceFiles={workspaceFiles}
          onSend={handleSend}
          onStop={handleStop}
          onSelectCommand={executeCommand}
          onSelectTask={(task) => navigateToSession(task.sessionId)}
          onFileSelect={() => {}}
          onFetchWorkspaceFiles={fetchWorkspaceFiles}
        />
      )}

      <TimelinePanel
        open={timelineOpen}
        onClose={() => setTimelineOpen(false)}
        sessionId={activeSessionId || ''}
        messages={messages}
      />

      {/* Voice Overlay */}
      <VoiceOverlay />

      {/* Lightbox */}
      {lightboxSrc && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.85)' }}
            role="dialog"
            aria-label="Image preview"
            onClick={() => setLightboxSrc(null)}>
          <button className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full transition-colors"
            style={{ background: 'rgba(255,255,255,0.15)', color: 'var(--color-bg)' }}
              aria-label="Close image preview"
              onClick={() => setLightboxSrc(null)}>
            <X size={20} />
          </button>
          <img src={lightboxSrc} className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
            style={{ objectFit: 'contain' }} alt="preview" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
