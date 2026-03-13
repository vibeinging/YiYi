/**
 * LongTaskPanel — Progress panel for long-running auto-continue tasks.
 *
 * Displays round progress, token usage, estimated cost, and elapsed time.
 * Follows the same elevated-card + chevron-collapse pattern as ToolCallPanel.
 */

import { memo, useState, useEffect, useRef } from 'react';
import {
  Infinity as InfinityIcon,
  Loader2,
  CheckCircle2,
  PauseCircle,
  XCircle,
  ChevronRight,
  Coins,
  Timer,
  Hash,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChatStreamStore, type LongTaskState, type StopReason } from '../stores/chatStreamStore';

/* ── Helpers ── */

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return '';
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return `${mins}m ${rem}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const STATUS_CONFIG: Record<string, {
  label: string;
  labelKey: string;
  color: string;
  icon: typeof Loader2;
  animate?: boolean;
}> = {
  running:   { label: 'Running',   labelKey: 'longTask.running',   color: 'var(--color-primary)', icon: Loader2, animate: true },
  paused:    { label: 'Paused',    labelKey: 'longTask.paused',    color: 'var(--color-warning)', icon: PauseCircle },
  completed: { label: 'Completed', labelKey: 'longTask.completed', color: 'var(--color-success)', icon: CheckCircle2 },
  stopped:   { label: 'Stopped',   labelKey: 'longTask.stopped',   color: 'var(--color-error)',   icon: XCircle },
};

const STOP_REASON_KEYS: Record<StopReason, string> = {
  task_complete:    'longTask.reason.taskComplete',
  max_rounds:       'longTask.reason.maxRounds',
  budget_exhausted: 'longTask.reason.budgetExhausted',
  user_cancelled:   'longTask.reason.userCancelled',
  error:            'longTask.reason.error',
};

/* ── Stop Reason Badge ── */

function StopReasonBadge({ reason }: { reason: StopReason }) {
  const { t } = useTranslation();
  const isSuccess = reason === 'task_complete';
  return (
    <div
      style={{
        marginTop: '6px',
        padding: '4px 8px',
        borderRadius: 'var(--radius-sm)',
        background: isSuccess
          ? 'color-mix(in srgb, var(--color-success) 8%, transparent)'
          : 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
        fontSize: '11px',
        color: isSuccess ? 'var(--color-success)' : 'var(--color-text-secondary)',
        fontFamily: 'var(--font-text)',
      }}
    >
      {t(STOP_REASON_KEYS[reason])}
    </div>
  );
}

/* ── Round Divider ── */

export function RoundDivider({ round, maxRounds }: { round: number; maxRounds: number }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-3 px-4 py-2"
      style={{ animation: 'fadeSlideIn 0.2s ease-out' }}
    >
      <div
        className="flex-1"
        style={{ height: '1px', background: 'var(--color-border)' }}
      />
      <span
        style={{
          fontSize: '10px',
          fontWeight: 600,
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-text-muted)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        {t('longTask.round')} {round} / {maxRounds}
      </span>
      <div
        className="flex-1"
        style={{ height: '1px', background: 'var(--color-border)' }}
      />
    </div>
  );
}

/* ── Main Progress Panel ── */

export const LongTaskProgressPanel = memo(function LongTaskProgressPanel() {
  const { t } = useTranslation();
  const longTask = useChatStreamStore((s) => s.longTask);
  const [collapsed, setCollapsed] = useState(false);
  const [elapsed, setElapsed] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Update elapsed time every second while running
  useEffect(() => {
    if (longTask.status === 'running' && longTask.startedAt) {
      setElapsed(formatElapsed(longTask.startedAt));
      timerRef.current = setInterval(() => {
        setElapsed(formatElapsed(longTask.startedAt));
      }, 1000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    } else if (longTask.startedAt) {
      setElapsed(formatElapsed(longTask.startedAt));
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [longTask.status, longTask.startedAt]);

  if (longTask.status === 'idle') return null;

  const cfg = STATUS_CONFIG[longTask.status] || STATUS_CONFIG.running;
  const StatusIcon = cfg.icon;
  const progress = longTask.maxRounds > 0
    ? Math.round((longTask.currentRound / longTask.maxRounds) * 100)
    : 0;
  const isTerminal = longTask.status === 'completed' || longTask.status === 'stopped';

  return (
    <div
      className="animate-slide-up"
      style={{
        borderRadius: '12px',
        background: 'var(--color-bg-elevated)',
        border: `1px solid ${
          longTask.status === 'running'
            ? 'color-mix(in srgb, var(--color-primary) 25%, var(--color-border))'
            : 'var(--color-border)'
        }`,
        overflow: 'hidden',
        transition: 'border-color 0.3s ease',
      }}
    >
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-bg-muted)]"
        onClick={() => setCollapsed((p) => !p)}
        style={{ background: 'transparent', transition: 'background 0.15s' }}
      >
        <ChevronRight
          size={11}
          style={{
            transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            transition: 'transform 0.2s',
            color: 'var(--color-text-muted)',
          }}
        />

        {isTerminal ? (
          <StatusIcon size={13} style={{ color: cfg.color }} />
        ) : (
          <InfinityIcon size={13} style={{ color: cfg.color }} />
        )}

        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--color-text)',
            fontFamily: 'var(--font-text)',
          }}
        >
          {t('longTask.title')}
        </span>

        {/* Status badge */}
        <span
          style={{
            fontSize: '10px',
            fontWeight: 600,
            padding: '1px 6px',
            borderRadius: 'var(--radius-full)',
            background: `color-mix(in srgb, ${cfg.color} 12%, transparent)`,
            color: cfg.color,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {t(cfg.labelKey)}
        </span>

        <div className="flex-1" />

        {/* Right-side summary */}
        <div className="flex items-center gap-2 shrink-0">
          {!isTerminal && (
            <span
              style={{
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-muted)',
                fontWeight: 500,
              }}
            >
              {t('longTask.round')} {longTask.currentRound}/{longTask.maxRounds}
            </span>
          )}
          {isTerminal && (
            <span
              style={{
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-muted)',
                fontWeight: 500,
              }}
            >
              {longTask.currentRound} {t('longTask.rounds')}
            </span>
          )}
          <span
            style={{
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-text-muted)',
              fontWeight: 500,
            }}
          >
            {formatCost(longTask.estimatedCostUsd)}
          </span>
          {cfg.animate ? (
            <Loader2
              size={12}
              className="animate-spin"
              style={{ color: cfg.color }}
            />
          ) : (
            <StatusIcon size={12} style={{ color: cfg.color }} />
          )}
        </div>
      </button>

      {/* Body */}
      <div
        style={{
          maxHeight: collapsed ? '0px' : '200px',
          opacity: collapsed ? 0 : 1,
          overflow: 'hidden',
          transition: 'max-height 0.25s ease, opacity 0.2s ease',
        }}
      >
        <div style={{ padding: '0 12px 10px', borderTop: '1px solid var(--color-border)' }}>
          {/* Progress bar */}
          {!isTerminal && (
            <div style={{ padding: '8px 0 6px' }}>
              <div
                style={{
                  height: '4px',
                  borderRadius: '2px',
                  background: 'var(--color-bg-muted)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${progress}%`,
                    borderRadius: '2px',
                    background: 'linear-gradient(90deg, var(--color-primary), var(--color-accent))',
                    transition: 'width 0.5s ease',
                  }}
                />
              </div>
            </div>
          )}

          {/* Stats row */}
          <div
            className="flex items-center gap-4 flex-wrap"
            style={{ paddingTop: isTerminal ? '8px' : '0' }}
          >
            {/* Rounds */}
            <div className="flex items-center gap-1.5">
              <Hash size={11} style={{ color: 'var(--color-text-muted)' }} />
              <span
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {longTask.currentRound} / {longTask.maxRounds} {t('longTask.rounds')}
              </span>
            </div>

            {/* Tokens */}
            <div className="flex items-center gap-1.5">
              <Coins size={11} style={{ color: 'var(--color-text-muted)' }} />
              <span
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {formatTokens(longTask.tokensUsed)} / {formatTokens(longTask.tokenBudget)} tokens
              </span>
            </div>

            {/* Cost */}
            <div className="flex items-center gap-1.5">
              <span
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color:
                    longTask.budgetCostUsd > 0 && longTask.estimatedCostUsd / longTask.budgetCostUsd > 0.8
                      ? 'var(--color-warning)'
                      : 'var(--color-text-secondary)',
                  fontWeight:
                    longTask.budgetCostUsd > 0 && longTask.estimatedCostUsd / longTask.budgetCostUsd > 0.8
                      ? 600
                      : 400,
                }}
              >
                {formatCost(longTask.estimatedCostUsd)} / {formatCost(longTask.budgetCostUsd)}
              </span>
            </div>

            {/* Elapsed */}
            {longTask.startedAt && (
              <div className="flex items-center gap-1.5">
                <Timer size={11} style={{ color: 'var(--color-text-muted)' }} />
                <span
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {elapsed}
                </span>
              </div>
            )}
          </div>

          {/* Stop reason */}
          {isTerminal && longTask.stopReason && (
            <StopReasonBadge reason={longTask.stopReason} />
          )}
        </div>
      </div>
    </div>
  );
});

export default LongTaskProgressPanel;
