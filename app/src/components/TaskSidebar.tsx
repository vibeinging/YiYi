/**
 * TaskSidebar - Left sidebar for session navigation + app nav.
 *
 * Tasks intentionally do NOT appear here — they render as inline TaskCards
 * in the chat stream with a detail overlay. This sidebar is purely for
 * switching between chat sessions and navigating app sections.
 */

import { memo, useState, useEffect, useRef, useCallback } from 'react';
import {
  Settings, Puzzle, Bot, Zap, FolderOpen, Sprout, Sparkles,
  Trash2, MessageCircle, Clock,
  PanelLeftClose, PanelLeft, Grid3X3,
  Plus, Pencil, Search, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useSessionStore } from '../stores/sessionStore';
import { useGroupsStore } from '../stores/groupsStore';
import { AvatarGrid } from './AvatarGrid';
import { timeAgo } from '../utils/taskStatus';
import type { Page } from '../App';
import type { ChatSession } from '../api/agent';
import { getOrCreateCompanionSession } from '../api/agent';
import { listCompanions, type Companion } from '../api/companions';
import { confirm } from './Toast';
import logoFaceRight from '../assets/yiyi-logo-face-right.png';

interface TaskSidebarProps {
  currentPage: Page;
  onPageChange: (page: Page) => void;
  onNavigateToSession: (sessionId: string) => void;
  onDragMouseDown: (e: React.MouseEvent) => void;
}

