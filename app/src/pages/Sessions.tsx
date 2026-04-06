/**
 * Sessions Panel - embedded in Bots page
 * Shows bot conversation history from the database
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  Trash2,
  RefreshCw,
  Search,
  Loader2,
  Inbox,
} from 'lucide-react';
import { toast, confirm } from '../components/Toast';
import { getHistory, clearHistory, type ChatMessage } from '../api/agent';
import { listBotSessions, type BotSession } from '../api/bots';
import { formatRelativeTime } from '../utils/time';

export function SessionsPanel() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<BotSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedSession, setSelectedSession] = useState<BotSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [clearing, setClearing] = useState<Set<string>>(new Set());

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listBotSessions();
      setSessions(data);
    } catch (error) {
      console.error('Failed to load bot sessions:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const loadSessionMessages = async (session: BotSession) => {
    setSelectedSession(session);
    setMessagesLoading(true);
    try {
      const data = await getHistory(session.id, 50);
      setMessages(data);
    } catch (error) {
      console.error('Failed to load messages:', error);
    } finally {
      setMessagesLoading(false);
    }
  };

  const handleClearHistory = async (sessionId: string) => {
    if (!(await confirm(t('sessions.clearHistoryConfirm')))) return;

    setClearing(prev => new Set(prev).add(sessionId));
    try {
      await clearHistory(sessionId);
      if (selectedSession?.id === sessionId) {
        setMessages([]);
      }
    } catch (error) {
      console.error('Failed to clear history:', error);
      toast.error(`${t('sessions.clearHistoryFailed')}: ${String(error)}`);
    } finally {
      setClearing(prev => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const filteredSessions = sessions.filter(session => {
    if (!search) return true;
    const q = search.toLowerCase();
    return session.name.toLowerCase().includes(q) ||
      session.id.toLowerCase().includes(q) ||
      (session.source_meta || '').toLowerCase().includes(q);
  });

  // Empty state when no sessions
  if (!loading && sessions.length === 0) {
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
            {t('sessions.noSessions')}
          </h3>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
            {t('sessions.emptyDesc')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex overflow-hidden">
      {/* Session list */}
      <div
        className="w-72 flex flex-col h-full shrink-0"
        style={{ background: 'var(--color-bg-elevated)', borderRight: '1px solid var(--color-border)' }}
      >
        {/* Search */}
        <div className="p-4 space-y-2.5">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-muted)' }} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('sessions.searchPlaceholder')}
              className="w-full pl-9 pr-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
              style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            />
          </div>
          <button
            onClick={loadSessions}
            className="flex items-center gap-1.5 text-[12px] transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>

        {/* List */}
        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 size={18} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full" style={{ color: 'var(--color-text-muted)' }}>
              <MessageSquare size={28} className="mb-2 opacity-20" />
              <p className="text-[12px]">{t('sessions.noSessions')}</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {filteredSessions.map((session) => {
                const isSelected = selectedSession?.id === session.id;
                return (
                  <button
                    key={session.id}
                    onClick={() => loadSessionMessages(session)}
                    className="w-full p-3 text-left rounded-lg transition-colors"
                    style={{
                      background: isSelected ? 'var(--color-bg-subtle)' : 'transparent',
                    }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = isSelected ? 'var(--color-bg-subtle)' : 'transparent'; }}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="font-medium truncate text-[13px]" style={{ color: 'var(--color-text)' }}>
                        {session.name}
                      </span>
                      <span className="text-[11px] flex-shrink-0 ml-2" style={{ color: 'var(--color-text-muted)' }}>
                        {formatRelativeTime(session.updated_at)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                        style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text-muted)' }}
                      >
                        {session.source}
                      </span>
                      {session.source_meta && (
                        <span className="text-[11px] truncate" style={{ color: 'var(--color-text-muted)' }}>
                          {session.source_meta}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Message detail */}
      <div className="flex-1 flex flex-col h-full min-w-0" style={{ background: 'var(--color-bg)' }}>
        {selectedSession ? (
          <>
            {/* Header */}
            <div
              className="h-13 flex items-center px-5 justify-between shrink-0"
              style={{ borderBottom: '1px solid var(--color-border)' }}
            >
              <div>
                <h3 className="font-semibold text-[14px]" style={{ color: 'var(--color-text)' }}>
                  {selectedSession.name}
                </h3>
                <p className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                  {selectedSession.source} · {selectedSession.id}
                </p>
              </div>
              <button
                onClick={() => handleClearHistory(selectedSession.id)}
                disabled={clearing.has(selectedSession.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-lg transition-colors disabled:opacity-50"
                style={{ color: 'var(--color-error)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {clearing.has(selectedSession.id) ? (
                  <RefreshCw size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} />
                )}
                <span>{t('sessions.clearHistory')}</span>
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-5">
              {messagesLoading ? (
                <div className="flex items-center justify-center h-32">
                  <Loader2 size={18} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full" style={{ color: 'var(--color-text-muted)' }}>
                  <MessageSquare size={32} className="mb-2 opacity-20" />
                  <p className="text-[13px]">{t('sessions.noMessages')}</p>
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
              <p className="text-[13px]">{t('sessions.selectSession')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
