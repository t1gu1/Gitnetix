import { useEffect, useState, type MouseEvent } from "react";

import { useAction } from "../api/hooks";
import type { Stash, StashApplied } from "../api/types";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Modal } from "../components/ui";
import { ago, plural, stashCount } from "../lib/format";
import { copyToClipboard, toast } from "../lib/toast";

/**
 * Stashes, in place of the branch tree: one branch's, or every one. Picking a
 * stash shows its files; it can then be popped, applied or dropped.
 */
export function StashList({
  active,
  pid,
  stashes,
  branch,
  total,
  selected,
  targetOf,
  onPick,
  onShowAll,
  onBack,
}: {
  active: boolean;
  pid: string;
  /** Stashes to list, newest first. */
  stashes: Stash[];
  /** Branch they were made on; undefined = every stash. */
  branch?: string;
  /** Stashes of the whole project. */
  total: number;
  /** Picked stash's SHA. */
  selected?: string;
  /** Checked-out branch a stash goes back onto (its own when checked out); undefined = none. */
  targetOf: (s: Stash) => string | undefined;
  onPick: (s?: Stash) => void;
  onShowAll: () => void;
  onBack: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; s: Stash } | null>(null);
  const [dropping, setDropping] = useState<Stash | null>(null);
  const inv = [["overview", pid], ["files", pid], ["diff", pid]];
  const apply = useAction<StashApplied, { projectId: string; branch: string; sha: string; pop: boolean }>("stashes.apply", { invalidate: inv });
  const current = stashes.find((s) => s.sha === selected);

  const run = (s: Stash, pop: boolean) => {
    const onto = targetOf(s);
    if (!onto) return;
    apply.mutate(
      { projectId: pid, branch: onto, sha: s.sha, pop },
      {
        onSuccess: (r) => {
          if (r.conflicts.length) {
            toast(`Applied onto ${onto} with ${plural(r.conflicts.length, "conflict")}: resolve them in its WIP files. The stash is kept.`, "error");
            return;
          }
          toast(r.dropped ? `Popped onto ${onto}` : `Applied onto ${onto}, stash kept`, "ok");
          if (r.dropped && s.sha === selected) onPick(undefined);
        },
      },
    );
  };

  const items = (s: Stash): MenuItem[] => {
    const onto = targetOf(s);
    const hint = onto ? undefined : "nothing checked out";
    return [
      { id: "pop", label: <>Pop onto <span className="mono">{onto ?? "…"}</span></>, icon: "unstash", hint: hint ?? "then drop it", disabled: !onto, run: () => run(s, true) },
      { id: "apply", label: <>Apply onto <span className="mono">{onto ?? "…"}</span></>, icon: "unstash", hint: hint ?? "keep it", disabled: !onto, run: () => run(s, false) },
      "sep",
      { id: "copy", label: "Copy SHA", icon: "edit", hint: s.sha.slice(0, 7), run: () => copyToClipboard(s.sha) },
      "sep",
      { id: "drop", label: "Drop stash…", icon: "trash", danger: true, run: () => setDropping(s) },
    ];
  };

  const openMenu = (s: Stash, e: MouseEvent) => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Keyboard-opened context menus report (0, 0): anchor to the row instead.
    const fromKey = e.clientX === 0 && e.clientY === 0;
    setMenu({ x: fromKey ? r.left : e.clientX, y: fromKey ? r.bottom + 2 : e.clientY, s });
  };

  // Escape goes back to the branches, unless it is closing something else or typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement).closest("input, textarea")) return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const onto = current && targetOf(current);
  return (
    <section aria-label={branch ? `Stashes of ${branch}` : "Stashes"} className="ws-releases" data-pane data-active={active}>
      <div className="pane-head">
        <span className="row" style={{ gap: 6, minWidth: 0 }}>
          <button className="btn btn-sm btn-icon pane-toggle" aria-label="Back to branches" data-tip="Back to branches (Esc)" onClick={onBack}>
            <Icon name="back" size={13} />
          </button>
          {branch ? <span className="mono ellipsis" style={{ fontSize: 12.5 }}>{branch}</span> : <span className="label">Stashes</span>}
        </span>
        {branch && total > stashes.length ? (
          <button className="btn btn-ghost btn-sm" data-tip="Every stash of the project" onClick={onShowAll}>
            All {total}
          </button>
        ) : (
          <span className="faint" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{stashCount(stashes.length)}</span>
        )}
      </div>
      <div className="scroll commits" style={{ flex: "1 1 auto" }}>
        {stashes.map((s) => (
          <button key={s.sha} className="commit-row" aria-pressed={s.sha === selected} onClick={() => onPick(s)} onContextMenu={(e) => openMenu(s, e)}>
            <span className="commit-subject">{s.message}</span>
            <span className="commit-meta">
              {!branch && <span className="mono ellipsis">{s.branch ?? "detached HEAD"}</span>}
              {s.untracked && <span title="Holds untracked files too">+ untracked</span>}
              <span title={new Date(s.date).toLocaleString()} style={{ whiteSpace: "nowrap" }}>{ago(s.date)}</span>
            </span>
          </button>
        ))}
        {stashes.length === 0 && <Empty>{branch ? <>No stashes made on <span className="mono">{branch}</span>.</> : "No stashes."}</Empty>}
      </div>
      {current && (
        <div className="col" style={{ gap: 6, padding: 12, borderTop: "1px solid var(--line)" }}>
          <div className="row" style={{ gap: 6 }}>
            <button
              className="btn btn-primary btn-md grow"
              disabled={!onto || apply.isPending}
              data-tip={onto ? `Put these changes back on ${onto}, then drop the stash` : "Check out a branch to pop it onto"}
              onClick={() => run(current, true)}
            >
              {apply.isPending ? <span className="spinner" /> : <Icon name="unstash" size={13} />}
              <span className="ellipsis">Pop onto <span className="mono">{onto ?? "…"}</span></span>
            </button>
            <button className="btn btn-md" disabled={!onto || apply.isPending} data-tip="Apply and keep the stash" onClick={() => run(current, false)}>
              Apply
            </button>
            <button className="btn btn-md btn-icon" aria-label="Drop stash" data-tip="Drop stash" onClick={() => setDropping(current)}>
              <Icon name="trash" size={13} />
            </button>
          </div>
          {onto && current.branch && onto !== current.branch && (
            <span className="hint">
              Made on <span className="mono">{current.branch}</span>, which isn't checked out.
            </span>
          )}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`Actions for stash ${menu.s.sha.slice(0, 7)}`} items={items(menu.s)} onClose={() => setMenu(null)} />}
      {dropping && <DropStashModal pid={pid} stash={dropping} onDone={() => dropping.sha === selected && onPick(undefined)} onClose={() => setDropping(null)} />}
    </section>
  );
}

function DropStashModal({ pid, stash, onDone, onClose }: { pid: string; stash: Stash; onDone: () => void; onClose: () => void }) {
  const drop = useAction("stashes.drop", { invalidate: [["overview", pid], ["files", pid], ["diff", pid]], success: "Stash dropped" });
  return (
    <Modal
      title="Drop stash"
      sub={stash.message}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-md btn-danger"
            disabled={drop.isPending}
            onClick={() => drop.mutate({ projectId: pid, sha: stash.sha }, { onSuccess: () => { onDone(); onClose(); } })}
          >
            {drop.isPending && <span className="spinner" />}
            Drop
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Deletes this stash{stash.branch ? <> made on <span className="mono">{stash.branch}</span></> : null} {ago(stash.date)}. Its changes are lost unless they were applied somewhere.
      </p>
      {drop.error && <ErrorBox error={drop.error} />}
    </Modal>
  );
}
