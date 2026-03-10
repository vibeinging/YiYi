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
  Trash2,
  ZoomIn,
  Paperclip,
  FileText,
} from 'lucide-react';
import {
  chat,
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
import { loadWorkspaceFile } from '../api/workspace';
import { listen } from '@tauri-apps/api/event';
import { useDragRegion } from '../hooks/useDragRegion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface ChatPageProps {
  consumeNotifContext?: () => Record<string, unknown> | null;
}

export function ChatPage({ consumeNotifContext }: ChatPageProps) {
  const { t } = useTranslation();
  const drag = useDragRegion();
  const [sessions, setSessions] = useState<ApiChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [aiName, setAiName] = useState('YiClaw');
  const [boundBots, setBoundBots] = useState<BotInfo[]>([]);
  const [allBots, setAllBots] = useState<BotInfo[]>([]);
  const [showBotPopover, setShowBotPopover] = useState(false);
  const [reboundNotice, setReboundNotice] = useState('');
  const botPopoverRef = useRef<HTMLDivElement>(null);
  const [pendingImages, setPendingImages] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

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

  // Load messages and bound bots when session changes
  useEffect(() => {
    if (!currentSessionId) return;
    loadMessages(currentSessionId);
    loadBoundBots(currentSessionId);
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

  // Load all available bots on mount and when popover opens
  const refreshAllBots = () => listBots().then(setAllBots).catch(() => setAllBots([]));
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
  }, [messages, streamingContent]);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 160) + 'px';
    }
  }, [message]);

  const handleSend = async () => {
    if ((!message.trim() && pendingImages.length === 0) || loading) return;

    const userMessage = message;
    const userAttachments = pendingImages.length > 0 ? [...pendingImages] : undefined;
    setMessage('');
    setPendingImages([]);
    setLoading(true);
    setStreamingContent('');

    // Optimistically show user message
    setMessages(prev => [...prev, {
      role: 'user' as const,
      content: userMessage,
      timestamp: Date.now(),
      attachments: userAttachments,
    }]);

    try {
      const response = await chat(userMessage, currentSessionId, userAttachments);
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
      setLoading(false);
    }
  };

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
    { icon: MessageSquare, label: t('chat.quick.askAnything'), prompt: '' },
    { icon: Puzzle, label: t('chat.quick.skills'), prompt: '' },
    { icon: Terminal, label: t('chat.quick.command'), prompt: '' },
    { icon: Clock, label: t('chat.quick.schedule'), prompt: '' },
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
          /* Empty state - welcome screen with inline input */
          <div className="h-full flex flex-col items-center justify-center px-6">
            <div className="max-w-lg w-full text-center">
              {/* Logo / Icon */}
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6"
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

              {/* Quick action cards */}
              <div className="grid grid-cols-2 gap-3 mb-6">
                {quickActions.map((action, idx) => {
                  const Icon = action.icon;
                  return (
                    <button
                      key={idx}
                      onClick={() => {
                        if (action.prompt) {
                          setMessage(action.prompt);
                          inputRef.current?.focus();
                        }
                      }}
                      className="flex items-center gap-3 p-3.5 rounded-xl text-left transition-all duration-200"
                      style={{ background: 'var(--color-bg-elevated)' }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'translateY(-1px)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translateY(0)';
                      }}
                    >
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                        style={{ background: 'var(--color-primary-subtle)' }}
                      >
                        <Icon size={16} style={{ color: 'var(--color-primary)' }} />
                      </div>
                      <span className="text-[13px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                        {action.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Tips */}
              <div className="text-[12px] space-y-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
                <p>{t('chat.empty.tip1')}</p>
                <p>{t('chat.empty.tip2')}</p>
              </div>
            </div>
          </div>
        ) : (
          /* Message list */
          <div className="max-w-3xl mx-auto py-6 px-6 space-y-6">
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
            {messages.map((msg, idx) => (
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
                        {msg.content.replace(/\n\n\[用户上传了文件:.*?\]/g, '').trim()}
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
            ))}

            {/* Loading */}
            {loading && !streamingContent && (
              <div className="flex gap-3 justify-start">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
                >
                  <Bot size={16} style={{ color: 'var(--color-primary)' }} />
                </div>
                <div
                  className="py-3 px-4 rounded-2xl"
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
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0 px-6 py-4" style={{ background: 'var(--color-bg)', borderTop: '1px solid var(--color-border)' }}>
        <form onSubmit={(e) => { e.preventDefault(); handleSend(); }} className="max-w-3xl mx-auto">
          <div
            className="rounded-2xl transition-all"
            style={{
              background: 'var(--color-bg-elevated)',
              border: '1px solid var(--color-border)',
            }}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          >
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

              <textarea
                ref={inputRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={t('chat.placeholder')}
                disabled={loading}
                rows={1}
                className="flex-1 bg-transparent border-none outline-none resize-none text-[14px] px-2 py-1.5 placeholder:text-[var(--color-text-tertiary)]"
                style={{ color: 'var(--color-text)', maxHeight: '160px' }}
                autoFocus
              />
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
