/**
 * TaskSidebar - Left sidebar as task management center + navigation.
 *
 * Layout:
 * - Top: Logo + brand (drag region)
 * - Middle: Task list (Pinned > Active > Scheduled > Date-grouped finished)
 * - Bottom: Quick nav icon bar (Chat, Skills, Bots, Settings, More)
 */

import { memo, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  CheckCircle, AlertCircle, Clock, Pause, XCircle,
  Settings, Puzzle, Bot, Zap, FolderOpen, Sprout,
  Pin, PinOff, Trash2, RefreshCw, MessageCircle,
  ChevronDown, ListTodo, PanelLeftClose, PanelLeft, Grid3X3,
  Plus, Pencil, MessageSquare, Search, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useSessionStore } from '../stores/sessionStore';
import { cancelTask, pauseTask, type TaskInfo } from '../api/tasks';
import { deleteCronJob, pauseCronJob, resumeCronJob } from '../api/cronjobs';
import { TASK_STATUS_CONFIG, timeAgo } from '../utils/taskStatus';
import type { Page } from '../App';
import type { ChatSession } from '../api/agent';
import { confirm } from './Toast';

interface TaskSidebarProps {
  currentPage: Page;
  onPageChange: (page: Page) => void;
  onNavigateToSession: (sessionId: string) => void;
  onDragMouseDown: (e: React.MouseEvent) => void;
}

// --- Context Menu ---
function ContextMenu({ x, y, task, onClose }: { x: number; y: number; task: TaskInfo; onClose: () => void }) {
  const { pinTask, unpinTask, deleteTask } = useTaskSidebarStore();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const items = [
    task.pinned
      ? { icon: PinOff, label: '取消置顶', danger: false, action: () => { unpinTask(task.id); onClose(); } }
      : { icon: Pin, label: '置顶', danger: false, action: () => { pinTask(task.id); onClose(); } },
  ];
  if (task.status === 'running') {
    items.push({ icon: Pause, label: '暂停', danger: false, action: async () => { await pauseTask(task.id); onClose(); } });
  }
  if (task.status === 'running' || task.status === 'paused' || task.status === 'pending') {
    items.push({ icon: XCircle, label: '取消', danger: false, action: async () => { await cancelTask(task.id); onClose(); } });
  }
  items.push({ icon: Trash2, label: '删除', danger: true, action: () => { deleteTask(task.id); onClose(); } });

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
            onClick={item.action}
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

// --- Cron Job Context Menu ---
function CronJobContextMenu({ x, y, job, onClose }: {
  x: number; y: number;
  job: { id: string; name: string; enabled: boolean };
  onClose: () => void;
}) {
  const loadCronJobs = useTaskSidebarStore((s) => s.loadCronJobs);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const items = [
    job.enabled
      ? { icon: Pause, label: '暂停', danger: false, action: async () => { await pauseCronJob(job.id); loadCronJobs(); onClose(); } }
      : { icon: RefreshCw, label: '恢复', danger: false, action: async () => { await resumeCronJob(job.id); loadCronJobs(); onClose(); } },
    { icon: Trash2, label: '删除', danger: true, action: async () => { await deleteCronJob(job.id); loadCronJobs(); onClose(); } },
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
            onClick={item.action}
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

// --- Session Context Menu ---
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
    // Check if session has running tasks
    const tasks = useTaskSidebarStore.getState().tasks;
    const runningTasks = tasks.filter(t => t.sessionId === id && t.status === 'running');
    if (runningTasks.length > 0) {
      const ok = await confirm(`该对话有 ${runningTasks.length} 个任务正在运行，删除后任务将被终止。确定删除吗？`);
      if (!ok) return;
    }
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
            onMouseDown={(e) => { console.log('[SessionMenu] mousedown on', item.label); e.stopPropagation(); }}
            onClick={() => { console.log('[SessionMenu] onClick on', item.label); item.action(); }}
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

// --- Task Card ---
function SidebarTaskCard({ task }: { task: TaskInfo }) {
  const navigateToSession = useTaskSidebarStore((s) => s.navigateToSession);
  const isNewlyCreated = useTaskSidebarStore((s) => s.newlyCreatedTaskIds.has(task.id));
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const isRunning = task.status === 'running';
  const cfg = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.pending;

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setTick(t => t + 1), 10000);
    return () => clearInterval(id);
  }, [isRunning]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  return (
    <>
      <div
        onClick={() => navigateToSession(task.sessionId)}
        onContextMenu={handleContextMenu}
        className={`group relative rounded-[10px] cursor-pointer transition-all duration-150 px-2.5 py-[9px] mx-1${isNewlyCreated ? ' task-birth-glow' : ''}`}
        style={{ background: 'transparent' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
        onMouseLeave={(e) => { if (!isNewlyCreated) e.currentTarget.style.background = 'transparent'; }}
      >
        {/* Status accent bar */}
        {(isRunning || task.status === 'paused') && (
          <div
            className="absolute left-0 top-[8px] bottom-[8px] w-[2.5px] rounded-full transition-colors"
            style={{
              background: cfg.color,
              opacity: isRunning ? 1 : 0.5,
              animation: isRunning ? 'pulse-dot 2.5s ease-in-out infinite' : 'none',
            }}
          />
        )}

        <div className="flex items-center gap-2.5">
          {/* Status icon */}
          <div className="shrink-0 w-4 h-4 flex items-center justify-center">
            {isRunning ? (
              <div className="w-[7px] h-[7px] rounded-full" style={{ background: cfg.color, boxShadow: `0 0 6px ${cfg.color}` }} />
            ) : task.status === 'completed' ? (
              <CheckCircle size={13} style={{ color: cfg.color }} />
            ) : task.status === 'failed' ? (
              <AlertCircle size={13} style={{ color: cfg.color }} />
            ) : task.status === 'paused' ? (
              <Pause size={13} style={{ color: cfg.color }} />
            ) : (
              <Clock size={13} style={{ color: cfg.color }} />
            )}
          </div>

          {/* Title */}
          <span className="flex-1 truncate text-[12.5px] font-medium" style={{ color: 'var(--sidebar-text-active)' }}>
            {task.title}
          </span>

          {/* Time */}
          <span className="shrink-0 text-[10px] tabular-nums opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--sidebar-text)' }}>
            {timeAgo(task.updatedAt || task.createdAt)}
          </span>
        </div>

        {/* Progress bar */}
        {isRunning && task.totalStages > 0 && (
          <div className="mt-[6px] ml-[26px] flex items-center gap-2">
            <div className="flex-1 h-[2px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div
                className="h-full rounded-full transition-all duration-700 ease-out"
                style={{ width: `${Math.min(task.progress, 100)}%`, background: cfg.color }}
              />
            </div>
            <span className="text-[9px] tabular-nums font-medium" style={{ color: 'var(--sidebar-text)', opacity: 0.7 }}>
              {task.currentStage}/{task.totalStages}
            </span>
          </div>
        )}
      </div>
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} task={task} onClose={() => setContextMenu(null)} />
      )}
    </>
  );
}

