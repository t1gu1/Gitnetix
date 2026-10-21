import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
      disabled?: boolean;
      /** Leaves the menu open, e.g. to toggle several options in a row. */
      keep?: boolean;
      run: () => void;
    };

/** Floating menu at a viewport point; closes on outside click, Escape, scroll or resize. */
export function ContextMenu({ x, y, items, label, alignRight, onClose }: { x: number; y: number; items: MenuItem[]; label: string; alignRight?: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(alignRight ? x - width : x, window.innerWidth - width - 8)),
      top: Math.max(8, y + height > window.innerHeight - 8 ? y - height : y),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y, alignRight]);

  useEffect(() => {
    const onClose = () => closeRef.current();
    const prev = document.activeElement as HTMLElement | null;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
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

  return createPortal(
    <div ref={ref} className="ctx-menu" role="menu" aria-label={label} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={`sep-${i}`} className="ctx-sep" role="separator" />
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
            {it.icon !== null && <span className="ctx-icon">{it.icon && <Icon name={it.icon} size={13} />}</span>}
            <span className="grow ellipsis">{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
