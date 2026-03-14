/**
 * QuickActionsOverlay — Floating panel above ChatInput that shows quick action cards.
 * Mirrors ChatWelcome's card UX so users can discover prompts at any time.
 */

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { getQuickActions } from './chatActions';

interface QuickActionsOverlayProps {
  onSelectPrompt: (prompt: string) => void;
  onClose: () => void;
}

export function QuickActionsOverlay({ onSelectPrompt, onClose }: QuickActionsOverlayProps) {
  const { t } = useTranslation();
  const [expandedAction, setExpandedAction] = useState<number | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const quickActions = getQuickActions(t);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="absolute left-0 right-0 bottom-full mb-2 rounded-2xl z-50 overflow-hidden"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border-strong)',
        boxShadow: 'var(--shadow-lg)',
      }}
      onClick={() => expandedAction !== null && setExpandedAction(null)}
    >
      <div className="p-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-3 px-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
            {t('chat.quick.title', '快速操作')}
          </span>
          <button
            onClick={onClose}
            className="text-[11px] px-2 py-0.5 rounded-md transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            Esc
          </button>
        </div>

        {/* Cards grid */}
        <div className="grid grid-cols-3 gap-2">
          {quickActions.map((action, idx) => {
            const Icon = action.icon;
            const isExpanded = expandedAction === idx;
            const isHidden = expandedAction !== null && !isExpanded;

            return (
              <div
                key={idx}
                className="transition-all duration-500 ease-out"
                style={{
                  gridColumn: isExpanded ? '1 / -1' : undefined,
                  opacity: isHidden ? 0 : 1,
                  transform: isHidden ? 'scale(0.95)' : 'scale(1)',
                  pointerEvents: isHidden ? 'none' : 'auto',
                  maxHeight: isHidden ? 0 : '400px',
                  overflow: 'hidden',
                }}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedAction(isExpanded ? null : idx);
                  }}
                  className="w-full text-left rounded-xl transition-all duration-300"
                  style={{
                    background: 'var(--color-bg-subtle)',
                    boxShadow: isExpanded
                      ? `0 4px 16px ${action.color}15, 0 0 0 1px ${action.color}25`
                      : 'none',
                  }}
                  onMouseEnter={(e) => {
                    if (!isExpanded) {
                      e.currentTarget.style.background = 'var(--color-bg-muted)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isExpanded) {
                      e.currentTarget.style.background = 'var(--color-bg-subtle)';
                    }
                  }}
                >
                  <div className="flex items-center gap-2 p-2.5">
                    <div
                      className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-all duration-500"
                      style={{ background: isExpanded ? `${action.color}18` : `${action.color}0C` }}
                    >
                      <Icon size={13} style={{ color: action.color }} />
                    </div>
                    <span className="text-[12px] font-semibold flex-1 truncate" style={{ color: 'var(--color-text)' }}>
                      {action.label}
                    </span>
                    <div
                      className="transition-transform duration-500 shrink-0"
                      style={{ transform: isExpanded ? 'rotate(45deg)' : 'rotate(0)', color: 'var(--color-text-tertiary)' }}
                    >
                      <Plus size={12} />
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="px-2.5 pb-2.5 space-y-1">
                      <p className="text-[11px] px-1 mb-2" style={{ color: 'var(--color-text-muted)' }}>
                        {action.desc}
                      </p>
                      {action.examples.map((ex, eidx) => (
                        <div
                          key={eidx}
                          className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12px] transition-all duration-150 cursor-pointer"
                          style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectPrompt(ex);
                            onClose();
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = `${action.color}0E`;
                            e.currentTarget.style.color = 'var(--color-text)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'var(--color-bg-subtle)';
                            e.currentTarget.style.color = 'var(--color-text-secondary)';
                          }}
                        >
                          <span className="w-1 h-1 rounded-full shrink-0" style={{ background: action.color, opacity: 0.5 }} />
                          <span>{ex}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