// --- Cron Job Card ---
function SidebarCronJobCard({ job, onNavigateToSession }: {
  job: { id: string; name: string; schedule_display: string; enabled: boolean };
  onNavigateToSession: (sessionId: string) => void;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      <div
        onClick={() => onNavigateToSession(`cron:${job.id}`)}
        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); }}
        className="rounded-[10px] cursor-pointer transition-all px-2.5 py-[9px] mx-1"
        style={{ background: 'transparent' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-4 h-4 flex items-center justify-center shrink-0">
            <RefreshCw size={12} style={{ color: 'var(--color-primary)', opacity: 0.8 }} />
          </div>
          <span className="flex-1 truncate text-[12.5px] font-medium" style={{ color: 'var(--sidebar-text-active)' }}>
            {job.name}
          </span>
        </div>
        {job.schedule_display && (
          <span className="text-[10px] block ml-[26px] mt-0.5" style={{ color: 'var(--sidebar-text)', opacity: 0.6 }}>
            {job.schedule_display}
          </span>
        )}
      </div>
      {contextMenu && (
        <CronJobContextMenu x={contextMenu.x} y={contextMenu.y} job={job} onClose={() => setContextMenu(null)} />
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

// --- Section Header ---
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3.5 pt-3 pb-1.5">
      <span className="text-[10px] font-semibold tracking-[0.08em] uppercase" style={{ color: 'var(--sidebar-section)' }}>
        {children}
      </span>
    </div>
  );
}

// --- Date grouping helpers ---
interface DateGroup {
  label: string;
  tasks: TaskInfo[];
}

function getDateGroupLabel(ts: number): string {
  const now = new Date();
  const date = new Date(ts);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400_000;
  // Monday of this week
  const dayOfWeek = now.getDay() || 7; // Sunday=7
  const weekStart = todayStart - (dayOfWeek - 1) * 86400_000;

  if (ts >= todayStart) return '今天';
  if (ts >= yesterdayStart) return '昨天';
  if (ts >= weekStart) return '本周';
  // Same month
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return '本月';
  // Format as YYYY-MM
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function groupTasksByDate(tasks: TaskInfo[]): DateGroup[] {
  const order = ['今天', '昨天', '本周', '本月'];
  const groups = new Map<string, TaskInfo[]>();

  for (const task of tasks) {
    const label = getDateGroupLabel(task.completedAt || task.updatedAt || task.createdAt);
    const list = groups.get(label);
    if (list) list.push(task);
    else groups.set(label, [task]);
  }

  // Sort tasks within each group by time desc
  for (const list of groups.values()) {
    list.sort((a, b) => (b.completedAt || b.updatedAt || b.createdAt) - (a.completedAt || a.updatedAt || a.createdAt));
  }

  // Sort groups: predefined order first, then chronologically desc for month labels
  const result: DateGroup[] = [];
  for (const label of order) {
    const list = groups.get(label);
    if (list) { result.push({ label, tasks: list }); groups.delete(label); }
  }
  // Remaining (month labels) sorted desc
  const remaining = [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  for (const [label, tasks] of remaining) {
    result.push({ label, tasks });
  }
  return result;
}

// ═══════════════════════════════════════════
// Main Sidebar Component
// ═══════════════════════════════════════════
export const TaskSidebar = memo(function TaskSidebar({
  currentPage,
  onPageChange,
  onNavigateToSession,
  onDragMouseDown,
}: TaskSidebarProps) {
  const { t } = useTranslation();
  const tasks = useTaskSidebarStore((s) => s.tasks);
  const cronJobs = useTaskSidebarStore((s) => s.cronJobs);
  const sidebarCollapsed = useTaskSidebarStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useTaskSidebarStore((s) => s.toggleSidebar);

  const [moreOpen, setMoreOpen] = useState(false);
  const [showAllFinished, setShowAllFinished] = useState(false);

  // Pinned tasks: sorted by lastActivityAt desc (pin time)
  const pinnedTasks = useMemo(
    () => tasks.filter(t => t.pinned).sort((a, b) => (b.lastActivityAt || b.updatedAt) - (a.lastActivityAt || a.updatedAt)),
    [tasks],
  );

  // Active tasks (not pinned): running/paused/pending
  const activeTasks = useMemo(
    () => tasks.filter(t => !t.pinned && (t.status === 'running' || t.status === 'paused' || t.status === 'pending')),
    [tasks],
  );

  // Finished tasks (not pinned), grouped by date
  const finishedGroups = useMemo(() => {
    const finished = tasks.filter(t => !t.pinned && (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'));
    return groupTasksByDate(finished);
  }, [tasks]);

  const totalFinished = useMemo(() => finishedGroups.reduce((sum, g) => sum + g.tasks.length, 0), [finishedGroups]);

  // Limit finished tasks when collapsed: show first N tasks across groups
  const MAX_COLLAPSED_FINISHED = 8;
  const visibleFinishedGroups = useMemo(() => {
    if (showAllFinished) return finishedGroups;
    let remaining = MAX_COLLAPSED_FINISHED;
    const result: DateGroup[] = [];
    for (const group of finishedGroups) {
      if (remaining <= 0) break;
      if (group.tasks.length <= remaining) {
        result.push(group);
        remaining -= group.tasks.length;
      } else {
        result.push({ label: group.label, tasks: group.tasks.slice(0, remaining) });
        remaining = 0;
      }
    }
    return result;
  }, [finishedGroups, showAllFinished]);

  const hasMoreFinished = totalFinished > MAX_COLLAPSED_FINISHED;

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
    const activeCount = activeTasks.length + pinnedTasks.filter(t => t.status === 'running' || t.status === 'paused' || t.status === 'pending').length;
    return (
      <aside
        className="flex flex-col shrink-0 items-center py-2 relative z-40"
        style={{
          width: '56px',
          background: 'var(--sidebar-bg)',
          borderRight: '1px solid var(--sidebar-border)',
        }}
      >
        {/* Drag region (traffic lights space on macOS) */}
        <div className="h-10 shrink-0 flex items-center justify-center app-drag-region" onMouseDown={onDragMouseDown} />

        {/* New chat button */}
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

        {/* Active task count */}
        {activeCount > 0 && (
          <button
            onClick={() => toggleSidebar(false)}
            className="mt-1 w-9 h-9 flex flex-col items-center justify-center rounded-xl transition-colors"
            style={{ color: 'var(--sidebar-text-active)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            title={`${activeCount} active tasks`}
          >
            <span className="text-[13px] font-bold tabular-nums leading-none">{activeCount}</span>
            <div className="w-1 h-1 rounded-full mt-[3px]" style={{ background: 'var(--color-primary)', boxShadow: '0 0 4px var(--color-primary)' }} />
          </button>
        )}

        <div className="flex-1" />

        {/* Collapsed nav icons */}
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

        {/* Expand */}
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
  const hasNoTasks = tasks.length === 0 && cronJobs.length === 0;

  // Session list: show search results or paginated list
  const displaySessions = searchResults ?? chatSessions;
  const isSearching = searchResults !== null;

  // Debounced search
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback((value: string) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!value.trim()) {
      clearSearch();
      return;
    }
    searchTimerRef.current = setTimeout(() => searchSessionsFn(value), 200);
  }, [searchSessionsFn, clearSearch]);

  // Search expand state
  const [searchOpen, setSearchOpen] = useState(false);
  // Refs
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
      {/* ── Drag region (traffic lights space on macOS) ── */}
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

      {/* ── Content List ── */}
      <div className="flex-1 overflow-y-auto py-0.5" style={{ scrollbarWidth: 'thin' }}>
        {/* Chat sessions */}
        {(displaySessions.length > 0 || searchOpen || isSearching) && (
          <div className="mb-1">
            {/* Section header with expandable search */}
            <div className="flex items-center px-3.5 pt-3 pb-1.5">
              {searchOpen || isSearching ? (
                /* Expanded search input — slides in from right */
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
                /* Collapsed: label + search icon */
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
            {/* Infinite scroll sentinel — only in non-search mode */}
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

        {isSearching && displaySessions.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[11px]" style={{ color: 'var(--sidebar-text)', opacity: 0.4 }}>
              没有找到匹配的对话
            </p>
          </div>
        ) : hasNoTasks && chatSessions.length === 0 && !isSearching ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <div className="w-10 h-10 rounded-2xl flex items-center justify-center mb-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
              <MessageSquare size={20} style={{ color: 'var(--sidebar-text)', opacity: 0.4 }} />
            </div>
            <p className="text-[12px] font-medium leading-relaxed" style={{ color: 'var(--sidebar-text)', opacity: 0.4 }}>
              点击上方按钮开始新对话
            </p>
          </div>
        ) : (
          <>
            {/* Pinned tasks */}
            {pinnedTasks.length > 0 && (
              <div className="mb-1">
                <SectionLabel>
                  <Pin size={9} className="inline mr-1 -mt-[1px]" />
                  置顶
                </SectionLabel>
                {pinnedTasks.map((task) => (
                  <SidebarTaskCard key={task.id} task={task} />
                ))}
              </div>
            )}

            {/* Active tasks (not pinned) */}
            {activeTasks.length > 0 && (
              <div className="mb-1">
                <SectionLabel>进行中</SectionLabel>
                {activeTasks.map((task) => (
                  <SidebarTaskCard key={task.id} task={task} />
                ))}
              </div>
            )}

            {/* Cron jobs */}
            {cronJobs.length > 0 && (
              <div className="mb-1">
                <SectionLabel>定时</SectionLabel>
                {cronJobs.map((job) => (
                  <SidebarCronJobCard key={job.id} job={job} onNavigateToSession={onNavigateToSession} />
                ))}
              </div>
            )}

            {/* Finished tasks grouped by date */}
            {visibleFinishedGroups.map((group) => (
              <div key={group.label} className="mb-1">
                <SectionLabel>{group.label}</SectionLabel>
                {group.tasks.map((task) => (
                  <SidebarTaskCard key={task.id} task={task} />
                ))}
              </div>
            ))}

            {hasMoreFinished && !showAllFinished && (
              <button
                onClick={() => setShowAllFinished(true)}
                className="w-full flex items-center justify-center gap-1 py-2 text-[10px] font-medium rounded-lg transition-colors"
                style={{ color: 'var(--sidebar-text)', opacity: 0.5 }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--sidebar-hover)'; (e.currentTarget.style as any).opacity = '0.8'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; (e.currentTarget.style as any).opacity = '0.5'; }}
              >
                <ChevronDown size={11} />
                更多 ({totalFinished - MAX_COLLAPSED_FINISHED})
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Bottom Nav Bar ── */}
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
          {/* More button */}
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

        {/* Collapse toggle */}
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
