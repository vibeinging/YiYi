/**
 * 开工方案 Bridge(S2③)—— 监听 PM 发来的 `chat://project_plan` 事件,在聊天流里
 * 插入一张「开工方案」卡片。用户点「开工」后由前端调 commit_project_plan 派工。
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
    const unlisten = listen<ProjectPlanPayload>('chat://project_plan', (event) => {
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
