/**
 * Bot Conversations Panel
 * Shows bot conversations with trigger mode, session linking, and management
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  Trash2,
  RefreshCw,
  Search,
  Loader2,
  Inbox,
  Link2,
  Unlink,
  Bell,
  BellOff,
  AtSign,
  MessageCircle,
  Hash,
} from 'lucide-react';
import { toast, confirm } from '../Toast';
import {
  listBotConversations,
  updateBotConversationTrigger,
  linkBotConversation,
  deleteBotConversation,
  type BotConversationInfo,
  type TriggerMode,
} from '../../api/bots';
import { getHistory, type ChatMessage } from '../../api/agent';
import { PLATFORM_META } from './platformMeta';
import { formatRelativeTime } from '../../utils/time';

const TRIGGER_OPTIONS: { value: TriggerMode; icon: typeof AtSign; labelKey: string }[] = [
  { value: 'mention', icon: AtSign, labelKey: 'conversations.triggerMention' },
  { value: 'all', icon: MessageCircle, labelKey: 'conversations.triggerAll' },
  { value: 'keyword', icon: Hash, labelKey: 'conversations.triggerKeyword' },
  { value: 'muted', icon: BellOff, labelKey: 'conversations.triggerMuted' },
];

export function BotConversationsPanel() {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<BotConversationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [triggerMenuId, setTriggerMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Guard against stale getHistory responses
  const loadRequestRef = useRef(0);

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const loadConversations = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listBotConversations();
      setConversations(data);
    } catch (error) {
      console.error('Failed to load conversations:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Close trigger menu on outside click via document listener
  useEffect(() => {
    if (!triggerMenuId) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setTriggerMenuId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [triggerMenuId]);

  const handleSelect = useCallback(async (conv: BotConversationInfo) => {
    if (conv.id === selectedId) return;
    setSelectedId(conv.id);
    setMessagesLoading(true);
    const requestId = ++loadRequestRef.current;
    try {
      const data = await getHistory(conv.session_id, 50);
      if (loadRequestRef.current === requestId) {
        setMessages(data);
      }
    } catch (error) {
      console.error('Failed to load messages:', error);
    } finally {
      if (loadRequestRef.current === requestId) {
        setMessagesLoading(false);
      }
    }
  }, [selectedId]);

  const handleTriggerChange = async (convId: string, mode: TriggerMode) => {
    try {
      await updateBotConversationTrigger(convId, mode);
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, trigger_mode: mode } : c)),
      );
      setTriggerMenuId(null);
    } catch (error) {
      console.error('Failed to update trigger:', error);
      toast.error(String(error));
    }
  };

  const handleUnlink = async (convId: string) => {
    try {
      await linkBotConversation(convId, null);
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, linked_session_id: null } : c)),
      );
      toast.success(t('conversations.unlinked'));
    } catch (error) {
      toast.error(String(error));
    }
  };

  const handleDelete = async (convId: string) => {
    if (!(await confirm(t('conversations.deleteConfirm')))) return;
    try {
      await deleteBotConversation(convId);
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      if (selectedId === convId) {
        setSelectedId(null);
        setMessages([]);
      }
    } catch (error) {
      toast.error(String(error));
    }
  };

  const filtered = useMemo(() => {
    if (!search) return conversations;
    const q = search.toLowerCase();
    return conversations.filter((c) =>
      (c.display_name || '').toLowerCase().includes(q) ||
      c.external_id.toLowerCase().includes(q) ||
      c.bot_name.toLowerCase().includes(q) ||
      c.platform.toLowerCase().includes(q),
    );
  }, [conversations, search]);

  if (!loading && conversations.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center max-w-sm px-6">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
            style={{ background: 'var(--color-bg-subtle)' }}
          >
            <Inbox size={28} style={{ color: 'var(--color-text-muted)', opacity: 0.5 }} />
          </div>
          <h3
            className="text-[16px] font-semibold mb-2"
            style={{ color: 'var(--color-text)', fontFamily: 'var(--font-display)' }}
          >
            {t('conversations.noConversations')}
          </h3>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
            {t('conversations.emptyDesc')}
          </p>
        </div>
      </div>
    );
  }

  const selectedTriggerOpt = selected
    ? TRIGGER_OPTIONS.find((o) => o.value === selected.trigger_mode)
    : null;

  return (
    <div className="h-full flex overflow-hidden">
      {/* Conversation list */}
      <div
        className="w-80 flex flex-col h-full shrink-0"
        style={{ background: 'var(--color-bg-elevated)', borderRight: '1px solid var(--color-border)' }}
      >
        <div className="p-4 space-y-2.5">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-muted)' }} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('conversations.searchPlaceholder')}
              className="w-full pl-9 pr-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
              style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            />
          </div>
          <button
            onClick={loadConversations}
            className="flex items-center gap-1.5 text-[12px] transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 size={18} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full" style={{ color: 'var(--color-text-muted)' }}>
              <MessageSquare size={28} className="mb-2 opacity-20" />
              <p className="text-[12px]">{t('conversations.noResults')}</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((conv) => {
                const isActive = selectedId === conv.id;
                const meta = PLATFORM_META[conv.platform] || PLATFORM_META.webhook;
                const triggerOpt = TRIGGER_OPTIONS.find((o) => o.value === conv.trigger_mode);
                return (
                  <button
                    key={conv.id}
                    onClick={() => handleSelect(conv)}
                    className={`w-full p-3 text-left rounded-lg transition-colors ${
                      isActive ? 'bg-[var(--color-bg-subtle)]' : 'hover:bg-[var(--color-bg-muted)]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-base shrink-0">{meta.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-medium truncate text-[13px]" style={{ color: 'var(--color-text)' }}>
                            {conv.display_name || conv.external_id}
                          </span>
                          <span className="text-[11px] flex-shrink-0 ml-auto" style={{ color: 'var(--color-text-muted)' }}>
                            {formatRelativeTime(conv.last_message_at)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                            style={{ background: meta.color + '15', color: meta.color }}
                          >
                            {conv.bot_name}
                          </span>
                          {triggerOpt && (
                            <span className="text-[10px] flex items-center gap-0.5" style={{ color: 'var(--color-text-muted)' }}>
                              {conv.trigger_mode === 'muted' ? <BellOff size={9} /> : <Bell size={9} />}
                              {t(triggerOpt.labelKey)}
                            </span>
                          )}
                          {conv.linked_session_id && (
                            <Link2 size={10} style={{ color: 'var(--color-primary)' }} />
                          )}
                          <span className="text-[10px] ml-auto" style={{ color: 'var(--color-text-muted)' }}>
                            {conv.message_count} {t('conversations.msgCount')}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Detail pane */}
      <div className="flex-1 flex flex-col h-full min-w-0" style={{ background: 'var(--color-bg)' }}>
        {selected ? (
          <>
            <div
              className="flex items-center px-5 py-3 justify-between shrink-0"
              style={{ borderBottom: '1px solid var(--color-border)' }}
            >
              <div className="min-w-0">
                <h3 className="font-semibold text-[14px] truncate" style={{ color: 'var(--color-text)' }}>
                  {selected.display_name || selected.external_id}
                </h3>
                <p className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--color-text-muted)' }}>
                  <span>{selected.bot_name}</span>
                  <span className="opacity-50">·</span>
                  <span>{selected.platform}</span>
                  <span className="opacity-50">·</span>
                  <span>{selected.message_count} {t('conversations.msgCount')}</span>
                </p>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {/* Trigger mode dropdown */}
                <div className="relative" ref={menuRef}>
                  <button
                    onClick={() => setTriggerMenuId(triggerMenuId === selected.id ? null : selected.id)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-lg transition-colors"
                    style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
                  >
                    {selected.trigger_mode === 'muted' ? <BellOff size={13} /> : <Bell size={13} />}
                    {selectedTriggerOpt ? t(selectedTriggerOpt.labelKey) : ''}
                  </button>
                  {triggerMenuId === selected.id && (
                    <div
                      className="absolute right-0 top-full mt-1 w-40 rounded-xl border shadow-lg py-1 z-50"
                      style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}
                    >
                      {TRIGGER_OPTIONS.map((opt) => {
                        const Icon = opt.icon;
                        const isCurrent = selected.trigger_mode === opt.value;
                        return (
                          <button
                            key={opt.value}
                            onClick={() => handleTriggerChange(selected.id, opt.value)}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-[12px] transition-colors ${
                              isCurrent ? '' : 'hover:bg-[var(--color-bg-subtle)]'
                            }`}
                            style={{
                              color: isCurrent ? 'var(--color-primary)' : 'var(--color-text)',
                              background: isCurrent ? 'var(--color-primary)' + '10' : undefined,
                            }}
                          >
                            <Icon size={13} />
                            {t(opt.labelKey)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {selected.linked_session_id && (
                  <button
                    onClick={() => handleUnlink(selected.id)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)]"
                    style={{ color: 'var(--color-warning)' }}
                    title={t('conversations.unlink')}
                  >
                    <Unlink size={13} />
                  </button>
                )}

                <button
                  onClick={() => handleDelete(selected.id)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-lg transition-colors hover:bg-[var(--color-error)]/10"
                  style={{ color: 'var(--color-error)' }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {messagesLoading ? (
                <div className="flex items-center justify-center h-32">
                  <Loader2 size={18} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full" style={{ color: 'var(--color-text-muted)' }}>
                  <MessageSquare size={32} className="mb-2 opacity-20" />
                  <p className="text-[13px]">{t('conversations.noMessages')}</p>
                </div>
              ) : (
                <div className="max-w-2xl mx-auto space-y-3">
                  {messages.map((msg, idx) => (
                    <div
                      key={idx}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className="max-w-[75%] rounded-2xl px-4 py-2.5"
                        style={{
                          background: msg.role === 'user' ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
                          color: msg.role === 'user' ? '#FFFFFF' : 'var(--color-text)',
                          border: msg.role === 'user' ? 'none' : '1px solid var(--color-border)',
                        }}
                      >
                        <p className="text-[13px] whitespace-pre-wrap break-words leading-relaxed">
                          {msg.content}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center" style={{ color: 'var(--color-text-muted)' }}>
              <MessageSquare size={32} className="mx-auto mb-3 opacity-15" />
              <p className="text-[13px]">{t('conversations.selectConversation')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
