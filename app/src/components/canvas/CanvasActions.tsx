import React from 'react';
import type { ActionsComponent, CanvasActionHandler } from '../../api/canvas';

interface CanvasActionsProps {
  data: ActionsComponent;
  canvasId: string;
  onAction?: CanvasActionHandler;
}

const VARIANT_STYLES: Record<string, React.CSSProperties> = {
  primary: {
    background: 'var(--color-primary)',
    color: 'var(--color-bg)',
    border: 'none',
  },
  secondary: {
    background: 'transparent',
    color: 'var(--color-text)',
    border: '1px solid var(--color-bg-subtle)',
  },
  danger: {
    background: 'var(--color-error)',
    color: 'var(--color-bg)',
    border: 'none',
  },
};

const BUTTON_BASE: React.CSSProperties = {
  padding: '10px 18px',
  minHeight: 44,
  borderRadius: 'var(--radius-full)',
  fontSize: '13px',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'var(--transition-fast)',
};

export const CanvasActions = React.memo(function CanvasActions({
  data,
  canvasId,
  onAction,
}: CanvasActionsProps) {
  return (
    <div role="group" aria-label="Actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {data.buttons.map((btn) => {
        const variant = btn.variant ?? 'primary';
        return (
          <button
            key={btn.action}
            type="button"
            onClick={() => onAction?.(canvasId, data.id, btn.action, btn.label)}
            aria-label={btn.label}
            style={{ ...BUTTON_BASE, ...VARIANT_STYLES[variant] }}
          >
            {btn.label}
          </button>
        );
      })}
    </div>
  );
});
