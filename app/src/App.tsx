import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Settings,
  MessageSquare,
  Puzzle,
  Bot,
  Terminal,
  Clock,
  FolderOpen,
  Zap,

  Activity,
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeft,
  FileDown,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-shell';
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

import { ThemeSwitcher } from './components/ThemeSwitcher';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { useTheme } from './hooks/useTheme';
import { useDragRegion } from './hooks/useDragRegion';
import { ToastProvider } from './components/Toast';
import { SandboxAccessDialog } from './components/SandboxAccessDialog';
import { ClaudeCodeDialog } from './components/ClaudeCodeDialog';
import { useChatEventBridge } from './hooks/useChatEventBridge';

type Page = 'chat' | 'skills' | 'cronjobs' | 'workspace' | 'mcp' | 'heartbeat' | 'bots' | 'terminal' | 'settings';

interface NavSection {
  labelKey: string;
  items: { id: Page; icon: React.ComponentType<any>; labelKey: string }[];
}

const navSections: NavSection[] = [
  {
    labelKey: 'nav.section.assistant',
    items: [
      { id: 'chat', icon: MessageSquare, labelKey: 'nav.chat' },
    ],
  },
  {
    labelKey: 'nav.section.extensions',
    items: [
      { id: 'skills', icon: Puzzle, labelKey: 'nav.skills' },
      { id: 'mcp', icon: Zap, labelKey: 'nav.mcp' },
    ],
  },
  {
    labelKey: 'nav.section.automation',
    items: [
      { id: 'cronjobs', icon: Clock, labelKey: 'nav.cronjobs' },
      { id: 'bots', icon: Bot, labelKey: 'nav.bots' },
    ],
  },
  {
    labelKey: 'nav.section.system',
    items: [
      { id: 'workspace', icon: FolderOpen, labelKey: 'nav.workspace' },
      { id: 'terminal', icon: Terminal, labelKey: 'nav.terminal' },
      { id: 'settings', icon: Settings, labelKey: 'nav.settings' },
    ],
  },
];

