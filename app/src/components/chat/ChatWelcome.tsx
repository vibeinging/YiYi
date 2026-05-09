/**
 * ChatWelcome — Empty state with quick action cards.
 *
 * Card grid stays static; clicking a card slides an expansion panel out
 * below the grid. Switching cards swaps content in-place (no fold/unfold
 * round-trip). Height animates via the `grid-template-rows: 0fr ↔ 1fr`
 * trick so the panel matches its actual content size.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Sprout } from 'lucide-react';
import logoImg from '../../assets/yiyi-logo.png';
import { getQuickActions } from './chatActions';
import { getMorningGreeting } from '../../api/system';

interface ChatWelcomeProps {
  aiName: string;
  onSendPrompt: (prompt: string) => void;
}

export function ChatWelcome({ aiName, onSendPrompt }: ChatWelcomeProps) {
  const { t, i18n } = useTranslation();
  const [expandedAction, setExpandedAction] = useState<number | null>(null);
  const [morningGreeting, setMorningGreeting] = useState<string | null>(null);

  const quickActions = getQuickActions(t);
  const expanded = expandedAction !== null ? quickActions[expandedAction] : null;

  useEffect(() => {
    getMorningGreeting()
      .then(g => { if (g) setMorningGreeting(g); })
      .catch(() => {});
  }, []);

  return (
    <div
      className="h-full flex flex-col items-center justify-center px-6"
      onClick={() => expandedAction !== null && setExpandedAction(null)}
    >
      <div className="max-w-[520px] w-full">
        {/* Hero */}
        <div className="flex items-center gap-4 mb-8">
          <div className="relative shrink-0">
            <img
              src={logoImg}
              alt="YiYi"
              className="w-14 h-14 rounded-2xl"
              style={{ boxShadow: '0 4px 20px rgba(255, 180, 80, 0.2)' }}
            />
            <div
              className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center"
              style={{ background: 'var(--color-success)', boxShadow: '0 0 0 2.5px var(--color-bg)' }}
            >
              <div className="w-[5px] h-[5px] rounded-full bg-white" />
            </div>
          </div>
          <div>
            <h1
              className="text-[22px] font-bold tracking-tight"
              style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text)' }}
            >
              {(() => {
                const h = new Date().getHours();
                const greeting = h < 6 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好';
                return `${greeting} 👋`;
              })()}
            </h1>
            <p className="text-[13.5px] mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
              {(t('chat.empty.description') as string).replace('YiYi', aiName).replace(/我是.*?。/, '')}
            </p>
          </div>
        </div>

        {/* Morning greeting from Growth System */}
        {morningGreeting && (
          <div
            className="mb-4 p-3.5 rounded-xl text-[13px] leading-relaxed"
            style={{
              background: 'linear-gradient(135deg, rgba(175,82,222,0.06), rgba(88,86,214,0.06))',
              border: '1px solid rgba(175,82,222,0.15)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <div className="flex items-center gap-1.5 mb-1.5">
              <Sprout size={14} style={{ color: '#AF52DE' }} />
              <span className="text-[12px] font-medium" style={{ color: '#AF52DE' }}>
                {i18n.language === 'zh' ? 'YiYi 的成长感悟' : "YiYi's Growth Insight"}
              </span>
            </div>
            {morningGreeting}
          </div>
        )}

        {/* Quick action grid — always static, no reflow */}
        <div className="grid grid-cols-3 gap-2.5 mb-2">
          {quickActions.map((action, idx) => {
            const Icon = action.icon;
            const isActive = expandedAction === idx;
            return (
              <button
                key={idx}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpandedAction(isActive ? null : idx);
                }}
                className="text-left rounded-2xl"
                style={{
                  background: 'var(--color-bg-elevated)',
                  boxShadow: isActive
                    ? `0 4px 18px ${action.color}1a, 0 0 0 1px ${action.color}33`
                    : '0 1px 3px rgba(0,0,0,0.04)',
                  transition: 'box-shadow 220ms cubic-bezier(0.4, 0, 0.2, 1), transform 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                <div className="flex items-center gap-3 p-3">
                  <div
                    className="w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0"
                    style={{
                      background: isActive ? `${action.color}22` : `${action.color}0C`,
                      transition: 'background 220ms cubic-bezier(0.4, 0, 0.2, 1)',
                    }}
                  >
                    <Icon size={15} style={{ color: action.color }} />
                  </div>
                  <span className="text-[13px] font-semibold flex-1 truncate" style={{ color: 'var(--color-text)' }}>
                    {action.label}
                  </span>
                  <Plus
                    size={13}
                    style={{
                      color: 'var(--color-text-tertiary)',
                      transform: isActive ? 'rotate(45deg)' : 'rotate(0)',
                      transition: 'transform 220ms cubic-bezier(0.4, 0, 0.2, 1)',
                    }}
                  />
                </div>
              </button>
            );
          })}
        </div>

        {/* Expansion panel — content swaps in place; height auto-fits via
         *   grid-rows trick. No `maxHeight: 400px` guesswork. */}
        <div
          className="grid mb-3"
          style={{
            gridTemplateRows: expanded ? '1fr' : '0fr',
            transition: 'grid-template-rows 280ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <div style={{ overflow: 'hidden', minHeight: 0 }}>
            <div
              key={expandedAction ?? 'none'}
              className="rounded-2xl p-3 mt-1"
              onClick={(e) => e.stopPropagation()}
              style={{
                background: expanded ? `${expanded.color}08` : 'transparent',
                border: expanded ? `1px solid ${expanded.color}22` : '1px solid transparent',
                animation: expanded ? 'welcome-panel-in 220ms cubic-bezier(0.4, 0, 0.2, 1) both' : undefined,
              }}
            >
              {expanded && (
                <>
                  <p className="text-[12px] px-1 mb-2" style={{ color: 'var(--color-text-muted)' }}>
                    {expanded.desc}
                  </p>
                  <div className="space-y-1">
                    {expanded.examples.map((ex, eidx) => (
                      <div
                        key={eidx}
                        className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] cursor-pointer"
                        style={{
                          background: 'var(--color-bg-subtle)',
                          color: 'var(--color-text-secondary)',
                          transition: 'background 140ms ease, color 140ms ease',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedAction(null);
                          onSendPrompt(ex);
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = `${expanded.color}10`;
                          e.currentTarget.style.color = 'var(--color-text)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'var(--color-bg-subtle)';
                          e.currentTarget.style.color = 'var(--color-text-secondary)';
                        }}
                      >
                        <span className="w-1 h-1 rounded-full shrink-0" style={{ background: expanded.color, opacity: 0.5 }} />
                        <span>{ex}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div
          className="text-[12px] text-center"
          style={{ color: 'var(--color-text-tertiary)', opacity: 0.6 }}
        >
          {expanded ? t('chat.empty.backHint') : t('chat.empty.tip1')}
        </div>
      </div>

      <style>{`
        @keyframes welcome-panel-in {
          0%   { opacity: 0; transform: translateY(-4px); }
          100% { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
