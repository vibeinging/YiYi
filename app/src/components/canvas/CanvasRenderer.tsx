import React from 'react';
import type {
  CanvasComponent,
  CanvasActionHandler,
  CardComponent,
  StatusComponent,
  TableComponent,
  ActionsComponent,
  ListComponent,
  FormComponent,
} from '../../api/canvas';
import { CanvasCard } from './CanvasCard';
import { CanvasStatus } from './CanvasStatus';
import { CanvasTable } from './CanvasTable';
import { CanvasActions } from './CanvasActions';
import { CanvasList } from './CanvasList';
import { CanvasForm } from './CanvasForm';

interface CanvasRendererProps {
  canvasId: string;
  title?: string;
  components: CanvasComponent[];
  onAction?: CanvasActionHandler;
}

const WRAPPER_STYLE: React.CSSProperties = {
  borderRadius: 'var(--radius-lg)',
  background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border)',
  overflow: 'hidden',
  boxShadow: 'var(--shadow-sm)',
  maxWidth: '100%',
};

const TITLE_STYLE: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--color-bg-subtle)',
  fontWeight: 600,
  fontSize: '14px',
  color: 'var(--color-text)',
};

const BODY_STYLE: React.CSSProperties = {
  padding: '12px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

export const CanvasRenderer = React.memo(function CanvasRenderer({
  canvasId,
  title,
  components,
  onAction,
}: CanvasRendererProps) {
  return (
    <div role="region" aria-label={title ?? 'Canvas'} style={WRAPPER_STYLE}>
      {title && <h3 style={TITLE_STYLE}>{title}</h3>}
      <div style={BODY_STYLE}>
        {components.map((comp, i) => {
          const key = comp.id ?? `${comp.type}-${i}`;
          switch (comp.type) {
            case 'card':
              return <CanvasCard key={key} data={comp as CardComponent} />;
            case 'status':
              return <CanvasStatus key={key} data={comp as StatusComponent} />;
            case 'table':
              return <CanvasTable key={key} data={comp as TableComponent} />;
            case 'actions':
              return (
                <CanvasActions
                  key={key}
                  data={comp as ActionsComponent}
                  canvasId={canvasId}
                  onAction={onAction}
                />
              );
            case 'list':
              return <CanvasList key={key} data={comp as ListComponent} />;
            case 'form':
              return (
                <CanvasForm
                  key={key}
                  data={comp as FormComponent}
                  canvasId={canvasId}
                  onAction={onAction}
                />
              );
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
});
