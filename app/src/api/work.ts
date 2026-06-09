// Work API —— chat×work 2×2 的 work 象限(S7)。
import { invoke } from '@tauri-apps/api/core';

/** 一个 work job(后端 kind=work_dispatch 的协作)摘要。 */
export interface WorkJob {
  id: number;
  /** 所属群聊 session —— 点击跳到该工作群对话看进度。 */
  session_id: string;
  /** 用户原始诉求(任务标题)。 */
  intent: string;
  /** planning / running / done / aborted / failed。 */
  status: string;
  created_at: number;
  completed_at: number | null;
}

/** 列出所有 work job(新→旧),WorkPage 监控列表用。 */
export async function listWorkJobs(): Promise<WorkJob[]> {
  return await invoke<WorkJob[]>('list_work_jobs');
}

export interface LaunchedWork {
  session_id: string;
  collaboration_id: number;
}

/** 「新建工作」:在指定团队群上显式发起一个 work job(牵头者接手 intake)。返回新会话 + 协作 id。 */
export async function launchWorkJob(teamGid: number, task: string): Promise<LaunchedWork> {
  return await invoke<LaunchedWork>('launch_work_job', { teamGid, task });
}
