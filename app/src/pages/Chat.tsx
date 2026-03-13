/**
 * Chat Page
 * Chrome-style session tabs + rich empty state
 *
 * SINGLE_WINDOW_MODE: When true, hides session tabs and auto-creates/selects
 * a default "main" session. The multi-session data layer is preserved.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Send,
  User,
  Bot,
  Copy,
  Check,
  Loader2,
  Plus,
  X,
  MessageSquare,
  Zap,
  Puzzle,
  Terminal,
  Link2,
  Unlink,
  ChevronDown,
  ChevronRight,
  Trash2,
  ZoomIn,
  Paperclip,
  FileText,
  Mic,
  CheckCircle2,
  Square,
  Brain,
  ClipboardList,
  Clock,
  BarChart3,
} from 'lucide-react';
import {
  chatStreamStart,
  chatStreamStop,
  onChatComplete,
  onChatError,
  listSessions,
  createSession,
  ensureSession,
  deleteSession,
  getHistory,
  clearHistory,
  deleteMessage,
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
import { MentionPicker, buildMentionList } from '../components/MentionPicker';
import { MentionInput, type MentionInputHandle, type MentionTag } from '../components/MentionInput';
import { SlashCommandPicker, filterCommands, SLASH_COMMANDS, type SlashCommand } from '../components/SlashCommandPicker';
import { SpawnAgentPanel } from '../components/SpawnAgentPanel';
import { ToolCallPanel, HistorySpawnAgentsPanel } from '../components/ToolCallPanel';
import { TaskCard } from '../components/TaskCard';
import { LongTaskProgressPanel, RoundDivider } from '../components/LongTaskPanel';
import { BackgroundTaskCard } from '../components/BackgroundTaskCard';
import { CronJobSessionView } from '../components/CronJobSessionView';
import { listAllTasksBrief, getTaskByName } from '../api/tasks';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useChatStreamStore } from '../stores/chatStreamStore';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useDragRegion } from '../hooks/useDragRegion';
import { useVoiceInput } from '../hooks/useVoiceInput';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

import type { SpawnAgent } from '../stores/chatStreamStore';
import logoImg from '../assets/yiyi-logo.png';
import logoFaceRight from '../assets/yiyi-logo-face-right.png';

interface BackgroundTaskProposal {
  task_name: string;
  task_description: string;
  context_summary: string;
  estimated_steps?: number;
}

interface ProcessedMsg {
  msg: ChatMessage;
  historyTools?: { id: number; name: string; status: 'done'; preview?: string; resultPreview?: string }[];
  historyAgents?: { name: string; result: string; is_error?: boolean }[];
  /** Task IDs extracted from create_task tool calls in this message chain */
  taskIds?: string[];
  /** Background task proposals extracted from propose_background_task tool calls */
  backgroundProposals?: BackgroundTaskProposal[];
}

interface ChatPageProps {
  consumeNotifContext?: () => Record<string, unknown> | null;
}

