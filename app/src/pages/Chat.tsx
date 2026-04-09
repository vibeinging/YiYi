/**
 * Chat Page — orchestrates session tabs, messages, and input.
 * UI components extracted to components/chat/.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import {
  chatStreamStart,
  chatStreamStop,
  onChatComplete,
  onChatError,
  listSessions,
  ensureSession,
  getHistory,
  clearHistory,
  type ChatMessage,
  type Attachment,
} from '../api/agent';
import { listWorkspaceFiles, loadWorkspaceFile, getWorkspacePath, type WorkspaceFile } from '../api/workspace';
import { listSkills } from '../api/skills';
import { type MentionTag } from '../components/MentionInput';
import { SLASH_COMMANDS, type SlashCommand } from '../components/SlashCommandPicker';
import { listAllTasksBrief, getTaskByName } from '../api/tasks';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useChatStreamStore } from '../stores/chatStreamStore';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useSessionStore } from '../stores/sessionStore';
import { useDragRegion } from '../hooks/useDragRegion';
import { toast } from '../components/Toast';

import { ChatWelcome } from '../components/chat/ChatWelcome';
import { ChatMessages, type ChatMessagesHandle } from '../components/chat/ChatMessages';
import { ChatInput, type ChatInputHandle } from '../components/chat/ChatInput';
import { VoiceOverlay } from '../components/voice/VoiceOverlay';
import { useBuddyStore } from '../stores/buddyStore';

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
  const { t } = useTranslation();
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
  const cronJobs = useTaskSidebarStore((s) => s.cronJobs);
  const pendingSessionId = useTaskSidebarStore((s) => s.pendingSessionId);

  const navigateToSession = useCallback(async (targetSessionId: string) => {
    try {
      const isCron = targetSessionId.startsWith('cron:');
      const jobId = isCron ? targetSessionId.slice(5) : targetSessionId;

      let displayName: string;
      if (isCron) {
        displayName = useTaskSidebarStore.getState().cronJobs.find((j) => j.id === jobId)?.name ?? jobId;
      } else {
        const matchedTask = useTaskSidebarStore.getState().tasks.find((t) => t.sessionId === targetSessionId);
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
    if (!activeSessionId) return;
    useChatStreamStore.getState().setSessionId(activeSessionId);
    loadMessages(activeSessionId);

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
  const spawnRunning = spawnAgents.some((a) => a.status === 'running');
  const loading = streamLoading || spawnRunning;

  const runStreamingChat = async (text: string, sessionId: string, attachments?: Attachment[]): Promise<string> => {
    let resolveComplete: (reply: string) => void;
    let rejectComplete: (err: Error) => void;
    const completePromise = new Promise<string>((resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    });
    const unComplete = await onChatComplete((reply) => { resolveComplete(reply); });
    const unError = await onChatError((err) => { rejectComplete(new Error(err)); });
    try {
      await chatStreamStart(text, sessionId, attachments);
      const reply = await completePromise;
      return reply;
    } finally {
      unComplete();
      unError();
    }
  };

  const handleSend = async (plainText: string, mentions: MentionTag[], attachments: Attachment[]) => {
    messagesRef.current?.scrollToBottom();

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
    if (agentMentions.length > 0) {
      const agentNames = agentMentions.map(m => m.name).join(', ');
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
      await runStreamingChat(userMessage, activeSessionId, userAttachments);
      await loadMessages(activeSessionId);
      // Refresh session list to pick up auto-generated title
      await useSessionStore.getState().refreshSessions();
      // Trigger buddy observer (non-blocking)
      // Use messagesRef or re-read state to avoid stale closure
      const currentMessages = await getHistory(activeSessionId);
      const recentMsgs = (currentMessages || []).slice(-5).map((m: any) => `${m.role}: ${(m.content || '').slice(0, 200)}`);
      recentMsgs.push(`user: ${userMessage.slice(0, 200)}`);
      useBuddyStore.getState().triggerObserve(recentMsgs).catch(() => {});
    } catch (error) {
      console.error('Failed to send message:', error);
      setMessages(prev => [...prev, {
        role: 'assistant' as const,
        content: `Error: ${String(error)}`,
        timestamp: Date.now(),
      }]);
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
  const sidebarTasks = useTaskSidebarStore((s) => s.tasks);
  const isTaskSession = useMemo(
    () => sidebarTasks.some(t => t.sessionId === activeSessionId),
    [sidebarTasks, activeSessionId],
  );
  // Determine if current session is a chat session (not task/cron)
  const isChatSession = !isTaskSession && !isCronSession;
  const showWelcome = isChatSession && messages.length === 0 && !loading;

  // --- Render ---
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Drag region — replaces the tab bar */}
      <div
        data-tauri-drag-region
        className="shrink-0 app-drag-region"
        style={{ background: 'var(--color-bg)', height: '38px' }}
      />

      {/* Messages or Welcome */}
      {showWelcome ? (
        <div className="flex-1 overflow-y-auto" style={{ background: 'var(--color-bg)' }}>
          <ChatWelcome aiName={aiName} onSendPrompt={fillQuickPrompt} />
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


      {/* Input */}
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
