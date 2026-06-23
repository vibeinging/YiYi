/**
 * workStore —— work 表面的前端状态(R5)。
 *
 * 与 chat 的 sessionStore 分治:Work 页左栏的选中 job 记在这里(zustand 模块级常驻,
 * 切页卸载重挂 WorkPage 不丢选中);sessionStore.switchToSession 检测到 work 会话
 * (id 以 `work-` 开头)时也写这里 + 广播跳工作页,旁路入口(通知/搜索携带 work 会话)
 * 不再把 chat 页带进「幽灵会话」。
 */

import { create } from 'zustand';

interface WorkState {
  /** Work 页左栏当前选中的 job 会话 id(空串 = 未选)。 */
  selectedSessionId: string;
  setSelectedSessionId: (id: string) => void;
  /** chat 引导卡带来的待预填任务文本(R6):WorkPage 挂载/变化时消费并打开启动器。 */
  pendingLauncherTask: string | null;
  setPendingLauncherTask: (t: string | null) => void;
  /** 不在工作页时完成的 job 数(R6:NavRail「工作」入口红点;进入工作页清零)。 */
  unseenDone: number;
  bumpUnseenDone: () => void;
  clearUnseenDone: () => void;
}

export const useWorkStore = create<WorkState>((set) => ({
  selectedSessionId: '',
  setSelectedSessionId: (id) => set({ selectedSessionId: id }),
  pendingLauncherTask: null,
  setPendingLauncherTask: (t) => set({ pendingLauncherTask: t }),
  unseenDone: 0,
  bumpUnseenDone: () => set((s) => ({ unseenDone: s.unseenDone + 1 })),
  clearUnseenDone: () => set({ unseenDone: 0 }),
}));
