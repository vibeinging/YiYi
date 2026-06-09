/**
 * Work Page —— chat×work 2×2 的 **work 象限**入口:多 agent 派工任务的交付面。
 *
 * 与 chat(对话/关系)在 UI 上以**琥珀**强调区分(chat 是靛紫)。决策 X:work 从 chat
 * 发起、独立跑、结果回流 chat —— 所以这里主要是**监控/列表**(看 work job 进度),
 * 发起入口在「工作群」里。
 *
 * 当前为前端入口 shell:后端 work 表面(engine/work + commit_work_plan)已就位、待 S6
 * 接线(把派工流量切过来 + work job 标 kind=work_dispatch)。接线后这里列出 work job
 * 列表 + 进度;现在先立**空态**,把入口与视觉区分立起来。
 */

import { Hammer, ArrowRight } from 'lucide-react';

const AMBER = 'var(--color-warning)'; // #FF9F0A —— work 象限强调色,与 chat 的靛紫区分

export function WorkPage({ onGoChat }: { onGoChat?: () => void }) {
  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--color-bg)' }}>
      {/* ── 头部:琥珀强调,一眼区别于 chat 的紫 ── */}
      <header
        className="shrink-0 flex items-center gap-3 px-6 h-14 border-b"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--color-warning-subtle)' }}
        >
          <Hammer size={17} color={AMBER} strokeWidth={2.1} />
        </div>
        <div className="flex flex-col">
          <span className="text-[14px] font-semibold leading-tight" style={{ color: 'var(--color-text)' }}>
            工作
          </span>
          <span className="text-[11px] leading-tight" style={{ color: 'var(--color-text-muted)' }}>
            团队交付 · 多 agent 派工
          </span>
        </div>
      </header>

      {/* ── 工作任务列表(接线后填充);现为空态 ── */}
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="max-w-[420px] flex flex-col items-center text-center gap-4">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{ background: 'var(--color-warning-subtle)' }}
          >
            <Hammer size={30} color={AMBER} strokeWidth={1.7} />
          </div>
          <h2 className="text-[16px] font-semibold" style={{ color: 'var(--color-text)' }}>
            还没有进行中的工作
          </h2>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            工作任务从「工作群」里发起 —— 在群里跟你的团队说要做什么(比如「做个落地页」),
            牵头者接手、拆解派工,这里就会列出各任务的进度;做完后结果回流到那个群。
          </p>
          {onGoChat && (
            <button
              onClick={onGoChat}
              className="mt-1 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium transition-colors"
              style={{ background: AMBER, color: '#1a1206' }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
            >
              去工作群发起
              <ArrowRight size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
