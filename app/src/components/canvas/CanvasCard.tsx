import React from 'react';
import type { CardComponent } from '../../api/canvas';

interface CanvasCardProps {
  data: CardComponent;
}

const CARD_STYLE: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  padding: 10,
  background: 'var(--color-bg-subtle)',
  borderRadius: 'var(--radius-md)',
};

const IMAGE_STYLE: React.CSSProperties = {
  width: 64,
  height: 64,
  maxWidth: '15vw',
  borderRadius: 'var(--radius-sm)',
  objectFit: 'cover',
  flexShrink: 0,
};

const TITLE_STYLE: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '14px',
  color: 'var(--color-text)',
  marginBottom: 2,
};

const DESC_STYLE: React.CSSProperties = {
  fontSize: '13px',
  color: 'var(--color-text-secondary)',
  lineHeight: 1.5,
};

const FOOTER_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  marginTop: 6,
};

const TAG_STYLE: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--color-primary-subtle)',
  color: 'var(--color-primary)',
  fontSize: 11,
  fontWeight: 500,
};

export const CanvasCard = React.memo(function CanvasCard({ data }: CanvasCardProps) {
  const { title, description, image, accent, tags, footer } = data;

  return (
    <article
      aria-label={title}
      style={{
        ...CARD_STYLE,
        borderLeft: accent ? `3px solid ${accent}` : 'none',
      }}
    >
      {image && (
        <img src={image} alt="" aria-hidden="true" style={IMAGE_STYLE} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={TITLE_STYLE}>{title}</div>
        {description && <div style={DESC_STYLE}>{description}</div>}
        {tags && tags.length > 0 && (
          <ul aria-label="Tags" style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap', listStyle: 'none', margin: 0, padding: 0 }}>
            {tags.map((tag, i) => (
              <li key={i} style={TAG_STYLE}>{tag}</li>
            ))}
          </ul>
        )}
        {footer && <div style={FOOTER_STYLE}>{footer}</div>}
      </div>
    </article>
  );
});
