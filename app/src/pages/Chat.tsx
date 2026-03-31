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
import {
  listBots,
  sessionListBots,
  sessionBindBot,
  sessionUnbindBot,
  type BotInfo,
} from '../api/bots';
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

import { ChatTabBar, type OpenTab } from '../components/chat/ChatTabBar';
import { ChatWelcome } from '../components/chat/ChatWelcome';
import { ChatMessages, type ChatMessagesHandle } from '../components/chat/ChatMessages';
import { ChatInput, type ChatInputHandle } from '../components/chat/ChatInput';

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
  const openTabIds = useSessionStore((s) => s.openTabIds);
  const chatSessions = useSessionStore((s) => s.chatSessions);
  const initialized = useSessionStore((s) => s.initialized);

  // --- Core state ---
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Tabs that are newly added (for entrance animation)
  const [highlightTabs, setHighlightTabs] = useState<Map<string, 'new' | 'complete' | 'fail'>>(new Map());

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
      if (match?.[1]) setAiName(match[1].trim());
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

  // --- Bot state ---
  const [boundBots, setBoundBots] = useState<BotInfo[]>([]);
  const [allBots, setAllBots] = useState<BotInfo[]>([]);
  const [showBotPopover, setShowBotPopover] = useState(false);
  const [reboundNotice, setReboundNotice] = useState('');
  const botPopoverRef = useRef<HTMLDivElement>(null);

  const refreshAllBots = useCallback(() => {
    listBots().then(setAllBots).catch(() => setAllBots([]));
  }, []);

  useEffect(() => { refreshAllBots(); }, []);

  const loadBoundBots = async (sessionId: string) => {
    try {
      const bots = await sessionListBots(sessionId);
      setBoundBots(bots);
    } catch { setBoundBots([]); }
  };

  const handleBindBot = async (botId: string) => {
    if (!activeSessionId) return;
    try {
      const prevSession = await sessionBindBot(activeSessionId, botId);
      await loadBoundBots(activeSessionId);
      if (prevSession) {
        setReboundNotice(t('chat.bots.rebound'));
        setTimeout(() => setReboundNotice(''), 3000);
      }
    } catch (error) {
      console.error('Failed to bind bot:', error);
    }
  };

  const handleUnbindBot = async (botId: string) => {
    if (!activeSessionId) return;
    try {
      await sessionUnbindBot(activeSessionId, botId);
      await loadBoundBots(activeSessionId);
    } catch (error) {
      console.error('Failed to unbind bot:', error);
    }
  };

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (botPopoverRef.current && !botPopoverRef.current.contains(e.target as Node)) {
        setShowBotPopover(false);
      }
    };
    if (showBotPopover) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showBotPopover]);

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

  const handleCloseTab = useCallback((tabId: string) => {
    const { openTabIds } = useSessionStore.getState();
    // If it's a task/cron tab, unfocus
    const sidebarTasks = useTaskSidebarStore.getState().tasks;
    const isTask = sidebarTasks.some(t => t.sessionId === tabId) || tabId.startsWith('cron:');
    if (isTask) {
      useChatStreamStore.getState().unfocusTask();
    }
    useSessionStore.getState().closeTab(tabId);
    toast.info('关闭标签不会删除对话，可从侧边栏再次打开');
  }, []);

  const handleSelectTab = useCallback((tabId: string) => {
    const sidebarTasks = useTaskSidebarStore.getState().tasks;
    const isTask = sidebarTasks.some(t => t.sessionId === tabId) || tabId.startsWith('cron:');
    if (!isTask) {
      useChatStreamStore.getState().unfocusTask();
    }
    useSessionStore.getState().switchToSession(tabId);
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

  // --- Add tab without switching (task created in background) ---
  const pendingNewTab = useTaskSidebarStore((s) => s.pendingNewTab);
  useEffect(() => {
    if (!pendingNewTab || !initialized) return;
    const tab = useTaskSidebarStore.getState().consumePendingNewTab();
    if (!tab) return;
    // Ensure session exists
    ensureSession(tab.id, tab.name, 'chat').catch(() => {});
    // Add tab without switching
    useSessionStore.getState().addTab(tab.id);
    // Highlight the new tab
    setHighlightTabs(prev => {
      const next = new Map(prev);
      next.set(tab.id, 'new');
      return next;
    });
    // Clear highlight after animation
    setTimeout(() => {
      setHighlightTabs(prev => {
        const next = new Map(prev);
        next.delete(tab.id);
        return next;
      });
    }, 3000);
  }, [pendingNewTab, initialized]);

  // --- Tab notification (task complete/fail) ---
  const pendingTabNotify = useTaskSidebarStore((s) => s.pendingTabNotify);
  useEffect(() => {
    if (!pendingTabNotify) return;
    const n = useTaskSidebarStore.getState().consumeTabNotify();
    if (!n) return;
    setHighlightTabs(prev => {
      const next = new Map(prev);
      next.set(n.id, n.type);
      return next;
    });
    setTimeout(() => {
      setHighlightTabs(prev => {
        const next = new Map(prev);
        next.delete(n.id);
        return next;
      });
    }, 4000);
  }, [pendingTabNotify]);

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
    loadBoundBots(activeSessionId);

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

  // Refresh on bot activity
  useEffect(() => {
    if (!activeSessionId) return;
    const unlistenResponse = listen<{ session_id: string }>('bot://response', (event) => {
      if (event.payload.session_id === activeSessionId) loadMessages(activeSessionId);
    });
    const unlistenMessage = listen<{ bot_id: string }>('bot://message', (event) => {
      if (boundBots.some(b => b.id === event.payload.bot_id)) {
        setTimeout(() => loadMessages(activeSessionId), 500);
      }
    });
    const unlistenEarlyReply = listen<{ session_id: string }>('bot://early-reply', (event) => {
      if (event.payload.session_id === activeSessionId) loadMessages(activeSessionId);
    });
    return () => {
      unlistenResponse.then(fn => fn());
      unlistenMessage.then(fn => fn());
      unlistenEarlyReply.then(fn => fn());
    };
  }, [activeSessionId, boundBots]);

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
    await chatStreamStart(text, sessionId, attachments);
    const reply = await completePromise;
    unComplete();
    unError();
    return reply;
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

    // Bind @mentioned bots
    const botMentions = mentions.filter(m => m.type === 'bot');
    for (const bm of botMentions) await handleBindBot(bm.id);

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
    const knownNames = new Set([...boundBots.map(b => b.name), ...allBots.map(b => b.name)]);
    const parts: React.ReactNode[] = [];
    let remaining = text;
    let key = 0;
    while (remaining.length > 0) {
      const atIdx = remaining.indexOf('@');
      if (atIdx === -1) { parts.push(remaining); break; }
      if (atIdx > 0) parts.push(remaining.slice(0, atIdx));
      const afterAt = remaining.slice(atIdx + 1);
      let matched = false;
      for (const name of knownNames) {
        if (afterAt.startsWith(name)) {
          const charAfter = afterAt[name.length];
          if (!charAfter || /[\s,，.。!！?？)）\]】]/.test(charAfter)) {
            parts.push(
              <span key={`mention-${key++}`} style={{
                background: 'rgba(255,255,255,0.2)', color: 'var(--color-bg)',
                padding: '1px 6px', borderRadius: '6px', fontWeight: 600, fontSize: '13px', whiteSpace: 'nowrap',
              }}>@{name}</span>,
            );
            remaining = afterAt.slice(name.length);
            matched = true;
            break;
          }
        }
      }
      if (!matched) { parts.push('@'); remaining = afterAt; }
    }
    return <>{parts}</>;
  }, [boundBots, allBots]);

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

  // --- Derived state ---
  // --- Meditation status ---
  const [meditationStatus, setMeditationStatus] = useState<'idle' | 'running' | 'completed' | null>(null);

  useEffect(() => {
    const checkMeditation = () => {
      invoke('get_meditation_status').then((status: any) => {
        if (status && (status === 'running' || status === 'completed')) {
          setMeditationStatus(status);
          if (status === 'completed') {
            setTimeout(() => setMeditationStatus(null), 5000);
          }
        } else {
          setMeditationStatus(null);
        }
      }).catch(() => {});
    };
    checkMeditation();
    const interval = setInterval(checkMeditation, 30_000);
    return () => clearInterval(interval);
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

  // Build OpenTab[] from openTabIds
  const openTabs: OpenTab[] = useMemo(() => {
    const sessionMap = new Map(chatSessions.map(s => [s.id, s]));
    const taskMap = new Map(sidebarTasks.map(t => [t.sessionId, t]));
    return openTabIds.map(id => {
      const session = sessionMap.get(id);
      if (session) return { id, name: session.name };
      const task = taskMap.get(id);
      if (task) return { id, name: task.title };
      if (id.startsWith('cron:')) {
        const jobId = id.slice(5);
        const job = cronJobs.find(j => j.id === jobId);
        return { id, name: job?.name || jobId };
      }
      return { id, name: id };
    });
  }, [openTabIds, chatSessions, sidebarTasks, cronJobs]);

  const handleNewChat = useCallback(() => {
    useSessionStore.getState().createNewChat();
  }, []);

  // --- Render ---
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <ChatTabBar
        tabs={openTabs}
        currentTabId={activeSessionId}
        highlightTabs={highlightTabs}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onNewChat={handleNewChat}
      />

      {/* Bot binding bar */}
      <div
        className="shrink-0 flex items-center gap-2 px-4 py-1.5"
        style={{ background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)', minHeight: '32px' }}
      >
        <div className="relative" ref={botPopoverRef}>
          <button
            onClick={() => { if (!showBotPopover) refreshAllBots(); setShowBotPopover(!showBotPopover); }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors text-[12px]"
            style={{
              color: boundBots.length > 0 ? 'var(--color-primary)' : 'var(--color-text-tertiary)',
              background: showBotPopover ? 'var(--color-bg-elevated)' : 'transparent',
            }}
            onMouseEnter={(e) => { if (!showBotPopover) e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}
            onMouseLeave={(e) => { if (!showBotPopover) e.currentTarget.style.background = 'transparent'; }}
          >
            <span>{boundBots.length > 0 ? `${t('chat.bots.bound')} (${boundBots.length})` : t('chat.bots.bind')}</span>
          </button>

          {showBotPopover && (
            <div className="absolute left-0 top-full mt-1 rounded-xl shadow-lg z-50 overflow-hidden"
              style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', minWidth: 'min(260px, 80vw)' }}>
              {boundBots.length > 0 && (
                <div className="p-2">
                  <div className="text-[11px] font-medium px-2 py-1" style={{ color: 'var(--color-text-muted)' }}>{t('chat.bots.bound')}</div>
                  {boundBots.map((bot) => (
                    <div key={bot.id} className="flex items-center justify-between px-2 py-1.5 rounded-lg"
                      style={{ background: 'var(--color-primary-subtle)' }}>
                      <span className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>{bot.name}</span>
                      <button onClick={() => handleUnbindBot(bot.id)}
                        className="text-[11px] px-2 py-0.5 rounded transition-colors"
                        style={{ color: 'var(--color-text-muted)' }}>
                        解绑
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {(() => {
                const boundIds = new Set(boundBots.map(b => b.id));
                const available = allBots.filter(b => !boundIds.has(b.id) && b.enabled);
                return available.length > 0 ? (
                  <div className="p-2" style={{ borderTop: boundBots.length > 0 ? '1px solid var(--color-border)' : 'none' }}>
                    {available.map((bot) => (
                      <button key={bot.id} onClick={() => handleBindBot(bot.id)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors text-left text-[13px]"
                        style={{ color: 'var(--color-text)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                        {bot.name}
                        <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text-muted)' }}>
                          {bot.platform}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null;
              })()}
              <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--color-text-tertiary)', borderTop: '1px solid var(--color-border)' }}>
                {t('chat.bots.bindHint')}
              </div>
            </div>
          )}
        </div>

        {boundBots.map((bot) => (
          <span key={bot.id} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px]"
            style={{ background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}>
            {bot.name}
          </span>
        ))}

        {reboundNotice && (
          <span className="text-[11px] ml-auto" style={{ color: 'var(--color-warning, #f59e0b)' }}>{reboundNotice}</span>
        )}
      </div>

      {/* Messages or Welcome */}
      {showWelcome ? (
        <div className="flex-1 overflow-y-auto" style={{ background: 'var(--color-bg)' }}>
          <ChatWelcome aiName={aiName} onSendPrompt={sendQuickPrompt} />
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
          boundBots={boundBots}
          allBots={allBots}
          loading={loading}
          onOpenLightbox={openLightbox}
          onUnfocus={handleGoToRecentChat}
          onSendPrompt={sendQuickPrompt}
          onCanvasAction={handleCanvasAction}
          renderUserContent={renderUserContent}
        />
      )}

      {/* Meditation status indicator */}
      {meditationStatus === 'running' && (
        <div className="flex items-center gap-2 px-4 py-2 text-[13px] rounded-xl mx-4 mb-2"
          style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
          <span className="animate-pulse">&#x1F9D8;</span>
          <span>{t('settings.meditationRunning')}</span>
        </div>
      )}
      {meditationStatus === 'completed' && (
        <div className="flex items-center gap-2 px-4 py-2 text-[13px] rounded-xl mx-4 mb-2"
          style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-success)' }}>
          <span>&#x2728;</span>
          <span>{t('settings.meditationComplete')}</span>
        </div>
      )}

      {/* Input */}
      <ChatInput
        ref={inputRef}
        loading={loading}
        allBots={allBots}
        workspaceFiles={workspaceFiles}
        onSend={handleSend}
        onStop={handleStop}
        onSelectCommand={executeCommand}
        onSelectTask={(task) => navigateToSession(task.sessionId)}
        onMentionBotSelect={(bot) => handleBindBot(bot.id)}
        onFileSelect={() => {}}
        onFetchWorkspaceFiles={fetchWorkspaceFiles}
        onRefreshBots={refreshAllBots}
      />

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
