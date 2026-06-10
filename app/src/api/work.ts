// Work API —— chat×work 2×2 的 work 象限(S7)。
import { invoke } from '@tauri-apps/api/core';

/** 一个 work job(后端 kind=work_dispatch 的协作)摘要。 */
export interface WorkJob {
  id: number;
  /** 所属群聊 session —— 选中后右栏嵌入该会话看团队推进。 */
  session_id: string;
  /** 任务标题(优先会话名,回退协作 intent)。 */
  intent: string;
  /** planning / running / done / aborted / failed。 */
  status: string;
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
}

/** 列出所有 work job(新→旧),WorkPage 监控列表用。 */
export async function listWorkJobs(): Promise<WorkJob[]> {
  return await invoke<WorkJob[]>('list_work_jobs');
}

/** 项目复用:某文件夹是否已绑过团队(同一项目反复干活复用同支团队)。命中返回 group_id。 */
export async function findTeamByFolder(folder: string): Promise<number | null> {
  return await invoke<number | null>('find_team_by_folder', { folder });
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
