/**
 * BackgroundTaskCard - Confirmation card shown in chat when Agent proposes background execution.
 * User can choose "后台执行" or "在这里继续".
 */

import { useState } from 'react';
import { Rocket, MessageSquare, Loader2 } from 'lucide-react';
import { confirmBackgroundTask } from '../api/tasks';

interface BackgroundTaskProposal {
  task_name: string;
  task_description: string;
  context_summary: string;
  estimated_steps?: number;
  workspace_path?: string;
}

interface Props {
  proposal: BackgroundTaskProposal;
  sessionId: string;
  originalMessage: string;
  onConfirmed?: () => void;
  onInline?: () => void;
}

export function BackgroundTaskCard({ proposal, sessionId, originalMessage, onConfirmed, onInline }: Props) {
  const [loading, setLoading] = useState(false);
  const [chosen, setChosen] = useState<'background' | 'inline' | null>(null);

  const handleBackground = async () => {
    setLoading(true);
    setChosen('background');
    try {
      await confirmBackgroundTask(
        sessionId,
        proposal.task_name,
        originalMessage,
        proposal.context_summary,
        proposal.workspace_path,
      );
      onConfirmed?.();
    } catch (err) {
      console.error('Failed to create background task:', err);
      setChosen(null);
    } finally {
      setLoading(false);
    }
  };

  const handleInline = () => {
    setChosen('inline');
    onInline?.();
  };

  if (chosen === 'background') {
    return (
      <div className="rounded-xl p-4 my-2" style={{ background: 'color-mix(in srgb, var(--color-success) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--color-success) 20%, transparent)' }}>
        <div className="flex items-center gap-2">
          <Rocket size={14} style={{ color: 'var(--color-success)' }} />
          <span className="text-[13px] font-medium" style={{ color: 'var(--color-success)' }}>
            任务已在后台开始：{proposal.task_name}
          </span>
        </div>
        <p className="text-[12px] mt-1" style={{ color: 'var(--color-text-secondary)' }}>
          你可以在左侧侧边栏查看进度。
        </p>
      </div>
    );
  }

  if (chosen === 'inline') return null;

  return (
    <div className="rounded-xl p-4 my-2" style={{
      background: 'var(--color-bg-elevated)',
      border: '1px solid var(--color-border)',
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
    }}>
      <p className="text-[13px] font-medium mb-2" style={{ color: 'var(--color-text)' }}>
        这个任务需要一些时间来完成。
      </p>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>
          {proposal.task_name}
        </span>
      </div>
      <p className="text-[12px] mb-3" style={{ color: 'var(--color-text-secondary)' }}>
        {proposal.task_description}
      </p>
      <div className="flex items-center gap-3">
        <button
          onClick={handleBackground}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors"
          style={{ background: 'var(--color-primary)', color: '#fff' }}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
          后台执行
        </button>
        <button
          onClick={handleInline}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors"
          style={{
            background: 'var(--color-bg-muted)',
            color: 'var(--color-text)',
          }}
        >
          <MessageSquare size={14} />
          在这里继续
        </button>
      </div>
    </div>
  );
}
