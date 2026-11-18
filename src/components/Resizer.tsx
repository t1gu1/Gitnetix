import { useRef, type KeyboardEvent, type PointerEvent } from "react";

import { useStored } from "../lib/stored";

/** A pane width the viewer can drag, kept between sessions. */
export function usePaneWidth(key: string, def: number, min: number, max: number) {
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));
  const [width, setWidth] = useStored(key, def, (s) => clamp(Number(s)) || def, String);
  // Latest width, ahead of the render: a drag can end before its last move has rendered.
  const last = useRef(width);
  last.current = width;
  const set = (v: number, persist = false) => {
    last.current = clamp(v);
    setWidth(last.current, persist);
  };
  const save = () => setWidth(last.current, true);
  return { width, set, save, def, min, max };
}

export type PaneWidth = ReturnType<typeof usePaneWidth>;

/**
 * Vertical drag handle on a pane's right edge, or with `right` on the left edge
 * of a pane docked on the right (dragging left widens it). Double-click
 * resets; arrow keys nudge. With `percent` the value is a percent of the parent's width.
 */
export function Resizer({ pane, label, right, percent }: { pane: PaneWidth; label: string; right?: boolean; percent?: boolean }) {
  // `k` turns dragged pixels into the value's unit.
  const start = useRef<{ x: number; w: number; k: number } | null>(null);
  const pos = (e: PointerEvent) => (right ? -e.clientX : e.clientX);
  const end = () => {
    if (!start.current) return;
    start.current = null;
    document.body.classList.remove("resizing");
    pane.save();
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
        start.current = { x: pos(e), w: pane.width, k: percent ? 100 / e.currentTarget.parentElement!.clientWidth : 1 };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => start.current && pane.set(start.current.w + (pos(e) - start.current.x) * start.current.k)}
      onPointerUp={end}
      onLostPointerCapture={end}
      onDoubleClick={() => pane.set(pane.def, true)}
      onKeyDown={(e: KeyboardEvent) => {
        const step = (e.shiftKey ? 64 : 16) / (percent ? 8 : 1);
        if (e.key === (right ? "ArrowRight" : "ArrowLeft")) pane.set(pane.width - step, true);
        else if (e.key === (right ? "ArrowLeft" : "ArrowRight")) pane.set(pane.width + step, true);
        else return;
        e.preventDefault();
      }}
    />
  );
}
