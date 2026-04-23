import { useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { healthCheck, isSetupComplete } from './api/system';
import { SetupWizard } from './pages/SetupWizard';
import { ChatPage } from './pages/Chat';
import { SkillsPage } from './pages/Skills';
import { BotsPage } from './pages/Bots';
import { SettingsPage } from './pages/Settings';
import { TerminalPage } from './pages/Terminal';
import { CronJobsPage } from './pages/CronJobs';
import { WorkspacePage } from './pages/Workspace';
import { MCPPage } from './pages/MCP';
import { HeartbeatPage } from './pages/Heartbeat';
import { GrowthPage } from './pages/Growth';
import { useTheme } from './hooks/useTheme';
import { useDragRegion } from './hooks/useDragRegion';
import { ToastProvider } from './components/Toast';
import { ClaudeCodeDialog } from './components/ClaudeCodeDialog';
import { BuddySprite } from './components/buddy';
import { useChatEventBridge } from './hooks/useChatEventBridge';
import { useTaskEventBridge } from './hooks/useTaskEventBridge';
import { useBotEventBridge } from './hooks/useBotEventBridge';
import { usePermissionBridge } from './hooks/usePermissionBridge';
import { useGrowthEventBridge } from './hooks/useGrowthEventBridge';
import { TaskSidebar } from './components/TaskSidebar';
import { TaskDetailOverlay } from './components/TaskDetailOverlay';
import { useTaskSidebarStore } from './stores/taskSidebarStore';
import { useTaskStore } from './stores/taskStore';
export type Page = 'chat' | 'skills' | 'cronjobs' | 'workspace' | 'mcp' | 'heartbeat' | 'growth' | 'bots' | 'terminal' | 'settings';

function App() {
  return <MainApp />;
}

function MainApp() {
  const [currentPage, setCurrentPage] = useState<Page>('chat');
  const [healthStatus, setHealthStatus] = useState<'ok' | 'error' | 'checking'>('checking');
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const { appliedTheme } = useTheme();
  const drag = useDragRegion();

  // Auto-collapse sidebar on narrow windows
  const toggleSidebar = useTaskSidebarStore((s) => s.toggleSidebar);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 860px)');
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        useTaskSidebarStore.getState().toggleSidebar(true);
      }
    };
    handleChange(query);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  // Bridge Tauri streaming events to Zustand store (app-level, runs once)
  useChatEventBridge();
  useTaskEventBridge();
  useBotEventBridge();
  usePermissionBridge();
  useGrowthEventBridge();

  // Task sidebar store
  const sidebarCollapsed = useTaskSidebarStore((s) => s.sidebarCollapsed);
  const selectedTaskId = useTaskStore((s) => s.selectedTaskId);

  // Load tasks on mount (data feeds inline TaskCards in the chat stream)
  const loadTasks = useTaskStore((s) => s.loadTasks);
  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    healthCheck()
      .then(() => setHealthStatus('ok'))
      .catch(() => setHealthStatus('error'));
    isSetupComplete()
      .then((done) => setSetupDone(done))
      .catch(() => setSetupDone(true));
  }, []);

  // Show window & fade out loading screen once React is ready
  useEffect(() => {
    if (setupDone === null) return;
    // Show the window (it starts hidden to avoid white flash)
    getCurrentWindow().show().catch(() => {});
    const el = document.getElementById('app-loading');
    if (!el) return;
    el.style.opacity = '0';
    const t = setTimeout(() => el.remove(), 260);
    return () => clearTimeout(t);
  }, [setupDone]);

  useEffect(() => {
    const handler = (e: Event) => {
      const page = (e as CustomEvent).detail as Page;
      if (page) setCurrentPage(page);
    };
    window.addEventListener('navigate', handler);
    return () => window.removeEventListener('navigate', handler);
  }, []);

  // Tray menu navigation: jump to a specific page (and optional sub-tab).
  useEffect(() => {
    const unlisten = listen<{ page: Page; tab?: string | null }>('tray://navigate', (event) => {
      const { page, tab } = event.payload;
      if (page) setCurrentPage(page);
      if (tab) {
        // Settings page listens on this event to pre-select its tab.
        window.dispatchEvent(new CustomEvent('settings:set-tab', { detail: tab }));
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Notification click navigation
  const pendingNotifCtx = useRef<Record<string, unknown> | null>(null);

  const consumeNotifContext = useCallback(() => {
    const ctx = pendingNotifCtx.current;
    if (ctx) {
      pendingNotifCtx.current = null;
      return ctx;
    }
    return null;
  }, []);

  const applyNotifContext = useCallback((ctx: { page: Page; [key: string]: unknown }) => {
    pendingNotifCtx.current = ctx;
    setCurrentPage(ctx.page);
  }, []);

  useEffect(() => {
    const unlistenNavigate = listen<{ page: Page; [key: string]: unknown }>(
      'notification://navigate',
      (event) => {
        if (event.payload.page) applyNotifContext(event.payload);
      }
    );

    let pendingFallback: { page: Page; [key: string]: unknown } | null = null;
    let pendingTimestamp = 0;

    const unlistenPending = listen<{ page: Page; [key: string]: unknown }>(
      'notification://pending',
      (event) => {
        pendingFallback = event.payload;
        pendingTimestamp = Date.now();
      }
    );

    const onFocus = () => {
      if (pendingFallback && Date.now() - pendingTimestamp < 30_000) {
        const ctx = pendingFallback;
        pendingFallback = null;
        if (ctx.page) applyNotifContext(ctx);
      }
    };
    window.addEventListener('focus', onFocus);

    return () => {
      window.removeEventListener('focus', onFocus);
      unlistenNavigate.then(fn => fn());
      unlistenPending.then(fn => fn());
    };
  }, [applyNotifContext]);

  // cron jobs no longer appear in the sidebar; reloading is owned by the
  // cronjobs page when it mounts.

  /** Render the active page */
  const renderPage = () => {
    switch (currentPage) {
      case 'chat': return <ChatPage consumeNotifContext={consumeNotifContext} healthStatus={healthStatus} />;
      case 'skills': return <SkillsPage />;
      case 'cronjobs': return <CronJobsPage consumeNotifContext={consumeNotifContext} />;
      case 'workspace': return <WorkspacePage />;
      case 'mcp': return <MCPPage />;
      case 'heartbeat': return <HeartbeatPage />;
      case 'growth': return <GrowthPage />;
      case 'bots': return <BotsPage consumeNotifContext={consumeNotifContext} />;
      case 'terminal': return <TerminalPage />;
      case 'settings': return <SettingsPage />;
      default: return null;
    }
  };

  // Show setup wizard for first-time users
  if (setupDone === false) {
    return (
      <ToastProvider>
        <div className={appliedTheme}>
          <SetupWizard onComplete={() => setSetupDone(true)} />
        </div>
      </ToastProvider>
    );
  }

  // Loading state
  if (setupDone === null) {
    return null;
  }

  const sidebarWidth = sidebarCollapsed ? 60 : 220;

  return (
    <ToastProvider>
    <div className={`h-screen flex ${appliedTheme}`} style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
      {/* Task Sidebar (replaces old navigation sidebar) */}
      <TaskSidebar
        currentPage={currentPage}
        onPageChange={(page) => {
          setCurrentPage(page);
        }}
        onNavigateToSession={(sessionId) => {
          useTaskSidebarStore.getState().navigateToSession(sessionId);
          setCurrentPage('chat');
        }}
        onDragMouseDown={drag.onMouseDown}
      />

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Drag region for non-chat pages (Chat has its own ChatTabBar drag region) */}
        {currentPage !== 'chat' && (
          <div
            data-tauri-drag-region
            className="h-10 shrink-0 app-drag-region"
            style={{ background: 'var(--color-bg)' }}
          />
        )}
        {/* Page content */}
        <div className="flex-1 overflow-hidden" style={{ background: 'var(--color-bg)', position: 'relative' }}>
          {renderPage()}
        </div>
      </div>

      {/* Task Detail Overlay (left slide-out, covers main area) */}
      {selectedTaskId && <TaskDetailOverlay />}
    </div>
    <BuddySprite />
    <ClaudeCodeDialog />
    </ToastProvider>
  );
}

export default App;
