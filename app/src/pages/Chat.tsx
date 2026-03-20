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
  createSession,
  ensureSession,
  getHistory,
  clearHistory,
  type ChatMessage,
  type ChatSession as ApiChatSession,
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
import { useDragRegion } from '../hooks/useDragRegion';
import { toast } from '../components/Toast';

import { ChatTabBar, type OpenTab } from '../components/chat/ChatTabBar';
import { ChatWelcome } from '../components/chat/ChatWelcome';
import { ChatMessages, type ChatMessagesHandle } from '../components/chat/ChatMessages';
import { ChatInput, type ChatInputHandle } from '../components/chat/ChatInput';

import logoImg from '../assets/yiyi-logo.png';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAIN_SESSION_ID = 'main';

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

  // --- Core state ---
  const [sessions, setSessions] = useState<ApiChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([
    { id: MAIN_SESSION_ID, name: '', isMain: true },
  ]);
  // Tabs that are newly added (for entrance animation)
  const [highlightTabs, setHighlightTabs] = useState<Map<string, 'new' | 'complete' | 'fail'>>(new Map());

  // --- Refs ---
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const sessionsLoadedRef = useRef(false);
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
    if (!currentSessionId) return;
    try {
      const prevSession = await sessionBindBot(currentSessionId, botId);
      await loadBoundBots(currentSessionId);
      if (prevSession) {
        setReboundNotice(t('chat.bots.rebound'));
        setTimeout(() => setReboundNotice(''), 3000);
      }
    } catch (error) {
      console.error('Failed to bind bot:', error);
    }
  };

  const handleUnbindBot = async (botId: string) => {
    if (!currentSessionId) return;
    try {
      await sessionUnbindBot(currentSessionId, botId);
      await loadBoundBots(currentSessionId);
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

      setOpenTabs(prev => {
        if (prev.some(t => t.id === targetSessionId)) return prev;
        return [...prev, { id: targetSessionId, name: displayName, isMain: false }];
      });

      useChatStreamStore.getState().focusTask(targetSessionId, displayName, targetSessionId);
      setCurrentSessionId(targetSessionId);
    } catch (err) {
      console.error('Failed to navigate to session:', err);
    }
  }, []);

  const handleCloseTab = useCallback((tabId: string) => {
    if (tabId === MAIN_SESSION_ID) return;
    setOpenTabs(prev => prev.filter(t => t.id !== tabId));
    if (currentSessionId === tabId) {
      useChatStreamStore.getState().unfocusTask();
      setCurrentSessionId(MAIN_SESSION_ID);
    }
    toast.info('关闭标签不会删除任务，可从侧边栏再次打开');
  }, [currentSessionId]);

  const handleSelectTab = useCallback((tabId: string) => {
    if (tabId === MAIN_SESSION_ID) {
      useChatStreamStore.getState().unfocusTask();
    }
    setCurrentSessionId(tabId);
  }, []);

  const handleUnfocus = useCallback(() => {
    useChatStreamStore.getState().unfocusTask();
    setCurrentSessionId(MAIN_SESSION_ID);
  }, []);

  // --- Session loading ---
  const loadSessions = async (): Promise<string> => {
    try {
      await ensureSession(MAIN_SESSION_ID, t('chat.defaultSession'), 'chat');
      const list = await listSessions();
      setSessions(list);
      setCurrentSessionId(MAIN_SESSION_ID);
      currentSessionIdRef.current = MAIN_SESSION_ID;
      return MAIN_SESSION_ID;
    } catch (error) {
      console.error('Failed to load sessions:', error);
      return '';
    }
  };

  useEffect(() => {
    (async () => {
      await loadSessions();
      sessionsLoadedRef.current = true;
      const ctx = consumeNotifContext?.();
      if (ctx?.page === 'chat' && ctx?.session_id) {
        setCurrentSessionId(ctx.session_id as string);
        return;
      }
      const pending = useTaskSidebarStore.getState().consumePendingSession();
      if (pending) await navigateToSession(pending);
    })();
  }, []);

  useEffect(() => {
    if (!pendingSessionId || !sessionsLoadedRef.current) return;
    useTaskSidebarStore.getState().consumePendingSession();
    navigateToSession(pendingSessionId);
  }, [pendingSessionId, navigateToSession]);

  // --- Add tab without switching (task created in background) ---
  const pendingNewTab = useTaskSidebarStore((s) => s.pendingNewTab);
  useEffect(() => {
    if (!pendingNewTab || !sessionsLoadedRef.current) return;
    const tab = useTaskSidebarStore.getState().consumePendingNewTab();
    if (!tab) return;
    // Ensure session exists
    ensureSession(tab.id, tab.name, 'chat').catch(() => {});
    // Add tab without switching
    setOpenTabs(prev => {
      if (prev.some(t => t.id === tab.id)) return prev;
      return [...prev, { id: tab.id, name: tab.name, isMain: false }];
    });
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
  }, [pendingNewTab]);

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
    if (!currentSessionId) return;
    useChatStreamStore.getState().setSessionId(currentSessionId);
    loadMessages(currentSessionId);
    loadBoundBots(currentSessionId);

    invoke('chat_stream_state', { sessionId: currentSessionId })
      .then((snapshot: any) => {
        if (snapshot && snapshot.is_active) {
          useChatStreamStore.getState().recoverFromSnapshot(snapshot);
        } else {
          useChatStreamStore.getState().resetStream();
        }
      })
      .catch(() => { useChatStreamStore.getState().resetStream(); });
  }, [currentSessionId]);

  // Refresh on bot activity
  useEffect(() => {
    if (!currentSessionId) return;
    const unlistenResponse = listen<{ session_id: string }>('bot://response', (event) => {
      if (event.payload.session_id === currentSessionId) loadMessages(currentSessionId);
    });
    const unlistenMessage = listen<{ bot_id: string }>('bot://message', (event) => {
      if (boundBots.some(b => b.id === event.payload.bot_id)) {
        setTimeout(() => loadMessages(currentSessionId), 500);
      }
    });
    const unlistenEarlyReply = listen<{ session_id: string }>('bot://early-reply', (event) => {
      if (event.payload.session_id === currentSessionId) loadMessages(currentSessionId);
    });
    return () => {
      unlistenResponse.then(fn => fn());
      unlistenMessage.then(fn => fn());
      unlistenEarlyReply.then(fn => fn());
    };
  }, [currentSessionId, boundBots]);

  // Tray new session
  const handleNewSession = async () => {
    try {
      const session = await createSession(`${t('chat.newSession')} ${sessions.length}`);
      setSessions(prev => [...prev, session]);
      setCurrentSessionId(session.id);
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  useEffect(() => {
    const unlisten = listen('tray://new-session', () => handleNewSession());
    return () => { unlisten.then(fn => fn()); };
  }, [sessions]);

  // Sidebar "聊天" click → switch to main session
  useEffect(() => {
    const handler = () => handleUnfocus();
    window.addEventListener('chat:go-main', handler);
    return () => window.removeEventListener('chat:go-main', handler);
  }, [handleUnfocus]);

  // Spawn complete
  useEffect(() => {
    const unlisten = listen<{ session_id: string }>('chat://spawn_complete', (event) => {
      if (event.payload.session_id === currentSessionId) loadMessages(currentSessionId);
    });
    return () => { unlisten.then(fn => fn()); };
  }, [currentSessionId]);

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
      await runStreamingChat(userMessage, currentSessionId, userAttachments);
      await loadMessages(currentSessionId);
      const list = await listSessions();
      setSessions(list);
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

  const sendQuickPrompt = async (prompt: string) => {
    if (loading) return;
    useChatStreamStore.getState().startStream();
    setMessages(prev => [...prev, { role: 'user' as const, content: prompt, timestamp: Date.now() }]);
    try {
      await runStreamingChat(prompt, currentSessionId);
      useChatStreamStore.getState().clearStreamState();
      await loadMessages(currentSessionId);
      const list = await listSessions();
      setSessions(list);
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
        await clearHistory(currentSessionId);
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
      case 'back':
        handleUnfocus();
        break;
    }
  }, [currentSessionId, navigateToSession, handleUnfocus, t]);

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
                background: 'rgba(255,255,255,0.2)', color: '#FFFFFF',
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

  const isCronSession = currentSessionId.startsWith('cron:');
  const cronJobId = isCronSession ? currentSessionId.slice(5) : '';
  const sidebarTasks = useTaskSidebarStore((s) => s.tasks);
  const isTaskSession = useMemo(
    () => currentSessionId !== MAIN_SESSION_ID && sidebarTasks.some(t => t.sessionId === currentSessionId),
    [sidebarTasks, currentSessionId],
  );
  const isMainSession = currentSessionId === MAIN_SESSION_ID;
  const showWelcome = isMainSession && messages.length === 0 && !loading;

  // --- Render ---
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <ChatTabBar
        tabs={openTabs}
        currentTabId={currentSessionId}
        aiName={aiName}
        healthStatus={healthStatus}
        highlightTabs={highlightTabs}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
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
              style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', minWidth: '260px' }}>
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
          currentSessionId={currentSessionId}
          isTaskSession={isTaskSession}
          isCronSession={isCronSession}
          cronJobId={cronJobId}
          aiName={aiName}
          boundBots={boundBots}
          allBots={allBots}
          loading={loading}
          onOpenLightbox={openLightbox}
          onUnfocus={handleUnfocus}
          onSendPrompt={sendQuickPrompt}
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
          style={{ background: 'rgba(0,0,0,0.85)' }} onClick={() => setLightboxSrc(null)}>
          <button className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full transition-colors"
            style={{ background: 'rgba(255,255,255,0.15)', color: '#fff' }} onClick={() => setLightboxSrc(null)}>
            <X size={20} />
          </button>
          <img src={lightboxSrc} className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
            style={{ objectFit: 'contain' }} alt="preview" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
