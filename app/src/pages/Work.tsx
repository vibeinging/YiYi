/**
 * Work Page —— chat×work 2×2 的 **work 象限**入口:多 agent 派工任务的**监控面**。
 *
 * 与 chat(对话/关系)以**琥珀**强调区分(chat 是靛紫)。决策 X:work 从 chat 发起、独立跑、
 * 结果回流 chat —— 所以这里是 work job 的**列表/监控**(看进度),发起 + 实时干活在「工作群」
 * 的聊天里。点一个 job → 跳到它所属的工作群对话看团队实时推进。
 *
 * 数据:`list_work_jobs`(后端 kind=work_dispatch 的协作摘要,S6 落地标记)。轻量轮询保持新鲜。
 */

import { useEffect, useState } from 'react';
import { Hammer, ArrowRight, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { listWorkJobs, type WorkJob } from '../api/work';

const AMBER = 'var(--color-warning)'; // #FF9F0A —— work 象限强调色,区别于 chat 的靛紫

function statusMeta(status: string): { label: string; color: string; Icon: typeof Loader2; spin: boolean } {
  switch (status) {
    case 'done':
      return { label: '已交付', color: 'var(--color-success)', Icon: CheckCircle2, spin: false };
    case 'aborted':
      return { label: '已中止', color: 'var(--color-text-muted)', Icon: XCircle, spin: false };
    case 'failed':
      return { label: '失败', color: 'var(--color-error)', Icon: XCircle, spin: false };
    default: // planning / running
      return { label: '进行中', color: AMBER, Icon: Loader2, spin: true };
  }
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function WorkPage({
  onGoChat,
  onOpenSession,
}: {
  onGoChat?: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [jobs, setJobs] = useState<WorkJob[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      listWorkJobs()
        .then((j) => { if (alive) setJobs(j); })
        .catch(() => {})
        .finally(() => { if (alive) setLoaded(true); });
    load();
    // 轻量轮询:进行中的 job 状态会变(running→done),保持列表新鲜。
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

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

      {loaded && jobs.length === 0 ? (
        /* ── 空态 ── */
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
                className="mt-1 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium transition-opacity"
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
      ) : (
        /* ── work job 列表 ── */
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="max-w-[680px] mx-auto flex flex-col gap-2">
            {jobs.map((job) => {
              const m = statusMeta(job.status);
              return (
                <button
                  key={job.id}
                  onClick={() => onOpenSession?.(job.session_id)}
                  className="group w-full flex items-center gap-3 px-3.5 py-3 rounded-xl text-left transition-colors"
                  style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}
                >
                  <div
                    className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
                    style={{ background: `color-mix(in srgb, ${m.color} 14%, transparent)` }}
                  >
                    <m.Icon size={17} color={m.color} className={m.spin ? 'animate-spin' : ''} strokeWidth={2} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>
                      {job.intent || '(未命名任务)'}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                      <span style={{ color: m.color }}>{m.label}</span>
                      <span> · {fmtTime(job.created_at)}</span>
                    </div>
                  </div>
                  <ArrowRight
                    size={15}
                    className="shrink-0 opacity-0 group-hover:opacity-60 transition-opacity"
                    style={{ color: 'var(--color-text-muted)' }}
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
