/**
 * FileCard — inline preview for `send_file_to_user` / sent attachments.
 *
 * Two visual modes:
 *   • Image / video / audio — rendered inline inside the message block,
 *     no surrounding card chrome. Action chips appear on hover. The image
 *     IS the message; framing it as a "card" makes it feel like a
 *     separate document floating above the assistant's reply.
 *   • Other types (text head / unsupported) — light card with a row of
 *     compact actions, sized down so it sits comfortably alongside text.
 *
 * `path` may be local (preview lazy-loaded via `read_file_preview`) or a
 * remote URL (rendered with the URL as `src` directly).
 */
import { memo, useCallback, useEffect, useState } from 'react';
import { FolderOpen, ExternalLink, Copy, Check } from 'lucide-react';
import { readFilePreview, openPath, revealPath, type FilePreview } from '../api/agent';
import { Lightbox } from './Lightbox';

export interface SentFile {
  path: string;
  filename: string;
  description?: string;
  size: number;
}

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'];
export const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v'];
export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'ogg'];
const MEDIA_EXTS_SET = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS]);

/** True when `filename` ends in an extension we render inline (image / video / audio). */
export function isMediaFilename(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_EXTS_SET.has(ext);
}

/** True when `mime` indicates inline-renderable media. */
export function isMediaMime(mime: string): boolean {
  return mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/');
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function fileExt(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** OS-native label for "reveal in file manager". Detected once. */
const REVEAL_LABEL: string = (() => {
  const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
  if (/Mac/i.test(ua)) return '访达中显示';
  if (/Windows/i.test(ua)) return '资源管理器中显示';
  return '打开所在文件夹';
})();

function fallbackEmoji(ext: string): string {
  if (['pptx', 'ppt'].includes(ext)) return '📊';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return '📈';
  if (['docx', 'doc'].includes(ext)) return '📝';
  if (ext === 'pdf') return '📄';
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return '🗜️';
  if (['md', 'txt', 'log'].includes(ext)) return '📃';
  return '📎';
}

function urlPreview(url: string, ext: string): FilePreview {
  if (IMAGE_EXTS.includes(ext)) return { kind: 'image', data_uri: url };
  if (VIDEO_EXTS.includes(ext)) return { kind: 'video', data_uri: url };
  if (AUDIO_EXTS.includes(ext)) return { kind: 'audio', data_uri: url };
  return { kind: 'image', data_uri: url };
}

interface Props {
  file: SentFile;
}

export const FileCard = memo(function FileCard({ file }: Props) {
  const ext = fileExt(file.filename || file.path);
  const remote = isUrl(file.path);
  const [preview, setPreview] = useState<FilePreview | null>(
    remote ? urlPreview(file.path, ext) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (remote) return;
    let cancelled = false;
    readFilePreview(file.path)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e) => { if (!cancelled) setError(typeof e === 'string' ? e : 'failed'); });
    return () => { cancelled = true; };
  }, [remote, file.path]);

  const doOpen = useCallback(async () => {
    try {
      if (remote) window.open(file.path, '_blank');
      else await openPath(file.path);
    } catch (err) { console.error('open failed:', err); }
  }, [remote, file.path]);

  const doReveal = useCallback(async () => {
    if (remote) { doOpen(); return; }
    try { await revealPath(file.path); }
    catch (err) { console.error('reveal failed:', err); }
  }, [remote, file.path, doOpen]);

  const doCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (err) { console.error('copy failed:', err); }
  }, [file.path]);

  // Inline media: image, video, audio — no card chrome around the media.
  if (preview && (preview.kind === 'image' || preview.kind === 'video' || preview.kind === 'audio')) {
    return (
      <>
        <InlineMedia
          preview={preview}
          file={file}
          remote={remote}
          copied={copied}
          onZoom={() => preview.kind === 'image' && setLightbox(true)}
          onOpen={doOpen}
          onReveal={doReveal}
          onCopy={doCopyPath}
        />
        {lightbox && preview.kind === 'image' && (
          <Lightbox src={preview.data_uri} alt={file.filename} onClose={() => setLightbox(false)} />
        )}
      </>
    );
  }

  // Card mode (text / unsupported / loading / error) — compact card.
  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        maxWidth: 480,
      }}
    >
      <NonMediaPreview preview={preview} error={error} ext={ext} />
      <div className="px-3.5 pt-2 pb-1">
        <div className="flex items-center gap-2">
          <span
            className="truncate text-[13px] font-semibold"
            style={{ color: 'var(--color-text)' }}
            title={file.filename}
          >
            {file.filename}
          </span>
          <span
            className="shrink-0 text-[10.5px] tabular-nums"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {file.size > 0 ? formatSize(file.size) : remote ? 'remote' : ''}
          </span>
        </div>
        {file.description && (
          <div className="text-[12px] mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            {file.description}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderTop: '1px solid var(--color-border)' }}>
        <ActionButton onClick={doOpen} icon={<ExternalLink size={11} />}>{remote ? '在浏览器打开' : '打开'}</ActionButton>
        {!remote && <ActionButton onClick={doReveal} icon={<FolderOpen size={11} />}>{REVEAL_LABEL}</ActionButton>}
        <ActionButton onClick={doCopyPath} icon={copied ? <Check size={11} /> : <Copy size={11} />}>
          {copied ? '已复制' : remote ? '复制链接' : '复制路径'}
        </ActionButton>
      </div>
    </div>
  );
});

