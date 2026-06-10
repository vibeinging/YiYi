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
}

export const useWorkStore = create<WorkState>((set) => ({
  selectedSessionId: '',
  setSelectedSessionId: (id) => set({ selectedSessionId: id }),
}));
