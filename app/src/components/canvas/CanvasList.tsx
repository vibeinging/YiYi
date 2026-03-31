import React from 'react';
import type { ListComponent, ListItem } from '../../api/canvas';

interface CanvasListProps {
  data: ListComponent;
}

const ITEM_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  minHeight: 44,
  borderRadius: 'var(--radius-sm)',
};

const TITLE_STYLE: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 500,
  color: 'var(--color-text)',
};

const SUBTITLE_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
};

const BADGE_STYLE: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--color-primary-subtle)',
  color: 'var(--color-primary)',
  fontSize: 11,
  fontWeight: 500,
  flexShrink: 0,
};

export const CanvasList = React.memo(function CanvasList({ data }: CanvasListProps) {
  return (
    <ul role="list" aria-label="List" style={{ display: 'flex', flexDirection: 'column', gap: 2, listStyle: 'none', margin: 0, padding: 0 }}>
      {data.items.map((item: ListItem, i: number) => (
        <li key={i} style={ITEM_STYLE}>
          {item.icon && (
            <span aria-hidden="true" style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, fontSize: '14px' }}>
              {item.icon}
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={TITLE_STYLE}>{item.title}</div>
            {item.subtitle && <div style={SUBTITLE_STYLE}>{item.subtitle}</div>}
          </div>
          {item.badge && <span style={BADGE_STYLE}>{item.badge}</span>}
        </li>
      ))}
    </ul>
  );
});
