/**
 * FileCard — inline card rendered in the chat stream when the agent invokes
 * `send_file_to_user`. Mirrors the TaskCard pattern: reads `__type = file_sent`
 * JSON out of the tool result, presents a persistent clickable entry.
 *
 * Interaction model — "a sheet of paper the agent just handed you":
 *   • arrival: spring-in with a tiny tilt, settles into place
 *   • hover: 3D tilt following the cursor + light sheen sweep
 *   • click: open file
 *   • Alt + click: copy absolute path (pulse feedback)
 *   • Cmd/Ctrl + click OR folder button: reveal in Finder
 *   • right-click: contextual menu (打开 / 访达 / 复制路径)
 *   • keyboard: Enter = open, Cmd+Enter = reveal, Cmd+C = copy path
 *   • icon shows a radial ring sized to the file (0–10MB)
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, ExternalLink, Copy, Check } from 'lucide-react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';

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
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState<{ rx: number; ry: number; sheen: number }>({
    rx: 0,
    ry: 0,
    sheen: 50,
  });
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const doOpen = useCallback(async () => {
    try { await shellOpen(file.path); }
    catch (err) { console.error('Failed to open file:', err); }
  }, [file.path]);

  const doReveal = useCallback(async () => {
    try { await shellOpen(file.path.replace(/[^/]+$/, '')); }
    catch (err) { console.error('Failed to reveal file:', err); }
  }, [file.path]);

  const doCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  }, [file.path]);

  // Unified click — Alt = copy path, Cmd/Ctrl = reveal, default = open
  const handleClick = (e: React.MouseEvent) => {
    if (e.altKey) {
      e.preventDefault();
      doCopyPath();
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      doReveal();
      return;
    }
    doOpen();
  };

  const handleMove = (e: React.MouseEvent) => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    setTilt({
      rx: (py - 0.5) * -3.5,
      ry: (px - 0.5) * 6,
      sheen: Math.round(px * 100),
    });
  };

  const handleLeave = () => setTilt({ rx: 0, ry: 0, sheen: 50 });

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doReveal();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      doOpen();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      doCopyPath();
    }
  };

  // Dismiss context menu on outside click / escape
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);

  // Radial size ring — full circle at 10MB
  const RING_R = 22;
  const ringC = 2 * Math.PI * RING_R;
  const sizePct = Math.min(1, file.size / (10 * 1024 * 1024));
  const ringDash = ringC * sizePct;

  const emoji = extIcon(file.filename);

  return (
    <div className="relative" style={{ perspective: 900, maxWidth: 460 }}>
      <div
        ref={cardRef}
        role="button"
        tabIndex={0}
        aria-label={`文件 ${file.filename}，${formatSize(file.size)}。回车打开，⌘回车在访达显示，⌘C 复制路径`}
        onClick={handleClick}
        onKeyDown={handleKey}
        onContextMenu={handleContextMenu}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        className="filecard group relative w-full text-left rounded-2xl overflow-hidden outline-none"
        style={{
          background:
            'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 11%, var(--color-bg-elevated)) 0%, color-mix(in srgb, var(--color-primary) 3%, var(--color-bg-elevated)) 100%)',
          border: '1px solid color-mix(in srgb, var(--color-primary) 28%, transparent)',
          boxShadow:
            tilt.rx === 0 && tilt.ry === 0
              ? '0 1px 2px rgba(0,0,0,0.06)'
              : '0 14px 30px color-mix(in srgb, var(--color-primary) 18%, transparent), 0 2px 4px rgba(0,0,0,0.12)',
          transform: `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg) translateZ(0)`,
          transformStyle: 'preserve-3d',
          transition:
            tilt.rx === 0 && tilt.ry === 0
              ? 'transform 0.35s cubic-bezier(0.2, 0.9, 0.25, 1.1), box-shadow 0.3s ease'
              : 'box-shadow 0.2s ease',
          animation: 'filecard-in 0.55s cubic-bezier(0.2, 0.9, 0.25, 1.1) both',
          cursor: 'pointer',
        }}
        title="点击打开 · Alt+点击 复制路径 · 右键更多"
      >
        {/* Corner decoration — a dog-eared paper fold, subtly keyed off primary */}
        <span
          aria-hidden
          className="absolute right-0 top-0 pointer-events-none"
          style={{
            width: 18,
            height: 18,
            background:
              'linear-gradient(225deg, color-mix(in srgb, var(--color-primary) 25%, transparent) 0%, color-mix(in srgb, var(--color-primary) 8%, transparent) 50%, transparent 51%)',
            borderBottomLeftRadius: 4,
          }}
        />

        {/* Radial glow */}
        <span
          aria-hidden
          className="absolute -right-10 -top-10 w-28 h-28 rounded-full pointer-events-none"
          style={{
            background:
              'radial-gradient(circle, color-mix(in srgb, var(--color-primary) 22%, transparent) 0%, transparent 70%)',
            opacity: 0.6,
          }}
        />

        {/* Moving sheen — only visible on hover, tracks cursor */}
        <span
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
          style={{
            background: `linear-gradient(${105}deg, transparent ${Math.max(
              0,
              tilt.sheen - 15,
            )}%, rgba(255,255,255,0.14) ${tilt.sheen}%, transparent ${Math.min(
              100,
              tilt.sheen + 15,
            )}%)`,
            mixBlendMode: 'overlay',
          }}
        />

        <div className="relative flex items-center gap-3 p-3.5">
          {/* File icon + radial size ring */}
          <div className="relative shrink-0" style={{ width: 48, height: 48 }}>
            <svg
              width={48}
              height={48}
              className="absolute inset-0 pointer-events-none"
              viewBox="0 0 48 48"
              aria-hidden
            >
              <circle
                cx={24}
                cy={24}
                r={RING_R}
                fill="none"
                stroke="color-mix(in srgb, var(--color-primary) 18%, transparent)"
                strokeWidth={1.5}
              />
              <circle
                cx={24}
                cy={24}
                r={RING_R}
                fill="none"
                stroke="var(--color-primary)"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeDasharray={`${ringDash} ${ringC}`}
                transform="rotate(-90 24 24)"
                style={{ transition: 'stroke-dasharray 0.4s ease' }}
              />
            </svg>
            <div
              className="absolute inset-[5px] rounded-xl flex items-center justify-center"
              style={{
                background:
                  'linear-gradient(135deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 65%, transparent))',
                boxShadow:
                  '0 2px 10px color-mix(in srgb, var(--color-primary) 40%, transparent), inset 0 1px 0 rgba(255,255,255,0.22)',
                fontSize: 19,
              }}
            >
              {emoji !== '📎' ? (
                <span style={{ filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.2))' }}>{emoji}</span>
              ) : (
                <FileText size={18} style={{ color: '#fff' }} />
              )}
            </div>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span
                className="truncate text-[13.5px] font-semibold tracking-[-0.01em]"
                style={{ color: 'var(--color-text)' }}
                title={file.filename}
              >
                {file.filename}
              </span>
              <span
                className="shrink-0 text-[10px] font-semibold tabular-nums px-1.5 py-[1px] rounded-md"
                style={{
                  color: 'var(--color-text-secondary)',
                  background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)',
                }}
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
            <ActionBubble
              onClick={(e) => {
                e.stopPropagation();
                doReveal();
              }}
              title="在访达中显示 (⌘ + 点击卡片)"
            >
              <FolderOpen size={12} />
            </ActionBubble>
            <ActionBubble
              onClick={(e) => {
                e.stopPropagation();
                doCopyPath();
              }}
              title="复制路径 (Alt + 点击卡片)"
            >
              {copied ? (
                <Check size={12} className="filecard-check-in" />
              ) : (
                <Copy size={12} />
              )}
            </ActionBubble>
            <span
              className="w-7 h-7 rounded-full flex items-center justify-center transition-transform group-hover:translate-x-0.5"
              style={{
                background: 'color-mix(in srgb, var(--color-primary) 16%, transparent)',
                color: 'var(--color-primary)',
              }}
              aria-hidden
            >
              <ExternalLink size={12} />
            </span>
          </div>
        </div>

        {/* Copied toast floats above the card */}
        {copied && (
          <div
            className="absolute left-1/2 -translate-x-1/2 top-2 pointer-events-none"
            style={{
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: 600,
              borderRadius: 999,
              background: 'var(--color-primary)',
              color: '#fff',
              boxShadow: '0 6px 16px color-mix(in srgb, var(--color-primary) 45%, transparent)',
              animation: 'filecard-toast 1.4s ease forwards',
            }}
          >
            已复制路径
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onAction={(action) => {
            setMenu(null);
            if (action === 'open') doOpen();
            else if (action === 'reveal') doReveal();
            else if (action === 'copy') doCopyPath();
          }}
        />
      )}

      <style>{`
        @keyframes filecard-in {
          0%   { opacity: 0; transform: translateY(8px) rotate(-1.2deg) scale(0.985); }
          60%  { opacity: 1; transform: translateY(-1px) rotate(0.3deg) scale(1.005); }
          100% { opacity: 1; transform: translateY(0) rotate(0) scale(1); }
        }
        @keyframes filecard-toast {
          0%   { opacity: 0; transform: translate(-50%, 4px); }
          15%  { opacity: 1; transform: translate(-50%, 0); }
          80%  { opacity: 1; transform: translate(-50%, 0); }
          100% { opacity: 0; transform: translate(-50%, -4px); }
        }
        .filecard-check-in {
          animation: filecard-check 0.35s cubic-bezier(0.2, 0.9, 0.25, 1.1);
        }
        @keyframes filecard-check {
          0%   { transform: scale(0.4) rotate(-20deg); opacity: 0; }
          100% { transform: scale(1) rotate(0); opacity: 1; }
        }
        .filecard:focus-visible {
          box-shadow:
            0 0 0 2px var(--color-bg),
            0 0 0 4px var(--color-primary),
            0 14px 30px color-mix(in srgb, var(--color-primary) 18%, transparent) !important;
        }
      `}</style>
    </div>
  );
});

