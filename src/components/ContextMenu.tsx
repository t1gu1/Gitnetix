import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./Icon";

export type MenuItem =
  | "sep"
  | {
      id: string;
      label: ReactNode;
      /** null: no icon column, e.g. when the label brings its own picture. */
      icon?: string | null;
      hint?: ReactNode;
      danger?: boolean;
      /** Light red icon: not a delete, but something goes (e.g. a worktree). */
      warn?: boolean;
      disabled?: boolean;
      /** Leaves the menu open, e.g. to toggle several options in a row. */
      keep?: boolean;
      run: () => void;
    };

/** A group title in the menu, not a choice. */
type MenuHeading = { heading: ReactNode };

const TRIGGER = '[aria-haspopup="menu"]';
// Buttons inside a heading (e.g. "Hide") stay out of the arrow keys and the first focus.
const ITEM = '[role="menuitem"]:not(:disabled)';
// WebKit doesn't focus clicked buttons, so the last pressed trigger stands in for the focused one.
let lastDown: Element | null = null;
window.addEventListener("mousedown", (e) => (lastDown = (e.target as Element).closest?.(TRIGGER) ?? null), true);

/**
 * Floating menu at a viewport point; closes on outside click, Escape, scroll or resize.
 * `columns`: each run between separators is a column, side by side on wide screens.
 */
export function ContextMenu({ x, y, items, label, alignRight, columns, onClose }: { x: number; y: number; items: (MenuItem | MenuHeading)[]; label: string; alignRight?: boolean; columns?: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, "--origin": "top left" });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // The button that opened the menu: pressing it again closes the menu instead of reopening it.
  const [opener] = useState(() => (document.activeElement as Element | null)?.closest(TRIGGER) ?? lastDown);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const { width, height } = el.getBoundingClientRect();
      // Anchored under its button, the menu flips above the button rather than over it.
      const btn = opener?.getBoundingClientRect();
      const flip = btn && y >= btn.bottom ? btn.top - 2 : y;
      const up = y + height > window.innerHeight - 8;
      setPos({
        left: Math.max(8, Math.min(alignRight ? x - width : x, window.innerWidth - width - 8)),
        top: Math.max(8, up ? flip - height : y),
        // The menu grows out of the corner at the pointer or button.
        "--origin": `${up ? "bottom" : "top"} ${alignRight ? "right" : "left"}`,
      });
    };
    place();
    el.querySelector<HTMLButtonElement>(ITEM)?.focus();
    // Items can come and go while it is open (a hidden section): it stays anchored.
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [x, y, alignRight]);

  useEffect(() => {
    const onClose = () => closeRef.current();
    const prev = document.activeElement as HTMLElement | null;
    const down = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if (opener?.contains(e.target as Node)) {
        const swallow = (c: MouseEvent) => opener.contains(c.target as Node) && (c.stopPropagation(), c.preventDefault());
        window.addEventListener("click", swallow, { capture: true, once: true });
      }
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>(ITEM) ?? [])];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      btns[(i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length]?.focus();
    };
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", onClose);
      prev?.focus?.();
    };
  }, []);

  const row = (it: MenuItem | MenuHeading, i: number) =>
    it === "sep" ? (
      <div key={`sep-${i}`} className="ctx-sep" role="separator" />
    ) : "heading" in it ? (
      <div key={`head-${i}`} className="ctx-head ellipsis" role="presentation">
        {it.heading}
      </div>
    ) : (
      <button
        key={it.id}
        role="menuitem"
        className={`ctx-item${it.danger ? " c-del" : ""}`}
        disabled={it.disabled}
        onClick={() => {
          if (!it.keep) closeRef.current();
          it.run();
        }}
      >
        {it.icon !== null && <span className={`ctx-icon${it.warn ? " ctx-warn" : ""}`}>{it.icon && <Icon name={it.icon} size={13} />}</span>}
        <span className="grow ellipsis">{it.label}</span>
        {it.hint && <span className="ctx-hint">{it.hint}</span>}
      </button>
    );
  const cols: (MenuItem | MenuHeading)[][] = [[]];
  if (columns)
    for (const it of items) {
      if (it === "sep") cols.push([]);
      else cols[cols.length - 1].push(it);
    }

  return createPortal(
    <div ref={ref} className={`ctx-menu${columns ? " ctx-cols" : ""}`} role="menu" aria-label={label} style={pos as CSSProperties} onContextMenu={(e) => e.preventDefault()}>
      {columns
        ? cols.map((c, i) => (
            <div key={i} className="ctx-col" role="group">
              {c.map(row)}
            </div>
          ))
        : items.map(row)}
    </div>,
    document.body,
  );
}
