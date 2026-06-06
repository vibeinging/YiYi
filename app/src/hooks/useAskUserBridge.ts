/**
 * ask_user Bridge —— 监听后端 `chat://ask_user` 事件,在聊天流里插入一张
 * 可交互的提问卡片。用户的回答经 `answer_user_question` 命令回传给阻塞中的
 * agent。这是 permission://request 桥的开放问题版(F1)。
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useChatStreamStore } from '../stores/chatStreamStore';

interface AskUserPayload {
  request_id: string;
  session_id: string;
  collaboration_id: number | null;
  companion_id: number;
  asker_name: string;
  question: string;
  options: string[];
  kind: string;
  created_at: number;
}

export function useAskUserBridge() {
  useEffect(() => {
    const unlisten = listen<AskUserPayload>('chat://ask_user', (event) => {
      const q = event.payload;
      useChatStreamStore.getState().showQuestion({
        requestId: q.request_id,
        sessionId: q.session_id,
        companionId: q.companion_id,
        askerName: q.asker_name,
        question: q.question,
        options: q.options ?? [],
        kind: q.kind,
        status: 'pending',
      });
    });

    return () => { unlisten.then((fn) => fn()); };
  }, []);
}
