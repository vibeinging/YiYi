import React from 'react';
import { Check, Loader2, X, Circle } from 'lucide-react';
import type { StatusComponent, StatusStep } from '../../api/canvas';

interface CanvasStatusProps {
  data: StatusComponent;
}

const STEP_CONFIG: Record<string, { icon: React.ReactNode; color: string; alt: string }> = {
  done: { icon: <Check size={14} />, color: 'var(--color-success)', alt: 'Completed' },
  running: { icon: <Loader2 size={14} className="animate-spin" />, color: 'var(--color-primary)', alt: 'In progress' },
  error: { icon: <X size={14} />, color: 'var(--color-error)', alt: 'Failed' },
  pending: { icon: <Circle size={14} />, color: 'var(--color-text-muted)', alt: 'Pending' },
};

const DETAIL_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  marginTop: 1,
};

export const CanvasStatus = React.memo(function CanvasStatus({ data }: CanvasStatusProps) {
  return (
    <ol role="list" aria-label="Progress steps" style={{ display: 'flex', flexDirection: 'column', gap: 2, listStyle: 'none', margin: 0, padding: 0 }}>
      {data.steps.map((step: StatusStep, i: number) => {
        const cfg = STEP_CONFIG[step.status] ?? STEP_CONFIG.pending;
        const isLast = i === data.steps.length - 1;
        return (
          <li key={i} role="listitem" aria-label={`${step.label}: ${cfg.alt}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 20 }}>
              <div
                aria-hidden="true"
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: step.status === 'done' ? cfg.color : 'transparent',
                  border: `2px solid ${cfg.color}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: step.status === 'done' ? 'var(--color-bg)' : cfg.color,
                  flexShrink: 0,
                }}
              >
                {cfg.icon}
              </div>
              {!isLast && <div style={{ width: 2, height: 20, background: 'var(--color-bg-muted)' }} />}
            </div>
            <div style={{ paddingBottom: isLast ? 0 : 8, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text)' }}>{step.label}</div>
              {step.detail && <div style={DETAIL_STYLE}>{step.detail}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
});
