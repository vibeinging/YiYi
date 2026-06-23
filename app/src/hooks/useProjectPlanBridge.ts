/**
 * 开工方案 Bridge —— 监听 work 牵头者发来的 `work://plan_proposed` 事件。
 * R4 起方案卡来自**持久化消息**(propose_work_plan 落库 context_type=work_plan 锚点,
 * ChatMessages 据此渲染),本 bridge 只负责"即时性":事件到达 → 触发当前会话消息重载,
 * 让卡片立刻出现(否则要等下一次轮询/切换)。不再写全局单槽(那会跨会话污染、切页即丢)。
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';

export function useProjectPlanBridge() {
  useEffect(() => {
    const unlisten = listen('work://plan_proposed', () => {
      // 重载当前活跃会话(Chat.tsx 的 yiyi:reload-messages 监听)。方案属于哪个会话由
      // 持久化消息决定;若事件属于别的会话,重载当前会话是无害 no-op。
      window.dispatchEvent(new CustomEvent('yiyi:reload-messages'));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
