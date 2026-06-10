/**
 * Work Page —— chat×work 2×2 的 **work 象限**入口:多 agent 派工任务的**发起 + 监控 + 详情**。
 *
 * 两栏 · 列表+详情(对齐其他页面心智):
 *  - 左栏:work job 列表,**按文件夹(项目工作区)分组**;无文件夹的归"未指定"。
 *  - 右栏:选中 job 的**嵌入可交互会话**(`<ChatPage embedded />`)—— 复用整套对话:
 *    回答牵头者(PM)的澄清提问、点 ProjectPlanCard「开工」派工、实时看队友气泡、继续发消息。
 *    选中靠 `switchToSession(session_id)` 把它设为全局活跃会话,ChatPage 据此驱动。
 *
 * work **从这里显式发起**(「新建工作」:**项目优先**,参考 Claude Code —— 选/建项目文件夹 +
 * 说要做什么,YiYi 自动组队),不靠在 chat 里猜措辞、也不让用户选团队(群聊 ≠ 团队)。
 * 选的文件夹设为这支团队的工作区,团队的文件/shell 工具就在里面干活。
 *
 * 与 chat(对话/关系)以**琥珀**强调区分(chat 是靛紫)。
 * 数据:`list_work_jobs`(每会话去重 + 带分组字段)、`launch_work_job`(显式发起 + 透传文件夹)。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Hammer, Loader2, CheckCircle2, XCircle, Plus, X, Folder, Sparkles, Check,
  CircleHelp, PlayCircle, OctagonX,
} from 'lucide-react';
import { listWorkJobs, launchWorkJob, findTeamByFolder, abortWorkJob, type WorkJob } from '../api/work';
import { pickFolder } from '../api/workspace';
import { generateTeam, commitDynamicTeam } from '../api/companions';
import { useSessionStore } from '../stores/sessionStore';
import { useWorkStore } from '../stores/workStore';
import { CustomTeamPanel } from '../components/companions/CustomTeamPanel';
import { ChatPage } from './Chat';

const AMBER = 'var(--color-warning)'; // #FF9F0A —— work 象限强调色,区别于 chat 的靛紫

/** job 级状态机(R3)→ 视觉。澄清/待开工是「等用户」态(不转圈),running 才转圈。 */
function statusMeta(status: string): { label: string; color: string; Icon: typeof Loader2; spin: boolean; active: boolean } {
  switch (status) {
    case 'clarifying':
      return { label: '澄清中', color: 'var(--color-info, #5AC8FA)', Icon: CircleHelp, spin: false, active: true };
    case 'pending_commit':
      return { label: '待开工', color: AMBER, Icon: PlayCircle, spin: false, active: true };
    case 'done':
      return { label: '已交付', color: 'var(--color-success)', Icon: CheckCircle2, spin: false, active: false };
    case 'aborted':
      return { label: '已中止', color: 'var(--color-text-muted)', Icon: XCircle, spin: false, active: false };
    case 'failed':
      return { label: '失败', color: 'var(--color-error)', Icon: XCircle, spin: false, active: false };
    default: // running / 未知值兜底
      return { label: '进行中', color: AMBER, Icon: Loader2, spin: true, active: true };
  }
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 文件夹绝对路径 → 末段名(组头/选项展示用)。 */
function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** 按 group_id 聚合后的一个分组(= 一支团队 / 一个项目文件夹)。 */
interface JobGroup {
  key: string;
  groupName: string;
  emoji: string;
  workspacePath: string | null;
  jobs: WorkJob[];
}

export function WorkPage() {
  const [jobs, setJobs] = useState<WorkJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  // 选中键用**会话 id**(稳定)。R5:存 workStore(模块级常驻)—— 切页卸载重挂 WorkPage
  // 不再丢选中;旁路入口(switchToSession 检测 work- 前缀)也写它。
  const selectedSessionId = useWorkStore((s) => s.selectedSessionId);
  const [launcherOpen, setLauncherOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    // 防御:确保 session store 已初始化(默认页是 chat 时通常已就绪)。否则右栏 ChatPage 挂载
    // 时的 initialize() 可能用最近聊天会话覆盖掉刚 switchToSession 的 work 会话。幂等,安全。
    useSessionStore.getState().initialize();
    const load = () =>
      listWorkJobs()
        .then((j) => { if (alive) setJobs(j); })
        .catch(() => {})
        .finally(() => { if (alive) setLoaded(true); });
    load();
    const t = setInterval(load, 4000); // 进行中的 job 状态会变,保持新鲜
    return () => { alive = false; clearInterval(t); };
  }, []);

  // 按文件夹/团队分组,保留 jobs 已是新→旧的顺序。
  const groups: JobGroup[] = useMemo(() => {
    const map = new Map<string, JobGroup>();
    for (const j of jobs) {
      const key = j.group_id != null ? `g${j.group_id}` : '__none__';
      if (!map.has(key)) {
        map.set(key, {
          key,
          groupName: j.group_name ?? '未指定团队',
          emoji: j.group_emoji ?? '📁',
          workspacePath: j.workspace_path,
          jobs: [],
        });
      }
      map.get(key)!.jobs.push(j);
    }
    return [...map.values()];
  }, [jobs]);

  // 选中一个工作会话:switchToSession 一站式处理(设全局活跃会话 + 写 workStore 选中态;
  // work- 前缀分支里完成,见 sessionStore)。
  const selectSession = (sessionId: string) => {
    useSessionStore.getState().switchToSession(sessionId);
  };
  // 切回 Work 页时,把右栏会话恢复成左栏选中的 job(全局活跃会话可能在 Chat 页被改走)。
  useEffect(() => {
    if (selectedSessionId && useSessionStore.getState().activeSessionId !== selectedSessionId) {
      useSessionStore.getState().switchToSession(selectedSessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="h-full flex" style={{ background: 'var(--color-bg)' }}>
      {/* ── 左栏:头部 + 分组列表 ── */}
      <aside
        className="w-[300px] shrink-0 flex flex-col"
        style={{ borderRight: '1px solid var(--color-border)' }}
      >
        <header
          className="shrink-0 flex items-center gap-2.5 px-4 h-14"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'var(--color-warning-subtle)' }}
          >
            <Hammer size={17} color={AMBER} strokeWidth={2.1} />
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[14px] font-semibold leading-tight" style={{ color: 'var(--color-text)' }}>
              工作
            </span>
            <span className="text-[11px] leading-tight truncate" style={{ color: 'var(--color-text-muted)' }}>
              团队交付 · 多 agent 派工
            </span>
          </div>
          <button
            onClick={() => setLauncherOpen(true)}
            className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg transition-opacity"
            style={{ background: AMBER, color: '#1a1206' }}
            title="新建工作"
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
          >
            <Plus size={17} strokeWidth={2.4} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto py-1.5">
          {loaded && jobs.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                还没有工作。点右上角 ＋ 新建。
              </p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.key} className="mb-1">
                {/* 组头:emoji + 团队名 + 文件夹名(sticky) */}
                <div
                  className="sticky top-0 z-10 flex items-center gap-1.5 px-3 py-1.5"
                  style={{ background: 'var(--color-bg)' }}
                >
                  <span className="text-[13px] leading-none">{g.emoji}</span>
                  <span className="text-[11px] font-semibold truncate" style={{ color: 'var(--color-text-secondary)' }}>
                    {g.groupName}
                  </span>
                  {g.workspacePath && (
                    <span
                      className="text-[10.5px] truncate inline-flex items-center gap-0.5"
                      style={{ color: 'var(--color-text-muted)' }}
                      title={g.workspacePath}
                    >
                      <Folder size={10} strokeWidth={2} />
                      {basename(g.workspacePath)}
                    </span>
                  )}
                </div>

                {g.jobs.map((job) => {
                  const m = statusMeta(job.status);
                  const sel = job.session_id === selectedSessionId;
                  return (
                    <div
                      key={job.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectSession(job.session_id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') selectSession(job.session_id); }}
                      className="group w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer"
                      style={{ background: sel ? 'var(--color-bg-subtle)' : 'transparent' }}
                      onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                      onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <div
                        className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
                        style={{ background: `color-mix(in srgb, ${m.color} 14%, transparent)` }}
                      >
                        <m.Icon size={14} color={m.color} className={m.spin ? 'animate-spin' : ''} strokeWidth={2} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-medium truncate" style={{ color: 'var(--color-text)' }}>
                          {job.intent || '(未命名任务)'}
                        </div>
                        <div className="text-[10.5px] mt-0.5 truncate" style={{ color: 'var(--color-text-muted)' }}>
                          <span style={{ color: m.color }}>{m.label}</span>
                          <span> · {fmtTime(job.created_at)}</span>
                        </div>
                      </div>
                      {/* 中止(逃生门):仅活动态显示,hover 出现;双击免误触(一次确认) */}
                      {m.active && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!window.confirm(`中止「${job.intent}」?运行中的任务将停止。`)) return;
                            try { await abortWorkJob(job.session_id); } catch { /* 轮询会刷新真状态 */ }
                          }}
                          className="shrink-0 w-6 h-6 rounded-md hidden group-hover:flex items-center justify-center transition-colors hover:bg-[var(--color-bg-muted)]"
                          style={{ color: 'var(--color-text-muted)' }}
                          title="中止这项工作"
                        >
                          <OctagonX size={13} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </section>
            ))
          )}
        </div>
      </aside>

      {/* ── 右栏:选中 = 嵌入会话;否则空态 ── */}
      <main className="flex-1 min-w-0">
        {selectedSessionId ? (
          <ChatPage embedded />
        ) : (
          <div className="h-full flex items-center justify-center px-6">
            <div className="max-w-[420px] flex flex-col items-center text-center gap-4">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center"
                style={{ background: 'var(--color-warning-subtle)' }}
              >
                <Hammer size={30} color={AMBER} strokeWidth={1.7} />
              </div>
              <h2 className="text-[16px] font-semibold" style={{ color: 'var(--color-text)' }}>
                {jobs.length === 0 ? '还没有进行中的工作' : '选一个工作看团队推进'}
              </h2>
              <p className="text-[13px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                {jobs.length === 0
                  ? '点「新建工作」—— 选/建一个项目文件夹、说要做什么,YiYi 自动组建一支团队接手、拆解派工,在那个文件夹里把活干完。'
                  : '左栏选一个工作 —— 右边就是那支团队的工作会话:回答牵头者的澄清、点「开工」派工、实时看队友干活。'}
              </p>
              {jobs.length === 0 && (
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
              )}
            </div>
          </div>
        )}
      </main>

      {launcherOpen && (
        <WorkLauncher
          onClose={() => setLauncherOpen(false)}
          onLaunched={(sessionId) => { setLauncherOpen(false); selectSession(sessionId); }}
        />
      )}
    </div>
  );
}

