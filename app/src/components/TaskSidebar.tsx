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
  Trash2, MessageCircle, Clock, Hammer,
  PanelLeftClose, PanelLeft, Grid3X3,
  Plus, Pencil, Search, X, Users, MoreHorizontal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useSessionStore } from '../stores/sessionStore';
import { useGroupsStore } from '../stores/groupsStore';
import { useWorkStore } from '../stores/workStore';
import { AvatarGrid } from './AvatarGrid';
import { timeAgo } from '../utils/taskStatus';
import type { Page } from '../App';
import type { ChatSession } from '../api/agent';
import { listCompanions, retireCompanion, COMPANIONS_CHANGED_EVENT, type Companion } from '../api/companions';
import { CompanionEditDrawer } from './companions/CompanionEditDrawer';
import { confirm, toast } from './Toast';
import logoFaceRight from '../assets/yiyi-logo-face-right.png';

interface TaskSidebarProps {
  currentPage: Page;
  onPageChange: (page: Page) => void;
  onNavigateToSession: (sessionId: string) => void;
  onDragMouseDown: (e: React.MouseEvent) => void;
}

// 会话按"最近活跃"分桶 —— updated_at 是毫秒时间戳(Date.now() 口径)。
// displaySessions 已按 updated_at 倒序,故顺序遍历即得有序分组。
const DAY_MS = 86_400_000;
function sessionBucket(ts: number): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return '今天';
  if (ts >= startOfToday - DAY_MS) return '昨天';
  if (ts >= startOfToday - 7 * DAY_MS) return '本周';
  if (ts >= startOfToday - 30 * DAY_MS) return '本月';
  return '更早';
}

// FriendStrip(横排好友头像)已并入 FriendGroupPanel —— 好友列表从横排左右滑改成弹出面板里的
// 纵向列表(用户反馈:横排不便)。

