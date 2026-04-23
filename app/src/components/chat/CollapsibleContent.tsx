/**
 * Collapse long assistant replies behind a "展开全文 / 收起" toggle.
 * Uses pure CSS max-height so streaming content stays smooth — no layout
 * thrash as tokens arrive. ResizeObserver checks the fully-rendered
 * height once per content change and only shows the toggle if the
 * content actually overflows.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface Props {
  /** Rendered markdown (or any React tree) to conditionally clip. */
  children: React.ReactNode;
  /** Max height while collapsed, in px. 15 lines @ 14px/1.7 ≈ 360px. */
  maxCollapsedPx?: number;
  /** Force expanded (e.g. while actively streaming). */
  forceExpanded?: boolean;
}

export function CollapsibleContent({
  children,
  maxCollapsedPx = 360,
  forceExpanded = false,
}: Props) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollHeight > maxCollapsedPx + 8);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxCollapsedPx]);

  const open = forceExpanded || expanded || !overflowing;

  return (
    <div className="relative">
      <div
        ref={innerRef}
        style={{
          maxHeight: open ? 'none' : `${maxCollapsedPx}px`,
          overflow: 'hidden',
          transition: open ? undefined : 'max-height 0.2s ease',
        }}
      >
        {children}
      </div>

      {overflowing && !forceExpanded && !expanded && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: 0, right: 0, bottom: 28,
            height: 48,
            background: 'linear-gradient(to bottom, transparent, var(--color-bg-elevated))',
            pointerEvents: 'none',
          }}
        />
      )}

      {overflowing && !forceExpanded && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium transition-colors"
          style={{
            color: 'var(--color-primary)',
            background: 'transparent',
            border: 'none',
            padding: '2px 0',
            cursor: 'pointer',
          }}
        >
          {expanded ? (
            <>
              <ChevronUp size={12} /> 收起
            </>
          ) : (
            <>
              <ChevronDown size={12} /> 展开全文
            </>
          )}
        </button>
      )}
    </div>
  );
}
