import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { useCoverScrollbars } from "./ui";

type Pt = { x: number; y: number };
/** Where pointers `p` are together: their middle, and how far apart the first two are (0 for one). */
const spread = (p: Pt[]) => ({ x: p.reduce((a, q) => a + q.x, 0) / p.length, y: p.reduce((a, q) => a + q.y, 0) / p.length, d: p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0 });

/** `children` (an image) over the whole screen, zoomed up to 8× by a pinch, the wheel, a double tap or click and + / -, and dragged around once zoomed; 0 fits it again. Escape, the close button or a tap beside it closes it.
 * ←/→, and a one-finger swipe when not zoomed, call `onStep(1)` (→, to the left: next) or `onStep(-1)`; it stays up, the new image fitted.
 * `onDownload`: a Download button beside the close one. */
export function Zoom({ name, onClose, onStep, onDownload, children }: { name: string; onClose: () => void; onStep?: (d: number) => void; onDownload?: () => void; children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const pic = useRef<HTMLDivElement>(null);
  const [v, setV] = useState({ s: 1, x: 0, y: 0 });
  const pts = useRef(new Map<number, Pt>());
  // A press that has not moved yet (`bare`: beside the image), and the last tap: a second one there soon after zooms.
  const press = useRef<(Pt & { t: number; bare: boolean }) | null>(null);
  const last = useRef({ x: 0, y: 0, t: 0 });
  // A tap beside the image closes on its click, the last event of a tap: closed sooner, the mousedown after it would land on the gallery and close it too.
  const shut = useRef(false);
  // Where a finger went down on the image at 1×, alone: a swipe from there steps, as long as no second finger joins it.
  const swipe = useRef<Pt | null>(null);
  // From the middle of the screen, where the image's middle stands at 1×.
  const at = (e: { clientX: number; clientY: number }): Pt => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };
  /** Zooms by `f` (0: back to 1×) with the point under `from` brought to `to`; a zoomed image cannot be dragged off the screen. */
  const go = (from: Pt, to: Pt, f: number) =>
    setV((v) => {
      const s = Math.min(8, Math.max(1, v.s * f));
      const k = s / v.s;
      const mx = Math.max(0, (s * pic.current!.offsetWidth - stage.current!.clientWidth) / 2);
      const my = Math.max(0, (s * pic.current!.offsetHeight - stage.current!.clientHeight) / 2);
      return { s, x: Math.min(mx, Math.max(-mx, to.x - k * (from.x - v.x))), y: Math.min(my, Math.max(-my, to.y - k * (from.y - v.y))) };
    });
  const latest = useRef({ onClose, onStep });
  latest.current = { onClose, onStep };
  const step = (d: number) => {
    setV({ s: 1, x: 0, y: 0 });
    latest.current.onStep?.(d);
  };
  useEffect(() => {
    const mid = { x: 0, y: 0 };
    // Before the gallery's own: Escape closes this alone, ←/→ step here.
    const k = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        latest.current.onClose();
      } else if (latest.current.onStep && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.stopPropagation();
        step(e.key === "ArrowLeft" ? -1 : 1);
      } else if (e.key === "+" || e.key === "=") go(mid, mid, 1.5);
      else if (e.key === "-") go(mid, mid, 1 / 1.5);
      else if (e.key === "0") go(mid, mid, 0);
    };
    // Not passive, so the page does not scroll or zoom too (a trackpad pinch comes as Ctrl + wheel).
    const w = (e: WheelEvent) => {
      e.preventDefault();
      const p = at(e);
      go(p, p, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : e.ctrlKey ? 0.01 : 0.002)));
    };
    const el = stage.current!;
    window.addEventListener("keydown", k, true);
    el.addEventListener("wheel", w, { passive: false });
    return () => {
      window.removeEventListener("keydown", k, true);
      el.removeEventListener("wheel", w);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useCoverScrollbars();
  const lift = (id: number) => {
    pts.current.delete(id);
    press.current = null;
    swipe.current = null;
  };
  return createPortal(
    // Its touches stay here: a drag must not also swipe the page under it to another pane.
    <div className="ag-zoom" role="dialog" aria-modal="true" aria-label={name} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}>
      <div
        ref={stage}
        className="ag-zoom-stage"
        style={{ cursor: v.s > 1 ? "grab" : "zoom-in" }}
        onDragStart={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = at(e);
          pts.current.set(e.pointerId, p);
          press.current = pts.current.size === 1 ? { ...p, t: e.timeStamp, bare: e.target === e.currentTarget } : null;
          shut.current = false;
          swipe.current = pts.current.size === 1 && e.pointerType === "touch" && v.s === 1 ? p : null;
        }}
        onPointerMove={(e) => {
          const p = pts.current;
          if (!p.has(e.pointerId)) return;
          const a = spread([...p.values()]);
          p.set(e.pointerId, at(e));
          const b = spread([...p.values()]);
          if (press.current && Math.hypot(b.x - press.current.x, b.y - press.current.y) > 8) press.current = null;
          go(a, b, a.d ? b.d / a.d : 1);
        }}
        onPointerUp={(e) => {
          const t = press.current;
          const sw = swipe.current;
          lift(e.pointerId);
          if (sw && onStep) {
            const p = at(e);
            // As far and as flat as a swipe between pages (swipeProps).
            if (Math.abs(p.x - sw.x) >= 60 && Math.abs(p.x - sw.x) >= 2 * Math.abs(p.y - sw.y)) return step(p.x < sw.x ? 1 : -1);
          }
          if (!t || e.timeStamp - t.t > 300) return;
          const l = last.current;
          if (e.timeStamp - l.t < 300 && Math.hypot(t.x - l.x, t.y - l.y) < 30) {
            last.current = { x: 0, y: 0, t: 0 };
            go(t, t, v.s > 1 ? 0 : 2.5);
          } else if (t.bare) shut.current = true;
          else last.current = { x: t.x, y: t.y, t: e.timeStamp };
        }}
        onClick={() => shut.current && onClose()}
        onPointerCancel={(e) => lift(e.pointerId)}
      >
        <div ref={pic} style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})` }}>
          {children}
        </div>
      </div>
      {onDownload && (
        <button type="button" className="ag-zoom-close ag-zoom-download" aria-label={`Download ${name}`} data-tip="Download" onClick={onDownload}>
          <Icon name="download" />
        </button>
      )}
      <button type="button" className="ag-zoom-close" aria-label="Close full screen" autoFocus onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>,
    document.body,
  );
}
