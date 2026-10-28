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
 * Vertical drag handle on a pane's right edge, or with `top` a horizontal one
 * on a bottom pane's top edge (the value is then its height). Double-click
 * resets; arrow keys nudge. With `percent` the value is a percent of the width of the two panes it sits between.
 */
export function Resizer({ pane, label, top, percent }: { pane: PaneWidth; label: string; top?: boolean; percent?: boolean }) {
  // `k` turns dragged pixels into the value's unit.
  const start = useRef<{ x: number; w: number; k: number } | null>(null);
  const pos = (e: PointerEvent) => (top ? -e.clientY : e.clientX);
  const end = () => {
    if (!start.current) return;
    start.current = null;
    document.body.classList.remove("resizing", "resizing-rows");
    pane.save();
  };
  return (
    <div
      role="separator"
      aria-orientation={top ? "horizontal" : "vertical"}
      aria-label={label}
      aria-valuenow={pane.width}
      aria-valuemin={pane.min}
      aria-valuemax={pane.max}
      tabIndex={0}
      className={top ? "resizer resizer-top hide-narrow" : "resizer hide-narrow"}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        // The two panes share what other columns (the commit graph) leave of the parent.
        const span = (el: Element | null) => (el instanceof HTMLElement ? el.offsetWidth : 0);
        const el = e.currentTarget;
        start.current = { x: pos(e), w: pane.width, k: percent ? 100 / (span(el.previousElementSibling) + span(el.nextElementSibling) || el.parentElement!.clientWidth) : 1 };
        document.body.classList.add("resizing", ...(top ? ["resizing-rows"] : []));
      }}
      onPointerMove={(e) => start.current && pane.set(start.current.w + (pos(e) - start.current.x) * start.current.k)}
      onPointerUp={end}
      onLostPointerCapture={end}
      onDoubleClick={() => pane.set(pane.def, true)}
      onKeyDown={(e: KeyboardEvent) => {
        const step = (e.shiftKey ? 64 : 16) / (percent ? 8 : 1);
        if (e.key === (top ? "ArrowDown" : "ArrowLeft")) pane.set(pane.width - step, true);
        else if (e.key === (top ? "ArrowUp" : "ArrowRight")) pane.set(pane.width + step, true);
        else return;
        e.preventDefault();
      }}
    />
  );
}
