import { Fragment, useRef, useState } from "react";

import { useProjectPrefs, useTagV } from "../api/hooks";
import type { BranchType } from "../api/types";
import { KINDS, kindOf } from "../lib/kinds";
import { Icon } from "./Icon";
import { moveTo } from "./TopBar";
import { Seg } from "./ui";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Can start a branch name (`wip`): the backend's `custom_type` checks it again. Release is the release dialog's. */
const validType = (id: string) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/.test(id) && !id.endsWith(".lock") && !id.includes("..") && !same(id, "release");

/** `feat` → Feature; a type of the user's own (`wip`) → Wip. */
export const typeLabel = (id: string) => KINDS.find((k) => k.id === id)?.label ?? (id === "release" ? "Release" : id.charAt(0).toUpperCase() + id.slice(1));

/** `list` with `id` in the first unpinned place: the unpinned ones from there move down one, past the pinned ones, which keep their places.
 * The backend's `BranchTypes::add`: keep the two in step. */
export function placed(list: BranchType[], id: string): BranchType[] {
  const free = [{ id, pinned: false }, ...list.filter((t) => !t.pinned)];
  return [...list.map((t) => (t.pinned ? t : free.shift()!)), ...free];
}

/** The type a branch name's prefix says (`feature/x` → feat, `WIP/x` → a listed `wip`, else `WIP`), or `picked` when it has none. */
export function typeOfName(list: BranchType[], name: string, picked: string) {
  const p = name.slice(0, Math.max(name.indexOf("/"), 0));
  if (!validType(p)) return picked;
  return kindOf(p) ?? list.find((t) => same(t.id, p))?.id ?? p;
}

/** The type a new branch starts on: Feature, or the first listed when Feature was removed. New types go first, so not simply the first. */
export const firstType = (list: BranchType[]) => (list.some((t) => t.id === "feat") ? "feat" : (list.find((t) => t.id !== "release")?.id ?? "feat"));

/** `name` with its prefix swapped for type `k` (`feat/x` → `fix/x`); a name without one stays as it is. */
export const withType = (name: string, k: string) => (name.indexOf("/") > 0 ? `${k}/${name.slice(name.indexOf("/") + 1)}` : name);

/** The project's first 12 branch types (6 on one row), and `value` in the first unpinned place when it is not among them.
 * Release always gets a place too: the last one neither picked nor pinned. One not saved yet, typed as a branch name's prefix, shines: creating the branch saves it. */
export function TypePicker({ pid, value, onChange, release = true, size }: { pid: string; value: string; onChange: (k: string) => void; release?: boolean; size?: "lg" }) {
  const { branchTypes: t } = useProjectPrefs(pid);
  const list = release ? t.list : t.list.filter((x) => x.id !== "release");
  const max = t.oneRow ? 6 : 12;
  let shown = list.slice(0, max);
  if (!shown.some((x) => x.id === value)) {
    shown = placed(shown, value).slice(0, max);
    // Every place pinned: it takes the last one.
    if (!shown.some((x) => x.id === value)) shown[max - 1] = { id: value, pinned: false };
  }
  // Release opens the new release dialog: listed further down, it still shows.
  const rel = release && list.find((x) => x.id === "release");
  if (rel && !shown.some((x) => x.id === "release")) {
    const last = (keep: (x: BranchType) => boolean) => shown.reduce((at, x, i) => (x.id !== value && keep(x) ? i : at), -1);
    const at = last((x) => !x.pinned);
    const i = at >= 0 ? at : last(() => true);
    if (i >= 0) shown[i] = rel;
  }
  const fresh = !list.some((x) => x.id === value);
  const options = shown.map((x) => ({
    value: x.id,
    label: fresh && x.id === value ? <span className="glow-working" data-tip="New: saved with the branch"><span>{typeLabel(x.id)}</span></span> : typeLabel(x.id),
  }));
  return <Seg grid cols={6} size={size} label="Type" value={value} onChange={onChange} options={options} />;
}