function InlineMedia({
  preview,
  file,
  remote,
  copied,
  onZoom,
  onOpen,
  onReveal,
  onCopy,
}: {
  preview: Extract<FilePreview, { kind: 'image' | 'video' | 'audio' }>;
  file: SentFile;
  remote: boolean;
  copied: boolean;
  onZoom: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onCopy: () => void;
}) {
  return (
    <figure className="group relative inline-block max-w-full" style={{ margin: 0 }}>
      {preview.kind === 'image' && (
        <button
          onClick={onZoom}
          className="block rounded-xl overflow-hidden"
          style={{ cursor: 'zoom-in', maxWidth: '100%', background: 'transparent', padding: 0, border: 0 }}
        >
          <img
            src={preview.data_uri}
            alt={file.filename}
            className="block"
            style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 12 }}
          />
        </button>
      )}
      {preview.kind === 'video' && (
        <video
          src={preview.data_uri}
          controls
          className="block rounded-xl"
          style={{ maxWidth: '100%', maxHeight: 360, background: '#000' }}
        />
      )}
      {preview.kind === 'audio' && (
        <audio src={preview.data_uri} controls className="block" style={{ maxWidth: '100%' }} />
      )}

      {/* Overlay action chips (top-right of media), reveal on hover. */}
      <div
        className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', borderRadius: 8, padding: '3px 4px' }}
      >
        <Chip onClick={onOpen} title={remote ? '在浏览器打开' : '打开'}>
          <ExternalLink size={11} />
        </Chip>
        {!remote && (
          <Chip onClick={onReveal} title={REVEAL_LABEL}>
            <FolderOpen size={11} />
          </Chip>
        )}
        <Chip onClick={onCopy} title={remote ? '复制链接' : '复制路径'}>
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </Chip>
      </div>

      {(file.description || file.filename) && (
        <figcaption
          className="mt-1 text-[11px] leading-snug"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {file.description || file.filename}
          {file.size > 0 && (
            <span className="ml-2 tabular-nums" style={{ opacity: 0.7 }}>
              {formatSize(file.size)}
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}

function NonMediaPreview({
  preview,
  error,
  ext,
}: {
  preview: FilePreview | null;
  error: string | null;
  ext: string;
}) {
  const wrap: React.CSSProperties = {
    background: 'var(--color-bg-subtle)',
    borderBottom: '1px solid var(--color-border)',
  };
  if (error) {
    return (
      <div className="flex items-center gap-3 px-4 py-3" style={wrap}>
        <span style={{ fontSize: 28 }}>{fallbackEmoji(ext)}</span>
        <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
          预览不可用 · {error}
        </div>
      </div>
    );
  }
  if (!preview) {
    return (
      <div className="flex items-center justify-center text-[11px]" style={{ ...wrap, height: 90, color: 'var(--color-text-tertiary)' }}>
        加载中…
      </div>
    );
  }
  if (preview.kind === 'text') {
    return (
      <div style={wrap}>
        <pre
          className="px-4 py-3 text-[11.5px] overflow-auto"
          style={{
            margin: 0,
            maxHeight: 220,
            color: 'var(--color-text-secondary)',
            fontFamily: 'var(--font-mono)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {preview.content}
          {preview.truncated && (
            <div className="mt-2 text-[10.5px]" style={{ color: 'var(--color-text-muted)' }}>
              … 已截断（仅展示前 64 KB）
            </div>
          )}
        </pre>
      </div>
    );
  }
  // unsupported
  return (
    <div className="flex items-center gap-3 px-4 py-3" style={wrap}>
      <span style={{ fontSize: 28 }}>{fallbackEmoji(ext)}</span>
      <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
        {ext.toUpperCase() || 'FILE'} · 无内嵌预览
      </div>
    </div>
  );
}

function Chip({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-6 h-6 flex items-center justify-center rounded-md transition-colors"
      style={{ color: '#fff', background: 'transparent' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

function ActionButton({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 text-[11.5px] px-2 py-1 rounded-md transition-colors"
      style={{ color: 'var(--color-text-secondary)', background: 'transparent' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon}
      {children}
    </button>
  );
}

export default FileCard;
