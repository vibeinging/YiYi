/**
 * Work Page —— chat×work 2×2 的 **work 象限**入口:多 agent 派工任务的**发起 + 监控面**。
 *
 * 与 chat(对话/关系)以**琥珀**强调区分(chat 是靛紫)。两个入口已把 chat/work 分好 ——
 * work **从这里显式发起**(「新建工作」:选团队 + 说要做什么),不靠在 chat 里猜措辞。
 * 发起后牵头者接手 intake(澄清→拆解→派工),团队在那个 work 会话里干活,这里列出所有
 * work job + 进度;点一个进去看团队推进。
 *
 * 数据:`list_work_jobs`(kind=work_dispatch 协作)、`launch_work_job`(显式发起)。
 */

import { useEffect, useState } from 'react';
import { Hammer, ArrowRight, Loader2, CheckCircle2, XCircle, Plus, X } from 'lucide-react';
import { listWorkJobs, launchWorkJob, type WorkJob } from '../api/work';
import { listCompanionGroups, type CompanionGroup } from '../api/groups';

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
  onGoChat: _onGoChat,
  onOpenSession,
}: {
  onGoChat?: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [jobs, setJobs] = useState<WorkJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      listWorkJobs()
        .then((j) => { if (alive) setJobs(j); })
        .catch(() => {})
        .finally(() => { if (alive) setLoaded(true); });
    load();
    const t = setInterval(load, 4000); // 进行中的 job 状态会变,保持新鲜
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--color-bg)' }}>
      {/* ── 头部:琥珀强调 + 新建工作 ── */}
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
        <div className="flex-1" />
        <button
          onClick={() => setLauncherOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-opacity"
          style={{ background: AMBER, color: '#1a1206' }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
        >
          <Plus size={15} strokeWidth={2.4} />
          新建工作
        </button>
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
              点右上角「新建工作」—— 选一个团队(软件公司 / 你自定义的团队)+ 说要做什么,
              牵头者接手、拆解派工,这里就会列出各任务的进度;做完结果回到那个工作会话。
            </p>
            <button
              onClick={() => setLauncherOpen(true)}
              className="mt-1 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium transition-opacity"
              style={{ background: AMBER, color: '#1a1206' }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
            >
              <Plus size={15} strokeWidth={2.4} />
              新建工作
            </button>
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

      {launcherOpen && (
        <WorkLauncher
          onClose={() => setLauncherOpen(false)}
          onLaunched={(sid) => { setLauncherOpen(false); onOpenSession?.(sid); }}
        />
      )}
    </div>
  );
}

/** 「新建工作」弹窗:选团队 + 描述任务 → 显式发起 work job。 */
function WorkLauncher({ onClose, onLaunched }: { onClose: () => void; onLaunched: (sessionId: string) => void }) {
  const [teams, setTeams] = useState<CompanionGroup[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [task, setTask] = useState('');
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    listCompanionGroups()
      .then((gs) => { setTeams(gs); if (gs.length === 1) setSelected(gs[0].id); })
      .catch(() => {});
  }, []);

  const launch = async () => {
    if (!selected || !task.trim() || launching) return;
    setLaunching(true);
    setError('');
    try {
      const r = await launchWorkJob(selected, task.trim());
      onLaunched(r.session_id);
    } catch (e) {
      setError(String(e));
      setLaunching(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={onClose}
    >
      <div
        className="w-[460px] max-w-[92vw] rounded-2xl flex flex-col gap-4 p-5"
        style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Hammer size={16} color={AMBER} strokeWidth={2.2} />
          <span className="text-[15px] font-semibold flex-1" style={{ color: 'var(--color-text)' }}>新建工作</span>
          <button onClick={onClose} className="p-1 rounded-lg" style={{ color: 'var(--color-text-muted)' }}>
            <X size={16} />
          </button>
        </div>

        {/* 团队选择 */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>选个团队</span>
          {teams.length === 0 ? (
            <p className="text-[12px] py-2" style={{ color: 'var(--color-text-muted)' }}>
              还没有团队 —— 先去「对话」里建一个软件公司群 / 自定义团队,再回来发起工作。
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5 max-h-[140px] overflow-y-auto">
              {teams.map((g) => {
                const on = selected === g.id;
                return (
                  <button
                    key={g.id}
                    onClick={() => setSelected(g.id)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] transition-colors"
                    style={{
                      background: on ? 'var(--color-warning-subtle)' : 'var(--color-bg-muted)',
                      border: `1px solid ${on ? AMBER : 'var(--color-border)'}`,
                      color: on ? 'var(--color-text)' : 'var(--color-text-secondary)',
                    }}
                  >
                    <span>{g.emoji || '👥'}</span>
                    {g.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 任务描述 */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>要做什么</span>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
            placeholder="比如:做个待办事项落地页 —— 能添加 / 删除 / 标记完成,localStorage 存数据"
            className="w-full rounded-lg px-3 py-2 text-[13px] resize-none outline-none"
            style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          />
        </div>

        {error && (
          <div className="text-[12px] px-2.5 py-1.5 rounded-lg" style={{ background: 'var(--color-error-bg, #fee)', color: 'var(--color-error, #c00)' }}>
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3.5 py-1.5 rounded-lg text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
            取消
          </button>
          <button
            onClick={launch}
            disabled={!selected || !task.trim() || launching}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[13px] font-medium transition-opacity disabled:opacity-50"
            style={{ background: AMBER, color: '#1a1206' }}
          >
            {launching ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
            {launching ? '发起中…' : '发起'}
          </button>
        </div>
      </div>
    </div>
  );
}
