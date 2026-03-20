/**
 * ChatWelcome — Empty state welcome screen with quick action cards.
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
  const { t } = useTranslation();
  const [expandedAction, setExpandedAction] = useState<number | null>(null);
  const [morningGreeting, setMorningGreeting] = useState<string | null>(null);

  const quickActions = getQuickActions(t);

  // Fetch morning greeting once
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
        {/* Hero: Mascot + Greeting */}
        <div
          className="transition-all duration-500 ease-out"
          style={{
            opacity: expandedAction !== null ? 0 : 1,
            maxHeight: expandedAction !== null ? 0 : '280px',
            overflow: 'hidden',
          }}
        >
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
        </div>

        {/* Morning greeting from Growth System */}
        {morningGreeting && expandedAction === null && (
          <div
            className="mb-4 p-3.5 rounded-xl text-[13px] leading-relaxed transition-all"
            style={{
              background: 'linear-gradient(135deg, rgba(175,82,222,0.06), rgba(88,86,214,0.06))',
              border: '1px solid rgba(175,82,222,0.15)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <div className="flex items-center gap-1.5 mb-1.5">
              <Sprout size={14} style={{ color: '#AF52DE' }} />
              <span className="text-[12px] font-medium" style={{ color: '#AF52DE' }}>
                YiYi's Growth Insight
              </span>
            </div>
            {morningGreeting}
          </div>
        )}

        {/* Quick action cards */}
        <div className="grid grid-cols-3 gap-2.5 mb-5">
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
                  className="w-full text-left rounded-2xl transition-all duration-300"
                  style={{
                    background: 'var(--color-bg-elevated)',
                    boxShadow: isExpanded
                      ? `0 8px 32px ${action.color}15, 0 0 0 1px ${action.color}25`
                      : '0 1px 3px rgba(0,0,0,0.04)',
                  }}
                  onMouseEnter={(e) => {
                    if (!isExpanded) {
                      e.currentTarget.style.transform = 'translateY(-1px)';
                      e.currentTarget.style.boxShadow = `0 4px 16px ${action.color}12, 0 0 0 1px ${action.color}18`;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isExpanded) {
                      e.currentTarget.style.transform = 'translateY(0)';
                      e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.04)';
                    }
                  }}
                >
                  <div className="flex items-center gap-3 p-3">
                    <div
                      className="w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0 transition-all duration-500"
                      style={{ background: isExpanded ? `${action.color}18` : `${action.color}0C` }}
                    >
                      <Icon size={15} style={{ color: action.color }} />
                    </div>
                    <span className="text-[13px] font-semibold flex-1" style={{ color: 'var(--color-text)' }}>
                      {action.label}
                    </span>
                    <div
                      className="transition-transform duration-500"
                      style={{ transform: isExpanded ? 'rotate(45deg)' : 'rotate(0)', color: 'var(--color-text-tertiary)' }}
                    >
                      <Plus size={13} />
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-1 animate-fade-in">
                      <p className="text-[12px] px-1 mb-2" style={{ color: 'var(--color-text-muted)' }}>
                        {action.desc}
                      </p>
                      {action.examples.map((ex, eidx) => (
                        <div
                          key={eidx}
                          className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] transition-all duration-150 cursor-pointer"
                          style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedAction(null);
                            onSendPrompt(ex);
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

        {/* Keyboard hints */}
        <div
          className="text-[12px] text-center transition-all duration-500 ease-out"
          style={{
            color: 'var(--color-text-tertiary)',
            opacity: expandedAction !== null ? 0 : 0.6,
            maxHeight: expandedAction !== null ? 0 : '40px',
            overflow: 'hidden',
          }}
        >
          <span>{t('chat.empty.tip1')}</span>
        </div>

        {expandedAction !== null && (
          <div className="text-[11px] text-center animate-fade-in" style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }}>
            {t('chat.empty.backHint')}
          </div>
        )}
      </div>
    </div>
  );
}
