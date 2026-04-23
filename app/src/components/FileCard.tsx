/**
 * FileCard — inline card rendered in the chat stream when the agent invokes
 * `send_file_to_user`. Mirrors the TaskCard pattern: reads `__type = file_sent`
 * JSON out of the tool result, presents a persistent clickable entry.
 *
 * Click anywhere → reveal the file in Finder via the shell plugin.
 */
import { memo } from 'react';
import { FileText, FolderOpen, ExternalLink } from 'lucide-react';

export interface SentFile {
  path: string;
  filename: string;
  description?: string;
  size: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (['pptx', 'ppt'].includes(ext)) return '📊';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return '📈';
  if (['docx', 'doc'].includes(ext)) return '📝';
  if (['pdf'].includes(ext)) return '📄';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return '🖼️';
  if (['zip', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (['md', 'txt'].includes(ext)) return '📃';
  return '📎';
}

interface Props {
  file: SentFile;
}

export const FileCard = memo(function FileCard({ file }: Props) {
  const handleOpen = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(file.path);
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  };

  const handleReveal = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      const dir = file.path.replace(/[^/]+$/, '');
      await open(dir);
    } catch (err) {
      console.error('Failed to reveal file:', err);
    }
  };

  return (
    <button
      onClick={handleOpen}
      className="group relative w-full text-left rounded-2xl overflow-hidden transition-all"
      style={{
        background:
          'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-elevated)) 0%, color-mix(in srgb, var(--color-primary) 3%, var(--color-bg-elevated)) 100%)',
        border: '1px solid color-mix(in srgb, var(--color-primary) 28%, transparent)',
        maxWidth: '460px',
        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow =
          '0 6px 18px color-mix(in srgb, var(--color-primary) 15%, transparent), 0 1px 2px rgba(0,0,0,0.1)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
      }}
      title="点击打开"
    >
      <span
        aria-hidden
        className="absolute -right-10 -top-10 w-28 h-28 rounded-full pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, color-mix(in srgb, var(--color-primary) 22%, transparent) 0%, transparent 70%)',
          opacity: 0.6,
        }}
      />

      <div className="relative flex items-center gap-3 p-3.5">
        {/* File icon pill */}
        <div
          className="shrink-0 w-11 h-11 rounded-xl flex items-center justify-center"
          style={{
            background:
              'linear-gradient(135deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 70%, transparent))',
            boxShadow: '0 2px 8px color-mix(in srgb, var(--color-primary) 40%, transparent)',
            fontSize: 20,
          }}
        >
          {extIcon(file.filename) !== '📎' ? (
            <span>{extIcon(file.filename)}</span>
          ) : (
            <FileText size={18} style={{ color: '#fff' }} />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="truncate text-[13.5px] font-semibold"
              style={{ color: 'var(--color-text)' }}
              title={file.filename}
            >
              {file.filename}
            </span>
            <span
              className="shrink-0 text-[10px] font-semibold tabular-nums"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {formatSize(file.size)}
            </span>
          </div>
          {file.description ? (
            <div
              className="text-[11.5px] mt-0.5 truncate"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {file.description}
            </div>
          ) : (
            <div
              className="text-[11px] mt-0.5 truncate font-mono"
              style={{ color: 'var(--color-text-muted)' }}
              title={file.path}
            >
              {file.path}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <span
            role="button"
            onClick={handleReveal}
            className="w-7 h-7 rounded-full flex items-center justify-center transition-all hover:scale-105"
            style={{
              background: 'color-mix(in srgb, var(--color-primary) 16%, transparent)',
              color: 'var(--color-primary)',
            }}
            title="在访达中显示"
          >
            <FolderOpen size={12} />
          </span>
          <span
            className="w-7 h-7 rounded-full flex items-center justify-center transition-transform group-hover:translate-x-0.5"
            style={{
              background: 'color-mix(in srgb, var(--color-primary) 16%, transparent)',
              color: 'var(--color-primary)',
            }}
          >
            <ExternalLink size={12} />
          </span>
        </div>
      </div>
    </button>
  );
});

export default FileCard;