function App() {
  const { t } = useTranslation();
  const [currentPage, setCurrentPage] = useState<Page>('chat');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [healthStatus, setHealthStatus] = useState<'ok' | 'error' | 'checking'>('checking');
  const [setupDone, setSetupDone] = useState<boolean | null>(null); // null = loading
  const { appliedTheme } = useTheme();
  const drag = useDragRegion();

  // Bridge Tauri streaming events to Zustand store (app-level, runs once)
  useChatEventBridge();

  // File notifications from agent send_file_to_user tool
  const [fileNotification, setFileNotification] = useState<{
    path: string; filename: string; description: string; size: number;
  } | null>(null);

  useEffect(() => {
    healthCheck()
      .then(() => setHealthStatus('ok'))
      .catch(() => setHealthStatus('error'));
    // Check if setup wizard has been completed
    isSetupComplete()
      .then((done) => setSetupDone(done))
      .catch(() => setSetupDone(true)); // If check fails, skip wizard
  }, []);

  // Listen for agent://send_file events
  useEffect(() => {
    const unlisten = listen<{ path: string; filename: string; description: string; size: number }>(
      'agent://send_file',
      (event) => {
        setFileNotification(event.payload);
        // Auto-dismiss after 15 seconds
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

  // Notification click navigation.
  // Two mechanisms:
  //   1. macOS: Rust detects click via mac-notification-sys → emits notification://navigate
  //   2. Windows/Linux: Rust emits notification://pending after sending notification.
  //      Clicking the notification focuses the app window. We detect focus within a
  //      short time window and treat it as a notification click.
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
    // macOS: direct click callback from Rust
    const unlistenNavigate = listen<{ page: Page; [key: string]: unknown }>(
      'notification://navigate',
      (event) => {
        if (event.payload.page) applyNotifContext(event.payload);
      }
    );

    // Windows/Linux: pending context + focus detection
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
      // Accept focus within 30 seconds of notification (user may not click immediately)
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

  /** Render the active page. Streaming state now lives in Zustand store,
   *  so ChatPage can safely unmount and remount without losing state.
   */
  const renderPage = () => {
    switch (currentPage) {
      case 'chat': return <ChatPage consumeNotifContext={consumeNotifContext} />;
      case 'skills': return <SkillsPage />;
      case 'cronjobs': return <CronJobsPage />;
      case 'workspace': return <WorkspacePage />;
      case 'mcp': return <MCPPage />;
      case 'heartbeat': return <HeartbeatPage />;
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

  // Loading state while checking setup status
  if (setupDone === null) {
    return (
      <div className={`h-screen flex items-center justify-center ${appliedTheme}`} style={{ background: 'var(--color-bg)' }}>
        <div className="text-[var(--color-text-muted)] text-[14px]">Loading...</div>
      </div>
    );
  }

  return (
    <ToastProvider>
    <div className={`h-screen flex ${appliedTheme}`}>
      {/* Sidebar */}
      <aside
        className={`
          flex flex-col shrink-0
          transition-all duration-300 ease-in-out relative z-40
          ${isSidebarCollapsed ? 'w-[60px]' : 'w-[220px]'}
        `}
        style={{
          background: 'var(--sidebar-bg)',
          borderRight: '1px solid var(--sidebar-border)',
          backdropFilter: 'blur(40px) saturate(140%)',
          WebkitBackdropFilter: 'blur(40px) saturate(140%)',
        }}
      >
        {/* Top spacing for macOS traffic lights + health indicator */}
        <div className="h-14 shrink-0 flex items-center justify-end px-3 app-drag-region" onMouseDown={drag.onMouseDown}>
          <div className="flex items-center gap-2 pointer-events-none">
            <div className={`w-2 h-2 rounded-full ${
              healthStatus === 'ok' ? 'bg-[var(--color-success)]' :
              healthStatus === 'error' ? 'bg-[var(--color-error)]' :
              'bg-[var(--color-text-tertiary)]'
            }`} />
            {!isSidebarCollapsed && (
              <span className="text-[11px]" style={{ color: 'var(--sidebar-text)' }}>
                {healthStatus === 'ok' ? t('common.connected') : healthStatus}
              </span>
            )}
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-2 px-2">
          {navSections.map((section, sIdx) => (
            <div key={sIdx} className={sIdx > 0 ? 'mt-5' : ''}>
              {!isSidebarCollapsed && (
                <div
                  className="px-3 mb-2 text-[10px] font-bold tracking-[0.08em] uppercase"
                  style={{ color: 'var(--sidebar-section)' }}
                >
                  {t(section.labelKey)}
                </div>
              )}
              {isSidebarCollapsed && sIdx > 0 && (
                <div className="mx-3 mb-2 border-t" style={{ borderColor: 'var(--sidebar-border)' }} />
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = currentPage === item.id;

                  return (
                    <button
                      key={item.id}
                      onClick={() => setCurrentPage(item.id)}
                      className={`
                        w-full flex items-center gap-3 rounded-lg
                        text-[13px] font-medium transition-all duration-200
                        ${isSidebarCollapsed ? 'px-0 py-2.5 justify-center' : 'px-3 py-2'}
                      `}
                      style={{
                        background: isActive ? 'var(--sidebar-active)' : 'transparent',
                        color: isActive ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) e.currentTarget.style.background = 'var(--sidebar-hover)';
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) e.currentTarget.style.background = 'transparent';
                      }}
                      title={isSidebarCollapsed ? t(item.labelKey) : undefined}
                    >
                      <Icon size={18} />
                      {!isSidebarCollapsed && (
                        <span className="truncate">{t(item.labelKey)}</span>
                      )}
                      {isActive && !isSidebarCollapsed && (
                        <div
                          className="ml-auto w-1.5 h-1.5 rounded-full"
                          style={{ background: 'var(--color-accent)' }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Sidebar footer */}
        <div className="p-2 shrink-0" style={{ borderTop: '1px solid var(--sidebar-border)' }}>
          <button
            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[12px] transition-colors"
            style={{ color: 'var(--sidebar-text)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--sidebar-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {isSidebarCollapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
            {!isSidebarCollapsed && <span>{t('common.collapse')}</span>}
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
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
                // Open file with system default application
                open(fileNotification.path).catch(() => {
                  // Fallback: copy path to clipboard
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
    </div>
    <SandboxAccessDialog />
    <ClaudeCodeDialog />
    </ToastProvider>
  );
}

export default App;
