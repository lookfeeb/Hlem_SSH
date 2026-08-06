import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clamp } from "../lib/math";

interface SplitPaneProps {
  top: ReactNode;
  bottom: ReactNode;
  minTop: number;
  minBottom: number;
  defaultTopHeight?: number;
}

const SPLIT_HANDLE_HEIGHT = 10;

export function SplitPane({
  top,
  bottom,
  minTop,
  minBottom,
  defaultTopHeight = 420,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [topHeight, setTopHeight] = useState(defaultTopHeight);
  const initializedRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, []);

  const clampTopHeight = useCallback(
    (value: number, containerHeight: number) => {
      const maxTop = Math.max(minTop, containerHeight - minBottom - SPLIT_HANDLE_HEIGHT);
      return clamp(value, minTop, maxTop);
    },
    [minTop, minBottom],
  );

  const syncTopHeight = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const { height } = container.getBoundingClientRect();
    setTopHeight((current) => {
      if (initializedRef.current) return clampTopHeight(current, height);
      initializedRef.current = true;
      return clampTopHeight(Math.min(defaultTopHeight, Math.round(height * 0.55)), height);
    });
  }, [clampTopHeight, defaultTopHeight]);

  useLayoutEffect(() => {
    syncTopHeight();
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(syncTopHeight);
    observer.observe(container);
    return () => observer.disconnect();
  }, [syncTopHeight]);

  const startDrag = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    dragCleanupRef.current?.();

    const bounds = container.getBoundingClientRect();

    const onMouseMove = (e: MouseEvent) => {
      setTopHeight(clampTopHeight(e.clientY - bounds.top, bounds.height));
    };

    const stopDrag = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stopDrag);
      document.body.classList.remove("isResizing");
      dragCleanupRef.current = null;
    };

    document.body.classList.add("isResizing");
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stopDrag);
    dragCleanupRef.current = stopDrag;
  }, [clampTopHeight]);

  return (
    <div className="splitPane" ref={containerRef} style={{ gridTemplateRows: `${topHeight}px 10px minmax(0, 1fr)` }}>
      <div className="splitTop">
        {top}
      </div>
      <button
        className="splitHandle"
        onMouseDown={startDrag}
        aria-label="拖动调整终端与文件面板高度"
      />
      <div className="splitBottom">{bottom}</div>
    </div>
  );
}
