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
import { AgentMarkdown } from './markdownShared';
import { getMorningGreeting } from '../../api/system';

interface ChatWelcomeProps {
  aiName: string;
  onSendPrompt: (prompt: string) => void;
  /** 私聊某个伙伴时传入 —— hero 头像 + 介绍改成它的(否则默认 YiYi)。 */
  companion?: {
    name: string;
    avatar_emoji: string;
    color_hex: string;
    role_label: string | null;
    /** 它的角色定义 / 人设(persona.md 全文)。优先于 role_label 作介绍。 */
    intro?: string | null;
  } | null;
}

/**
 * Stop a button's mousedown from stealing focus from the contentEditable
 * MentionInput in ChatInput. Without this, when the user has typed text
 * (input is focused), mousedown on a welcome card blurs the editor and
 * the browser swallows the resulting click — user has to click twice.
 */
const preventFocusSteal = (e: React.MouseEvent) => e.preventDefault();

export function ChatWelcome({ aiName, onSendPrompt, companion }: ChatWelcomeProps) {
  const { t, i18n } = useTranslation();
  const [expandedAction, setExpandedAction] = useState<number | null>(null);
  const [morningGreeting, setMorningGreeting] = useState<string | null>(null);

  const quickActions = getQuickActions(t);
  const expanded = expandedAction !== null ? quickActions[expandedAction] : null;

  // 成长感悟是 YiYi(全局)的 —— 私聊伙伴时不拉、不显示。
  useEffect(() => {
    if (companion) return;
    getMorningGreeting()
      .then(g => { if (g) setMorningGreeting(g); })
      .catch(() => {});
  }, [companion]);

  return (
    <div
      className="h-full flex flex-col items-center justify-center px-6"
      onClick={() => expandedAction !== null && setExpandedAction(null)}
    >
      <div className={`w-full ${companion ? 'max-w-[720px]' : 'max-w-[520px]'}`}>
        {/* Hero */}
        <div className="flex items-center gap-4 mb-8">
          <div className="relative shrink-0">
            {companion ? (
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center text-[30px]"
                style={{
                  background: `${companion.color_hex || 'var(--color-primary)'}26`,
                  boxShadow: `0 4px 20px ${companion.color_hex || 'var(--color-primary)'}2e`,
                }}
              >
                {companion.avatar_emoji || '🤖'}
              </div>
            ) : (
              <img
                src={logoImg}
                alt="YiYi"
                className="w-14 h-14 rounded-2xl"
                style={{ boxShadow: '0 4px 20px rgba(255, 180, 80, 0.2)' }}
              />
            )}
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
                // 私聊伙伴时点出它的名字,让人一眼知道在和谁聊。
                return companion ? `${greeting},我是${companion.name} 👋` : `${greeting} 👋`;
              })()}
            </h1>
            {!companion && (
              <p className="text-[13.5px] mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                {(t('chat.empty.description') as string).replace('YiYi', aiName).replace(/我是.*?。/, '')}
              </p>
            )}
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

        {companion ? (
          /* 伙伴:不显示快捷卡片,改成它的角色定义/人设介绍(markdown 渲染)。 */
          <div
            className="rounded-2xl px-6 py-5 mb-3"
            style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
          >
            {companion.role_label && (
              <div className="text-[12.5px] font-semibold mb-3 pb-3" style={{ color: companion.color_hex || 'var(--color-primary)', borderBottom: '1px solid var(--color-bg-subtle)' }}>
                擅长 · {companion.role_label}
              </div>
            )}
            {companion.intro ? (
              <div className="markdown-body text-[13.5px] leading-relaxed max-h-[46vh] overflow-y-auto pr-1" style={{ color: 'var(--color-text-secondary)' }}>
                <AgentMarkdown>{companion.intro}</AgentMarkdown>
              </div>
            ) : (
              <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                {companion.role_label
                  ? '还没写它的角色定义 —— 在它的资料页 ⚙ 里补充人设。'
                  : '我是你的 AI 伙伴,直接打字开始聊吧 ✨'}
              </p>
            )}
          </div>
        ) : (
        <>
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
                onMouseDown={preventFocusSteal}
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
                        onMouseDown={preventFocusSteal}
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
        </>
        )}

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