/** Collapsible thinking/reasoning block for assistant messages */
function ThinkingBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div
      className="rounded-xl text-[13px] overflow-hidden"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
      }}
    >
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center gap-1.5 w-full px-3 py-2 text-left"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <Brain size={14} />
        <span>{streaming ? '思考中…' : '思考过程'}</span>
      </button>
      {!collapsed && (
        <div
          className="px-3 pb-2 whitespace-pre-wrap break-words leading-relaxed"
          style={{
            color: 'var(--color-text-muted)',
            maxHeight: '200px',
            overflowY: 'auto',
          }}
        >
          {content}
          {streaming && (
            <span className="yiyi-working">
              <img src={logoFaceRight} alt="" width={24} height={24} />
              <span className="yiyi-dots"><span /><span /><span /></span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Hide session tab bar and auto-select a single main session */
const SINGLE_WINDOW_MODE = true;

export function ChatPage({ consumeNotifContext }: ChatPageProps) {
  const { t } = useTranslation();
  const drag = useDragRegion();
  // Voice input — disabled pending fixes (Whisper WASM + WKWebView compat)
  // const handleVoiceResult = useCallback((text: string) => {
  //   inputRef.current?.insertText(text);
  // }, []);
  // const { status: voiceStatus, modelProgress, toggleRecording, error: voiceError } = useVoiceInput(handleVoiceResult);
  const [sessions, setSessions] = useState<ApiChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState('');
  const [mainSessionId, setMainSessionId] = useState(''); // always tracks the "home" session
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState('');

  // Process messages: merge consecutive assistant(tool_calls)+tool sequences into one block
  const processedMessages = useMemo<ProcessedMsg[]>(() => {
    const result: ProcessedMsg[] = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.role === 'tool') { i++; continue; } // handled as part of parent

      // Detect a ReAct chain: consecutive assistant(tool_calls) → tool(s) → ... → assistant(final)
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const allTools: ProcessedMsg['historyTools'] & {} = [];
        let toolIdCounter = 0;
        let j = i;

        // Walk through the chain: assistant(tc) + tool results + assistant(tc) + tool results + ...
        while (j < messages.length) {
          const cur = messages[j];
          if (cur.role === 'assistant' && cur.tool_calls && cur.tool_calls.length > 0) {
            for (const tc of cur.tool_calls) {
              toolIdCounter++;
              const toolMsg = messages.slice(j + 1).find(
                (m) => m.role === 'tool' && m.tool_call_id === tc.id
              );
              allTools.push({
                id: toolIdCounter,
                name: tc.name,
                status: 'done' as const,
                preview: tc.arguments.length > 100 ? tc.arguments.slice(0, 100) + '...' : tc.arguments,
                resultPreview: toolMsg?.content?.slice(0, 200),
              });
            }
            j++;
          } else if (cur.role === 'tool') {
            j++; // skip tool messages (already collected above)
          } else {
            break; // hit a non-tool-chain message
          }
        }

        // Extract task IDs and background proposals from tool calls
        const taskIds: string[] = [];
        const backgroundProposals: BackgroundTaskProposal[] = [];
        const regularTools = allTools.filter((tool) => {
          if (tool.name === 'create_task' && tool.resultPreview) {
            try {
              const parsed = JSON.parse(tool.resultPreview);
              if (parsed.id) { taskIds.push(parsed.id); return false; }
            } catch { /* result may not be JSON, keep as regular tool */ }
          }
          if (tool.name === 'propose_background_task' && tool.resultPreview) {
            try {
              const parsed = JSON.parse(tool.resultPreview);
              if (parsed.__type === 'propose_background_task') {
                backgroundProposals.push(parsed as BackgroundTaskProposal);
                return false;
              }
            } catch { /* keep as regular tool */ }
          }
          return true;
        });

        // The final message in the chain: either the next assistant(no tools) or the last assistant(with tools)
        // Find the final text response that follows this tool chain
        const finalMsg = (j < messages.length && messages[j].role === 'assistant' && !messages[j].tool_calls?.length)
          ? messages[j] : null;

        if (finalMsg) {
          result.push({
            msg: finalMsg,
            historyTools: regularTools,
            historyAgents: finalMsg.spawn_agents?.length ? finalMsg.spawn_agents : undefined,
            taskIds: taskIds.length > 0 ? taskIds : undefined,
            backgroundProposals: backgroundProposals.length > 0 ? backgroundProposals : undefined,
          });
          i = j + 1;
        } else {
          // No final text reply yet (chain ended at last tool-calling assistant)
          // Use the last assistant message's content
          result.push({
            msg: messages[j - 1],
            historyTools: regularTools,
            taskIds: taskIds.length > 0 ? taskIds : undefined,
            backgroundProposals: backgroundProposals.length > 0 ? backgroundProposals : undefined,
          });
          i = j;
        }
        continue;
      }
      // Assistant with spawn_agents → render as team results panel
      if (msg.role === 'assistant' && msg.spawn_agents && msg.spawn_agents.length > 0) {
        result.push({ msg, historyAgents: msg.spawn_agents });
      } else {
        result.push({ msg });
      }
      i++;
    }
    return result;
  }, [messages]);

  const streamLoading = useChatStreamStore((s) => s.loading);
  const streamingContent = useChatStreamStore((s) => s.streamingContent);
  const streamingThinking = useChatStreamStore((s) => s.streamingThinking);
  const activeTools = useChatStreamStore((s) => s.activeTools);
  const claudeCode = useChatStreamStore((s) => s.claudeCode);
  const spawnAgents = useChatStreamStore((s) => s.spawnAgents);
  const collapsedAgents = useChatStreamStore((s) => s.collapsedAgents);
  const toggleCollapseAgent = useChatStreamStore((s) => s.toggleCollapseAgent);
  const streamError = useChatStreamStore((s) => s.errorMessage);
  const longTask = useChatStreamStore((s) => s.longTask);
  const focusedTask = useChatStreamStore((s) => s.focusedTask);
  // Treat as loading when streaming OR spawn agents are still running
  const spawnRunning = spawnAgents.some((a) => a.status === 'running');

  const loading = streamLoading || spawnRunning;
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const inputRef = useRef<MentionInputHandle>(null);
  const [aiName, setAiName] = useState('YiYiClaw');
  const [boundBots, setBoundBots] = useState<BotInfo[]>([]);
  const [allBots, setAllBots] = useState<BotInfo[]>([]);
  const [showBotPopover, setShowBotPopover] = useState(false);
  const [reboundNotice, setReboundNotice] = useState('');
  const botPopoverRef = useRef<HTMLDivElement>(null);

  const [pendingImages, setPendingImages] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [expandedAction, setExpandedAction] = useState<number | null>(null);

  // @-mention state
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [filePickerQuery, setFilePickerQuery] = useState('');
  const [filePickerIndex, setFilePickerIndex] = useState(0);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceBasePath, setWorkspaceBasePath] = useState('');

  // /slash-command state
  const [showCommandPicker, setShowCommandPicker] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandPickerIndex, setCommandPickerIndex] = useState(0);

  // /focus task suggestion state
  const [showTaskPicker, setShowTaskPicker] = useState(false);
  const [taskPickerQuery, setTaskPickerQuery] = useState('');
  const [taskPickerIndex, setTaskPickerIndex] = useState(0);
  const [taskSuggestions, setTaskSuggestions] = useState<{ id: string; title: string; status: string; sessionId: string }[]>([]);
  const skipTaskPickerCloseRef = useRef(false);

  // Session ID to return to when unfocusing from a task
  const preFocusSessionIdRef = useRef<string>('');
  // Always-fresh ref for currentSessionId (avoids stale closures in effects)
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  // Close lightbox on Escape
  useEffect(() => {
    if (!lightboxSrc) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxSrc(null);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [lightboxSrc]);

  const openLightbox = useCallback((att: Attachment) => {
    setLightboxSrc(`data:${att.mimeType};base64,${att.data}`);
  }, []);

  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
  const MAX_ATTACHMENTS = 10;
  const COMPRESS_THRESHOLD = 1024 * 1024; // 1MB — compress images larger than this
  const MAX_DIMENSION = 1920;
  const COMPRESS_QUALITY = 0.85;

  const isImageMime = (mime: string) => mime.startsWith('image/');

  /** Compress an image using Canvas. Returns a base64 string (no prefix). */
  const compressImage = (file: File): Promise<{ base64: string; mimeType: string } | null> => {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
          const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, width, height);
        const outputMime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const quality = outputMime === 'image/jpeg' ? COMPRESS_QUALITY : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];
        resolve(base64 ? { base64, mimeType: outputMime } : null);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  };

  /** Read a file as base64 Attachment. Supports images (with compression) and any other file type. */
  const readFileAsAttachment = async (file: File): Promise<Attachment | null> => {
    if (file.size > MAX_FILE_SIZE) return null;

    // Images: compress if large
    if (isImageMime(file.type) && file.size > COMPRESS_THRESHOLD) {
      const compressed = await compressImage(file);
      if (compressed) {
        return { mimeType: compressed.mimeType, data: compressed.base64, name: file.name };
      }
    }

    // Read as base64 (images and all file types)
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1];
        resolve(base64
          ? { mimeType: file.type || 'application/octet-stream', data: base64, name: file.name }
          : null
        );
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  };

  const addAttachments = async (files: FileList | File[]) => {
    const remaining = MAX_ATTACHMENTS - pendingImages.length;
    const toProcess = Array.from(files).slice(0, remaining);
    const results = await Promise.all(toProcess.map(readFileAsAttachment));
    const valid = results.filter((r): r is Attachment => r !== null);
    if (valid.length > 0) {
      setPendingImages((prev) => [...prev, ...valid]);
    }
  };

  const removeImage = (idx: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== idx));
  };

  // Load all available bots on mount and when popover opens
  const refreshAllBots = useCallback(() => {
    listBots().then(setAllBots).catch(() => setAllBots([]));
  }, []);

  // Fetch workspace files for @-mention picker (cached, refreshed on open)
  const fetchWorkspaceFiles = useCallback(async () => {
    try {
      const [files, basePath] = await Promise.all([listWorkspaceFiles(), getWorkspacePath()]);
      setWorkspaceFiles(files.filter(f => !f.is_dir)); // only files, not dirs
      setWorkspaceBasePath(basePath);
    } catch {
      // ignore — workspace might not exist yet
    }
  }, []);

  // MentionInput callbacks
  const handleMentionTrigger = useCallback((query: string) => {
    setShowFilePicker(true);
    setFilePickerQuery(query);
    setFilePickerIndex(0);
    if (workspaceFiles.length === 0) fetchWorkspaceFiles();
    if (allBots.length === 0) refreshAllBots();
  }, [workspaceFiles.length, allBots.length, fetchWorkspaceFiles, refreshAllBots]);

  const handleMentionDismiss = useCallback(() => {
    setShowFilePicker(false);
  }, []);

  const handleMentionBotSelect = (bot: BotInfo) => {
    inputRef.current?.insertMention({ type: 'bot', id: bot.id, name: bot.name });
  };

  const handleFileSelect = (file: WorkspaceFile) => {
    inputRef.current?.insertMention({ type: 'file', id: file.path, name: file.name });
  };

  const refreshAiName = () => {
    loadWorkspaceFile('SOUL.md').then((content) => {
      const match = content.match(/^---\s*\nname:\s*(.+)\s*\n/m);
      if (match?.[1]) setAiName(match[1].trim());
    }).catch(() => {});
  };

  // Load AI name from SOUL.md, and refresh when agent modifies it
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

  // Load sessions + handle pending navigation (cron job clicks, notifications)
  const cronJobs = useTaskSidebarStore((s) => s.cronJobs);
  const pendingSessionId = useTaskSidebarStore((s) => s.pendingSessionId);
  const sessionsLoadedRef = useRef(false);

  // Reusable: navigate to a specific session with focus/unfocus support
  // mainSessionId can be passed explicitly (e.g. right after loadSessions before re-render)
  const navigateToSession = useCallback(async (targetSessionId: string, mainSessionId?: string) => {
    try {
      const isCron = targetSessionId.startsWith('cron:');
      const jobId = isCron ? targetSessionId.slice(5) : targetSessionId;

      // Resolve display name: cron job name or task title
      let displayName: string;
      if (isCron) {
        displayName = useTaskSidebarStore.getState().cronJobs.find((j) => j.id === jobId)?.name ?? jobId;
      } else {
        const matchedTask = useTaskSidebarStore.getState().tasks.find((t) => t.sessionId === targetSessionId);
        displayName = matchedTask?.title ?? targetSessionId;
      }

      const sessionName = isCron ? `[Cron] ${displayName}` : displayName;
      await ensureSession(
        targetSessionId,
        sessionName,
        isCron ? 'cronjob' : 'chat',
        isCron ? jobId : undefined,
      );
      const mainId = mainSessionId || currentSessionIdRef.current;
      if (mainId && mainId !== targetSessionId) {
        preFocusSessionIdRef.current = mainId;
        useChatStreamStore.getState().focusTask(targetSessionId, displayName, targetSessionId);
      }
      setCurrentSessionId(targetSessionId);
    } catch (err) {
      console.error('Failed to navigate to session:', err);
    }
  }, []);

  // On mount: load sessions, then handle pending navigation
  useEffect(() => {
    (async () => {
      const mainId = await loadSessions();
      sessionsLoadedRef.current = true;

      const ctx = consumeNotifContext?.();
      if (ctx?.page === 'chat' && ctx?.session_id) {
        setCurrentSessionId(ctx.session_id as string);
        return;
      }
      // Consume pending session set before mount (e.g. page switch from settings)
      const pending = useTaskSidebarStore.getState().consumePendingSession();
      if (pending) await navigateToSession(pending, mainId);
    })();
  }, []);

  const loadSessions = async (): Promise<string> => {
    try {
      const list = await listSessions();
      let id: string;
      if (list.length === 0) {
        const name = SINGLE_WINDOW_MODE ? t('chat.defaultSession') : t('chat.defaultSession');
        const session = await createSession(name);
        setSessions([session]);
        id = session.id;
      } else {
        setSessions(list);
        // Pick the first non-cron session as main, fallback to first
        const main = list.find((s) => !s.id.startsWith('cron:')) || list[0];
        id = main.id;
      }
      setCurrentSessionId(id);
      setMainSessionId(id);
      currentSessionIdRef.current = id;
      return id;
    } catch (error) {
      console.error('Failed to load sessions:', error);
      return '';
    }
  };

  // Handle pending session changes while already on chat page
  useEffect(() => {
    if (!pendingSessionId || !sessionsLoadedRef.current) return;
    useTaskSidebarStore.getState().consumePendingSession();
    navigateToSession(pendingSessionId);
  }, [pendingSessionId, navigateToSession]);

  // Load messages and bound bots when session changes; sync store session
  useEffect(() => {
    if (!currentSessionId) return;
    useChatStreamStore.getState().setSessionId(currentSessionId);
    loadMessages(currentSessionId);
    loadBoundBots(currentSessionId);

    // Check if there's an active stream for this session (handles page-switch recovery).
    // We recover from the backend snapshot INSTEAD of resetting, so no chunks are lost
    // between mount and the snapshot response.
    invoke('chat_stream_state', { sessionId: currentSessionId })
      .then((snapshot: any) => {
        if (snapshot && snapshot.is_active) {
          useChatStreamStore.getState().recoverFromSnapshot(snapshot);
        } else {
          useChatStreamStore.getState().resetStream();
        }
      })
      .catch(() => {
        useChatStreamStore.getState().resetStream();
      });
  }, [currentSessionId]);

  // Refresh messages when bot activity happens for the current session
  useEffect(() => {
    if (!currentSessionId) return;
    const unlistenResponse = listen<{ session_id: string }>('bot://response', (event) => {
      if (event.payload.session_id === currentSessionId) {
        loadMessages(currentSessionId);
      }
    });
    const unlistenMessage = listen<{ bot_id: string }>('bot://message', (event) => {
      // If any of our bound bots received a message, refresh after a short delay
      // (wait for process_message to save the user message to DB)
      if (boundBots.some(b => b.id === event.payload.bot_id)) {
        setTimeout(() => loadMessages(currentSessionId), 500);
      }
    });
    const unlistenEarlyReply = listen<{ session_id: string }>('bot://early-reply', (event) => {
      if (event.payload.session_id === currentSessionId) {
        loadMessages(currentSessionId);
      }
    });
    return () => {
      unlistenResponse.then(fn => fn());
      unlistenMessage.then(fn => fn());
      unlistenEarlyReply.then(fn => fn());
    };
  }, [currentSessionId, boundBots]);

  // Listen for tray "new session" event
  useEffect(() => {
    const unlisten = listen('tray://new-session', () => {
      handleNewSession();
    });
    return () => { unlisten.then(fn => fn()); };
  }, [sessions]);

  useEffect(() => { refreshAllBots(); }, []);

  const loadBoundBots = async (sessionId: string) => {
    try {
      const bots = await sessionListBots(sessionId);
      setBoundBots(bots);
    } catch {
      setBoundBots([]);
    }
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

  // Close bot popover on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (botPopoverRef.current && !botPopoverRef.current.contains(e.target as Node)) {
        setShowBotPopover(false);
      }
    };
    if (showBotPopover) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showBotPopover]);


  const loadMessages = async (sessionId: string) => {
    try {
      const msgs = await getHistory(sessionId);
      isAtBottomRef.current = true; // new session → scroll to bottom
      setMessages(msgs);
    } catch (error) {
      console.error('Failed to load messages:', error);
      setMessages([]);
    }
  };

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

  useEffect(() => {
    if (isAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent, activeTools, claudeCode, spawnAgents]);

  // Sync message state from MentionInput (for send button disabled state)
  // Also detect /command trigger and /focus task suggestions
  const handleMentionInput = useCallback((text: string) => {
    setMessage(text);

    const trimmed = text.trimStart();

    // Detect /command at the very start of input (no space yet)
    if (trimmed.startsWith('/') && !trimmed.includes(' ') && !trimmed.includes('\n')) {
      const query = trimmed.slice(1);
      setCommandQuery(query);
      setCommandPickerIndex(0);
      setShowCommandPicker(true);
      setShowTaskPicker(false);
      return;
    }

    setShowCommandPicker(false);

    // Detect /task <query> — show task suggestions
    const focusMatch = trimmed.match(/^\/task\s(.*)$/i);
    if (focusMatch) {
      const q = focusMatch[1];
      setTaskPickerQuery(q);
      setTaskPickerIndex(0);
      setShowTaskPicker(true);
      listAllTasksBrief().then((tasks) => {
        const filtered = q
          ? tasks.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()))
          : tasks;
        setTaskSuggestions(filtered.map((t) => ({ id: t.id, title: t.title, status: t.status, sessionId: t.sessionId })));
      }).catch(() => setTaskSuggestions([]));
      return;
    }

    // Don't close task picker during selectCommand's clear → insertText transition
    if (!skipTaskPickerCloseRef.current) {
      setShowTaskPicker(false);
    }
  }, []);

  // Reload messages when all spawn agents complete
  useEffect(() => {
    const unlisten = listen<{ session_id: string }>('chat://spawn_complete', (event) => {
      if (event.payload.session_id === currentSessionId) {
        loadMessages(currentSessionId);
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [currentSessionId]);

  /**
   * Subscribe to streaming events, invoke chatStreamStart, and wait for
   * completion.  Returns the assistant reply string.  Callers are responsible
   * for setting loading / streamingContent state around this call.
   */
  const runStreamingChat = async (
    text: string,
    sessionId: string,
    attachments?: Attachment[],
  ): Promise<string> => {
    // Register complete/error listeners BEFORE starting the stream to avoid race conditions
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

  const handleSend = async () => {
    const plainText = inputRef.current?.getPlainText() || '';
    const mentions = inputRef.current?.getMentions() || [];
    const inputEmpty = inputRef.current?.isEmpty() ?? true;

    if ((inputEmpty && pendingImages.length === 0) || loading) return;

    // User actively sent a message — force scroll to bottom
    isAtBottomRef.current = true;

    // Intercept /command typed directly (with optional args)
    const trimmed = plainText.trim();
    const cmdMatch = trimmed.match(/^\/(\S+)(?:\s+(.*))?$/);
    if (cmdMatch) {
      const cmd = SLASH_COMMANDS.find(c => c.name === cmdMatch[1]);
      if (cmd) {
        executeCommand(cmd, cmdMatch[2]);
        return;
      }
    }

    let userMessage = plainText;

    // Load @-referenced file contents and prepend as context
    const fileMentions = mentions.filter(m => m.type === 'file');
    if (fileMentions.length > 0) {
      const fileContents = await Promise.all(
        fileMentions.map(async (m) => {
          try {
            const content = await loadWorkspaceFile(m.name);
            const truncated = content.length > 100_000
              ? content.slice(0, 100_000) + '\n... (truncated)'
              : content;
            const absPath = workspaceBasePath ? `${workspaceBasePath}/${m.name}` : m.id;
            return `[用户引用了文件: ${m.name}，路径: ${absPath}]\n\`\`\`\n${truncated}\n\`\`\``;
          } catch {
            return `[用户引用了文件: ${m.name}] (读取失败)`;
          }
        })
      );
      userMessage = fileContents.join('\n\n') + '\n\n' + userMessage;
    }

    // If a bot is @mentioned, bind it to the session before sending
    const botMentions = mentions.filter(m => m.type === 'bot');
    for (const bm of botMentions) {
      await handleBindBot(bm.id);
    }

    const userAttachments = pendingImages.length > 0 ? [...pendingImages] : undefined;
    inputRef.current?.clear();
    setMessage('');
    setPendingImages([]);
    useChatStreamStore.getState().startStream();

    // Optimistically show user message
    setMessages(prev => [...prev, {
      role: 'user' as const,
      content: userMessage,
      timestamp: Date.now(),
      attachments: userAttachments,
    }]);

    try {
      await runStreamingChat(userMessage, currentSessionId, userAttachments);

      // Reload from DB to get persisted messages (including assistant reply)
      await loadMessages(currentSessionId);
      // Refresh sessions list to update names/timestamps
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

  /** Send a prompt directly (used by quick action examples) */
  const sendQuickPrompt = async (prompt: string) => {
    if (loading) return;
    useChatStreamStore.getState().startStream();

    setMessages(prev => [...prev, {
      role: 'user' as const,
      content: prompt,
      timestamp: Date.now(),
    }]);

    try {
      await runStreamingChat(prompt, currentSessionId);

      useChatStreamStore.getState().clearStreamState();
      await loadMessages(currentSessionId);
      const list = await listSessions();
      setSessions(list);
    } catch (error) {
      console.error('Failed to send quick prompt:', error);
      useChatStreamStore.getState().clearStreamState();
      setMessages(prev => [...prev, {
        role: 'assistant' as const,
        content: `Error: ${String(error)}`,
        timestamp: Date.now(),
      }]);
    } finally {
      useChatStreamStore.getState().endStream();
    }
  };

  /** Render user message content with @mention pills */
  const renderUserContent = useCallback((text: string) => {
    // Split on @mention patterns: @Name followed by space/punctuation/end
    // Bot names registered in boundBots get styled, others stay plain
    const knownNames = new Set([
      ...boundBots.map(b => b.name),
      ...allBots.map(b => b.name),
    ]);

    const parts: React.ReactNode[] = [];
    let remaining = text;
    let key = 0;

    while (remaining.length > 0) {
      const atIdx = remaining.indexOf('@');
      if (atIdx === -1) {
        parts.push(remaining);
        break;
      }

      // Push text before @
      if (atIdx > 0) {
        parts.push(remaining.slice(0, atIdx));
      }

      // Try to match a known bot name after @
      const afterAt = remaining.slice(atIdx + 1);
      let matched = false;
      for (const name of knownNames) {
        if (afterAt.startsWith(name)) {
          // Check that it's followed by whitespace, end, or punctuation
          const charAfter = afterAt[name.length];
          if (!charAfter || /[\s,，.。!！?？)）\]】]/.test(charAfter)) {
            parts.push(
              <span
                key={`mention-${key++}`}
                style={{
                  background: 'rgba(255,255,255,0.2)',
                  color: '#FFFFFF',
                  padding: '1px 6px',
                  borderRadius: '6px',
                  fontWeight: 600,
                  fontSize: '13px',
                  whiteSpace: 'nowrap',
                }}
              >
                @{name}
              </span>
            );
            remaining = afterAt.slice(name.length);
            matched = true;
            break;
          }
        }
      }

      if (!matched) {
        parts.push('@');
        remaining = afterAt;
      }
    }

    return <>{parts}</>;
  }, [boundBots, allBots]);

  const handleDeleteMessage = async (msg: ChatMessage, idx: number) => {
    if (msg.id) {
      await deleteMessage(msg.id);
    }
    setMessages((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleClearAll = async () => {
    if (!currentSessionId) return;
    await clearHistory(currentSessionId);
    setMessages([]);
  };

  const handleCopy = (content: string, idx: number) => {
    navigator.clipboard.writeText(content);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1500);
  };

  const handleNewSession = async () => {
    try {
      const session = await createSession(`${t('chat.newSession')} ${sessions.length}`);
      setSessions(prev => [...prev, session]);
      setCurrentSessionId(session.id);
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  // Fill the picked command into the input (don't execute yet)
  const selectCommand = useCallback((cmd: SlashCommand) => {
    setShowCommandPicker(false);

    // For /task, load task suggestions immediately
    if (cmd.name === 'task') {
      skipTaskPickerCloseRef.current = true;
      inputRef.current?.clear();
      setTimeout(() => {
        inputRef.current?.insertText(`/${cmd.name} `);
        inputRef.current?.focus();
        // Allow handleMentionInput to manage task picker again after insert settles
        setTimeout(() => { skipTaskPickerCloseRef.current = false; }, 50);
      }, 0);
      setMessage(`/${cmd.name} `);
      setTaskPickerQuery('');
      setTaskPickerIndex(0);
      setShowTaskPicker(true);
      listAllTasksBrief().then((tasks) => {
        setTaskSuggestions(tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, sessionId: t.sessionId })));
      }).catch(() => setTaskSuggestions([]));
      return;
    }

    inputRef.current?.clear();
    // Use setTimeout so the clear() flushes first
    setTimeout(() => {
      inputRef.current?.insertText(`/${cmd.name} `);
      inputRef.current?.focus();
    }, 0);
    setMessage(`/${cmd.name} `);
  }, []);

  // Select a task from the task suggestion picker → execute focus immediately
  const selectTask = useCallback((task: { id: string; title: string; sessionId: string }) => {
    inputRef.current?.clear();
    setMessage('');
    setShowTaskPicker(false);
    preFocusSessionIdRef.current = currentSessionId;
    useChatStreamStore.getState().focusTask(task.id, task.title, task.sessionId);
    setCurrentSessionId(task.sessionId);
  }, [currentSessionId]);

  // Unfocus from a task and return to the main conversation
  const handleUnfocus = useCallback(() => {
    const store = useChatStreamStore.getState();
    store.unfocusTask();
    if (preFocusSessionIdRef.current) {
      setCurrentSessionId(preFocusSessionIdRef.current);
      preFocusSessionIdRef.current = '';
    }
  }, []);

  // Slash command execution
  const executeCommand = useCallback(async (cmd: SlashCommand, args?: string) => {
    inputRef.current?.clear();
    setMessage('');
    setShowCommandPicker(false);

    const showSystemMsg = (content: string) => {
      setMessages((prev) => [...prev, {
        role: 'assistant' as const,
        content,
        timestamp: Date.now(),
      }]);
    };

    switch (cmd.name) {
      case 'clear':
        // Insert a context reset marker — history is preserved but LLM context resets
        await clearHistory(currentSessionId);
        setMessages((prev) => [...prev, {
          role: 'context_reset',
          content: '',
          timestamp: Date.now(),
        }]);
        break;
      case 'skills': {
        try {
          const skills = await listSkills({ enabledOnly: true });
          if (skills.length === 0) {
            showSystemMsg(t('chat.command.noSkills'));
          } else {
            const lines = skills.map(
              (s) => `- ${s.emoji || '📦'} **${s.name}** — ${s.description}`
            ).join('\n');
            showSystemMsg(`**${t('chat.command.enabledSkills')}** (${skills.length})\n\n${lines}`);
          }
        } catch {
          showSystemMsg(t('chat.command.noSkills'));
        }
        break;
      }
      case 'task': {
        if (!args?.trim()) {
          showSystemMsg(t('chat.command.taskUsage'));
          break;
        }
        try {
          const task = await getTaskByName(args.trim());
          if (task) {
            preFocusSessionIdRef.current = currentSessionId;
            useChatStreamStore.getState().focusTask(task.id, task.title, task.sessionId);
            setCurrentSessionId(task.sessionId);
          } else {
            try {
              const allTasks = await listAllTasksBrief();
              if (allTasks.length > 0) {
                const taskNames = allTasks.map((tk) => `  · ${tk.title}`).join('\n');
                showSystemMsg(`${t('chat.command.taskNotFound')}: "${args.trim()}"\n\n可用任务:\n${taskNames}`);
              } else {
                showSystemMsg(`${t('chat.command.taskNotFound')}: "${args.trim()}"\n\n当前没有任何任务`);
              }
            } catch {
              showSystemMsg(`${t('chat.command.taskNotFound')}: "${args.trim()}"`);
            }
          }
        } catch (err) {
          console.error('task command error:', err);
          showSystemMsg(`${t('chat.command.taskNotFound')}: "${args.trim()}" (${err})`);
        }
        break;
      }
      case 'back': {
        handleUnfocus();
        break;
      }
    }
  }, [handleClearAll, handleNewSession, t, currentSessionId]);

  const handleCloseSession = async (sessionId: string) => {
    if (sessions.length <= 1) return;
    try {
      await deleteSession(sessionId);
      const remaining = sessions.filter(s => s.id !== sessionId);
      setSessions(remaining);
      if (currentSessionId === sessionId) {
        setCurrentSessionId(remaining[remaining.length - 1].id);
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };


  const handleKeyDown = (e: React.KeyboardEvent) => {
    // When slash command picker is open, intercept navigation keys
    if (showCommandPicker) {
      const cmds = filterCommands(commandQuery);
      const maxIdx = cmds.length - 1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCommandPickerIndex(prev => Math.min(prev + 1, maxIdx));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCommandPickerIndex(prev => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = cmds[commandPickerIndex];
        if (selected) selectCommand(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowCommandPicker(false);
        return;
      }
    }

    // When task suggestion picker is open, intercept navigation keys
    if (showTaskPicker && taskSuggestions.length > 0) {
      const maxIdx = taskSuggestions.length - 1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setTaskPickerIndex(prev => Math.min(prev + 1, maxIdx));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setTaskPickerIndex(prev => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = taskSuggestions[taskPickerIndex];
        if (selected) selectTask(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowTaskPicker(false);
        return;
      }
    }

    // When mention picker is open, intercept navigation keys
    if (showFilePicker) {
      const items = buildMentionList(allBots, workspaceFiles, filePickerQuery);
      const maxIdx = items.length - 1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFilePickerIndex(prev => Math.min(prev + 1, maxIdx));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFilePickerIndex(prev => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = items[filePickerIndex];
        if (selected) {
          if (selected.type === 'bot') handleMentionBotSelect(selected.bot);
          else handleFileSelect(selected.file);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowFilePicker(false);
        return;
      }
    }
    // Ignore Enter during IME composition (e.g. Chinese input method selecting a word)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const fileItems = items.filter((item) => item.kind === 'file');
    if (fileItems.length > 0) {
      e.preventDefault();
      const files = fileItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      await addAttachments(files);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      await addAttachments(files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const quickActions = [
    {
      icon: MessageSquare,
      label: t('chat.quick.askAnything'),
      desc: t('chat.quick.askAnythingDesc'),
      examples: [
        t('chat.quick.askAnythingEx1'),
        t('chat.quick.askAnythingEx2'),
        t('chat.quick.askAnythingEx3'),
      ],
      color: 'var(--color-primary)',
    },
    {
      icon: Puzzle,
      label: t('chat.quick.skills'),
      desc: t('chat.quick.skillsDesc'),
      examples: [
        t('chat.quick.skillsEx1'),
        t('chat.quick.skillsEx2'),
        t('chat.quick.skillsEx3'),
      ],
      color: '#8b5cf6',
    },
    {
      icon: Terminal,
      label: t('chat.quick.command'),
      desc: t('chat.quick.commandDesc'),
      examples: [
        t('chat.quick.commandEx1'),
        t('chat.quick.commandEx2'),
        t('chat.quick.commandEx3'),
      ],
      color: '#059669',
    },
    {
      icon: Clock,
      label: t('chat.quick.schedule'),
      desc: t('chat.quick.scheduleDesc'),
      examples: [
        t('chat.quick.scheduleEx1'),
        t('chat.quick.scheduleEx2'),
        t('chat.quick.scheduleEx3'),
      ],
      color: '#d97706',
    },
    {
      icon: FileText,
      label: t('chat.quick.writing'),
      desc: t('chat.quick.writingDesc'),
      examples: [
        t('chat.quick.writingEx1'),
        t('chat.quick.writingEx2'),
        t('chat.quick.writingEx3'),
      ],
      color: '#e11d48',
    },
    {
      icon: BarChart3,
      label: t('chat.quick.analysis'),
      desc: t('chat.quick.analysisDesc'),
      examples: [
        t('chat.quick.analysisEx1'),
        t('chat.quick.analysisEx2'),
        t('chat.quick.analysisEx3'),
      ],
      color: '#0891b2',
    },
  ];

  // Detect cron job session for header rendering
  const isCronSession = currentSessionId.startsWith('cron:');
  const cronJobId = isCronSession ? currentSessionId.slice(5) : '';

  const handleBackToMain = useCallback(() => {
    useChatStreamStore.getState().unfocusTask();
    if (mainSessionId) {
      setCurrentSessionId(mainSessionId);
    }
  }, [mainSessionId]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Chrome-style session tabs — hidden in single-window mode */}
      {!SINGLE_WINDOW_MODE && (
      <div
        className="flex items-end shrink-0 overflow-hidden app-drag-region"
        onMouseDown={drag.onMouseDown}
        style={{
          background: 'var(--sidebar-bg)',
          paddingLeft: '8px',
          paddingRight: '8px',
          minHeight: '40px',
          paddingTop: '8px',
        }}
      >
        <div className="flex items-end flex-1 min-w-0">
          {sessions.map((session) => {
            const isActive = session.id === currentSessionId;
            return (
              <div
                key={session.id}
                className="group flex items-center min-w-0 transition-all duration-200"
                style={{
                  flex: '1 1 0',
                  maxWidth: '200px',
                  background: isActive ? 'var(--color-bg)' : 'transparent',
                  borderRadius: '8px 8px 0 0',
                  marginRight: '1px',
                }}
              >
                <button
                  onClick={() => setCurrentSessionId(session.id)}
                  className="flex items-center gap-2 min-w-0 flex-1"
                  style={{
                    padding: '7px 8px 7px 12px',
                    fontSize: '12px',
                    fontWeight: isActive ? 600 : 400,
                    color: isActive ? 'var(--color-text)' : 'rgba(255,255,255,0.5)',
                  }}
                >
                  <MessageSquare size={13} className="shrink-0" style={{ opacity: isActive ? 1 : 0.5 }} />
                  <span className="truncate">{session.name}</span>
                </button>
                {sessions.length > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleCloseSession(session.id); }}
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 mr-1"
                    style={{ color: isActive ? 'var(--color-text-muted)' : 'rgba(255,255,255,0.3)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = isActive ? 'var(--color-bg-muted)' : 'rgba(255,255,255,0.1)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* New tab button */}
        <button
          onClick={handleNewSession}
          className="shrink-0 flex items-center gap-1.5 rounded-lg transition-all mb-1 ml-1 px-2.5"
          style={{
            height: '28px',
            fontSize: '12px',
            color: 'rgba(255,255,255,0.85)',
            background: 'rgba(255,255,255,0.1)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
          title={t('chat.newSession')}
        >
          <Plus size={14} strokeWidth={2.5} />
          <span>{t('common.new')}</span>
        </button>
      </div>
      )}

      {/* Bot binding bar */}
      <div
        className="shrink-0 flex items-center gap-2 px-4 py-1.5"
        style={{
          background: 'var(--color-bg)',
          borderBottom: '1px solid var(--color-border)',
          minHeight: '32px',
        }}
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
            <Link2 size={13} />
            <span>
              {boundBots.length > 0
                ? `${t('chat.bots.bound')} (${boundBots.length})`
                : t('chat.bots.bind')}
            </span>
            <ChevronDown size={11} />
          </button>

          {showBotPopover && (
            <div
              className="absolute left-0 top-full mt-1 rounded-xl shadow-lg z-50 overflow-hidden"
              style={{
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)',
                minWidth: '260px',
              }}
            >
              {/* Bound bots */}
              {boundBots.length > 0 && (
                <div className="p-2">
                  <div className="text-[11px] font-medium px-2 py-1" style={{ color: 'var(--color-text-muted)' }}>
                    {t('chat.bots.bound')}
                  </div>
                  {boundBots.map((bot) => (
                    <div
                      key={bot.id}
                      className="flex items-center justify-between px-2 py-1.5 rounded-lg"
                      style={{ background: 'var(--color-primary-subtle)' }}
                    >
                      <div className="flex items-center gap-2">
                        <Bot size={14} style={{ color: 'var(--color-primary)' }} />
                        <span className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
                          {bot.name}
                        </span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text-muted)' }}>
                          {bot.platform}
                        </span>
                      </div>
                      <button
                        onClick={() => handleUnbindBot(bot.id)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors"
                        style={{ color: 'var(--color-text-muted)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-danger)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; }}
                      >
                        <Unlink size={11} />
                        {t('chat.bots.unbind')}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Available bots to bind */}
              {(() => {
                const boundIds = new Set(boundBots.map(b => b.id));
                const available = allBots.filter(b => !boundIds.has(b.id) && b.enabled);
                return available.length > 0 ? (
                  <div className="p-2" style={{ borderTop: boundBots.length > 0 ? '1px solid var(--color-border)' : 'none' }}>
                    <div className="text-[11px] font-medium px-2 py-1" style={{ color: 'var(--color-text-muted)' }}>
                      {t('chat.bots.bind')}
                    </div>
                    {available.map((bot) => (
                      <button
                        key={bot.id}
                        onClick={() => handleBindBot(bot.id)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors text-left"
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <Bot size={14} style={{ color: 'var(--color-text-muted)' }} />
                        <span className="text-[13px]" style={{ color: 'var(--color-text)' }}>
                          {bot.name}
                        </span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text-muted)' }}>
                          {bot.platform}
                        </span>
                        <Plus size={13} className="ml-auto" style={{ color: 'var(--color-text-tertiary)' }} />
                      </button>
                    ))}
                  </div>
                ) : !boundBots.length ? (
                  <div className="p-4 text-center text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
                    {t('chat.bots.noBots')}
                  </div>
                ) : null;
              })()}

              {/* Hint */}
              <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--color-text-tertiary)', borderTop: '1px solid var(--color-border)' }}>
                {t('chat.bots.bindHint')}
              </div>
            </div>
          )}
        </div>


        {/* Bound bot badges (inline) */}
        {boundBots.map((bot) => (
          <span
            key={bot.id}
            className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px]"
            style={{ background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}
          >
            <Bot size={11} />
            {bot.name}
          </span>
        ))}

        {/* Rebound notice */}
        {reboundNotice && (
          <span className="text-[11px] ml-auto" style={{ color: 'var(--color-warning, #f59e0b)' }}>
            {reboundNotice}
          </span>
        )}
      </div>

      {/* Focus banner — shown when viewing a task/cron session */}
      {(focusedTask || isCronSession) && (
        <div className="shrink-0 flex items-center justify-between px-4 py-2 rounded-lg mx-2 mt-1.5 mb-0.5"
          style={{
            background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)',
          }}>
          <div className="flex items-center gap-2">
            <ClipboardList size={14} style={{ color: 'var(--color-primary)' }} />
            <span className="text-[13px] font-medium" style={{ color: 'var(--color-primary)' }}>
              当前任务：{isCronSession ? (cronJobId && cronJobs.find(j => j.id === cronJobId)?.name) || focusedTask?.taskName || '' : focusedTask?.taskName || ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
              /back 返回
            </span>
            <button
              onClick={() => isCronSession ? handleBackToMain() : handleUnfocus()}
              className="text-[12px] px-2.5 py-1 rounded-md transition-colors font-medium"
              style={{
                color: 'var(--color-primary)',
                background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-primary) 25%, transparent)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-primary) 15%, transparent)'; }}
            >
              返回主对话
            </button>
          </div>
        </div>
      )}

      {/* Cron job task info card — shown below focus banner */}
      {isCronSession && cronJobId && (
        <CronJobSessionView jobId={cronJobId} onUnfocus={handleBackToMain} />
      )}

      {/* Messages area */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto" style={{ background: 'var(--color-bg)' }}>
        {messages.length === 0 && !loading ? (
          (focusedTask || isCronSession) ? (
            /* Task/Cron empty state */
            <div className="h-full flex flex-col items-center justify-center px-6">
              <div className="text-center space-y-3">
                <div
                  className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto"
                  style={{ background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)' }}
                >
                  <Clock size={22} style={{ color: 'var(--color-primary)' }} />
                </div>
                <p className="text-[15px] font-medium" style={{ color: 'var(--color-text)' }}>
                  {isCronSession ? '定时任务尚未执行' : focusedTask?.taskName || '任务'}
                </p>
                <p className="text-[13px]" style={{ color: 'var(--color-text-muted)' }}>
                  {isCronSession ? '任务将在预定时间自动执行，请耐心等待' : '暂无对话记录，发送消息开始交互'}
                </p>
              </div>
            </div>
          ) : (
          /* Empty state - welcome screen */
          <div
            className="h-full flex flex-col items-center justify-center px-6"
            onClick={() => expandedAction !== null && setExpandedAction(null)}
          >
            <div className="max-w-[520px] w-full">
              {/* Hero: Mascot + Greeting */}
              <div
                className="transition-all duration-500 ease-out"
                style={{
                  opacity: expandedAction !== null ? 0 : 1,
                  maxHeight: expandedAction !== null ? 0 : '280px',
                  overflow: 'hidden',
                }}
              >
                <div className="flex items-center gap-4 mb-8">
                  <div className="relative shrink-0">
                    <img
                      src={logoImg}
                      alt="YiYi"
                      className="w-14 h-14 rounded-2xl"
                      style={{ boxShadow: '0 4px 20px rgba(255, 180, 80, 0.2)' }}
                    />
                    <div
                      className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center"
                      style={{ background: 'var(--color-success)', boxShadow: '0 0 0 2.5px var(--color-bg)' }}
                    >
                      <div className="w-[5px] h-[5px] rounded-full bg-white" />
                    </div>
                  </div>
                  <div>
                    <h1
                      className="text-[22px] font-bold tracking-tight"
                      style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text)' }}
                    >
                      {(() => {
                        const h = new Date().getHours();
                        const greeting = h < 6 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好';
                        return `${greeting} 👋`;
                      })()}
                    </h1>
                    <p className="text-[13.5px] mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                      {(t('chat.empty.description') as string).replace('YiYiClaw', aiName).replace(/我是.*?。/, '')}
                    </p>
                  </div>
                </div>
              </div>

              {/* Quick action cards — 3x2 grid that expands on click */}
              <div className="grid grid-cols-3 gap-2.5 mb-5">
                {quickActions.map((action, idx) => {
                  const Icon = action.icon;
                  const isExpanded = expandedAction === idx;
                  const isHidden = expandedAction !== null && !isExpanded;

                  return (
                    <div
                      key={idx}
                      className="transition-all duration-500 ease-out"
                      style={{
                        gridColumn: isExpanded ? '1 / -1' : undefined,
                        opacity: isHidden ? 0 : 1,
                        transform: isHidden ? 'scale(0.95)' : 'scale(1)',
                        pointerEvents: isHidden ? 'none' : 'auto',
                        maxHeight: isHidden ? 0 : '400px',
                        overflow: 'hidden',
                      }}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedAction(isExpanded ? null : idx);
                        }}
                        className="w-full text-left rounded-2xl transition-all duration-300"
                        style={{
                          background: isExpanded
                            ? 'var(--color-bg-elevated)'
                            : 'var(--color-bg-elevated)',
                          boxShadow: isExpanded
                            ? `0 8px 32px ${action.color}15, 0 0 0 1px ${action.color}25`
                            : '0 1px 3px rgba(0,0,0,0.04)',
                        }}
                        onMouseEnter={(e) => {
                          if (!isExpanded) {
                            e.currentTarget.style.transform = 'translateY(-1px)';
                            e.currentTarget.style.boxShadow = `0 4px 16px ${action.color}12, 0 0 0 1px ${action.color}18`;
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isExpanded) {
                            e.currentTarget.style.transform = 'translateY(0)';
                            e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.04)';
                          }
                        }}
                      >
                        {/* Card header */}
                        <div className="flex items-center gap-3 p-3">
                          <div
                            className="w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0 transition-all duration-500"
                            style={{
                              background: isExpanded ? `${action.color}18` : `${action.color}0C`,
                            }}
                          >
                            <Icon size={15} style={{ color: action.color }} />
                          </div>
                          <span
                            className="text-[13px] font-semibold flex-1"
                            style={{ color: 'var(--color-text)' }}
                          >
                            {action.label}
                          </span>
                          <div
                            className="transition-transform duration-500"
                            style={{
                              transform: isExpanded ? 'rotate(45deg)' : 'rotate(0)',
                              color: 'var(--color-text-tertiary)',
                            }}
                          >
                            <Plus size={13} />
                          </div>
                        </div>

                        {/* Expanded examples */}
                        {isExpanded && (
                          <div className="px-3 pb-3 space-y-1 animate-fade-in">
                            <p className="text-[12px] px-1 mb-2" style={{ color: 'var(--color-text-muted)' }}>
                              {action.desc}
                            </p>
                            {action.examples.map((ex, eidx) => (
                              <div
                                key={eidx}
                                className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] transition-all duration-150 cursor-pointer"
                                style={{
                                  background: 'var(--color-bg-subtle)',
                                  color: 'var(--color-text-secondary)',
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedAction(null);
                                  sendQuickPrompt(ex);
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = `${action.color}0E`;
                                  e.currentTarget.style.color = 'var(--color-text)';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = 'var(--color-bg-subtle)';
                                  e.currentTarget.style.color = 'var(--color-text-secondary)';
                                }}
                              >
                                <span className="w-1 h-1 rounded-full shrink-0" style={{ background: action.color, opacity: 0.5 }} />
                                <span>{ex}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Keyboard hints */}
              <div
                className="text-[12px] text-center transition-all duration-500 ease-out"
                style={{
                  color: 'var(--color-text-tertiary)',
                  opacity: expandedAction !== null ? 0 : 0.6,
                  maxHeight: expandedAction !== null ? 0 : '40px',
                  overflow: 'hidden',
                }}
              >
                <span>{t('chat.empty.tip1')}</span>
              </div>

              {expandedAction !== null && (
                <div className="text-[11px] text-center animate-fade-in" style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }}>
                  {t('chat.empty.backHint')}
                </div>
              )}
            </div>
          </div>
          )
        ) : (
          /* Message list */
          <div className="w-full py-6 px-8 space-y-6">
            {/* Clear all button */}
            {messages.length > 0 && (
              <div className="flex justify-end">
                <button
                  onClick={handleClearAll}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] transition-all hover:bg-red-500/10 hover:text-red-400"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  <Trash2 size={12} />
                  {t('chat.clearAll')}
                </button>
              </div>
            )}
            {processedMessages.map(({ msg, historyTools, historyAgents, taskIds, backgroundProposals }, idx) => {
              // Context reset divider
              if (msg.role === 'context_reset') {
                return (
                  <div key={idx} className="flex items-center gap-3 py-3 px-4">
                    <div className="flex-1 h-px" style={{ background: 'var(--color-border)' }} />
                    <span className="text-[11px] font-medium shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                      {t('chat.contextReset') || '上下文已重置'}
                    </span>
                    <div className="flex-1 h-px" style={{ background: 'var(--color-border)' }} />
                  </div>
                );
              }
              return (
              <div
                key={idx}
                className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'} group`}
              >
                {msg.role === 'assistant' && (
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                  >
                    <img src={logoFaceRight} alt="YiYi" width={28} height={28} />
                  </div>
                )}

                <div className={`max-w-[80%] space-y-2 ${msg.role === 'user' ? '' : ''}`}>
                  {/* Historical tool calls panel */}
                  {/* Historical tool calls */}
                  {historyTools && historyTools.length > 0 && (
                    <ToolCallPanel tools={historyTools} isHistory />
                  )}
                  {/* Historical task cards from create_task tool calls */}
                  {taskIds && taskIds.length > 0 && (
                    <div className="space-y-2">
                      {taskIds.map((tid) => (
                        <TaskCard key={tid} taskId={tid} />
                      ))}
                    </div>
                  )}
                  {/* Background task proposals */}
                  {backgroundProposals && backgroundProposals.length > 0 && (
                    backgroundProposals.map((proposal, pi) => (
                      <BackgroundTaskCard
                        key={`bg-${pi}`}
                        proposal={proposal}
                        sessionId={currentSessionId}
                        originalMessage={[...messages].reverse().find((m: ChatMessage) => m.role === 'user')?.content || ''}
                      />
                    ))
                  )}
                  {/* Historical spawn agent results */}
                  {historyAgents && historyAgents.length > 0 && (
                    <HistorySpawnAgentsPanel agents={historyAgents} />
                  )}
                  {/* Historical thinking/reasoning content */}
                  {msg.role === 'assistant' && msg.thinking && (
                    <ThinkingBlock content={msg.thinking} />
                  )}
                  <div
                    className="py-2.5 px-4 rounded-2xl text-[14px] leading-relaxed"
                    style={msg.role === 'user' ? {
                      background: 'var(--color-primary)',
                      color: '#FFFFFF',
                      borderBottomRightRadius: '6px',
                    } : {
                      background: 'var(--color-bg-elevated)',
                      color: 'var(--color-text)',
                      border: '1px solid var(--color-border)',
                      borderBottomLeftRadius: '6px',
                    }}
                  >
                    {/* Attachments: images + files */}
                    {msg.attachments && msg.attachments.length > 0 && (() => {
                      const images = msg.attachments.filter(a => isImageMime(a.mimeType));
                      const files = msg.attachments.filter(a => !isImageMime(a.mimeType));
                      return (
                        <div className={`${msg.content ? 'mb-2' : ''}`}>
                          {/* Image grid */}
                          {images.length > 0 && (
                            <div className={`${images.length === 1 ? '' : 'grid gap-1.5'} ${files.length > 0 ? 'mb-2' : ''}`}
                              style={images.length > 1 ? {
                                gridTemplateColumns: `repeat(${Math.min(images.length, 3)}, 1fr)`,
                              } : undefined}
                            >
                              {images.map((att, i) => (
                                <div
                                  key={i}
                                  className="relative group/att rounded-lg overflow-hidden cursor-pointer"
                                  style={images.length === 1
                                    ? { maxWidth: '320px' }
                                    : { aspectRatio: '1', maxHeight: '160px' }
                                  }
                                  onClick={() => openLightbox(att)}
                                >
                                  <img
                                    src={`data:${att.mimeType};base64,${att.data}`}
                                    className="w-full h-full rounded-lg"
                                    style={{ objectFit: images.length === 1 ? 'contain' : 'cover' }}
                                    alt={att.name || 'image'}
                                    loading="lazy"
                                  />
                                  <div
                                    className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/att:opacity-100 transition-opacity"
                                    style={{ background: 'rgba(0,0,0,0.3)' }}
                                  >
                                    <ZoomIn size={20} className="text-white drop-shadow" />
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          {/* File chips */}
                          {files.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {files.map((att, i) => (
                                <div
                                  key={i}
                                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px]"
                                  style={{
                                    background: msg.role === 'user' ? 'rgba(255,255,255,0.15)' : 'var(--color-bg-muted)',
                                    color: msg.role === 'user' ? 'rgba(255,255,255,0.9)' : 'var(--color-text-secondary)',
                                  }}
                                >
                                  <FileText size={14} className="shrink-0" />
                                  <span className="truncate" style={{ maxWidth: '180px' }}>
                                    {att.name || 'file'}
                                  </span>
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
                          msg.content.replace(/\n\n\[用户上传了文件:.*?\]/g, '').replace(/\[用户引用了文件:.*?\]\n```[\s\S]*?```\n?\n?/g, '').trim()
                        )}
                      </div>
                    ) : (
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>

                  {/* Meta */}
                  <div className={`flex items-center gap-2 mt-1 px-1 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                    <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                      {msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                    {msg.source?.via === 'bot' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{
                        background: 'var(--color-bg-elevated)',
                        color: 'var(--color-text-muted)',
                        border: '1px solid var(--color-border)',
                      }}>
                        {msg.role === 'user'
                          ? `${msg.source.sender_name || msg.source.sender_id || ''} via ${msg.source.platform}`
                          : `via ${msg.source.platform}`}
                      </span>
                    )}
                    <button
                      onClick={() => handleCopy(msg.content, idx)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {copiedIdx === idx ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                    <button
                      onClick={() => handleDeleteMessage(msg, idx)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-red-400"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {msg.role === 'user' && (
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                    style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
                  >
                    <User size={16} />
                  </div>
                )}
              </div>
              );
            })}

            {/* Active tool calls + streaming response */}
            {streamLoading && (
              <div className="flex gap-3 justify-start">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                >
                  <img src={logoFaceRight} alt="YiYi" width={28} height={28} />
                </div>
                <div className="max-w-[80%] space-y-2">
                  {/* Tool call panel (includes Claude Code live panel) */}
                  {(activeTools.length > 0 || claudeCode) && (() => {
                    // Separate create_task and propose_background_task tools
                    const taskCards: string[] = [];
                    const bgProposals: BackgroundTaskProposal[] = [];
                    const filteredTools = activeTools.filter((t) => {
                      if (t.name === 'create_task' && t.status === 'done' && t.resultPreview) {
                        try {
                          const parsed = JSON.parse(t.resultPreview);
                          if (parsed.id) { taskCards.push(parsed.id); return false; }
                        } catch { /* keep as regular tool */ }
                      }
                      if (t.name === 'propose_background_task' && t.status === 'done' && t.resultPreview) {
                        try {
                          const parsed = JSON.parse(t.resultPreview);
                          if (parsed.__type === 'propose_background_task') {
                            bgProposals.push(parsed as BackgroundTaskProposal);
                            return false;
                          }
                        } catch { /* keep as regular tool */ }
                      }
                      return true;
                    });
                    return (
                      <>
                        {(filteredTools.length > 0 || claudeCode) && (
                          <ToolCallPanel tools={filteredTools} />
                        )}
                        {taskCards.map((tid) => (
                          <TaskCard key={tid} taskId={tid} />
                        ))}
                        {bgProposals.map((proposal, pi) => (
                          <BackgroundTaskCard
                            key={`bg-stream-${pi}`}
                            proposal={proposal}
                            sessionId={currentSessionId}
                            originalMessage={[...messages].reverse().find((m: ChatMessage) => m.role === 'user')?.content || ''}
                          />
                        ))}
                      </>
                    );
                  })()}

                  {/* Thinking/reasoning content (collapsible) */}
                  {streamingThinking && (
                    <ThinkingBlock content={streamingThinking} streaming />
                  )}

                  {/* Streaming content */}
                  {streamingContent ? (
                    <div
                      className="py-2.5 px-4 rounded-2xl text-[14px] leading-relaxed prose prose-sm max-w-none"
                      style={{
                        background: 'var(--color-bg-elevated)',
                        border: '1px solid var(--color-border)',
                        borderBottomLeftRadius: '6px',
                        color: 'var(--color-text)',
                      }}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {streamingContent}
                      </ReactMarkdown>
                      <span className="yiyi-working">
                        <img src={logoFaceRight} alt="" width={28} height={28} />
                        <span className="yiyi-dots"><span /><span /><span /></span>
                      </span>
                    </div>
                  ) : (
                    /* Loading: simple dots */
                    <div
                      className="py-2.5 px-4 rounded-2xl inline-flex items-center"
                      style={{
                        background: 'var(--color-bg-elevated)',
                        border: '1px solid var(--color-border)',
                        borderBottomLeftRadius: '6px',
                      }}
                    >
                      <span className="yiyi-dots"><span /><span /><span /></span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Error message from LLM */}
            {streamError && !streamLoading && (
              <div className="flex gap-3 justify-start">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                >
                  <img src={logoFaceRight} alt="YiYi" width={28} height={28} style={{ opacity: 0.6 }} />
                </div>
                <div
                  className="py-2.5 px-4 rounded-2xl text-[13px] leading-relaxed max-w-[80%]"
                  style={{
                    background: 'rgba(var(--color-error-rgb, 255,69,58), 0.08)',
                    border: '1px solid var(--color-error)',
                    borderBottomLeftRadius: '6px',
                    color: 'var(--color-error)',
                  }}
                >
                  <div className="font-semibold mb-1">{t('common.error') || 'Error'}</div>
                  <div style={{ color: 'var(--color-text-secondary)', wordBreak: 'break-word' }}>{streamError}</div>
                </div>
              </div>
            )}

            {/* Long task round divider */}
            {longTask.status !== 'idle' && longTask.currentRound > 1 && (
              <RoundDivider round={longTask.currentRound} maxRounds={longTask.maxRounds} />
            )}

            {/* Long task progress panel */}
            {longTask.status !== 'idle' && (
              <div className="flex gap-3 justify-start px-2">
                <div className="shrink-0" style={{ width: '32px' }} />
                <div className="flex-1 min-w-0">
                  <LongTaskProgressPanel />
                </div>
              </div>
            )}

            {/* Sub-agent (spawn_agents) panel — persistent, independent of streaming state */}
            {spawnAgents.length > 0 && (
              <SpawnAgentPanel
                agents={spawnAgents}
                collapsedAgents={collapsedAgents}
                onToggleCollapse={toggleCollapseAgent}
              />
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0 px-6 py-4" style={{ background: 'var(--color-bg)', borderTop: '1px solid var(--color-border)' }}>
        <form onSubmit={(e) => { e.preventDefault(); handleSend(); }} className="w-full">
          <div
            className="relative rounded-2xl transition-all"
            style={{
              background: 'var(--color-bg-elevated)',
              border: '1px solid var(--color-border)',
            }}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          >
            {/* /slash-command picker dropdown */}
            {showCommandPicker && (
              <SlashCommandPicker
                query={commandQuery}
                selectedIndex={commandPickerIndex}
                onSelect={selectCommand}
                t={t}
              />
            )}

            {/* /focus task suggestion picker */}
            {showTaskPicker && !showCommandPicker && taskSuggestions.length > 0 && (
              <div
                className="absolute left-0 right-0 bottom-full mb-1 rounded-xl overflow-hidden z-50"
                style={{
                  background: 'var(--color-bg-elevated)',
                  border: '1px solid var(--color-border-strong)',
                  boxShadow: 'var(--shadow-lg)',
                  maxHeight: '240px',
                  overflowY: 'auto',
                }}
              >
                <div className="px-3 pt-2 pb-1">
                  <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                    选择任务
                  </span>
                </div>
                {taskSuggestions.map((task, i) => {
                  const isActive = i === taskPickerIndex;
                  const statusIcon = task.status === 'running' ? '●' : task.status === 'completed' ? '✓' : task.status === 'failed' ? '✗' : '○';
                  return (
                    <div
                      key={task.id}
                      onClick={() => selectTask(task)}
                      className="flex items-center gap-2.5 px-3 py-2 mx-1 rounded-lg cursor-pointer transition-colors"
                      style={{
                        background: isActive ? 'var(--color-primary-subtle)' : 'transparent',
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) e.currentTarget.style.background = 'var(--color-bg-muted)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = isActive ? 'var(--color-primary-subtle)' : 'transparent';
                      }}
                    >
                      <span className="text-[13px]" style={{ color: 'var(--color-text-muted)' }}>{statusIcon}</span>
                      <span className="text-[13px] font-medium" style={{ color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)' }}>
                        {task.title}
                      </span>
                    </div>
                  );
                })}
                <div className="px-3 pt-1 pb-2">
                  <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    ↑↓ 导航 · Enter 选择 · Esc 关闭
                  </span>
                </div>
              </div>
            )}

            {/* @-mention picker dropdown (bots + files) */}
            {showFilePicker && !showCommandPicker && (
              <MentionPicker
                bots={allBots}
                files={workspaceFiles}
                query={filePickerQuery}
                selectedIndex={filePickerIndex}
                onSelectBot={handleMentionBotSelect}
                onSelectFile={handleFileSelect}
              />
            )}


            {/* Image preview strip */}
            {pendingImages.length > 0 && (
              <div className="flex gap-2 px-3 pt-3 pb-1 flex-wrap">
                {pendingImages.map((att, i) => (
                  <div key={i} className="relative group/img" style={{ border: '1px solid var(--color-border)', borderRadius: '8px', overflow: 'hidden' }}>
                    {isImageMime(att.mimeType) ? (
                      <img
                        src={`data:${att.mimeType};base64,${att.data}`}
                        className="w-16 h-16 object-cover"
                        alt={att.name || 'image'}
                      />
                    ) : (
                      <div className="flex items-center gap-1.5 px-2.5 py-2 h-16" style={{ background: 'var(--color-bg-muted)', minWidth: '100px' }}>
                        <FileText size={16} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                        <span className="text-[11px] truncate" style={{ color: 'var(--color-text-secondary)', maxWidth: '80px' }}>
                          {att.name || 'file'}
                        </span>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removeImage(i)}
                      className="absolute top-0 right-0 w-5 h-5 flex items-center justify-center rounded-bl-md opacity-0 group-hover/img:opacity-100 transition-opacity"
                      style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-end gap-2 p-2">
              {/* File upload button */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addAttachments(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading || pendingImages.length >= MAX_ATTACHMENTS}
                className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all disabled:opacity-30"
                style={{ color: 'var(--color-text-muted)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                title={t('chat.addFile')}
              >
                <Paperclip size={18} />
              </button>

              <MentionInput
                ref={inputRef}
                placeholder={t('chat.placeholder')}
                disabled={loading}
                onInput={handleMentionInput}
                onMentionTrigger={handleMentionTrigger}
                onMentionDismiss={handleMentionDismiss}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
              />
              {/* Voice input button — disabled pending fixes
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={toggleRecording}
                disabled={voiceStatus === 'loading' || voiceStatus === 'transcribing'}
                className={`w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all hover:bg-[var(--color-bg-muted)] disabled:opacity-50${voiceStatus === 'recording' ? ' voice-recording !bg-[rgba(255,69,58,0.12)]' : ''}`}
                style={{ color: voiceStatus === 'recording' ? '#FF453A' : 'var(--color-text-muted)' }}
                title={
                  voiceStatus === 'recording' ? t('chat.voice.recording')
                  : voiceStatus === 'loading' ? t('chat.voice.modelLoading', { progress: modelProgress })
                  : voiceStatus === 'transcribing' ? t('chat.voice.transcribing')
                  : t('chat.voice.record')
                }
              >
                {voiceStatus === 'loading' || voiceStatus === 'transcribing'
                  ? <Loader2 size={18} className="animate-spin" />
                  : <Mic size={18} />
                }
              </button>
              */}
              {loading ? (
                <button
                  type="button"
                  onClick={() => {
                    chatStreamStop();
                    useChatStreamStore.getState().endStream();
                    useChatStreamStore.getState().spawnComplete();
                  }}
                  className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all"
                  style={{
                    background: 'var(--color-error)',
                    color: '#FFFFFF',
                  }}
                  title={t('chat.stop', '停止')}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!message.trim() && pendingImages.length === 0}
                  className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{
                    background: (message.trim() || pendingImages.length > 0) ? 'var(--color-primary)' : 'transparent',
                    color: (message.trim() || pendingImages.length > 0) ? '#FFFFFF' : 'var(--color-text-muted)',
                  }}
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>

      {/* Lightbox modal */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.85)' }}
          onClick={() => setLightboxSrc(null)}
        >
          <button
            className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full transition-colors"
            style={{ background: 'rgba(255,255,255,0.15)', color: '#fff' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.3)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)'; }}
            onClick={() => setLightboxSrc(null)}
          >
            <X size={20} />
          </button>
          <img
            src={lightboxSrc}
            className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
            style={{ objectFit: 'contain' }}
            alt="preview"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
