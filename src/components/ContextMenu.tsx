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
      /** What the search field matches when the label isn't plain text. */
      text?: string;
      run: () => void;
    };

/** A group title in the menu, not a choice. */
type MenuHeading = { heading: ReactNode };

/** Pickers with more choices than this get a search field. */
export const SEARCH_ABOVE = 10;

const TRIGGER = '[aria-haspopup="menu"]';
// Buttons inside a heading (e.g. "Hide") stay out of the arrow keys and the first focus.
const ITEM = '[role="menuitem"]:not(:disabled)';
// WebKit doesn't focus clicked buttons, so the last pressed trigger stands in for the focused one.
let lastDown: Element | null = null;
window.addEventListener("mousedown", (e) => (lastDown = (e.target as Element).closest?.(TRIGGER) ?? null), true);

/**
 * Floating menu at a viewport point; closes on outside click, Escape, scroll or resize.
 * `columns`: each run between separators is a column, side by side on wide screens.
 * `search`: the placeholder of a filter field atop the items (e.g. a long branch list), matching their `text` or plain-text label.
 */
export function ContextMenu({ x, y, items, label, alignRight, columns, search, onClose }: { x: number; y: number; items: (MenuItem | MenuHeading)[]; label: string; alignRight?: boolean; columns?: boolean; search?: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // The button that opened the menu: pressing it again closes the menu instead of reopening it.
  const [opener] = useState(() => (document.activeElement as Element | null)?.closest(TRIGGER) ?? lastDown);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth?: number; maxHeight?: number; "--origin": string }>(() => ({
    left: x,
    top: y,
    // A searchable menu reads as the dropdown of its field: at least as wide as it.
    minWidth: search && opener ? Math.max(220, opener.getBoundingClientRect().width) : undefined,
    "--origin": "top left",
  }));
  // Filtering only shrinks the list: the menu keeps the side and width it opened with instead of jumping around.
  const opened = useRef<{ up: boolean; width: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      // Layout sizes: the bounding box would include the pop-in scale the menu opens with.
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const full = el.scrollHeight + height - el.clientHeight;
      // Anchored under its button, the menu flips above the button rather than over it,
      // to the side with more room, and scrolls there rather than cover the button.
      const btn = opener?.getBoundingClientRect();
      const under = btn !== undefined && y >= btn.bottom;
      const flip = under ? btn.top - 2 : y;
      const below = window.innerHeight - 8 - y;
      const above = flip - 8;
      const up = opened.current?.up ?? (under ? full > below && above > below : y + height > window.innerHeight - 8);
      const room = under ? (up ? above : below) : undefined;
      if (search) opened.current ??= { up, width };
      setPos({
        left: Math.max(8, Math.min(alignRight ? x - width : x, window.innerWidth - width - 8)),
        top: Math.max(8, up ? flip - Math.min(full, room ?? height) : y),
        minWidth: opened.current?.width,
        maxHeight: room,
        // The menu grows out of the corner at the pointer or button.
        "--origin": `${up ? "bottom" : "top"} ${alignRight ? "right" : "left"}`,
      });
    };
    place();
    (field.current ?? el.querySelector<HTMLButtonElement>(ITEM))?.focus();
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
      // Typing on an item lands in the filter field.
      if (field.current && e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && document.activeElement !== field.current) return field.current.focus();
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>(ITEM) ?? [])];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      btns[i < 0 && step < 0 ? btns.length - 1 : (i + step + btns.length) % btns.length]?.focus();
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

  const q = query.trim().toLowerCase();
  // While filtering, only the matching choices show: no headings or separators.
  const matching = q ? items.filter((it) => it !== "sep" && !("heading" in it) && (it.text ?? (typeof it.label === "string" ? it.label : "")).toLowerCase().includes(q)) : items;
  const shown: (MenuItem | MenuHeading)[] = matching.length || !q ? matching : [{ id: "none", label: `No match for “${query.trim()}”`, icon: null, disabled: true, run: () => {} }];

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
        // Names too long for the menu read in full on hover.
        title={search && typeof it.label === "string" ? it.label : undefined}
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
    for (const it of shown) {
      if (it === "sep") cols.push([]);
      else cols[cols.length - 1].push(it);
    }

  return createPortal(
    <div ref={ref} className={`ctx-menu${columns ? " ctx-cols" : ""}${search ? " ctx-search" : ""}`} role="menu" aria-label={label} style={pos as CSSProperties} onContextMenu={(e) => e.preventDefault()}>
      {search && (
        <div className="ctx-filter">
          <input
            ref={field}
            className="input"
            aria-label={search}
            placeholder={search}
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // Enter picks the first match.
            onKeyDown={(e) => e.key === "Enter" && ref.current?.querySelector<HTMLButtonElement>(ITEM)?.click()}
          />
        </div>
      )}
      {columns
        ? cols.map((c, i) => (
            <div key={i} className="ctx-col" role="group">
              {c.map(row)}
            </div>
          ))
        : shown.map(row)}
    </div>,
    document.body,
  );
}
