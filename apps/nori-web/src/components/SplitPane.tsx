import { useRef, useState, useCallback, useEffect } from 'react';

interface SplitPaneProps {
  direction: 'horizontal' | 'vertical';
  defaultSize?: number;  // percentage 0-100, default 50
  minSize?: number;      // percentage, default 20
  maxSize?: number;      // percentage, default 80
  storageKey?: string;
  children: [React.ReactNode, React.ReactNode];
}

export function SplitPane({
  direction,
  defaultSize = 50,
  minSize = 20,
  maxSize = 80,
  storageKey,
  children,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialSize = loadSplitSize(storageKey, defaultSize, minSize, maxSize);
  const splitRef = useRef(initialSize); // ref to avoid re-renders during drag
  const [splitPos, setSplitPos] = useState(initialSize); // updated on mouseup
  const draggingRef = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingRef.current || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    let newPos: number;

    if (direction === 'horizontal') {
      newPos = ((e.clientX - rect.left) / rect.width) * 100;
    } else {
      newPos = ((e.clientY - rect.top) / rect.height) * 100;
    }

    newPos = Math.max(minSize, Math.min(maxSize, newPos));
    splitRef.current = newPos;

    // Apply position directly to the panes for responsive drag
    const firstPane = containerRef.current.querySelector('.split-pane-pane:first-child') as HTMLElement;
    const secondPane = containerRef.current.querySelector('.split-pane-pane:last-child') as HTMLElement;
    if (firstPane && secondPane) {
      if (direction === 'horizontal') {
        firstPane.style.width = `${newPos}%`;
        secondPane.style.width = `${100 - newPos}%`;
      } else {
        firstPane.style.height = `${newPos}%`;
        secondPane.style.height = `${100 - newPos}%`;
      }
    }
  }, [direction, minSize, maxSize]);

  const handleMouseUp = useCallback(() => {
    if (draggingRef.current) {
      draggingRef.current = false;
      setSplitPos(splitRef.current); // sync React state on release
      if (storageKey) localStorage.setItem(storageKey, String(splitRef.current));
    }
  }, [storageKey]);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const containerClass = direction === 'horizontal'
    ? 'split-pane-horizontal'
    : 'split-pane-vertical';

  const dividerClass = 'split-pane-divider';

  return (
    <div className={containerClass} ref={containerRef}>
      <div className="split-pane-pane" style={direction === 'horizontal' ? { width: `${splitPos}%` } : { height: `${splitPos}%` }}>
        {children[0]}
      </div>
      <div
        className={dividerClass}
        onMouseDown={handleMouseDown}
      />
      <div className="split-pane-pane" style={direction === 'horizontal' ? { width: `${100 - splitPos}%` } : { height: `${100 - splitPos}%` }}>
        {children[1]}
      </div>
    </div>
  );
}

function loadSplitSize(key: string | undefined, fallback: number, min: number, max: number): number {
  if (!key) return fallback;
  const stored = Number(localStorage.getItem(key));
  return Number.isFinite(stored) ? Math.max(min, Math.min(max, stored)) : fallback;
}
