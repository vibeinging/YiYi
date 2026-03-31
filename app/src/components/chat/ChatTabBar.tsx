/**
 * ChatTabBar — Session tab bar. All tabs are closeable.
 * Supports highlight animations: 'new' (pulse blue), 'complete' (flash green), 'fail' (flash red).
 */

import { memo } from 'react';
import { X, MessageSquare, Plus } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export interface OpenTab {
  id: string;
  name: string;
}

export type TabHighlight = 'new' | 'complete' | 'fail';

interface ChatTabBarProps {
  tabs: OpenTab[];
  currentTabId: string;
  highlightTabs?: Map<string, TabHighlight>;
  maxTitleLen?: number;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewChat: () => void;
}

const HIGHLIGHT_STYLES: Record<TabHighlight, React.CSSProperties> = {
  new: {
    animation: 'tab-highlight-new 2.5s ease-in-out',
    boxShadow: '0 0 12px var(--color-info, rgba(100,210,255,0.5)), inset 0 0 0 1px var(--color-info, rgba(100,210,255,0.3))',
  },
  complete: {
    animation: 'tab-highlight-complete 3s ease-out',
    boxShadow: '0 0 12px var(--color-success-subtle, rgba(52,199,89,0.5)), inset 0 0 0 1px var(--color-success-subtle, rgba(52,199,89,0.3))',
  },
  fail: {
    animation: 'tab-highlight-fail 3s ease-out',
    boxShadow: '0 0 12px var(--color-error-subtle, rgba(255,69,58,0.5)), inset 0 0 0 1px var(--color-error-subtle, rgba(255,69,58,0.3))',
  },
};

export const ChatTabBar = memo(function ChatTabBar({
  tabs,
  currentTabId,
  highlightTabs,
  maxTitleLen = 16,
  onSelectTab,
  onCloseTab,
  onNewChat,
}: ChatTabBarProps) {
  return (
    <>
      {/* Keyframes injected once */}
      <style>{`
        @keyframes tab-highlight-new {
          0%, 100% { box-shadow: none; }
          15%, 85% { box-shadow: 0 0 12px var(--color-info, rgba(100,210,255,0.4)), inset 0 0 0 1px var(--color-info, rgba(100,210,255,0.25)); }
          30%, 70% { box-shadow: 0 0 18px var(--color-info, rgba(100,210,255,0.6)), inset 0 0 0 1px var(--color-info, rgba(100,210,255,0.4)); }
          50% { box-shadow: 0 0 22px var(--color-info, rgba(100,210,255,0.7)), inset 0 0 0 1px var(--color-info, rgba(100,210,255,0.5)); }
        }
        @keyframes tab-highlight-complete {
          0% { box-shadow: 0 0 20px var(--color-success-subtle, rgba(52,199,89,0.6)), inset 0 0 0 1px var(--color-success-subtle, rgba(52,199,89,0.4)); }
          100% { box-shadow: none; }
        }
        @keyframes tab-highlight-fail {
          0% { box-shadow: 0 0 20px var(--color-error-subtle, rgba(255,69,58,0.6)), inset 0 0 0 1px var(--color-error-subtle, rgba(255,69,58,0.4)); }
          100% { box-shadow: none; }
        }
        @keyframes tab-dot-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .tab-close-btn:hover { background: var(--color-bg-muted, rgba(255,255,255,0.1)); }
        .tab-new-btn:hover { background: var(--sidebar-hover, rgba(255,255,255,0.08)); color: var(--sidebar-text-active, rgba(255,255,255,0.7)); }
      `}</style>

      <div
        role="tablist"
        aria-label="Chat sessions"
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest('button, input, a, textarea, select')) return;
          e.preventDefault();
          getCurrentWindow().startDragging();
        }}
        className="flex items-end shrink-0 app-drag-region"
        style={{
          background: 'var(--sidebar-bg)',
          paddingLeft: 8,
          paddingRight: 8,
          minHeight: 40,
          paddingTop: 8,
        }}
      >
        <div className="flex items-end flex-1 min-w-0 overflow-hidden">
          {tabs.map((tab) => {
            const isActive = tab.id === currentTabId;
            const highlight = highlightTabs?.get(tab.id);
            const highlightStyle = highlight ? HIGHLIGHT_STYLES[highlight] : undefined;

            return (
              <div
                key={tab.id}
                className="group flex items-center min-w-0 transition-all duration-200"
                style={{
                  flex: '1 1 0',
                  maxWidth: 180,
                  background: isActive ? 'var(--color-bg)' : 'transparent',
                  borderRadius: '8px 8px 0 0',
                  marginRight: 1,
                  ...highlightStyle,
                }}
              >
                <button
                  role="tab"
                  aria-selected={isActive}
                  aria-label={tab.name || 'New Chat'}
                  onClick={() => onSelectTab(tab.id)}
                  className="flex items-center gap-2 min-w-0 flex-1"
                  style={{
                    padding: '7px 8px 7px 12px',
                    fontSize: 12,
                    fontWeight: isActive ? 600 : 400,
                    color: isActive ? 'var(--color-text)' : 'var(--sidebar-text)',
                  }}
                >
                  {/* Activity dot for highlighted tabs */}
                  {highlight === 'new' ? (
                    <div className="w-[6px] h-[6px] rounded-full shrink-0"
                      aria-hidden="true"
                      style={{
                        background: 'var(--color-info)',
                        boxShadow: '0 0 6px var(--color-info)',
                        animation: 'tab-dot-pulse 1.2s ease-in-out infinite',
                      }} />
                  ) : highlight === 'complete' ? (
                    <div className="w-[6px] h-[6px] rounded-full shrink-0"
                      aria-hidden="true"
                      style={{ background: 'var(--color-success)', boxShadow: '0 0 6px var(--color-success)' }} />
                  ) : highlight === 'fail' ? (
                    <div className="w-[6px] h-[6px] rounded-full shrink-0"
                      aria-hidden="true"
                      style={{ background: 'var(--color-error)', boxShadow: '0 0 6px var(--color-error)' }} />
                  ) : (
                    <MessageSquare size={12} className="shrink-0" aria-hidden="true" style={{ opacity: isActive ? 1 : 0.5 }} />
                  )}
                  <span className="truncate" style={{ maxWidth: 120 }}>
                    {tab.name
                      ? (tab.name.length > maxTitleLen ? tab.name.slice(0, maxTitleLen) + '...' : tab.name)
                      : 'New Chat'}
                  </span>
                </button>
                <button
                  aria-label={`Close tab ${tab.name || 'New Chat'}`}
                  onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                  className="tab-close-btn shrink-0 opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 mr-1"
                  style={{ color: isActive ? 'var(--color-text-muted)' : 'var(--sidebar-text)' }}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>

        {/* New chat button */}
        <button
          role="tab"
          aria-label="New Chat"
          onClick={onNewChat}
          className="tab-new-btn shrink-0 flex items-center justify-center rounded-lg transition-colors mb-[2px]"
          style={{
            width: 28,
            height: 28,
            color: 'var(--sidebar-text)',
          }}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>
    </>
  );
});
