/**
 * Image lightbox with zoom & pan + native gesture support.
 *
 * Mouse / keyboard:
 *   • wheel — zoom toward cursor (mouse w/o trackpad falls here)
 *   • drag (mouse) — pan when zoomed in
 *   • double-click — toggle 1× ↔ 2.5× at cursor
 *   • +/- — zoom 1.25× / 0.8×
 *   • 0 — reset to fit
 *   • Esc / click backdrop — close
 *
 * Trackpad (macOS / multi-touch trackpads):
 *   • pinch — fine-grained zoom toward cursor (browsers surface this as
 *     `wheel` events with `ctrlKey: true`)
 *   • two-finger swipe — pan when zoomed in (`wheel` without ctrlKey,
 *     deltaX/deltaY routed to translation instead of zoom)
 *
 * Touch screen:
 *   • two-finger pinch — zoom toward midpoint
 *   • single-finger drag — pan
 *
 * Pan & zoom math is in screen coords: a CSS transform of
 *   `translate(tx, ty) scale(s)` applied to the image, with the image
 *   positioned at viewport center. Zooming "toward (px, py)" means the
 *   pixel under that screen point stays at the same screen position.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

interface LightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: View = { scale: 1, tx: 0, ty: 0 };

const clamp = (n: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, n));

export function Lightbox({ src, alt, onClose }: LightboxProps) {
  // scale + translation share a single state so zoomAt can update all three
  // atomically in one pure updater (no setState-inside-setState side effects).
  const [view, setView] = useState<View>(IDENTITY);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number }>({ x: 0, y: 0, tx: 0, ty: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { scale, tx, ty } = view;

  const reset = useCallback(() => setView(IDENTITY), []);

  // Zoom toward a screen-coord point so that the pixel under it stays put.
  const zoomAt = useCallback((nextScale: number, screenX: number, screenY: number) => {
    const el = containerRef.current;
    setView((v) => {
      const clamped = clamp(nextScale);
      if (!el) return { ...v, scale: clamped };
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const ratio = clamped / v.scale;
      return {
        scale: clamped,
        tx: v.tx * ratio + (1 - ratio) * (screenX - cx),
        ty: v.ty * ratio + (1 - ratio) * (screenY - cy),
      };
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomAt(scale * 1.25, window.innerWidth / 2, window.innerHeight / 2);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomAt(scale * 0.8, window.innerWidth / 2, window.innerHeight / 2);
      } else if (e.key === '0') {
        e.preventDefault();
        reset();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, zoomAt, reset, scale]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    // Browsers route trackpad pinch as a wheel event with ctrlKey=true;
    // genuine wheel/scroll has ctrlKey=false. Use that to split intent:
    //   • pinch         → zoom (sensitive: ~3x finer than mouse wheel for
    //                    smooth, finger-following feel)
    //   • mouse wheel   → zoom (coarser, since one notch should noticeably move)
    //   • two-finger swipe — when zoomed in, pan instead of zooming the
    //                        already-magnified view further
    const isPinch = e.ctrlKey;
    if (!isPinch && scale > 1.05) {
      // Pan via two-finger swipe; preserves natural macOS feel.
      setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
      return;
    }
    const sensitivity = isPinch ? 0.01 : 0.0015;
    const factor = Math.exp(-e.deltaY * sensitivity);
    zoomAt(scale * factor, e.clientX, e.clientY);
  };

  // Touch pinch + drag. We track the previous frame's distance + midpoint
  // and translate the delta into a zoomAt() call.
  const touchState = useRef<
    | { mode: 'pinch'; dist: number; mx: number; my: number }
    | { mode: 'pan'; x: number; y: number; tx: number; ty: number }
    | null
  >(null);

  const distance = (a: React.Touch, b: React.Touch) =>
    Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  const midpoint = (a: React.Touch, b: React.Touch) => ({
    mx: (a.clientX + b.clientX) / 2,
    my: (a.clientY + b.clientY) / 2,
  });

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const { mx, my } = midpoint(a, b);
      touchState.current = { mode: 'pinch', dist: distance(a, b), mx, my };
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      touchState.current = { mode: 'pan', x: t.clientX, y: t.clientY, tx, ty };
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!touchState.current) return;
    e.preventDefault();
    if (touchState.current.mode === 'pinch' && e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const newDist = distance(a, b);
      const ratio = newDist / touchState.current.dist;
      const { mx, my } = midpoint(a, b);
      zoomAt(scale * ratio, mx, my);
      touchState.current.dist = newDist;
      touchState.current.mx = mx;
      touchState.current.my = my;
    } else if (touchState.current.mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0];
      const start = touchState.current;
      setView((v) => ({
        ...v,
        tx: start.tx + (t.clientX - start.x),
        ty: start.ty + (t.clientY - start.y),
      }));
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length === 0) touchState.current = null;
    else if (e.touches.length === 1) {
      const t = e.touches[0];
      touchState.current = { mode: 'pan', x: t.clientX, y: t.clientY, tx, ty };
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (scale > 1.05) reset();
    else zoomAt(2.5, e.clientX, e.clientY);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, tx, ty };
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const start = dragStart.current;
      setView((v) => ({
        ...v,
        tx: start.tx + (e.clientX - start.x),
        ty: start.ty + (e.clientY - start.y),
      }));
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.85)', cursor: dragging ? 'grabbing' : 'default', touchAction: 'none' }}
      onClick={onClose}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="select-none"
        style={{
          maxWidth: '92vw',
          maxHeight: '92vh',
          borderRadius: 12,
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: 'center center',
          transition: dragging ? 'none' : 'transform 80ms ease-out',
          cursor: scale > 1.05 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
          willChange: 'transform',
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={onDoubleClick}
        onMouseDown={onMouseDown}
      />

      <div
        className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1.5 rounded-full"
        style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <ToolbarBtn onClick={() => zoomAt(scale * 0.8, window.innerWidth / 2, window.innerHeight / 2)} title="缩小 (-)">
          <ZoomOut size={14} />
        </ToolbarBtn>
        <span className="px-2 text-[11px] tabular-nums" style={{ color: 'rgba(255,255,255,0.85)', minWidth: 44, textAlign: 'center' }}>
          {Math.round(scale * 100)}%
        </span>
        <ToolbarBtn onClick={() => zoomAt(scale * 1.25, window.innerWidth / 2, window.innerHeight / 2)} title="放大 (+)">
          <ZoomIn size={14} />
        </ToolbarBtn>
        <span className="mx-1 w-px h-4" style={{ background: 'rgba(255,255,255,0.2)' }} />
        <ToolbarBtn onClick={reset} title="重置 (0)">
          <Maximize2 size={14} />
        </ToolbarBtn>
      </div>

      <button
        className="absolute top-4 right-4 p-2 rounded-full"
        style={{ background: 'rgba(255,255,255,0.1)', color: '#fff' }}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close"
      >
        <X size={18} />
      </button>
    </div>
  );
}

function ToolbarBtn({
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
      className="w-7 h-7 flex items-center justify-center rounded-full"
      style={{ color: '#fff', background: 'transparent' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

export default Lightbox;
