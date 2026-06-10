/**
 * 开工方案 Bridge —— 监听 work 牵头者发来的 `work://plan_proposed` 事件(chat×work 2×2:
 * work 表面独立事件),在会话里插入一张「开工方案」卡片。用户点「开工」后由前端调
 * commit_work_plan 派工(标 kind=work_dispatch)。
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useChatStreamStore } from '../stores/chatStreamStore';

interface ProjectPlanPayload {
  request_id: string;
  summary: string;
  plan: { tasks: { role: string; objective: string; depends_on: number[] }[] };
}

export function useProjectPlanBridge() {
  useEffect(() => {
    const unlisten = listen<ProjectPlanPayload>('work://plan_proposed', (event) => {
      const p = event.payload;
      useChatStreamStore.getState().showProjectPlan({
        requestId: p.request_id,
        summary: p.summary ?? '',
        tasks: p.plan?.tasks ?? [],
      });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);
}
