import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** A pane width the viewer can drag, kept in this browser between sessions. */
export function usePaneWidth(key: string, def: number, min: number, max: number) {
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return v ? clamp(v) : def;
    } catch {
      return def;
    }
  });
  const set = (v: number, persist = false) => {
    const w = clamp(v);
    setWidth(w);
    if (persist) {
      try {
        localStorage.setItem(key, String(w));
      } catch {
        /* per-viewer convenience only */
      }
    }
  };
  return { width, set, def, min, max };
}

export type PaneWidth = ReturnType<typeof usePaneWidth>;

/** Vertical drag handle on a pane's right edge. Double-click resets; arrow keys nudge. */
export function Resizer({ pane, label }: { pane: PaneWidth; label: string }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const end = () => {
    if (!start.current) return;
    start.current = null;
    document.body.classList.remove("resizing");
    pane.set(pane.width, true);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={pane.width}
      aria-valuemin={pane.min}
      aria-valuemax={pane.max}
      tabIndex={0}
      className="resizer hide-narrow"
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: pane.width };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => start.current && pane.set(start.current.w + e.clientX - start.current.x)}
      onPointerUp={end}
      onLostPointerCapture={end}
      onDoubleClick={() => pane.set(pane.def, true)}
      onKeyDown={(e: KeyboardEvent) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === "ArrowLeft") pane.set(pane.width - step, true);
        else if (e.key === "ArrowRight") pane.set(pane.width + step, true);
        else return;
        e.preventDefault();
      }}
    />
  );
}
