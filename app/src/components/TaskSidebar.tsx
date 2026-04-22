/**
 * TaskSidebar - Left sidebar for session navigation + app nav.
 *
 * Tasks intentionally do NOT appear here — they render as inline TaskCards
 * in the chat stream with a detail overlay. This sidebar is purely for
 * switching between chat sessions and navigating app sections.
 */

import { memo, useState, useEffect, useRef, useCallback } from 'react';
import {
  Settings, Puzzle, Bot, Zap, FolderOpen, Sprout,
  Trash2, MessageCircle, Clock,
  PanelLeftClose, PanelLeft, Grid3X3,
  Plus, Pencil, MessageSquare, Search, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useSessionStore } from '../stores/sessionStore';
import { timeAgo } from '../utils/taskStatus';
import type { Page } from '../App';
import type { ChatSession } from '../api/agent';
import { confirm } from './Toast';

interface TaskSidebarProps {
  currentPage: Page;
  onPageChange: (page: Page) => void;
  onNavigateToSession: (sessionId: string) => void;
  onDragMouseDown: (e: React.MouseEvent) => void;
}

// --- Session context menu ---
function SessionContextMenu({ x, y, session, onClose, onStartRename }: {
  x: number; y: number;
  session: ChatSession;
  onClose: () => void;
  onStartRename: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { deleteSession } = useSessionStore();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleRename = () => {
    onClose();
    onStartRename();
  };

  const handleDelete = async () => {
    const id = session.id;
    onClose();
    const ok = await confirm('确定删除这个对话吗？');
    if (!ok) return;
    try {
      await deleteSession(id);
    } catch (err) {
      console.error('Delete session failed:', err);
    }
  };

  const items = [
    { icon: Pencil, label: '重命名', danger: false, action: handleRename },
    { icon: Trash2, label: '删除', danger: true, action: handleDelete },
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] min-w-[150px] rounded-xl py-1.5 animate-scale-in"
      style={{
        left: x, top: y,
        background: 'var(--color-bg-elevated)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.28), 0 0 0 0.5px rgba(255,255,255,0.08)',
        backdropFilter: 'blur(40px)',
      }}
    >
      {items.map((item, i) => {
        const Icon = item.icon;
        return (
          <button
            key={i}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => item.action()}
            className="w-full flex items-center gap-2.5 px-3.5 py-[7px] text-[12.5px] transition-colors text-left"
            style={{ color: item.danger ? 'var(--color-error)' : 'var(--color-text)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = item.danger ? 'rgba(255,69,58,0.08)' : 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon size={14} style={{ opacity: 0.7 }} />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

// --- Session Card ---
function SidebarSessionCard({ session, isActive, onPageChange }: {
  session: ChatSession;
  isActive: boolean;
  onPageChange: (page: Page) => void;
}) {
  const { switchToSession, renameSession } = useSessionStore();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const startRename = () => {
    setRenameValue(session.name || '');
    setIsRenaming(true);
    setTimeout(() => renameInputRef.current?.select(), 0);
  };

  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== session.name) {
      renameSession(session.id, trimmed);
    }
    setIsRenaming(false);
  };

  return (
    <>
      <div
        onClick={() => { if (!isRenaming) { switchToSession(session.id); onPageChange('chat'); } }}
        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); }}
        className="group rounded-[10px] cursor-pointer transition-all duration-150 px-2.5 py-[9px] mx-1"
        style={{ background: isActive ? 'var(--sidebar-active)' : 'transparent' }}
        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = isActive ? 'var(--sidebar-active)' : 'transparent'; }}
      >
        <div className="flex items-center gap-2.5">
          <div className="shrink-0 w-4 h-4 flex items-center justify-center">
            <MessageSquare size={12} style={{ color: isActive ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)', opacity: isActive ? 1 : 0.6 }} />
          </div>
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setIsRenaming(false);
              }}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 text-[12.5px] font-medium bg-transparent border-none outline-none rounded px-0.5"
              style={{
                color: isActive ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
                boxShadow: '0 0 0 1px var(--color-border)',
              }}
              autoFocus
            />
          ) : (
            <span className="flex-1 truncate text-[12.5px] font-medium" style={{ color: isActive ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)' }}>
              {session.name || 'New Chat'}
            </span>
          )}
          <span className="shrink-0 text-[10px] tabular-nums opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--sidebar-text)' }}>
            {timeAgo(session.updated_at)}
          </span>
        </div>
      </div>
      {contextMenu && (
        <SessionContextMenu x={contextMenu.x} y={contextMenu.y} session={session} onClose={() => setContextMenu(null)} onStartRename={startRename} />
      )}
    </>
  );
}

