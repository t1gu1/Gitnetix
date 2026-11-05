import { useEffect, useRef, useState } from "react";

import { Avatar } from "./Avatar";
import { SEARCH_ABOVE } from "./ContextMenu";
import { Icon } from "./Icon";

export interface PickItem {
  id: string;
  name: string;
  /** Second line, e.g. a person's emails. */
  sub?: string;
  /** Shows an avatar: of this email, or of the name alone when empty. */
  avatar?: string;
}

/**
 * Saved picks after `next` (null: everyone, as `onChange` gives it): the ones checked now, and the saved ones not in
 * `present`, which stay picked for when they show up again.
 */
export const keepAbsent = (saved: string[], present: string[], next: string[] | null) => (next ? [...saved.filter((s) => !present.includes(s)), ...next] : []);

/**
 * Dropdown of checkboxes over `items` (`what`: their plural, "projects"), every one checked while `all`. Unchecking
 * one leaves the others checked; "Only" leaves that one alone. `onChange(null)` picks all again; otherwise it gives
 * the ids now checked, never none.
 */
export function CheckPicker({ what, items, all, picked, onChange }: { what: string; items: PickItem[]; all: boolean; picked: string[]; onChange: (ids: string[] | null) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((it) => `${it.name} ${it.sub ?? ""}`.toLowerCase().includes(q)) : items;
  const on = (id: string) => all || picked.includes(id);
  const checked = items.filter((it) => on(it.id));
  const label = all ? `All ${what}` : checked.length === 1 ? checked[0].name : `${checked.length} ${what}`;
  const toggle = (id: string) => {
    const next = on(id) ? checked.filter((it) => it.id !== id).map((it) => it.id) : [...checked.map((it) => it.id), id];
    if (next.length) onChange(next);
  };

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="select row" style={{ height: 32, gap: 8 }} aria-haspopup="true" aria-expanded={open} onClick={() => { setOpen(!open); setQuery(""); }}>
        <span className="sr-only">{what[0].toUpperCase() + what.slice(1)}: </span>
        <span className="ellipsis" style={{ maxWidth: 220 }}>{label}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="ctx-menu" role="group" aria-label={`${what[0].toUpperCase() + what.slice(1)} to include`} style={{ position: "absolute", top: 36, left: 0, minWidth: 240, maxHeight: 360, overflowY: "auto" }}>
          {items.length > SEARCH_ABOVE && (
            <div className="ctx-filter">
              <input className="input" autoFocus aria-label={`Filter ${what}`} placeholder={`Filter ${what}`} spellCheck={false} autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          )}
          {!q && (
            <>
              <label className="check ctx-item">
                <input type="checkbox" checked={all} onChange={() => onChange(null)} />
                <span className="grow ellipsis">All {what}</span>
              </label>
              <div className="ctx-sep" role="separator" />
            </>
          )}
          {!shown.length && <button className="ctx-item" disabled>No match for "{query.trim()}"</button>}
          {shown.map((it) => (
            <div key={it.id} className="ctx-row">
              <label className="check ctx-item">
                {/* The last one checked stays: picking no one shows nothing. */}
                <input type="checkbox" checked={on(it.id)} disabled={on(it.id) && checked.length === 1} onChange={() => toggle(it.id)} />
                {it.avatar !== undefined && <Avatar name={it.name} email={it.avatar || undefined} size={20} />}
                <span className="col grow" style={{ minWidth: 0, gap: 0, lineHeight: 1.25, padding: it.sub ? "4px 0" : undefined }}>
                  <span className="ellipsis">{it.name}</span>
                  {it.sub && <span className="faint ellipsis" style={{ fontSize: 11 }}>{it.sub}</span>}
                </span>
              </label>
              {items.length > 1 && <button className="ctx-only" aria-label={`Only ${it.name}`} onClick={() => onChange([it.id])}>Only</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The tracker people to count (`who`, empty: everyone) among `everyone`. Hidden with one person and no one picked. */
export function AssigneePicker({ everyone, who, onChange }: { everyone: string[]; who: string[]; onChange: (who: string[]) => void }) {
  if (everyone.length < 2 && who.length === 0) return null;
  return (
    <CheckPicker
      what="people"
      items={everyone.map((n) => ({ id: n, name: n, avatar: "" }))}
      all={who.length === 0}
      picked={who.filter((n) => everyone.includes(n))}
      onChange={(v) => onChange(keepAbsent(who, everyone, v))}
    />
  );
}
