/**
 * Chat Page
 * Chrome-style session tabs + rich empty state
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Send,
  Sparkles,
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
  Clock,
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
} from 'lucide-react';
import {
  chatStreamStart,
  onChatComplete,
  onChatError,
  listSessions,
  createSession,
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
import { getActiveLlm } from '../api/models';
import { listSkills } from '../api/skills';
import { createCronJob } from '../api/cronjobs';
import { MentionPicker, buildMentionList } from '../components/MentionPicker';
import { MentionInput, type MentionInputHandle, type MentionTag } from '../components/MentionInput';
import { SlashCommandPicker, filterCommands, SLASH_COMMANDS, type SlashCommand } from '../components/SlashCommandPicker';
import { SpawnAgentPanel } from '../components/SpawnAgentPanel';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useChatStreamStore } from '../stores/chatStreamStore';
import { useDragRegion } from '../hooks/useDragRegion';
import { useVoiceInput } from '../hooks/useVoiceInput';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

import type { SpawnAgent } from '../stores/chatStreamStore';

interface ChatPageProps {
  consumeNotifContext?: () => Record<string, unknown> | null;
}

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState('');
  const loading = useChatStreamStore((s) => s.loading);
  const streamingContent = useChatStreamStore((s) => s.streamingContent);
  const activeTools = useChatStreamStore((s) => s.activeTools);
  const spawnAgents = useChatStreamStore((s) => s.spawnAgents);
  const collapsedAgents = useChatStreamStore((s) => s.collapsedAgents);
  const toggleCollapseAgent = useChatStreamStore((s) => s.toggleCollapseAgent);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<MentionInputHandle>(null);
  const [aiName, setAiName] = useState('YiClaw');
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

  // Load sessions from DB on mount, then check for pending notification navigation
  useEffect(() => {
    loadSessions().then(() => {
      const ctx = consumeNotifContext?.();
      if (ctx?.page === 'chat' && ctx?.session_id) {
        setCurrentSessionId(ctx.session_id as string);
      }
    });
  }, []);

  const loadSessions = async () => {
    try {
      const list = await listSessions();
      if (list.length === 0) {
        // Create default session
        const session = await createSession(t('chat.defaultSession'));
        setSessions([session]);
        setCurrentSessionId(session.id);
      } else {
        setSessions(list);
        setCurrentSessionId(list[0].id);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  };

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
      setMessages(msgs);
    } catch (error) {
      console.error('Failed to load messages:', error);
      setMessages([]);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent, activeTools, spawnAgents]);

  // Sync message state from MentionInput (for send button disabled state)
  // Also detect /command trigger
  const handleMentionInput = useCallback((text: string) => {
    setMessage(text);

    // Detect /command at the very start of input
    const trimmed = text.trimStart();
    if (trimmed.startsWith('/') && !trimmed.includes(' ') && !trimmed.includes('\n')) {
      const query = trimmed.slice(1);
      setCommandQuery(query);
      setCommandPickerIndex(0);
      setShowCommandPicker(true);
    } else {
      setShowCommandPicker(false);
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
      useChatStreamStore.setState({ streamingContent: '', activeTools: [] });
      await loadMessages(currentSessionId);
      // Refresh sessions list to update names/timestamps
      const list = await listSessions();
      setSessions(list);
    } catch (error) {
      console.error('Failed to send message:', error);
      useChatStreamStore.setState({ streamingContent: '', activeTools: [] });
      setMessages(prev => [...prev, {
        role: 'assistant' as const,
        content: `Error: ${String(error)}`,
        timestamp: Date.now(),
      }]);
    } finally {
      useChatStreamStore.getState().endStream();
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

      useChatStreamStore.setState({ streamingContent: '', activeTools: [] });
      await loadMessages(currentSessionId);
      const list = await listSessions();
      setSessions(list);
    } catch (error) {
      console.error('Failed to send quick prompt:', error);
      useChatStreamStore.setState({ streamingContent: '', activeTools: [] });
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
        await handleClearAll();
        break;
      case 'new':
        await handleNewSession();
        break;
      case 'model': {
        try {
          const info = await getActiveLlm();
          const model = info.model
            ? `**${t('chat.command.currentModel')}**: \`${info.provider_id}/${info.model}\``
            : t('chat.command.noModel');
          showSystemMsg(model);
        } catch {
          showSystemMsg(t('chat.command.noModel'));
        }
        break;
      }
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
      case 'cron': {
        if (!args?.trim()) {
          showSystemMsg(`${t('chat.command.cronUsage')}\n\n${t('chat.command.cronExamples')}`);
          break;
        }
        // Parse: /cron 5m 提醒我喝水
        const cronMatch = args.trim().match(/^(\d+)(m|h)\s+(.+)$/);
        if (!cronMatch) {
          showSystemMsg(`${t('chat.command.cronUsage')}\n\n${t('chat.command.cronExamples')}`);
          break;
        }
        const [, amount, unit, taskText] = cronMatch;
        const delayMinutes = unit === 'h' ? parseInt(amount) * 60 : parseInt(amount);
        try {
          await createCronJob({
            id: '',
            name: taskText.slice(0, 30),
            enabled: true,
            schedule: {
              type: 'delay',
              cron: '',
              delay_minutes: delayMinutes,
            },
            text: taskText,
            dispatch: {
              targets: [{ type: 'app' }],
            },
          });
          showSystemMsg(`${t('chat.command.cronCreated')}: **${taskText}** (${amount}${unit})`);
        } catch {
          showSystemMsg(t('chat.command.cronFailed'));
        }
        break;
      }
      case 'help': {
        const helpLines = SLASH_COMMANDS.map(
          (c) => `  /${c.name} — ${t(c.description)}`
        ).join('\n');
        showSystemMsg(`**${t('chat.command.helpTitle')}**\n\n${helpLines}`);
        break;
      }
    }
  }, [handleClearAll, handleNewSession, t]);

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
        if (selected) executeCommand(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowCommandPicker(false);
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
  ];

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Chrome-style session tabs — no scroll, compress when many */}
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

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto" style={{ background: 'var(--color-bg)' }}>
        {messages.length === 0 && !loading ? (
          /* Empty state - welcome screen with expandable action cards */
          <div
            className="h-full flex flex-col items-center justify-center px-6"
            onClick={() => expandedAction !== null && setExpandedAction(null)}
          >
            <div className="max-w-lg w-full text-center">
              {/* Logo / Icon — hide when expanded */}
              <div
                className="transition-all duration-700 ease-out"
                style={{
                  opacity: expandedAction !== null ? 0 : 1,
                  maxHeight: expandedAction !== null ? 0 : '280px',
                  overflow: 'hidden',
                }}
              >
                <div
                  className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-8"
                  style={{
                    background: 'linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-end) 100%)',
                    boxShadow: '0 4px 24px rgba(255, 107, 107, 0.2)',
                  }}
                >
                  <Sparkles size={28} className="text-white" />
                </div>

                <h1
                  className="text-2xl font-bold mb-2 tracking-tight"
                  style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text)' }}
                >
                  {t('chat.empty.title')}
                </h1>
                <p className="text-[14px] mb-6" style={{ color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                  {(t('chat.empty.description') as string).replace('YiClaw', aiName)}
                </p>
              </div>

              {/* Quick action cards */}
              <div className="grid grid-cols-2 gap-3 mb-6">
                {quickActions.map((action, idx) => {
                  const Icon = action.icon;
                  const isExpanded = expandedAction === idx;
                  const isHidden = expandedAction !== null && !isExpanded;

                  return (
                    <div
                      key={idx}
                      className="transition-all duration-700 ease-out"
                      style={{
                        gridColumn: isExpanded ? '1 / -1' : undefined,
                        opacity: isHidden ? 0 : 1,
                        transform: isHidden ? 'scale(0.9)' : 'scale(1)',
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
                        className="w-full text-left rounded-xl transition-all duration-600"
                        style={{
                          background: isExpanded
                            ? 'var(--color-bg-elevated)'
                            : 'var(--color-bg-elevated)',
                          boxShadow: isExpanded
                            ? `0 8px 32px ${action.color}20, 0 0 0 1px ${action.color}30`
                            : 'none',
                        }}
                        onMouseEnter={(e) => {
                          if (!isExpanded) e.currentTarget.style.transform = 'translateY(-2px)';
                        }}
                        onMouseLeave={(e) => {
                          if (!isExpanded) e.currentTarget.style.transform = 'translateY(0)';
                        }}
                      >
                        {/* Card header */}
                        <div className="flex items-center gap-3 p-3.5">
                          <div
                            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-all duration-700"
                            style={{
                              background: isExpanded
                                ? `${action.color}20`
                                : 'var(--color-primary-subtle)',
                              transform: isExpanded ? 'scale(1.1)' : 'scale(1)',
                            }}
                          >
                            <Icon
                              size={16}
                              style={{ color: isExpanded ? action.color : 'var(--color-primary)' }}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <span
                              className="text-[13px] font-medium block"
                              style={{ color: isExpanded ? 'var(--color-text)' : 'var(--color-text-secondary)' }}
                            >
                              {action.label}
                            </span>
                            {isExpanded && (
                              <span
                                className="text-[12px] block mt-0.5 animate-fade-in"
                                style={{ color: 'var(--color-text-muted)' }}
                              >
                                {action.desc}
                              </span>
                            )}
                          </div>
                          <div
                            className="transition-transform duration-700"
                            style={{
                              transform: isExpanded ? 'rotate(45deg)' : 'rotate(0)',
                              color: 'var(--color-text-tertiary)',
                            }}
                          >
                            <Plus size={14} />
                          </div>
                        </div>

                        {/* Expanded: example prompts */}
                        {isExpanded && (
                          <div className="px-3.5 pb-3.5 space-y-1.5 animate-fade-in">
                            <div
                              className="text-[11px] font-medium uppercase tracking-wider mb-2 px-1"
                              style={{ color: 'var(--color-text-tertiary)' }}
                            >
                              {t('chat.empty.tip1').includes('Enter') ? 'Try asking' : '试试这些'}
                            </div>
                            {action.examples.map((ex, eidx) => (
                              <div
                                key={eidx}
                                className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] transition-all duration-150 cursor-pointer"
                                style={{
                                  background: 'var(--color-bg-subtle)',
                                  color: 'var(--color-text-secondary)',
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedAction(null);
                                  // Directly send the example prompt
                                  sendQuickPrompt(ex);
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = `${action.color}12`;
                                  e.currentTarget.style.color = 'var(--color-text)';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = 'var(--color-bg-subtle)';
                                  e.currentTarget.style.color = 'var(--color-text-secondary)';
                                }}
                              >
                                <Zap size={12} style={{ color: action.color, opacity: 0.7 }} className="shrink-0" />
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

              {/* Tips — hide when expanded */}
              <div
                className="text-[12px] space-y-1.5 transition-all duration-700 ease-out"
                style={{
                  color: 'var(--color-text-tertiary)',
                  opacity: expandedAction !== null ? 0 : 1,
                  maxHeight: expandedAction !== null ? 0 : '60px',
                  overflow: 'hidden',
                }}
              >
                <p>{t('chat.empty.tip1')}</p>
                <p>{t('chat.empty.tip2')}</p>
              </div>

              {/* Back hint when expanded */}
              {expandedAction !== null && (
                <div
                  className="text-[11px] animate-fade-in"
                  style={{ color: 'var(--color-text-tertiary)', opacity: 0.6 }}
                >
                  {t('chat.empty.backHint')}
                </div>
              )}
            </div>
          </div>
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
            {messages.filter(m => m.role !== 'tool').map((msg, idx) => {
              return (
              <div
                key={idx}
                className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'} group`}
              >
                {msg.role === 'assistant' && (
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                    style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
                  >
                    <Bot size={16} style={{ color: 'var(--color-primary)' }} />
                  </div>
                )}

                <div className={`max-w-[80%] ${msg.role === 'user' ? '' : ''}`}>
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
            {loading && (
              <div className="flex gap-3 justify-start">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                  style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
                >
                  <Bot size={16} style={{ color: 'var(--color-primary)' }} />
                </div>
                <div className="max-w-[80%] space-y-2">
                  {/* Tool status chips */}
                  {activeTools.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {activeTools.map((tool) => (
                        <div
                          key={tool.id}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px]"
                          style={{
                            background: 'var(--color-bg-elevated)',
                            border: '1px solid var(--color-border)',
                            color: 'var(--color-text-muted)',
                          }}
                        >
                          {tool.status === 'running' ? (
                            <Loader2 size={11} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
                          ) : (
                            <CheckCircle2 size={11} style={{ color: 'var(--color-success, #22c55e)' }} />
                          )}
                          <span className="font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                            {tool.name}
                          </span>
                        </div>
                      ))}
                    </div>
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
                      <span className="inline-block w-1.5 h-4 ml-0.5 animate-pulse rounded-sm" style={{ background: 'var(--color-primary)', verticalAlign: 'text-bottom' }} />
                    </div>
                  ) : (
                    /* Loading dots (before first chunk) */
                    <div
                      className="py-3 px-4 rounded-2xl inline-block"
                      style={{
                        background: 'var(--color-bg-elevated)',
                        border: '1px solid var(--color-border)',
                        borderBottomLeftRadius: '6px',
                      }}
                    >
                      <div className="flex gap-1.5">
                        <span className="w-2 h-2 rounded-full animate-bounce" style={{ background: 'var(--color-text-tertiary)', animationDelay: '0ms' }} />
                        <span className="w-2 h-2 rounded-full animate-bounce" style={{ background: 'var(--color-text-tertiary)', animationDelay: '150ms' }} />
                        <span className="w-2 h-2 rounded-full animate-bounce" style={{ background: 'var(--color-text-tertiary)', animationDelay: '300ms' }} />
                      </div>
                    </div>
                  )}
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
                onSelect={executeCommand}
                t={t}
              />
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
              <button
                type="submit"
                disabled={loading || (!message.trim() && pendingImages.length === 0)}
                className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  background: (message.trim() || pendingImages.length > 0) ? 'var(--color-primary)' : 'transparent',
                  color: (message.trim() || pendingImages.length > 0) ? '#FFFFFF' : 'var(--color-text-muted)',
                }}
              >
              {loading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <Send size={16} />
              )}
            </button>
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