// --- Bottom Nav Items ---
const primaryNav: { id: Page; icon: React.ComponentType<any>; labelKey: string }[] = [
  { id: 'chat', icon: MessageCircle, labelKey: 'nav.chat' },
  { id: 'skills', icon: Puzzle, labelKey: 'nav.skills' },
  { id: 'bots', icon: Bot, labelKey: 'nav.bots' },
];

const moreNavItems: { id: Page; icon: React.ComponentType<any>; labelKey: string }[] = [
  { id: 'growth', icon: Sprout, labelKey: 'nav.growth' },
  { id: 'mcp', icon: Zap, labelKey: 'nav.mcp' },
  { id: 'cronjobs', icon: Clock, labelKey: 'nav.cronjobs' },
  { id: 'workspace', icon: FolderOpen, labelKey: 'nav.workspace' },
  { id: 'settings', icon: Settings, labelKey: 'nav.settings' },
];

// --- More Popover ---
function MorePopover({ currentPage, onPageChange, onClose }: { currentPage: Page; onPageChange: (p: Page) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 50);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 right-0 mb-2 mx-1 rounded-xl py-1.5 z-[70] animate-slide-in-bottom"
      style={{
        background: 'var(--color-bg-elevated)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.32), 0 0 0 0.5px rgba(255,255,255,0.06)',
        backdropFilter: 'blur(40px)',
      }}
    >
      {moreNavItems.map((item) => {
        const Icon = item.icon;
        const isActive = currentPage === item.id;
        return (
          <button
            key={item.id}
            onClick={() => { onPageChange(item.id); onClose(); }}
            className="w-full flex items-center gap-2.5 px-3.5 py-[7px] text-[12.5px] font-medium transition-colors"
            style={{
              color: isActive ? 'var(--sidebar-text-active)' : 'var(--color-text-secondary)',
              background: isActive ? 'var(--sidebar-active)' : 'transparent',
            }}
            onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = isActive ? 'var(--sidebar-active)' : 'transparent'; }}
          >
            <Icon size={15} style={{ opacity: isActive ? 1 : 0.6 }} />
            {t(item.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════
// Main Sidebar Component
// ═══════════════════════════════════════════
export const TaskSidebar = memo(function TaskSidebar({
  currentPage,
  onPageChange,
  onNavigateToSession: _onNavigateToSession,
  onDragMouseDown,
}: TaskSidebarProps) {
  const { t } = useTranslation();
  const sidebarCollapsed = useTaskSidebarStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useTaskSidebarStore((s) => s.toggleSidebar);

  const [moreOpen, setMoreOpen] = useState(false);

  const isMorePage = moreNavItems.some(n => n.id === currentPage);

  const chatSessions = useSessionStore((s) => s.chatSessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const createNewChat = useSessionStore((s) => s.createNewChat);
  const hasMore = useSessionStore((s) => s.hasMore);
  const loadingMore = useSessionStore((s) => s.loadingMore);
  const loadMoreSessions = useSessionStore((s) => s.loadMoreSessions);
  const searchQuery = useSessionStore((s) => s.searchQuery);
  const searchResults = useSessionStore((s) => s.searchResults);
  const searchSessionsFn = useSessionStore((s) => s.searchSessions);
  const clearSearch = useSessionStore((s) => s.clearSearch);

  // ─── Collapsed ───
  if (sidebarCollapsed) {
    return (
      <aside
        className="flex flex-col shrink-0 items-center py-2 relative z-40"
        style={{
          width: '56px',
          background: 'var(--sidebar-bg)',
          borderRight: '1px solid var(--sidebar-border)',
        }}
      >
        <div className="h-10 shrink-0 flex items-center justify-center app-drag-region" onMouseDown={onDragMouseDown} />

        <button
          onClick={() => { createNewChat(); onPageChange('chat'); }}
          className="mt-1 w-9 h-9 flex items-center justify-center rounded-xl transition-colors"
          style={{ color: 'var(--sidebar-text)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title="新对话"
        >
          <Plus size={16} />
        </button>

        <div className="flex-1" />

        <div className="flex flex-col items-center gap-0.5 mb-1">
          {primaryNav.map((item) => {
            const Icon = item.icon;
            const isActive = currentPage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onPageChange(item.id);
                  if (item.id === 'chat') window.dispatchEvent(new CustomEvent('chat:go-main'));
                }}
                className="w-9 h-9 flex items-center justify-center rounded-xl transition-all"
                style={{
                  background: isActive ? 'var(--sidebar-active)' : 'transparent',
                  color: isActive ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = isActive ? 'var(--sidebar-active)' : 'transparent'; }}
                title={t(item.labelKey)}
              >
                <Icon size={16} />
              </button>
            );
          })}
        </div>

        <button
          onClick={() => toggleSidebar()}
          className="w-9 h-9 flex items-center justify-center rounded-xl transition-colors"
          style={{ color: 'var(--sidebar-text)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <PanelLeft size={15} />
        </button>
      </aside>
    );
  }

  // ─── Expanded ───
  const displaySessions = searchResults ?? chatSessions;
  const isSearching = searchResults !== null;

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback((value: string) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!value.trim()) {
      clearSearch();
      return;
    }
    searchTimerRef.current = setTimeout(() => searchSessionsFn(value), 200);
  }, [searchSessionsFn, clearSearch]);

  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting && !isSearching) loadMoreSessions(); },
      { rootMargin: '100px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMoreSessions, isSearching]);

  return (
    <aside
      className="flex flex-col shrink-0 relative z-40"
      style={{
        width: '220px',
        background: 'var(--sidebar-bg)',
        borderRight: '1px solid var(--sidebar-border)',
      }}
    >
      {/* ── Drag region ── */}
      <div className="h-10 shrink-0 app-drag-region" onMouseDown={onDragMouseDown} />

      {/* ── New Chat ── */}
      <div className="shrink-0 px-2 pb-1">
        <button
          onClick={() => { createNewChat(); onPageChange('chat'); }}
          className="w-full flex items-center gap-2 px-3 py-[7px] rounded-[10px] transition-colors text-[12.5px] font-medium"
          style={{ color: 'var(--sidebar-text-active)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <Plus size={14} style={{ opacity: 0.7 }} />
          新对话
        </button>
      </div>

      {/* ── Session List ── */}
      <div className="flex-1 overflow-y-auto py-0.5" style={{ scrollbarWidth: 'thin' }}>
        {(displaySessions.length > 0 || searchOpen || isSearching) && (
          <div className="mb-1">
            <div className="flex items-center px-3.5 pt-3 pb-1.5">
              {searchOpen || isSearching ? (
                <div className="flex-1 flex items-center gap-1.5 animate-in slide-in-from-right-4 duration-200">
                  <Search size={11} style={{ color: 'var(--sidebar-text-active)', opacity: 0.7, flexShrink: 0 }} />
                  <input
                    ref={searchInputRef}
                    autoFocus
                    type="text"
                    placeholder="搜索对话..."
                    defaultValue={searchQuery}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    onBlur={() => { if (!isSearching) setSearchOpen(false); }}
                    onKeyDown={(e) => { if (e.key === 'Escape') { clearSearch(); if (searchInputRef.current) searchInputRef.current.value = ''; setSearchOpen(false); } }}
                    className="flex-1 min-w-0 py-0 bg-transparent text-[11px] outline-none placeholder:opacity-50"
                    style={{ color: 'var(--sidebar-text-active)' }}
                  />
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { clearSearch(); if (searchInputRef.current) searchInputRef.current.value = ''; setSearchOpen(false); }}
                    className="p-0.5 rounded transition-opacity opacity-60 hover:opacity-100"
                    style={{ color: 'var(--sidebar-text-active)' }}
                  >
                    <X size={11} />
                  </button>
                </div>
              ) : (
                <>
                  <span className="text-[10px] font-semibold tracking-[0.08em] uppercase flex-1" style={{ color: 'var(--sidebar-section)' }}>
                    对话
                  </span>
                  <button
                    onClick={() => { setSearchOpen(true); }}
                    className="p-0.5 rounded transition-opacity opacity-50 hover:opacity-100"
                    style={{ color: 'var(--sidebar-text-active)' }}
                    title="搜索对话"
                  >
                    <Search size={12} />
                  </button>
                </>
              )}
            </div>
            {displaySessions.map((session) => (
              <SidebarSessionCard
                key={session.id}
                session={session}
                isActive={activeSessionId === session.id && currentPage === 'chat'}
                onPageChange={onPageChange}
              />
            ))}
            {!isSearching && hasMore && (
              <div ref={sentinelRef} className="flex items-center justify-center py-2">
                {loadingMore && (
                  <span className="text-[10px]" style={{ color: 'var(--sidebar-text)', opacity: 0.4 }}>
                    加载中...
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {isSearching && displaySessions.length === 0 && (
          <div className="px-4 py-6 text-center">
            <p className="text-[11px]" style={{ color: 'var(--sidebar-text)', opacity: 0.4 }}>
              没有找到匹配的对话
            </p>
          </div>
        )}

        {!isSearching && chatSessions.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <div className="w-10 h-10 rounded-2xl flex items-center justify-center mb-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
              <MessageSquare size={20} style={{ color: 'var(--sidebar-text)', opacity: 0.4 }} />
            </div>
            <p className="text-[12px] font-medium leading-relaxed" style={{ color: 'var(--sidebar-text)', opacity: 0.4 }}>
              点击上方按钮开始新对话
            </p>
          </div>
        )}
      </div>

      {/* ── Bottom Nav ── */}
      <div className="shrink-0 px-2 pt-1.5 pb-2 relative" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
        {moreOpen && (
          <MorePopover currentPage={currentPage} onPageChange={onPageChange} onClose={() => setMoreOpen(false)} />
        )}
        <div className="flex items-center justify-between">
          {primaryNav.map((item) => {
            const Icon = item.icon;
            const isActive = currentPage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onPageChange(item.id);
                  if (item.id === 'chat') window.dispatchEvent(new CustomEvent('chat:go-main'));
                }}
                className="flex-1 flex flex-col items-center gap-[3px] py-1.5 rounded-lg transition-all"
                style={{
                  color: isActive ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
                  opacity: isActive ? 1 : 0.6,
                }}
                onMouseEnter={(e) => { if (!isActive) (e.currentTarget.style as any).opacity = '0.9'; }}
                onMouseLeave={(e) => { if (!isActive) (e.currentTarget.style as any).opacity = '0.6'; }}
              >
                <Icon size={17} strokeWidth={isActive ? 2.2 : 1.8} />
                <span className="text-[9px] font-medium leading-none">{t(item.labelKey)}</span>
              </button>
            );
          })}
          <button
            onClick={() => setMoreOpen(!moreOpen)}
            className="flex-1 flex flex-col items-center gap-[3px] py-1.5 rounded-lg transition-all"
            style={{
              color: isMorePage ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
              opacity: isMorePage || moreOpen ? 1 : 0.6,
            }}
            onMouseEnter={(e) => { (e.currentTarget.style as any).opacity = '0.9'; }}
            onMouseLeave={(e) => { if (!isMorePage && !moreOpen) (e.currentTarget.style as any).opacity = '0.6'; }}
          >
            <Grid3X3 size={17} strokeWidth={isMorePage ? 2.2 : 1.8} />
            <span className="text-[9px] font-medium leading-none">{t('nav.more', '更多')}</span>
          </button>
        </div>

        <button
          onClick={() => toggleSidebar()}
          className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity z-50"
          style={{
            background: 'var(--color-bg-elevated)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.2), 0 0 0 0.5px rgba(255,255,255,0.06)',
            color: 'var(--color-text-secondary)',
          }}
        >
          <PanelLeftClose size={12} />
        </button>
      </div>
    </aside>
  );
});