// --- 好友弹出面板 ——点 Users 按钮弹出:好友纵向列表(可上下滚,取代原横排左右滑)。
//     2026-06-15:多分身群聊已退役,只保留 1:1 好友列表 + YiYi 主精灵。 ---
function FriendGroupPanel({
  x, y, companions, activeCompanionId, onOpenYiYi, onOpenFriend, onEditCompanion, onClose,
}: {
  x: number; y: number;
  companions: Companion[];
  activeCompanionId: number | null;
  onOpenYiYi: () => void;
  onOpenFriend: (id: number) => void;
  onEditCompanion: (c: Companion) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [ctx, setCtx] = useState<{ companion: Companion; x: number; y: number } | null>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // 右键「退休」—— 二次确认后退役(可去「小精灵」页恢复)。列表靠 COMPANIONS_CHANGED 自动刷新。
  const retire = async (c: Companion) => {
    setCtx(null);
    const ok = await confirm(`让「${c.name}」退休?退休后不在好友 / 群里出现(可去「小精灵」页恢复)。`);
    if (!ok) return;
    try { await retireCompanion(c.id); toast.success(`「${c.name}」已退休`); }
    catch (e) { toast.error(`退休失败:${e}`); }
  };

  const row = 'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg transition-colors text-left';
  return (
    <>
    <div
      ref={menuRef}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-[100] w-[226px] rounded-2xl py-2 animate-scale-in flex flex-col"
      style={{
        left: x, top: y,
        maxHeight: `calc(100vh - ${y + 16}px)`,
        background: 'var(--color-bg-elevated)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.28), 0 0 0 0.5px rgba(255,255,255,0.08)',
        backdropFilter: 'blur(40px)',
      }}
    >
      {/* 好友纵向列表(占剩余高度、可滚) */}
      <div className="text-[10px] font-semibold tracking-[0.08em] uppercase px-4 pb-1 shrink-0" style={{ color: 'var(--color-text-muted)' }}>
        好友
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-1.5" style={{ scrollbarWidth: 'thin' }}>
        {(() => {
          const bg = activeCompanionId === null ? 'var(--color-bg-muted)' : 'transparent';
          return (
            <button onClick={() => { onOpenYiYi(); onClose(); }} className={row} style={{ background: bg }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = bg; }}>
              <div className="shrink-0 w-8 h-8 rounded-[10px] flex items-center justify-center overflow-hidden" style={{ background: 'var(--sidebar-hover)' }}>
                <img src={logoFaceRight} alt="YiYi" style={{ width: '78%', height: '78%', objectFit: 'contain' }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>YiYi</div>
                <div className="text-[11px] truncate" style={{ color: 'var(--color-text-muted)' }}>主精灵</div>
              </div>
            </button>
          );
        })()}
        {companions.map((c) => {
          const active = activeCompanionId === c.id;
          const accent = c.color_hex || 'var(--color-primary)';
          const bg = active ? 'var(--color-bg-muted)' : 'transparent';
          return (
            <button key={c.id} onClick={() => { onOpenFriend(c.id); onClose(); }}
              onContextMenu={(e) => {
                e.preventDefault();
                // 锚定到该好友项的右端(尾部),不跟鼠标落点 —— 菜单总是整齐贴在 item 尾部。
                const r = e.currentTarget.getBoundingClientRect();
                setCtx({ companion: c, x: r.right - 4, y: r.top });
              }}
              className={row} style={{ background: bg }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = bg; }}>
              <div className="shrink-0 w-8 h-8 rounded-[10px] flex items-center justify-center text-[16px]" style={{ background: `${accent}26` }}>
                {c.avatar_emoji || '🤖'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>{c.name}</div>
                {c.role_label && <div className="text-[11px] truncate" style={{ color: 'var(--color-text-muted)' }}>{c.role_label}</div>}
              </div>
            </button>
          );
        })}
        {companions.length === 0 && (
          <div className="text-[11.5px] px-2.5 py-2" style={{ color: 'var(--color-text-muted)' }}>
            还没有伙伴 —— 去「小精灵」收养
          </div>
        )}
      </div>
    </div>
    {/* 右键菜单放在 panel 外 —— panel 的 backdrop-filter 会成为内部 fixed 的定位基准,放里面会把
        视口坐标当成相对 panel 的偏移而错位;它自带 onMouseDown stopPropagation,不会误关 panel。 */}
    {ctx && (
      <CompanionContextMenu
        x={ctx.x}
        y={ctx.y}
        companion={ctx.companion}
        onEdit={() => { onEditCompanion(ctx.companion); onClose(); }}
        onChat={() => { onOpenFriend(ctx.companion.id); onClose(); }}
        onRetire={() => retire(ctx.companion)}
        onClose={() => setCtx(null)}
      />
    )}
    </>
  );
}

// --- 好友右键菜单 —— 编辑资料 / 单独聊 / 退休 ---
function CompanionContextMenu({ x, y, companion, onEdit, onChat, onRetire, onClose }: {
  x: number; y: number;
  companion: Companion;
  onEdit: () => void;
  onChat: () => void;
  onRetire: () => void;
  onClose: () => void;
}) {
  const items = [
    { icon: Pencil, label: '编辑资料', danger: false, action: onEdit },
    { icon: MessageCircle, label: '单独聊', danger: false, action: onChat },
    { icon: Clock, label: '退休', danger: true, action: onRetire },
  ];
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-[110] min-w-[150px] rounded-xl py-1.5 animate-scale-in"
      style={{
        left: x, top: y,
        background: 'var(--color-bg-elevated)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.28), 0 0 0 0.5px rgba(255,255,255,0.08)',
        backdropFilter: 'blur(40px)',
      }}
    >
      <div className="px-3.5 pt-0.5 pb-1.5 text-[11px] font-medium truncate" style={{ color: 'var(--color-text-muted)' }}>
        {companion.name}
      </div>
      {items.map((item, i) => {
        const Icon = item.icon;
        return (
          <button
            key={i}
            onClick={() => { item.action(); onClose(); }}
            className="w-full flex items-center gap-2.5 px-3.5 py-[7px] text-[12.5px] transition-colors text-left"
            style={{ color: item.danger ? 'var(--color-error)' : 'var(--color-text)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = item.danger ? 'rgba(255,69,58,0.08)' : 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon size={14} style={{ opacity: 0.75 }} />
            {item.label}
          </button>
        );
      })}
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

  return (
    <>
      <div
        onClick={() => { if (!isRenaming) { switchToSession(session.id); onPageChange('chat'); } }}
        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); }}
        className="group flex items-center gap-2.5 cursor-pointer transition-colors duration-150 px-2.5 mx-1.5 my-[3px] rounded-xl"
        style={{ minHeight: '42px', background: isActive ? 'var(--color-bg-subtle)' : 'transparent' }}
        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
      >
        {/* 头像:私聊 = companion emoji, 群 = 成员拼图, 单聊 = YiYi。统一 32px 圆角方块。 */}
        {companion ? (
          <div
            className="shrink-0 w-9 h-9 rounded-[10px] flex items-center justify-center text-[18px]"
            style={{ background: companion.color_hex ? `${companion.color_hex}26` : 'var(--color-bg-subtle)' }}
            title={companion.name}
          >
            {companion.avatar_emoji || '🤖'}
          </div>
        ) : (
          <AvatarGrid groupId={session.group_id ?? null} size={36} radius="md" />
        )}

        <div className="flex-1 min-w-0 flex items-center gap-2">
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
              style={{ color: 'var(--color-text)', boxShadow: '0 0 0 1px var(--color-border)' }}
              autoFocus
            />
          ) : (
            <>
              {/* 单行:标题(常亮高对比)+ 右侧相对时间(hover 时让位给 ··· 菜单)。预览已去除,降噪。 */}
              <span className="flex-1 truncate text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
                {title}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums group-hover:hidden" style={{ color: 'var(--color-text-muted)' }}>
                {timeAgo(session.updated_at)}
              </span>
              {/* hover 快捷菜单(对齐 work 行的 hover 操作):与右键同一个菜单,可发现性入口。 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setContextMenu({ x: r.right - 4, y: r.bottom + 2 });
                }}
                className="shrink-0 w-5 h-5 rounded-md hidden group-hover:flex items-center justify-center transition-colors hover:bg-[var(--color-bg-muted)]"
                style={{ color: 'var(--color-text-muted)' }}
                title="重命名 / 删除"
              >
                <MoreHorizontal size={13} />
              </button>
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
  const workUnseen = useWorkStore((s) => s.unseenDone); // R6:job 完成红点
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

      {/* 工作(chat×work 2×2 的 work 象限)—— 与「对话」并列的对等入口,琥珀 Hammer
          一眼区别于对话的 YiYi 紫(关系 vs 交付)。点进 work 页(多 agent 派工监控)。 */}
      {(() => {
        const workActive = currentPage === 'work';
        return (
          <button
            onClick={() => onPageChange('work')}
            title="工作 · 团队交付"
            className={cell(workActive)}
            style={{
              color: workActive ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
              background: workActive ? 'var(--sidebar-active)' : 'transparent',
            }}
            onMouseEnter={(e) => { if (!workActive) e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
            onMouseLeave={(e) => { if (!workActive) e.currentTarget.style.background = 'transparent'; }}
          >
            <div className="w-7 h-7 rounded-lg flex items-center justify-center relative">
              <Hammer size={18} color="var(--color-warning)" strokeWidth={workActive ? 2.3 : 2} />
              {workUnseen > 0 && (
                <span
                  className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
                  style={{ background: 'var(--color-success)' }}
                  title="有工作完成了"
                />
              )}
            </div>
            <span className="text-[9px] font-medium leading-none">工作</span>
          </button>
        );
      })()}

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
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number } | null>(null);
  const [editingCompanion, setEditingCompanion] = useState<Companion | null>(null);
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
    const reload = () => {
      listCompanions(false).then(list => { if (!cancelled) setCompanions(list); }).catch(() => {});
    };
    reload();
    // 收养 / 改名 / 退休后(api/companions 广播)即时刷新好友列表,无需重启。
    window.addEventListener(COMPANIONS_CHANGED_EVENT, reload);
    return () => { cancelled = true; window.removeEventListener(COMPANIONS_CHANGED_EVENT, reload); };
  }, []);
  const companionById = new Map(companions.map(c => [c.id, c]));

  // 「+新对话」/ 点好友 都走 lazy 草稿:进 chat 页落到空草稿态(欢迎页),发首条消息才建会话。
  const switchToSession = useSessionStore(s => s.switchToSession);
  const enterDraftCompanion = useSessionStore(s => s.enterDraftCompanion);
  const handleNewChatClick = () => {
    // 「+新对话」→ 进空草稿态(YiYi 欢迎页),不预建 New Chat;发消息才落库。
    switchToSession('');
    onPageChange('chat');
  };

  // 当前会话绑的 companion(好友列表高亮 + chat 路由用)。
  const activeSession = chatSessions.find(s => s.id === activeSessionId);
  const activeCompanionId = (activeSession?.companion_id ?? null) as number | null;

  // 点好友头像 → 进和该 companion 的私聊(IM 心智)。
  //  有历史 → 复用最近一段(chatSessions 已按 updated_at 倒序,find 即最近;群 companion_id 为 null 自排除)。
  //  无历史 → 进纯草稿态(零会话 + 标记草稿好友):欢迎页/顶栏显示 ta,完全不碰 New Chat;
  //           发首条消息时(Chat.handleSend)才建一段全新私聊会话,避免"只是看看"堆空会话。
  const openFriend = async (companionId: number) => {
    try {
      const existing = chatSessions.find(s => s.companion_id === companionId && !s.group_id);
      if (existing) {
        switchToSession(existing.id);
        onPageChange('chat');
        return;
      }
      enterDraftCompanion(companionId);
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

        <button
          onClick={(e) => setGroupMenu({ x: e.clientX, y: e.clientY })}
          className="mt-0.5 w-9 h-9 flex items-center justify-center rounded-xl transition-colors"
          style={{ color: 'var(--sidebar-text)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title="群聊"
        >
          <Users size={16} />
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
      {groupMenu && (
      <FriendGroupPanel
        x={groupMenu.x}
        y={groupMenu.y}
        companions={companions}
        activeCompanionId={activeCompanionId}
        onOpenYiYi={openYiYi}
        onOpenFriend={openFriend}
        onEditCompanion={setEditingCompanion}
        onClose={() => setGroupMenu(null)}
      />
    )}
    {editingCompanion && (
      <CompanionEditDrawer
        companion={editingCompanion}
        onClose={() => setEditingCompanion(null)}
        onChanged={() => {}}
      />
    )}
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
        width: '300px',
        background: 'var(--color-bg)',
        borderRight: '1px solid var(--color-border)',
      }}
    >
      {/* ── Drag region ── */}
      <div className="h-10 shrink-0 app-drag-region" onMouseDown={onDragMouseDown} />

      {/* ── 头部身份区(与工作页头部同构:h-14 + 底边框,切页不跳动)── */}
      <header
        className="shrink-0 flex items-center gap-2 px-3 h-14"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 overflow-hidden"
          style={{ background: 'var(--color-bg-muted)' }}
        >
          <img src={logoFaceRight} alt="YiYi" style={{ width: '80%', height: '80%', objectFit: 'contain' }} />
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-[14px] font-semibold leading-tight" style={{ color: 'var(--color-text)' }}>
            对话
          </span>
          <span className="text-[11px] leading-tight truncate" style={{ color: 'var(--color-text-muted)' }}>
            伙伴 · 群聊 · 陪伴
          </span>
        </div>
        <button
          onClick={() => setSearchOpen(true)}
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
          style={{ color: 'var(--color-text)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title="搜索对话"
        >
          <Search size={15} style={{ opacity: 0.75 }} />
        </button>
        <button
          onClick={(e) => setGroupMenu({ x: e.clientX, y: e.clientY })}
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
          style={{ color: 'var(--color-text)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title="群聊 — 建群 / 管理成员 / 共享记忆"
        >
          <Users size={15} style={{ opacity: 0.75 }} />
        </button>
        <button
          onClick={handleNewChatClick}
          className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg transition-opacity"
          style={{ background: 'var(--color-primary)', color: '#fff' }}
          title="新对话"
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.88'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
        >
          <Plus size={16} strokeWidth={2.4} />
        </button>
      </header>

      {/* ── 搜索条(展开时出现在头部下方,不挤掉身份区)── */}
      {(searchOpen || isSearching) && (
        <div className="shrink-0 px-2 pb-1.5">
          <div className="flex items-center gap-1.5 px-3 py-[7px] rounded-[10px]" style={{ background: 'var(--color-bg-muted)' }}>
            <Search size={13} style={{ color: 'var(--color-text)', opacity: 0.7, flexShrink: 0 }} />
            <input
              ref={searchInputRef}
              autoFocus
              type="text"
              placeholder="搜索对话..."
              defaultValue={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              onBlur={() => { if (!isSearching) setSearchOpen(false); }}
              onKeyDown={(e) => { if (e.key === 'Escape') { clearSearch(); if (searchInputRef.current) searchInputRef.current.value = ''; setSearchOpen(false); } }}
              className="flex-1 min-w-0 py-0 bg-transparent text-[12px] outline-none placeholder:opacity-50"
              style={{ color: 'var(--color-text)' }}
            />
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { clearSearch(); if (searchInputRef.current) searchInputRef.current.value = ''; setSearchOpen(false); }}
              className="p-0.5 rounded transition-opacity opacity-60 hover:opacity-100"
              style={{ color: 'var(--color-text)' }}
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* 好友列表已移入「群聊」按钮的弹出面板(FriendGroupPanel)—— 横排改纵向,见用户反馈。 */}

      {/* ── Session List(下部分:聊天历史,按最近活跃分组)── */}
      <div className="flex-1 overflow-y-auto py-1.5" style={{ scrollbarWidth: 'thin' }}>
        {displaySessions.length > 0 && (
          <div className="mb-1 pt-1.5">
            {(() => {
              const card = (session: ChatSession) => (
                <SidebarSessionCard
                  key={session.id}
                  session={session}
                  isActive={activeSessionId === session.id && currentPage === 'chat'}
                  onPageChange={onPageChange}
                  companion={session.companion_id ? companionById.get(session.companion_id) : undefined}
                />
              );
              // 搜索时不分组,直接平铺结果。
              if (isSearching) return displaySessions.map(card);
              // 顺序遍历(已倒序)→ 桶变化时插一个分组头。
              const out: React.ReactNode[] = [];
              let lastBucket = '';
              for (const session of displaySessions) {
                const b = sessionBucket(session.updated_at);
                if (b !== lastBucket) {
                  lastBucket = b;
                  out.push(
                    <div key={`h-${b}`} className="text-[10px] font-semibold tracking-[0.08em] uppercase px-3.5 pt-3 pb-1" style={{ color: 'var(--color-text-muted)' }}>
                      {b}
                    </div>,
                  );
                }
                out.push(card(session));
              }
              return out;
            })()}
            {!isSearching && hasMore && (
              <div ref={sentinelRef} className="flex items-center justify-center py-2">
                {loadingMore && (
                  <span className="text-[10px]" style={{ color: 'var(--color-text-secondary)', opacity: 0.4 }}>
                    加载中...
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {isSearching && displaySessions.length === 0 && (
          <div className="px-4 py-6 text-center">
            <p className="text-[11px]" style={{ color: 'var(--color-text-secondary)', opacity: 0.4 }}>
              没有找到匹配的对话
            </p>
          </div>
        )}

        {!isSearching && chatSessions.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <div className="w-10 h-10 rounded-2xl flex items-center justify-center mb-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
              <Plus size={20} style={{ color: 'var(--color-text-secondary)', opacity: 0.4 }} />
            </div>
            <p className="text-[12px] font-medium leading-relaxed" style={{ color: 'var(--color-text-secondary)', opacity: 0.4 }}>
              点击上方按钮开始新对话
            </p>
          </div>
        )}
      </div>

    </aside>
    {groupMenu && (
      <FriendGroupPanel
        x={groupMenu.x}
        y={groupMenu.y}
        companions={companions}
        activeCompanionId={activeCompanionId}
        onOpenYiYi={openYiYi}
        onOpenFriend={openFriend}
        onEditCompanion={setEditingCompanion}
        onClose={() => setGroupMenu(null)}
      />
    )}
    {editingCompanion && (
      <CompanionEditDrawer
        companion={editingCompanion}
        onClose={() => setEditingCompanion(null)}
        onChanged={() => {}}
      />
    )}
    </>
  );
});
