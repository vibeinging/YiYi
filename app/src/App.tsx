import { useState, useEffect, useRef, useCallback } from 'react';
import { FileDown, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-shell';
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
import { useChatEventBridge } from './hooks/useChatEventBridge';
import { useTaskEventBridge } from './hooks/useTaskEventBridge';
import { useBotEventBridge } from './hooks/useBotEventBridge';
import { TaskSidebar } from './components/TaskSidebar';
import { TaskDetailOverlay } from './components/TaskDetailOverlay';
import { useTaskSidebarStore } from './stores/taskSidebarStore';
import { ClaudeCodeTerminal } from './pages/ClaudeCodeTerminal';

export type Page = 'chat' | 'skills' | 'cronjobs' | 'workspace' | 'mcp' | 'heartbeat' | 'growth' | 'bots' | 'terminal' | 'settings';

// Check for standalone window views before rendering the main app
const standaloneView = new URLSearchParams(window.location.search).get('view');

function App() {
  if (standaloneView === 'claude-code-terminal') {
    return <ClaudeCodeTerminal />;
  }
  return <MainApp />;
}

function MainApp() {
  const { t } = useTranslation();
  const [currentPage, setCurrentPage] = useState<Page>('chat');
  const [healthStatus, setHealthStatus] = useState<'ok' | 'error' | 'checking'>('checking');
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const { appliedTheme } = useTheme();
  const drag = useDragRegion();

  // Bridge Tauri streaming events to Zustand store (app-level, runs once)
  useChatEventBridge();
  useTaskEventBridge();
  useBotEventBridge();

  // Task sidebar store
  const sidebarCollapsed = useTaskSidebarStore((s) => s.sidebarCollapsed);
  const selectedTaskId = useTaskSidebarStore((s) => s.selectedTaskId);

  // Auto-expand sidebar when tasks appear
  const taskCount = useTaskSidebarStore((s) => s.tasks.length);
  const toggleSidebar = useTaskSidebarStore((s) => s.toggleSidebar);
  const prevTaskCountRef = useRef(taskCount);
  useEffect(() => {
    if (prevTaskCountRef.current === 0 && taskCount > 0 && sidebarCollapsed) {
      toggleSidebar(false);
    }
    prevTaskCountRef.current = taskCount;
  }, [taskCount, sidebarCollapsed, toggleSidebar]);

  // Load tasks and cron jobs on mount
  const loadTasks = useTaskSidebarStore((s) => s.loadTasks);
  const loadCronJobs = useTaskSidebarStore((s) => s.loadCronJobs);
  useEffect(() => {
    loadTasks();
    loadCronJobs();
  }, [loadTasks, loadCronJobs]);

  // File notifications from agent send_file_to_user tool
  const [fileNotification, setFileNotification] = useState<{
    path: string; filename: string; description: string; size: number;
  } | null>(null);

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

  // Listen for agent://send_file events
  useEffect(() => {
    const unlisten = listen<{ path: string; filename: string; description: string; size: number }>(
      'agent://send_file',
      (event) => {
        setFileNotification(event.payload);
        setTimeout(() => setFileNotification(null), 15000);
      }
    );
    return () => { unlisten.then(fn => fn()); };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const page = (e as CustomEvent).detail as Page;
      if (page) setCurrentPage(page);
    };
    window.addEventListener('navigate', handler);
    return () => window.removeEventListener('navigate', handler);
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

  // Listen for cron job changes to refresh sidebar
  useEffect(() => {
    const unlisten = listen('cronjob://refresh', () => {
      loadCronJobs();
    });
    return () => { unlisten.then(fn => fn()); };
  }, [loadCronJobs]);

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
          if (page === 'chat') {
            // Signal Chat.tsx to switch to main session
            window.dispatchEvent(new CustomEvent('chat:go-main'));
          }
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
        {/* File notification bar */}
        {fileNotification && (
          <div
            className="flex items-center gap-3 px-4 py-2.5 text-[13px] animate-in slide-in-from-top"
            style={{ background: 'var(--color-accent)', color: '#fff' }}
          >
            <FileDown size={16} />
            <span className="font-medium">{fileNotification.filename}</span>
            {fileNotification.description && (
              <span className="opacity-80">— {fileNotification.description}</span>
            )}
            <span className="opacity-60">
              ({(fileNotification.size / 1024).toFixed(1)} KB)
            </span>
            <button
              className="ml-auto px-3 py-1 rounded-md text-[12px] font-medium"
              style={{ background: 'rgba(255,255,255,0.2)' }}
              onClick={() => {
                open(fileNotification.path).catch(() => {
                  navigator.clipboard.writeText(fileNotification.path);
                });
              }}
            >
              {t('common.open')}
            </button>
            <button onClick={() => setFileNotification(null)} className="opacity-60 hover:opacity-100">
              <X size={14} />
            </button>
          </div>
        )}
        {/* Page content */}
        <div className="flex-1 overflow-hidden" style={{ background: 'var(--color-bg)', position: 'relative' }}>
          {renderPage()}
        </div>
      </div>

      {/* Task Detail Overlay (left slide-out, covers main area) */}
      {selectedTaskId && <TaskDetailOverlay />}
    </div>
    <ClaudeCodeDialog />
    </ToastProvider>
  );
}

export default App;
