import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import { toast } from '../components/Toast';

interface PersistSuggestion {
  type: 'skill' | 'code' | 'workflow';
  name: string;
  description: string;
  reason?: string;
  session_id?: string;
  task_id?: string;
}

const TYPE_LABELS: Record<string, string> = {
  skill: '技能',
  code: '代码工具',
  workflow: '工作流',
};

export function useGrowthEventBridge() {
  useEffect(() => {
    let cancelled = false;
    const unlisteners = [
      listen<PersistSuggestion>('growth://persist_suggestion', (event) => {
        if (cancelled) return;
        const { type, name, description } = event.payload;
        const label = TYPE_LABELS[type] || type;
        toast.info(
          `💡 "${name}" 可以保存为${label}：${description.slice(0, 60)}${description.length > 60 ? '...' : ''}`
        );
      }),
    ];
    return () => {
      cancelled = true;
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);
}
