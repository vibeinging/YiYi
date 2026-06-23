// Work API —— chat×work 2×2 的 work 象限(S7;R3 job 一等公民)。
import { invoke } from '@tauri-apps/api/core';

/** work job 的生命周期状态(R3 job 级状态机,来自后端 work_jobs 表)。 */
export type WorkJobStatus =
  | 'clarifying'      // 澄清中:牵头者在问/在想,等用户或等方案
  | 'pending_commit'  // 待开工:方案已出,等用户点「开工」
  | 'running'         // 进行中:队友按 DAG 并行干活
  | 'done'            // 已交付
  | 'failed'          // 失败
  | 'aborted';        // 已中止

/** 一个 work job(一个 work 会话)摘要。 */
export interface WorkJob {
  id: number;
  /** 所属 work 会话 —— 选中后右栏嵌入该会话看团队推进。 */
  session_id: string;
  /** 任务标题(优先会话名,回退 job intent)。 */
  intent: string;
  /** job 级状态机(见 WorkJobStatus;未知值前端按进行中兜底)。 */
  status: WorkJobStatus | string;
  created_at: number;
  completed_at: number | null;
  // ── 分组字段(按文件夹/团队分组;后端 LEFT JOIN 可能为 null)──
  /** 所属团队群 id。 */
  group_id: number | null;
  /** 团队群名(分组组头)。 */
  group_name: string | null;
  /** 团队群 emoji。 */
  group_emoji: string | null;
  /** 团队项目工作区绝对路径(团队在里面干活的文件夹)。 */
  workspace_path: string | null;
  // ── #3 监控:派工步进度 + token 成本 ──
  /** 派工总步数(含自动追加的验证步)。 */
  steps_total: number;
  /** 已完成/失败/跳过的步数(进度分子)。 */
  steps_done: number;
  /** 累计 token(input+output)。 */
  tokens: number;
}

/** 列出所有 work job(新→旧),WorkPage 监控列表用。 */
export async function listWorkJobs(): Promise<WorkJob[]> {
  return await invoke<WorkJob[]>('list_work_jobs');
}

/** 项目复用:某文件夹是否已绑过团队(同一项目反复干活复用同支团队)。命中返回 group_id。 */
export async function findTeamByFolder(folder: string): Promise<number | null> {
  return await invoke<number | null>('find_team_by_folder', { folder });
}

/** 项目团队摘要 ——「新建工作」弹窗「项目」下拉的数据源(只含绑了 workspace 的项目群)。 */
export interface ProjectGroup {
  /** 团队群 id。 */
  id: number;
  /** 团队群名。 */
  name: string;
  /** 团队群 emoji(可能为空)。 */
  emoji: string | null;
  /** 项目工作区绝对路径(团队在里面干活的文件夹)。 */
  workspace_path: string;
  /** 最近一次 work job 的创建时间(ms);没跑过则 null。下拉据此把最近项目置顶。 */
  last_used_at: number | null;
}

/**
 * 列出所有项目团队(绑了 workspace 的群),按最近一次 work job 降序。
 * 「新建工作」弹窗的「项目」下拉数据源 —— 历史 work 项目置顶。
 */
export async function listProjectGroups(): Promise<ProjectGroup[]> {
  return await invoke<ProjectGroup[]>('list_project_groups');
}

export interface LaunchedWork {
  session_id: string;
  collaboration_id: number;
}

/**
 * 「新建工作」:在指定团队群上显式发起一个 work job(牵头者接手 intake)。返回新会话 + 协作 id。
 * `workspacePath`:用户选/建的项目文件夹绝对路径 —— 设为这支团队的工作区,团队在里面干活。
 */
export async function launchWorkJob(
  teamGid: number,
  task: string,
  workspacePath?: string | null,
): Promise<LaunchedWork> {
  return await invoke<LaunchedWork>('launch_work_job', { teamGid, task, workspacePath: workspacePath ?? null });
}

/** 中止一个 work job(逃生门):非终态协作全部置 aborted。返回被中止的协作数。 */
export async function abortWorkJob(sessionId: string): Promise<number> {
  return await invoke<number>('abort_work_job', { sessionId });
}