/** Order, pin, add and remove the project's branch types, and pick one row or two. Release opens the new release dialog: it moves but stays; its row also picks how version tags read. */
export function BranchTypesEditor({ pid }: { pid: string }) {
  const { branchTypes: t, setBranchTypes } = useProjectPrefs(pid);
  const tagV = useTagV(pid);
  const [typed, setTyped] = useState("");
  const max = t.oneRow ? 6 : 12;
  const save = (list: BranchType[]) => setBranchTypes({ list });
  const move = (i: number, by: number) => {
    const l = [...t.list];
    [l[i], l[i + by]] = [l[i + by], l[i]];
    save(l);
  };
  // Dragged by its grip with pointer events, like the project tabs (HTML5 drag-and-drop clashes with the webview's folder drop).
  // The list holds the capture: the dragged row's DOM node moves as it is reordered, which would drop it.
  const [drag, setDrag] = useState<{ id: string; index: number } | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const shown = drag ? moveTo(t.list, drag.id, drag.index) : t.list;
  // Slot for the dragged row: how many other rows sit above the pointer.
  const indexAt = (id: string, y: number) =>
    t.list.filter((x) => {
      const r = x.id !== id && rows.current.get(x.id)?.getBoundingClientRect();
      return r && r.top + r.height / 2 < y;
    }).length;
  const endDrag = () => {
    if (drag && shown.map((x) => x.id).join() !== t.list.map((x) => x.id).join()) save(shown);
    setDrag(null);
  };
  // Spaces become dashes, as in a branch name; an alias is its type (`feature` is Feature).
  const id = kindOf(typed.trim()) ?? typed.trim().replace(/\s+/g, "-");
  const listed = t.list.some((x) => same(x.id, id));
  const add = () => {
    if (!validType(id) || listed) return;
    save(placed(t.list, id));
    setTyped("");
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      <Seg grid label="Types shown" value={t.oneRow ? "one" : "two"} onChange={(v) => setBranchTypes({ oneRow: v === "one" })} options={[{ value: "two", label: "Two rows · 12" }, { value: "one", label: "One row · 6" }]} />
      <ul
        className="list type-list"
        aria-label="Branch types"
        data-dragging={drag ? "" : undefined}
        onPointerMove={(e) => {
          if (!drag) return;
          // A release the page never got (focus lost, another window took the mouse): hand the capture back, which ends the drag.
          if (!(e.buttons & 1)) return e.currentTarget.hasPointerCapture(e.pointerId) ? e.currentTarget.releasePointerCapture(e.pointerId) : endDrag();
          const index = indexAt(drag.id, e.clientY);
          if (index !== drag.index) setDrag({ ...drag, index });
        }}
        onLostPointerCapture={endDrag}
      >
        {shown.map((x, i) => {
          const label = typeLabel(x.id);
          return (
            <Fragment key={x.id}>
              {i === max && <li className="type-cut hint">Not shown · offered when a branch name starts with one. Release always shows</li>}
              <li ref={(el) => void (el ? rows.current.set(x.id, el) : rows.current.delete(x.id))} className="type-row" data-hidden={i >= max || undefined} data-dragging={drag?.id === x.id || undefined}>
                <span
                  className="type-grip faint"
                  aria-hidden
                  data-tip="Drag to reorder"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.currentTarget.closest("ul")!.setPointerCapture(e.pointerId);
                    setDrag({ id: x.id, index: i });
                  }}
                >
                  <Icon name="grip" />
                </span>
                <span className="grow ellipsis">
                  {label} <span className="mono faint">{x.id === "release" ? "release/x.y.z" : `${x.id}/`}</span>
                </span>
                {/* Out of the label, which ellipsizes: the toggle never gets cut. Its text names it for screen readers. */}
                {x.id === "release" && (
                  <button
                    className="btn btn-ghost btn-sm type-tag"
                    style={{ flexShrink: 0 }}
                    data-tip={`Version tags read ${tagV.label("x.y.z")}: click for ${tagV.v ? "x.y.z" : "vx.y.z"}. Remembered for this project`}
                    disabled={!!drag}
                    onClick={() => tagV.setV(!tagV.v)}
                  >
                    tag <span className="mono">{tagV.label("x.y.z")}</span>
                  </button>
                )}
                <button
                  className={`btn btn-ghost btn-icon btn-sm${x.pinned ? " c-acc" : ""}`}
                  aria-pressed={x.pinned}
                  aria-label={`Pin ${label}`}
                  data-tip={x.pinned ? "Pinned: keeps its place when a type is added" : "Pin: keep its place when a type is added"}
                  onClick={() => save(t.list.map((y, j) => (j === i ? { ...y, pinned: !y.pinned } : y)))}
                >
                  <Icon name="pin" />
                </button>
                <button className="btn btn-ghost btn-icon btn-sm" aria-label={`Move ${label} up`} disabled={i === 0 || !!drag} onClick={() => move(i, -1)}>
                  <Icon name="chevronUp" />
                </button>
                <button className="btn btn-ghost btn-icon btn-sm" aria-label={`Move ${label} down`} disabled={i === t.list.length - 1 || !!drag} onClick={() => move(i, 1)}>
                  <Icon name="chevronDown" />
                </button>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={`Remove ${label}`}
                  data-tip={x.id === "release" ? "Opens the new release dialog: it stays" : undefined}
                  disabled={x.id === "release"}
                  onClick={() => save(t.list.filter((_, j) => j !== i))}
                >
                  <Icon name="trash" />
                </button>
              </li>
            </Fragment>
          );
        })}
      </ul>
      <form
        className="row"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="input mono grow" aria-label="New type" placeholder="A prefix, like wip" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <button className="btn" disabled={!validType(id) || listed}>
          <Icon name="plus" size={12} />
          Add
        </button>
      </form>
      {typed.trim() && (listed ? <p className="hint">{typeLabel(id)} is in the list.</p> : !validType(id) && <p className="hint c-del">A type is one part of a branch name: letters, digits, dots, dashes and underscores.</p>)}
    </div>
  );
}
