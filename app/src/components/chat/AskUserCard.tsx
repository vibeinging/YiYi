/**
 * In-stream ask_user bubble —— agent 在执行中向用户抛出的开放问题,作为对话流里
 * 的一条消息气泡出现(提问者头像 + 问题 + 选项 chips),就像群里别人发来一句话。
 * 回答走正常输入框(文本)或点选项 chip;两条路径都由父级 `onAnswer` 统一处理
 * (乐观上屏 + 回传 answer_user_question + 出队)。是 PermissionCard 的对话版(F1)。
 */

import { MessageCircleQuestion } from 'lucide-react';
import type { PendingQuestionState } from '../../stores/chatStreamStore';

const ACCENT = 'var(--color-primary)';

export function AskUserCard({
  question,
  onAnswer,
}: {
  question: PendingQuestionState;
  onAnswer: (answer: string) => void;
}) {
  const hasOptions = question.options.length > 0;
  const name = question.askerName || 'YiYi';
  const initial = name.slice(0, 1);

  return (
    <div className="flex gap-2 my-2 animate-in fade-in slide-in-from-bottom-1 duration-200">
      {/* 提问者头像 */}
      <span
        className="flex items-center justify-center rounded-lg text-[12px] font-semibold shrink-0"
        style={{ width: 28, height: 28, background: `${ACCENT}26`, color: ACCENT }}
      >
        {initial}
      </span>

      <div className="min-w-0">
        <div className="flex items-center gap-1 text-[12px] font-medium" style={{ color: 'var(--color-text)' }}>
          {name}
          <MessageCircleQuestion size={13} style={{ color: ACCENT }} />
          <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>想问你</span>
        </div>

        <div
          className="mt-1 inline-block rounded-2xl rounded-tl-sm px-3 py-2 max-w-full"
          style={{
            background: 'var(--color-bg-elevated)',
            border: `1px solid color-mix(in srgb, ${ACCENT} 35%, var(--color-border))`,
          }}
        >
          <div className="text-[13px] leading-relaxed" style={{ color: 'var(--color-text)' }}>
            {question.question}
          </div>

          {hasOptions ? (
            <>
              <div className="flex flex-wrap gap-2 mt-2">
                {question.options.map((opt, i) => (
                  <button
                    key={i}
                    onClick={() => onAnswer(opt)}
                    className="px-3 py-1 rounded-full text-[12px] font-medium transition-colors"
                    style={{
                      background: `color-mix(in srgb, ${ACCENT} 12%, var(--color-bg-elevated))`,
                      color: ACCENT,
                      border: `1px solid color-mix(in srgb, ${ACCENT} 40%, transparent)`,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = ACCENT; e.currentTarget.style.color = '#FFFFFF'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = `color-mix(in srgb, ${ACCENT} 12%, var(--color-bg-elevated))`; e.currentTarget.style.color = ACCENT; }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
              {/* 选项之外永远可以自由作答 —— 主输入框就是回答框(发送即回答),明示出来。 */}
              <div className="text-[11px] mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
                点选项,或直接在下方输入框用自己的话回答
              </div>
            </>
          ) : (
            <div className="text-[11px] mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
              在下方输入框回复…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