// --- 好友列表(横排头像:YiYi 置顶 + 各 companion,点击单独对话)---
function FriendStrip({
  companions,
  activeCompanionId,
  onOpenYiYi,
  onOpenFriend,
}: {
  companions: Companion[];
  /** 当前会话绑的 companion id(高亮用);null = 不在私聊。 */
  activeCompanionId: number | null;
  onOpenYiYi: () => void;
  onOpenFriend: (companionId: number) => void;
}) {
  return (
    <div className="shrink-0 px-2 pt-1 pb-1.5">
      <div className="text-[10px] font-semibold tracking-[0.08em] uppercase px-1.5 pb-1" style={{ color: 'var(--sidebar-section)' }}>
        好友
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
        {/* YiYi 置顶 —— 点它回到和主精灵的默认对话 */}
        <button
          onClick={onOpenYiYi}
          className="shrink-0 flex flex-col items-center gap-0.5 w-12 group"
          title="YiYi · 主精灵"
        >
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center overflow-hidden transition-all"
            style={{
              background: 'var(--sidebar-hover)',
              outline: activeCompanionId === null ? '2px solid var(--color-primary)' : '2px solid transparent',
              outlineOffset: '1px',
            }}
          >
            <img src={logoFaceRight} alt="YiYi" style={{ width: '80%', height: '80%', objectFit: 'contain' }} />
          </div>
          <span className="text-[10px] truncate w-full text-center" style={{ color: 'var(--sidebar-text)' }}>YiYi</span>
        </button>

        {companions.map((c) => {
          const active = activeCompanionId === c.id;
          return (
            <button
              key={c.id}
              onClick={() => onOpenFriend(c.id)}
              className="shrink-0 flex flex-col items-center gap-0.5 w-12 group"
              title={`和 ${c.name} 单独聊`}
            >
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-[18px] transition-all"
                style={{
                  background: c.color_hex ? `${c.color_hex}26` : 'var(--sidebar-hover)',
                  outline: active ? '2px solid var(--color-primary)' : '2px solid transparent',
                  outlineOffset: '1px',
                }}
              >
                {c.avatar_emoji || '🤖'}
              </div>
              <span className="text-[10px] truncate w-full text-center" style={{ color: 'var(--sidebar-text)' }}>
                {c.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
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
function SidebarSessionCard({ session, isActive, onPageChange, companion }: {
  session: ChatSession;
  isActive: boolean;
  onPageChange: (page: Page) => void;
  /** 私聊会话绑的 companion(用于渲染它的头像)。 */
  companion?: Companion;
}) {
  const { switchToSession, renameSession } = useSessionStore();
  // 若 session 绑了具名家族,从 groupsStore 取 emoji+name(失败时 group 为 undefined,
  // 不渲染前缀。stale 容忍:用户在 BuddyPanel 改了家族 emoji,下次 store.load() 自动刷新)。
  const group = useGroupsStore(s =>
    session.group_id != null ? s.byId.get(session.group_id) : undefined,
  );
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

  const title = group ? group.name : (session.name || 'New Chat');
  // 第二行预览(微信式):优先最后一条消息(后端带出),压成单行;空(新会话)则
  // 回落群话题。所有行固定 52px 高 + 垂直居中,1/2 行行高一致。
  const lastMsg = (session.last_message ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const preview = lastMsg || (group && session.name && session.name !== group.name ? session.name : null);

  return (
    <>
      <div
        onClick={() => { if (!isRenaming) { switchToSession(session.id); onPageChange('chat'); } }}
        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); }}
        className="group flex items-center gap-2.5 cursor-pointer transition-colors duration-150 px-2.5 mx-1.5 rounded-xl"
        style={{ minHeight: '52px', background: isActive ? 'var(--sidebar-active)' : 'transparent' }}
        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
      >
        {/* 头像:私聊 = companion emoji, 群 = 成员拼图, 单聊 = YiYi。统一 40px 圆角方块。 */}
        {companion ? (
          <div
            className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-[20px]"
            style={{ background: companion.color_hex ? `${companion.color_hex}26` : 'var(--color-bg-subtle)' }}
            title={companion.name}
          >
            {companion.avatar_emoji || '🤖'}
          </div>
        ) : (
          <AvatarGrid groupId={session.group_id ?? null} size={40} radius="md" />
        )}

        <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5 py-1">
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
              className="w-full text-[13px] font-medium bg-transparent border-none outline-none rounded px-0.5"
              style={{ color: 'var(--sidebar-text-active)', boxShadow: '0 0 0 1px var(--color-border)' }}
              autoFocus
            />
          ) : (
            <>
              {/* 第 1 行:标题(常亮高对比,不再 50% 发灰)+ 右上角常驻时间。 */}
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate text-[13px] font-medium" style={{ color: 'var(--sidebar-text-active)' }}>
                  {title}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums" style={{ color: 'var(--sidebar-section)' }}>
                  {timeAgo(session.updated_at)}
                </span>
              </div>
              {/* 第 2 行:话题预览(群聊),灰色单行截断。 */}
              {preview && (
                <span className="truncate text-[11.5px] leading-snug" style={{ color: 'var(--sidebar-text)' }}>
                  {preview}
                </span>
              )}
            </>
          )}
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
  { id: 'buddy', icon: Sparkles, labelKey: 'nav.buddy' },
  { id: 'extensions', icon: Puzzle, labelKey: 'nav.extensions' },
  { id: 'bots', icon: Bot, labelKey: 'nav.bots' },
  { id: 'cronjobs', icon: Clock, labelKey: 'nav.cronjobs' },
  { id: 'settings', icon: Settings, labelKey: 'nav.settings' },
];

// growth / mcp / workspace are reachable from their respective entry points
// (Buddy page, Extensions page, task detail) and don't need a dedicated nav slot.
const moreNavItems: { id: Page; icon: React.ComponentType<any>; labelKey: string }[] = [];

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
// NavRail —— 最左侧竖排导航(微信三栏的第 1 栏)
// ═══════════════════════════════════════════
export function NavRail({
  currentPage,
  onPageChange,
  onGoChat,
  onToggleSidebar,
  sidebarCollapsed,
  onDragMouseDown,
}: {
  currentPage: Page;
  onPageChange: (p: Page) => void;
  onGoChat: () => void;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  onDragMouseDown: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const chatActive = currentPage === 'chat';
  const cell = (active: boolean) =>
    `w-11 flex flex-col items-center gap-[3px] py-1.5 rounded-xl transition-all`;
  return (
    <aside
      className="flex flex-col shrink-0 items-center relative z-50"
      style={{ width: '60px', background: 'var(--sidebar-bg)', borderRight: '1px solid var(--sidebar-border)' }}
    >
      <div className="h-10 shrink-0 w-full app-drag-region" onMouseDown={onDragMouseDown} />

      {/* YiYi 主页(= 对话栏) */}
      <button
        onClick={onGoChat}
        title="YiYi · 对话"
        className={cell(chatActive)}
        style={{
          color: chatActive ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
          background: chatActive ? 'var(--sidebar-active)' : 'transparent',
        }}
        onMouseEnter={(e) => { if (!chatActive) e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
        onMouseLeave={(e) => { if (!chatActive) e.currentTarget.style.background = 'transparent'; }}
      >
        <div className="w-7 h-7 rounded-lg overflow-hidden flex items-center justify-center">
          <img src={logoFaceRight} alt="YiYi" style={{ width: '88%', height: '88%', objectFit: 'contain' }} />
        </div>
        <span className="text-[9px] font-medium leading-none">对话</span>
      </button>

      {/* 主导航(设置除外)—— 顶部 */}
      <div className="mt-0.5 flex flex-col items-center gap-0.5">
        {primaryNav.filter((i) => i.id !== 'settings').map((item) => {
          const Icon = item.icon;
          const isActive = currentPage === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onPageChange(item.id)}
              title={t(item.labelKey)}
              className={cell(isActive)}
              style={{
                color: isActive ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
                background: isActive ? 'var(--sidebar-active)' : 'transparent',
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon size={18} strokeWidth={isActive ? 2.2 : 1.8} />
              <span className="text-[9px] font-medium leading-none">{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      {/* 设置 —— 底部(微信式) */}
      {(() => {
        const settings = primaryNav.find((i) => i.id === 'settings');
        if (!settings) return null;
        const Icon = settings.icon;
        const isActive = currentPage === 'settings';
        return (
          <button
            onClick={() => onPageChange('settings')}
            title={t(settings.labelKey)}
            className={cell(isActive)}
            style={{
              color: isActive ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
              background: isActive ? 'var(--sidebar-active)' : 'transparent',
            }}
            onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
            onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon size={18} strokeWidth={isActive ? 2.2 : 1.8} />
            <span className="text-[9px] font-medium leading-none">{t(settings.labelKey)}</span>
          </button>
        );
      })()}

      <button
        onClick={onToggleSidebar}
        title={sidebarCollapsed ? '展开会话列表' : '折叠会话列表'}
        className="mt-0.5 mb-2 w-9 h-9 flex items-center justify-center rounded-xl transition-colors"
        style={{ color: 'var(--sidebar-text)' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        {sidebarCollapsed ? <PanelLeft size={15} /> : <PanelLeftClose size={15} />}
      </button>
    </aside>
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
  const hasMore = useSessionStore((s) => s.hasMore);
  const loadingMore = useSessionStore((s) => s.loadingMore);
  const loadMoreSessions = useSessionStore((s) => s.loadMoreSessions);
  const searchQuery = useSessionStore((s) => s.searchQuery);
  const searchResults = useSessionStore((s) => s.searchResults);
  const searchSessionsFn = useSessionStore((s) => s.searchSessions);
  const clearSearch = useSessionStore((s) => s.clearSearch);

  // 初始化:挂载时拉一次家族列表到 store —— session 卡渲染前缀、新对话 picker、
  // chat header 选择器都从这个 store 读。FamilyGroupsSection 的 CRUD 完成后会
  // 调 .load() 触发刷新。
  useEffect(() => {
    void useGroupsStore.getState().load();
  }, []);

  // companions(好友列表 + 私聊会话卡头像共用,拉一次)。
  const [companions, setCompanions] = useState<Companion[]>([]);
  useEffect(() => {
    let cancelled = false;
    listCompanions(false).then(list => { if (!cancelled) setCompanions(list); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const companionById = new Map(companions.map(c => [c.id, c]));

  // 点"+ 新对话"直接走老路径 —— 创建空白会话进 chat 页,不再走"和谁聊"picker。
  // 想拉家族成员的话,在对话里通过 ChatHeader 的邀请 / 管理入口操作。
  const createNewChat = useSessionStore(s => s.createNewChat);
  const switchToSession = useSessionStore(s => s.switchToSession);
  const refreshSessions = useSessionStore(s => s.refreshSessions);
  const handleNewChatClick = async () => {
    try {
      await createNewChat();
      onPageChange('chat');
    } catch (e) {
      console.error('createNewChat failed', e);
    }
  };

  // 当前会话绑的 companion(好友列表高亮 + chat 路由用)。
  const activeSession = chatSessions.find(s => s.id === activeSessionId);
  const activeCompanionId = (activeSession?.companion_id ?? null) as number | null;

  // 点好友 → 拿/建该 companion 的专属私聊会话,切过去。
  const openFriend = async (companionId: number) => {
    try {
      const sid = await getOrCreateCompanionSession(companionId);
      await refreshSessions(); // 新建的私聊会话同步进历史列表
      switchToSession(sid);
      onPageChange('chat');
    } catch (e) {
      console.error('openFriend failed', e);
    }
  };

  // 点 YiYi → 回到和主精灵的默认对话(最近一个非私聊非群的会话,没有就新建)。
  const openYiYi = () => {
    const yiyiChat = chatSessions.find(s => !s.group_id && !s.companion_id);
    if (yiyiChat) {
      switchToSession(yiyiChat.id);
      onPageChange('chat');
    } else {
      void handleNewChatClick();
    }
  };

  // ─── Collapsed ───
  if (sidebarCollapsed) {
    return (
      <>
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
          onClick={handleNewChatClick}
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
      </>
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
    <>
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
          onClick={handleNewChatClick}
          className="w-full flex items-center gap-2 px-3 py-[7px] rounded-[10px] transition-colors text-[12.5px] font-medium"
          style={{ color: 'var(--sidebar-text-active)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <Plus size={14} style={{ opacity: 0.7 }} />
          新对话
        </button>
      </div>

      {/* ── 好友列表(上部分:点头像和 agent 单独对话)── */}
      <FriendStrip
        companions={companions}
        activeCompanionId={activeCompanionId}
        onOpenYiYi={openYiYi}
        onOpenFriend={openFriend}
      />
      <div className="shrink-0 mx-3 mb-0.5" style={{ borderTop: '1px solid var(--sidebar-border)' }} />

      {/* ── Session List(下部分:聊天历史)── */}
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
                companion={session.companion_id ? companionById.get(session.companion_id) : undefined}
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
              <Plus size={20} style={{ color: 'var(--sidebar-text)', opacity: 0.4 }} />
            </div>
            <p className="text-[12px] font-medium leading-relaxed" style={{ color: 'var(--sidebar-text)', opacity: 0.4 }}>
              点击上方按钮开始新对话
            </p>
          </div>
        )}
      </div>

    </aside>
    </>
  );
});