/**
 * 「新建工作」弹窗 —— **项目优先**(参考 Claude Code):选/建项目文件夹 + 描述任务 → 开工。
 *
 * 不再让用户选团队(群聊 ≠ 团队)。团队由 YiYi 据任务**自动组建**:
 *  - [开工](主,不啰嗦):同项目已绑团队 → 复用;否则 generate_team → commit_dynamic_team → 开工。
 *  - [先看看团队](次,白盒):复用 CustomTeamPanel 审阅/编辑角色,确认后用该团队开工。
 *
 * 文件夹:默认「新建项目(自动)」(传 null,commit_dynamic_team 自动建 projects/<名>);
 * 可改「选已有文件夹」(pickFolder,如电脑上现成的 repo),launch 时覆盖成该目录。
 */
function WorkLauncher({
  onClose,
  onLaunched,
}: {
  onClose: () => void;
  onLaunched: (sessionId: string) => void;
}) {
  const [folderMode, setFolderMode] = useState<'auto' | 'pick'>('auto');
  const [pickedFolder, setPickedFolder] = useState<string | null>(null);
  const [task, setTask] = useState('');
  const [launching, setLaunching] = useState(false);
  const [phase, setPhase] = useState(''); // 进度文案:正在组队 / 开工中
  const [error, setError] = useState('');
  const [review, setReview] = useState(false); // 「先看看团队」白盒审阅视图

  // 选定项目目录:auto → null(commit_dynamic_team 自动建 projects/<名>);pick → 选定路径。
  const folder = folderMode === 'pick' ? pickedFolder : null;
  const canGo = task.trim().length > 0 && (folderMode === 'auto' || !!pickedFolder);

  const handlePick = async () => {
    setError('');
    try {
      const p = await pickFolder();
      if (p) { setPickedFolder(p); setFolderMode('pick'); }
    } catch (e) {
      setError(String(e));
    }
  };

  // 用一支团队(gid)在选定目录开工 → 选中新会话。auto 与 review 两条路共用。
  const launchOn = async (gid: number) => {
    setPhase('开工中…');
    const r = await launchWorkJob(gid, task.trim(), folder);
    onLaunched(r.session_id);
  };

  // 主路径:同项目复用团队 或 自动组队 → 开工。
  const launchAuto = async () => {
    if (!canGo || launching) return;
    setLaunching(true);
    setError('');
    try {
      // 项目复用:选了已有文件夹且该目录已绑团队 → 复用,不重复组队。
      let gid: number | null = folder ? await findTeamByFolder(folder) : null;
      if (!gid) {
        setPhase('正在组队…');
        const team = await generateTeam(task.trim());
        gid = await commitDynamicTeam(team.name, '🛠️', team.roles);
      }
      await launchOn(gid);
    } catch (e) {
      setError(String(e));
      setLaunching(false);
      setPhase('');
    }
  };

  // ── 白盒审阅视图:复用 CustomTeamPanel,落地后用该团队开工 ──
  if (review) {
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center"
        style={{ background: 'rgba(0,0,0,0.45)' }}
        onClick={onClose}
      >
        <div
          className="w-[520px] max-w-[94vw] max-h-[88vh] rounded-2xl flex flex-col overflow-hidden"
          style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 px-5 pt-4 pb-1 shrink-0">
            <button
              onClick={() => setReview(false)}
              className="text-[12px] px-1.5 py-1 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              ← 返回
            </button>
            <span className="text-[14px] font-semibold flex-1 text-center" style={{ color: 'var(--color-text)' }}>
              看看团队再开工
            </span>
            <button onClick={onClose} className="p-1 rounded-lg" style={{ color: 'var(--color-text-muted)' }}>
              <X size={16} />
            </button>
          </div>
          {/* 预填任务作 goal;落地后不开 chat,改为用该团队开工(folder 非 null 时覆盖工作区)。 */}
          <CustomTeamPanel
            goal={task.trim()}
            onClose={onClose}
            onCommitted={async (gid) => { await launchOn(gid); }}
          />
        </div>
      </div>
    );
  }

  // ── 主表单:项目文件夹 + 任务 ──
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-2xl flex flex-col gap-4 p-5"
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

        {/* 项目文件夹(主):自动新建 / 选已有 */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            项目文件夹 <span style={{ color: 'var(--color-text-muted)' }}>—— 团队在里面干活</span>
          </span>
          <div className="flex flex-col gap-1.5">
            <button
              onClick={() => setFolderMode('auto')}
              className="flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-colors"
              style={{
                background: folderMode === 'auto' ? 'var(--color-warning-subtle)' : 'var(--color-bg-muted)',
                border: `1px solid ${folderMode === 'auto' ? AMBER : 'var(--color-border)'}`,
              }}
            >
              <Sparkles size={15} color={folderMode === 'auto' ? AMBER : 'var(--color-text-muted)'} className="shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-medium" style={{ color: 'var(--color-text)' }}>新建项目(自动)</div>
                <div className="text-[10.5px]" style={{ color: 'var(--color-text-muted)' }}>YiYi 自动建一个项目目录</div>
              </div>
              {folderMode === 'auto' && <Check size={15} color={AMBER} strokeWidth={2.4} className="shrink-0" />}
            </button>
            <button
              onClick={handlePick}
              className="flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-colors"
              style={{
                background: folderMode === 'pick' ? 'var(--color-warning-subtle)' : 'var(--color-bg-muted)',
                border: `1px solid ${folderMode === 'pick' ? AMBER : 'var(--color-border)'}`,
              }}
            >
              <Folder size={15} color={folderMode === 'pick' ? AMBER : 'var(--color-text-muted)'} className="shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-medium" style={{ color: 'var(--color-text)' }}>选已有文件夹…</div>
                <div className="text-[10.5px] truncate" style={{ color: 'var(--color-text-muted)' }}>
                  {pickedFolder || '让团队改造电脑上现成的项目'}
                </div>
              </div>
              {folderMode === 'pick' && <Check size={15} color={AMBER} strokeWidth={2.4} className="shrink-0" />}
            </button>
          </div>
        </div>

        {/* 任务描述 */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>要做什么</span>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
            autoFocus
            placeholder="比如:做个待办事项落地页 —— 能添加 / 删除 / 标记完成,localStorage 存数据"
            className="w-full rounded-lg px-3 py-2 text-[13px] resize-none outline-none"
            style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          />
          <span className="text-[10.5px]" style={{ color: 'var(--color-text-muted)' }}>
            YiYi 会据此自动组建一支团队来干。想先看看 / 调团队?用下面「先看看团队」。
          </span>
        </div>

        {error && (
          <div className="text-[12px] px-2.5 py-1.5 rounded-lg" style={{ background: 'var(--color-error-bg, #fee)', color: 'var(--color-error, #c00)' }}>
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => { if (task.trim()) setReview(true); }}
            disabled={!task.trim() || launching}
            className="text-[12.5px] px-2 py-1.5 rounded-lg transition-colors disabled:opacity-40 hover:bg-[var(--color-bg-subtle)]"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            先看看团队
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3.5 py-1.5 rounded-lg text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
              取消
            </button>
            <button
              onClick={launchAuto}
              disabled={!canGo || launching}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[13px] font-medium transition-opacity disabled:opacity-50"
              style={{ background: AMBER, color: '#1a1206' }}
            >
              {launching ? <Loader2 size={14} className="animate-spin" /> : <Hammer size={14} strokeWidth={2.2} />}
              {launching ? (phase || '处理中…') : '开工'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
