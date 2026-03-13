import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import { create } from 'zustand';

export interface BotMessage {
  id: string;
  botId: string;
  platform: string;
  direction: 'incoming' | 'outgoing';
  conversationId: string;
  content: string;
  timestamp: number;
  senderName?: string;
}

interface BotMessageStore {
  messages: BotMessage[];
  addMessage: (msg: BotMessage) => void;
  clearMessages: () => void;
}

export const useBotMessageStore = create<BotMessageStore>((set) => ({
  messages: [],
  addMessage: (msg) =>
    set((state) => ({
      messages: [...state.messages.slice(-99), msg], // Keep last 100
    })),
  clearMessages: () => set({ messages: [] }),
}));

/**
 * App-level hook that bridges Tauri bot events to the Zustand store.
 * Must be called once in App.tsx.
 *
 * Listens to:
 *  - `bot://message`  — incoming messages received by a bot
 *  - `bot://response` — outgoing responses sent by the agent
 */
export function useBotEventBridge() {
  useEffect(() => {
    let cancelled = false;
    const store = () => useBotMessageStore.getState();

    const unlisteners = [
      listen('bot://message', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        store().addMessage({
          id: `${p.bot_id}-${p.timestamp}-in`,
          botId: p.bot_id,
          platform: p.platform,
          direction: 'incoming',
          conversationId: p.conversation_id,
          content: p.content,
          timestamp: p.timestamp || Date.now(),
          senderName: p.sender_name,
        });
      }),

      listen('bot://response', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        store().addMessage({
          id: `${p.bot_id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-out`,
          botId: p.bot_id,
          platform: p.platform,
          direction: 'outgoing',
          conversationId: p.conversation_id,
          content: p.content,
          timestamp: Date.now(),
        });
      }),
    ];

    return () => {
      cancelled = true;
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);
}
