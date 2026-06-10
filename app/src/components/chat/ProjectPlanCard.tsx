/**
 * 开工方案卡(S2③)—— PM 拆好的计划在聊天流里渲染成可审阅的卡片:任务清单
 * (角色 + 要做什么 + 依赖)+「开工 / 算了」。点「开工」调 commit_work_plan
 * 把任务派给各角色(白盒:用户拍板一次,团队才真正开干)。
 */

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Hammer, X, ArrowRight, Loader2, CheckCircle2 } from 'lucide-react';
import { useChatStreamStore, type ProjectPlanState } from '../../stores/chatStreamStore';
import { toast } from '../Toast';

const ROLE_META: Record<string, { emoji: string; name: string; color: string }> = {
  pm: { emoji: '🧭', name: '产品经理', color: '#3B82F6' },
  ui_designer: { emoji: '🎨', name: 'UI 设计师', color: '#EC4899' },
  frontend_dev: { emoji: '💻', name: '前端', color: '#10B981' },
  backend_dev: { emoji: '⚙️', name: '后端', color: '#F59E0B' },
  qa_engineer: { emoji: '🔍', name: '测试', color: '#8B5CF6' },
};

const ACCENT = 'var(--color-primary)';

export function ProjectPlanCard({ plan }: { plan: ProjectPlanState }) {
  const [committing, setCommitting] = useState(false);
  const [done, setDone] = useState(false);
  const sessionId = useChatStreamStore((s) => s.sessionId);
  const clearProjectPlan = useChatStreamStore((s) => s.clearProjectPlan);

  const start = async () => {
    if (committing || done) return;
    if (!sessionId) { toast.error('没有会话,无法开工'); return; }
    setCommitting(true);
    try {
      await invoke('commit_work_plan', {
        sessionId,
        plan: { tasks: plan.tasks },
      });
      // 让聊天重载,把派工协作的锚点消息拉进来 → CollaborationMessageCard 渲染队友的实时发言
      // (否则开工后页面静默,看不到团队在干活)。
      window.dispatchEvent(new CustomEvent('yiyi:reload-messages'));
      setDone(true);
      toast.success('开工!团队已按方案开干');
      setTimeout(() => clearProjectPlan(), 600);
    } catch (e) {
      toast.error(`开工失败:${e}`);
      setCommitting(false);
    }
  };

  return (
    <div
      className="my-2 rounded-2xl border overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-200"
      style={{
        borderColor: done ? 'var(--color-border)' : `color-mix(in srgb, ${ACCENT} 40%, var(--color-border))`,
        background: 'var(--color-bg-elevated)',
        opacity: done ? 0.8 : 1,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3.5 py-2.5 text-[13px] font-semibold"
        style={{ background: `color-mix(in srgb, ${ACCENT} 10%, var(--color-bg-elevated))`, color: 'var(--color-text)' }}
      >
        <Hammer size={15} style={{ color: ACCENT }} />
        开工方案
        <span className="text-[11px] font-normal px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
          {plan.tasks.length} 个任务
        </span>
      </div>

      {/* Summary */}
      {plan.summary && (
        <div className="px-3.5 pt-2 text-[12.5px]" style={{ color: 'var(--color-text-secondary)' }}>
          {plan.summary}
        </div>
      )}

      {/* Tasks */}
      <div className="px-3.5 py-2 flex flex-col gap-1.5">
        {plan.tasks.map((t, i) => {
          const meta = ROLE_META[t.role] || { emoji: '🤖', name: t.role, color: 'var(--color-text-muted)' };
          return (
            <div key={i} className="flex items-start gap-2.5 py-1">
              <span
                className="shrink-0 flex items-center justify-center rounded-lg text-[13px] mt-0.5"
                style={{ width: 24, height: 24, background: `${meta.color}22` }}
              >
                {meta.emoji}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium" style={{ color: meta.color }}>
                  {meta.name}
                  {t.depends_on.length > 0 && (
                    <span className="ml-1.5 text-[10.5px] font-normal" style={{ color: 'var(--color-text-muted)' }}>
                      <ArrowRight size={9} className="inline -mt-0.5" /> 接 {t.depends_on.map((d) => `#${d + 1}`).join('、')}
                    </span>
                  )}
                </div>
                <div className="text-[12.5px] leading-snug" style={{ color: 'var(--color-text)' }}>
                  {t.objective}
                </div>
              </div>
              <span className="shrink-0 text-[10.5px] tabular-nums mt-1" style={{ color: 'var(--color-text-muted)' }}>
                #{i + 1}
              </span>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 px-3.5 pb-3 pt-1">
        {done ? (
          <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: 'var(--color-success)' }}>
            <CheckCircle2 size={14} /> 已开工
          </span>
        ) : (
          <>
            <button
              onClick={start}
              disabled={committing}
              className="flex items-center gap-1.5 py-1.5 px-4 rounded-xl text-[13px] font-medium transition-colors disabled:opacity-50"
              style={{ background: ACCENT, color: '#FFFFFF' }}
            >
              {committing ? <Loader2 size={13} className="animate-spin" /> : <Hammer size={13} />}
              开工
            </button>
            <button
              onClick={() => clearProjectPlan()}
              disabled={committing}
              className="flex items-center gap-1 py-1.5 px-3 rounded-xl text-[12.5px] transition-colors disabled:opacity-50"
              style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
            >
              <X size={12} /> 算了
            </button>
          </>
        )}
      </div>
    </div>
  );
}