/** Small circular icon button used in the action row. */
function ActionBubble({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title: string;
}) {
  return (
    <span
      role="button"
      tabIndex={-1}
      onClick={onClick}
      className="w-7 h-7 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-95"
      style={{
        background: 'color-mix(in srgb, var(--color-primary) 16%, transparent)',
        color: 'var(--color-primary)',
      }}
      title={title}
    >
      {children}
    </span>
  );
}

/** Floating context menu positioned at (x, y), viewport-clamped. */
function ContextMenu({
  x,
  y,
  onAction,
}: {
  x: number;
  y: number;
  onAction: (a: 'open' | 'reveal' | 'copy') => void;
}) {
  const W = 180;
  const H = 120;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-[9999] py-1"
      style={{
        left,
        top,
        width: W,
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border-strong, rgba(0,0,0,0.12))',
        borderRadius: 10,
        boxShadow: '0 12px 36px rgba(0,0,0,0.22)',
        backdropFilter: 'blur(18px)',
        animation: 'filecard-in 0.18s ease-out',
      }}
    >
      <MenuItem onClick={() => onAction('open')}>
        <ExternalLink size={12} /> 打开
      </MenuItem>
      <MenuItem onClick={() => onAction('reveal')}>
        <FolderOpen size={12} /> 在访达中显示
      </MenuItem>
      <div style={{ height: 1, background: 'var(--color-border)', margin: '4px 6px' }} />
      <MenuItem onClick={() => onAction('copy')}>
        <Copy size={12} /> 复制路径
      </MenuItem>
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-left transition-colors hover:bg-black/5 dark:hover:bg-white/10"
      style={{ color: 'var(--color-text)', background: 'transparent', border: 'none' }}
    >
      {children}
    </button>
  );
}

export default FileCard;
