/**
 * ToolArtifactCard — inline image card for tool-produced visual artifacts
 * (screenshots, generated images, charts).
 *
 * Lazy-loads the image via `read_artifact_data_uri` Tauri command (path is
 * stored as a relative reference, not the bytes themselves).
 *
 * Click to expand to a fullscreen modal preview.
 */

import { memo, useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { readArtifactDataUri, type ToolArtifact } from '../api/agent';
import { Lightbox } from './Lightbox';

interface Props {
  artifact: ToolArtifact;
}

export const ToolArtifactCard = memo(function ToolArtifactCard({ artifact }: Props) {
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readArtifactDataUri(artifact.path, artifact.mime_type)
      .then((uri) => {
        if (!cancelled) setDataUri(uri);
      })
      .catch((e) => {
        if (!cancelled) setError(typeof e === 'string' ? e : 'failed to read');
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.path, artifact.mime_type]);

  if (error) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-xl text-[12px]"
        style={{
          background: 'var(--color-bg-subtle)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-text-muted)',
        }}
      >
        <ImageOff size={14} />
        <span>{artifact.name} — {error}</span>
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => dataUri && setOpen(true)}
        className="block rounded-xl overflow-hidden transition-all duration-200"
        style={{
          background: 'var(--color-bg-subtle)',
          border: '1px solid var(--color-border)',
          maxWidth: '320px',
          cursor: dataUri ? 'zoom-in' : 'default',
        }}
        onMouseEnter={(e) => {
          if (dataUri) e.currentTarget.style.borderColor = 'var(--color-border-strong)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'var(--color-border)';
        }}
      >
        {dataUri ? (
          <img
            src={dataUri}
            alt={artifact.name}
            className="block max-w-full"
            style={{ maxHeight: '240px', display: 'block' }}
          />
        ) : (
          <div
            className="flex items-center justify-center"
            style={{ width: 240, height: 160, color: 'var(--color-text-tertiary)' }}
          >
            <span className="text-[11px]">Loading…</span>
          </div>
        )}
        <div
          className="px-3 py-1.5 text-[11px] truncate"
          style={{
            color: 'var(--color-text-muted)',
            borderTop: '1px solid var(--color-border)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {artifact.name}
        </div>
      </button>

      {open && dataUri && (
        <Lightbox src={dataUri} alt={artifact.name} onClose={() => setOpen(false)} />
      )}
    </>
  );
});

export default ToolArtifactCard;
