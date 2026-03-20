/**
 * ChatTabBar — Session tab bar with main tab + task tabs.
 * Main tab shows logo + AI name + health status. Task tabs are closeable.
 * Supports highlight animations: 'new' (pulse blue), 'complete' (flash green), 'fail' (flash red).
 */

import { memo } from 'react';
import { X, MessageSquare } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import logoImg from '../../assets/yiyi-logo.png';

export interface OpenTab {
  id: string;
  name: string;
  isMain: boolean;
}

export type TabHighlight = 'new' | 'complete' | 'fail';

interface ChatTabBarProps {
  tabs: OpenTab[];
  currentTabId: string;
  aiName: string;
  healthStatus: 'ok' | 'error' | 'checking';
  highlightTabs?: Map<string, TabHighlight>;
  maxTitleLen?: number;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

const HIGHLIGHT_STYLES: Record<TabHighlight, React.CSSProperties> = {
  new: {
    animation: 'tab-highlight-new 2.5s ease-in-out',
    boxShadow: '0 0 12px rgba(59,130,246,0.5), inset 0 0 0 1px rgba(59,130,246,0.3)',
  },
  complete: {
    animation: 'tab-highlight-complete 3s ease-out',
    boxShadow: '0 0 12px rgba(34,197,94,0.5), inset 0 0 0 1px rgba(34,197,94,0.3)',
  },
  fail: {
    animation: 'tab-highlight-fail 3s ease-out',
    boxShadow: '0 0 12px rgba(239,68,68,0.5), inset 0 0 0 1px rgba(239,68,68,0.3)',
  },
};

export const ChatTabBar = memo(function ChatTabBar({
  tabs,
  currentTabId,
  aiName,
  healthStatus,
  highlightTabs,
  maxTitleLen = 12,
  onSelectTab,
  onCloseTab,
}: ChatTabBarProps) {
  return (
    <>
      {/* Keyframes injected once */}
      <style>{`
        @keyframes tab-highlight-new {
          0%, 100% { box-shadow: none; }
          15%, 85% { box-shadow: 0 0 12px rgba(59,130,246,0.4), inset 0 0 0 1px rgba(59,130,246,0.25); }
          30%, 70% { box-shadow: 0 0 18px rgba(59,130,246,0.6), inset 0 0 0 1px rgba(59,130,246,0.4); }
          50% { box-shadow: 0 0 22px rgba(59,130,246,0.7), inset 0 0 0 1px rgba(59,130,246,0.5); }
        }
        @keyframes tab-highlight-complete {
          0% { box-shadow: 0 0 20px rgba(34,197,94,0.6), inset 0 0 0 1px rgba(34,197,94,0.4); }
          100% { box-shadow: none; }
        }
        @keyframes tab-highlight-fail {
          0% { box-shadow: 0 0 20px rgba(239,68,68,0.6), inset 0 0 0 1px rgba(239,68,68,0.4); }
          100% { box-shadow: none; }
        }
        @keyframes tab-dot-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>

      <div
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
          paddingLeft: '8px',
          paddingRight: '8px',
          minHeight: '40px',
          paddingTop: '8px',
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
                  flex: tab.isMain ? '0 0 auto' : '1 1 0',
                  maxWidth: tab.isMain ? '200px' : '160px',
                  background: isActive ? 'var(--color-bg)' : 'transparent',
                  borderRadius: '8px 8px 0 0',
                  marginRight: '1px',
                  ...highlightStyle,
                }}
              >
                <button
                  onClick={() => onSelectTab(tab.id)}
                  className="flex items-center gap-2 min-w-0 flex-1"
                  style={{
                    padding: tab.isMain ? '6px 12px' : '7px 8px 7px 12px',
                    fontSize: '12px',
                    fontWeight: isActive ? 600 : 400,
                    color: isActive ? 'var(--color-text)' : 'rgba(255,255,255,0.5)',
                  }}
                >
                  {tab.isMain ? (
                    <>
                      <img
                        src={logoImg}
                        alt="YiYi"
                        className="w-7 h-7 rounded-lg shrink-0"
                        style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))' }}
                      />
                      <span className="truncate font-semibold">{aiName}</span>
                      <div
                        className="w-[5px] h-[5px] rounded-full shrink-0"
                        style={{
                          background:
                            healthStatus === 'ok'
                              ? 'var(--color-success)'
                              : healthStatus === 'error'
                                ? 'var(--color-error)'
                                : 'var(--color-text-tertiary)',
                          boxShadow:
                            healthStatus === 'ok' ? '0 0 4px var(--color-success)' : 'none',
                        }}
                      />
                    </>
                  ) : (
                    <>
                      {/* Activity dot for highlighted tabs */}
                      {highlight === 'new' ? (
                        <div className="w-[6px] h-[6px] rounded-full shrink-0"
                          style={{
                            background: 'rgb(59,130,246)',
                            boxShadow: '0 0 6px rgba(59,130,246,0.6)',
                            animation: 'tab-dot-pulse 1.2s ease-in-out infinite',
                          }} />
                      ) : highlight === 'complete' ? (
                        <div className="w-[6px] h-[6px] rounded-full shrink-0"
                          style={{ background: 'rgb(34,197,94)', boxShadow: '0 0 6px rgba(34,197,94,0.6)' }} />
                      ) : highlight === 'fail' ? (
                        <div className="w-[6px] h-[6px] rounded-full shrink-0"
                          style={{ background: 'rgb(239,68,68)', boxShadow: '0 0 6px rgba(239,68,68,0.6)' }} />
                      ) : (
                        <MessageSquare size={12} className="shrink-0" style={{ opacity: isActive ? 1 : 0.5 }} />
                      )}
                      <span className="truncate" style={{ maxWidth: '100px' }}>
                        {tab.name.length > maxTitleLen
                          ? tab.name.slice(0, maxTitleLen) + '...'
                          : tab.name}
                      </span>
                    </>
                  )}
                </button>
                {!tab.isMain && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 mr-1"
                    style={{ color: isActive ? 'var(--color-text-muted)' : 'rgba(255,255,255,0.3)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = isActive ? 'var(--color-bg-muted)' : 'rgba(255,255,255,0.1)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
});
