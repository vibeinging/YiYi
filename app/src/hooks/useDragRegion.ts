import { useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function useDragRegion() {
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // Only drag on left mouse button, and not on interactive elements
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a, textarea, select, [role="button"]')) return;

    e.preventDefault();
    getCurrentWindow().startDragging();
  }, []);

  return { onMouseDown };
}
