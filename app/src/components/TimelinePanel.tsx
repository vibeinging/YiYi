/**
 * TimelinePanel — workspace checkpoint timeline (right drawer).
 *
 * Solid dot = checkpoint exists (turn touched files); hollow dot =
 * read-only / pure-chat turn with no checkpoint. Clicking 恢复 opens
 * a confirmation modal and then calls `restoreCheckpoint` for a full
 * restore.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Clock, RefreshCw, RotateCcw, X } from 'lucide-react';
import {
  listCheckpoints,
  restoreCheckpoint,
  type CheckpointInfo,
} from '../api/snapshots';
import type { ChatMessage } from '../api/agent';
import { toast } from './Toast';

interface TimelinePanelProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  messages: ChatMessage[];
}

interface TimelineRow {
  turnIndex: number;
  userMessage: string;
  pre?: CheckpointInfo;
  post?: CheckpointInfo;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚才';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function buildRows(checkpoints: CheckpointInfo[], messages: ChatMessage[]): TimelineRow[] {
  // turn_index is 1-based and equals the count of user messages up through
  // (and including) the message that triggered the turn. Build a lookup.
  const userMessages = messages.filter((m) => m.role === 'user');

  const byTurn = new Map<number, TimelineRow>();
  // Seed all turns from messages so read-only turns (no checkpoint) still
  // appear as hollow dots in the timeline.
  userMessages.forEach((m, i) => {
    const turn = i + 1;
    const text = (m.content || '').trim();
    byTurn.set(turn, {
      turnIndex: turn,
      userMessage: text.length > 80 ? text.slice(0, 80) + '…' : text,
    });
  });
  for (const c of checkpoints) {
    const row = byTurn.get(c.turn_index) ?? {
      turnIndex: c.turn_index,
      userMessage: '',
    };
    if (c.phase === 'pre') row.pre = c;
    if (c.phase === 'post') row.post = c;
    byTurn.set(c.turn_index, row);
  }
  return Array.from(byTurn.values()).sort((a, b) => b.turnIndex - a.turnIndex);
}

export function TimelinePanel({ open, onClose, sessionId, messages }: TimelinePanelProps) {
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<CheckpointInfo | null>(null);
  const [restoring, setRestoring] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const list = await listCheckpoints(sessionId);
      setCheckpoints(list);
    } catch (e) {
      toast.error(`加载时间线失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  const rows = useMemo(() => buildRows(checkpoints, messages), [checkpoints, messages]);

  const handleConfirmRestore = async () => {
    if (!pendingRestore) return;
    setRestoring(true);
    try {
      const report = await restoreCheckpoint(
        pendingRestore.session_id,
        pendingRestore.turn_index,
        pendingRestore.phase as 'pre' | 'post',
      );
      const stashed = report.stash_commit
        ? `（手动改动已保存到 stash: ${report.stash_commit.slice(0, 7)}）`
        : '';
      toast.success(
        `已恢复到 Turn ${pendingRestore.turn_index} · 还原 ${report.restored_files.length} 个文件${stashed}`,
      );
      setPendingRestore(null);
      await refresh();
    } catch (e) {
      toast.error(`恢复失败: ${e}`);
    } finally {
      setRestoring(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[80]"
        style={{ background: 'rgba(0,0,0,0.25)' }}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="时间线"
        className="fixed top-0 right-0 bottom-0 z-[81] flex flex-col animate-in slide-in-from-right duration-200"
        style={{
          width: '380px',
          background: 'var(--color-bg)',
          borderLeft: '1px solid var(--color-border)',
        }}
      >
        <header
          className="flex items-center justify-between shrink-0 px-4 py-3"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div className="flex items-center gap-2">
            <Clock size={16} />
            <span className="font-medium">时间线</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--color-hover)]"
              onClick={refresh}
              aria-label="刷新"
              disabled={loading}
            >
              <RefreshCw
                size={14}
                className={loading ? 'animate-spin' : ''}
                style={{ color: 'var(--color-text-secondary)' }}
              />
            </button>
            <button
              className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--color-hover)]"
              onClick={onClose}
              aria-label="关闭"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {rows.length === 0 && !loading && (
            <div
              className="text-sm py-8 text-center"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              这个会话还没有可恢复的快照
            </div>
          )}

          {rows.length > 0 && (
            <div className="relative">
              <div
                className="absolute top-2 bottom-2 w-px"
                style={{ left: '7px', background: 'var(--color-border)' }}
                aria-hidden
              />
              <div className="flex flex-col gap-3">
                {rows.map((row) => (
                  <TimelineRowItem
                    key={row.turnIndex}
                    row={row}
                    onRequestRestore={(c) => setPendingRestore(c)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>

      {pendingRestore && (
        <RestoreConfirmModal
          checkpoint={pendingRestore}
          loading={restoring}
          onCancel={() => setPendingRestore(null)}
          onConfirm={handleConfirmRestore}
        />
      )}
    </>
  );
}

function TimelineRowItem({
  row,
  onRequestRestore,
}: {
  row: TimelineRow;
  onRequestRestore: (c: CheckpointInfo) => void;
}) {
  const target = row.post ?? row.pre;
  const hasCheckpoint = !!target;
  const stats = target;

  return (
    <div className="flex items-start gap-3">
      <div
        className="shrink-0 mt-1.5"
        style={{
          width: '15px',
          height: '15px',
          borderRadius: '50%',
          background: hasCheckpoint ? 'var(--color-accent)' : 'var(--color-bg)',
          border: hasCheckpoint
            ? '2px solid var(--color-accent)'
            : '2px solid var(--color-border)',
        }}
        aria-hidden
      />
      <div
        className="flex-1 rounded-lg p-3"
        style={{
          background: 'var(--color-card)',
          border: '1px solid var(--color-border)',
          opacity: hasCheckpoint ? 1 : 0.6,
        }}
      >
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span className="text-xs font-medium">
            Turn {row.turnIndex}
            {!hasCheckpoint && (
              <span
                className="ml-2 text-[11px]"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                未改文件
              </span>
            )}
          </span>
          {target && (
            <span
              className="text-[11px] shrink-0"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {relativeTime(target.created_at_ms)}
            </span>
          )}
        </div>

        {row.userMessage && (
          <div className="text-sm leading-snug mb-2" style={{ wordBreak: 'break-word' }}>
            {row.userMessage}
          </div>
        )}

        {stats && stats.files_changed > 0 && (
          <div
            className="text-xs space-y-0.5 mb-2"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <div>
              <span style={{ color: 'var(--color-success, #10b981)' }}>
                +{stats.insertions}
              </span>{' '}
              <span style={{ color: 'var(--color-error, #ef4444)' }}>
                -{stats.deletions}
              </span>{' '}
              · {stats.files_changed} 个文件
            </div>
            {stats.changed_files.slice(0, 3).map((f) => (
              <div key={f} className="font-mono text-[11px] truncate">
                📝 {f}
              </div>
            ))}
            {stats.files_changed > 3 && (
              <div className="text-[11px]">+ {stats.files_changed - 3} more</div>
            )}
          </div>
        )}

        {hasCheckpoint && target && (
          <button
            className="text-xs px-2 py-1 rounded-md inline-flex items-center gap-1 hover:bg-[var(--color-hover)]"
            style={{
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
            }}
            onClick={() => onRequestRestore(target)}
          >
            <RotateCcw size={12} />
            恢复到这里
          </button>
        )}
      </div>
    </div>
  );
}

function RestoreConfirmModal({
  checkpoint,
  loading,
  onCancel,
  onConfirm,
}: {
  checkpoint: CheckpointInfo;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      role="dialog"
      aria-label="恢复确认"
    >
      <div
        className="rounded-lg max-w-md w-full mx-4 p-5"
        style={{
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
        }}
      >
        <h3 className="text-base font-medium mb-3">恢复到 Turn {checkpoint.turn_index}</h3>
        <div
          className="text-sm mb-3"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          将影响 <strong>{checkpoint.files_changed}</strong> 个文件
          <span className="ml-2">
            <span style={{ color: 'var(--color-success, #10b981)' }}>
              +{checkpoint.insertions}
            </span>{' '}
            <span style={{ color: 'var(--color-error, #ef4444)' }}>
              -{checkpoint.deletions}
            </span>
          </span>
        </div>

        {checkpoint.changed_files.length > 0 && (
          <div
            className="rounded-md p-2 mb-3 max-h-40 overflow-y-auto"
            style={{ background: 'var(--color-card)' }}
          >
            {checkpoint.changed_files.map((f) => (
              <div key={f} className="font-mono text-xs truncate py-0.5">
                📝 {f}
              </div>
            ))}
          </div>
        )}

        <div
          className="text-xs rounded-md p-2 mb-4"
          style={{
            background: 'var(--color-card)',
            color: 'var(--color-text-secondary)',
          }}
        >
          ⚠ 当前工作区如有手动改动，会自动保存到 stash，可随时找回。
        </div>

        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-sm rounded-md hover:bg-[var(--color-hover)]"
            style={{ border: '1px solid var(--color-border)' }}
            onClick={onCancel}
            disabled={loading}
          >
            取消
          </button>
          <button
            className="px-3 py-1.5 text-sm rounded-md text-white"
            style={{ background: 'var(--color-accent)' }}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? '恢复中…' : '确认恢复'}
          </button>
        </div>
      </div>
    </div>
  );
}
