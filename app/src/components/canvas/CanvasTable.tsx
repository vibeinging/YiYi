import React from 'react';
import type { TableComponent } from '../../api/canvas';

interface CanvasTableProps {
  data: TableComponent;
}

const WRAPPER_STYLE: React.CSSProperties = {
  overflowX: 'auto',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-bg-subtle)',
  fontSize: '13px',
};

const TH_STYLE: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  borderBottom: '1px solid var(--color-bg-subtle)',
  background: 'var(--color-bg-subtle)',
  whiteSpace: 'nowrap',
};

const TD_STYLE: React.CSSProperties = {
  padding: '8px 12px',
  color: 'var(--color-text)',
  whiteSpace: 'nowrap',
  maxWidth: 200,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export const CanvasTable = React.memo(function CanvasTable({ data }: CanvasTableProps) {
  const { headers, rows } = data;

  return (
    <div style={WRAPPER_STYLE}>
      <table aria-label="Data table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} scope="col" style={TH_STYLE}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ borderBottom: ri < rows.length - 1 ? '1px solid var(--color-bg-subtle)' : 'none' }}>
              {row.map((cell, ci) => (
                <td key={ci} style={TD_STYLE} title={typeof cell === 'string' ? cell : undefined}>
                  {formatCell(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
