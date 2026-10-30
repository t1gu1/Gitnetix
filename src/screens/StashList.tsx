import { useEffect, useState, type MouseEvent } from "react";

import { queryClient, useAction } from "../api/hooks";
import { rpc } from "../api/transport";
import type { Stash, StashApplied } from "../api/types";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Modal } from "../components/ui";
import { ago, plural, stashCount } from "../lib/format";
import { copyToClipboard, toast } from "../lib/toast";

/**
 * Stashes, in place of the branch tree: one branch's, or every one. Picking a
 * stash shows its files; it can then be popped, applied or dropped. Every stash's
 * list can be cleaned up: drop the picked ones at once.
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
  const [menu, setMenu] = useState<{ x: number; y: number; alignRight: boolean; s: Stash } | null>(null);
  const [dropping, setDropping] = useState<Stash | null>(null);
  const [cleaning, setCleaning] = useState(false);
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

  // Same anchoring as the branch menu: the pointer on right-click, under the button (or row, from the keyboard) otherwise.
  const openMenu = (s: Stash, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.type !== "contextmenu") return setMenu({ x: r.right, y: r.bottom + 2, alignRight: true, s });
    // Keyboard-opened context menus report (0, 0): anchor to the row instead.
    const fromKey = e.clientX === 0 && e.clientY === 0;
    setMenu({ x: fromKey ? r.left : e.clientX, y: fromKey ? r.bottom + 2 : e.clientY, alignRight: false, s });
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
  const applying = apply.isPending ? apply.variables?.sha : undefined;
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
          <span className="row" style={{ gap: 8 }}>
            <span className="faint" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{stashCount(stashes.length)}</span>
            {!branch && stashes.length > 0 && (
              <button className="btn btn-sm" title="Pick which stashes to drop" onClick={() => setCleaning(true)}>
                Clean up
              </button>
            )}
          </span>
        )}
      </div>
      <div className="scroll commits" style={{ flex: "1 1 auto" }}>
        {stashes.map((s) => {
          const to = targetOf(s);
          const pop = to ? `Pop onto ${to}, then drop the stash` : "Check out a branch to pop it onto";
          const more = `More actions for stash ${s.sha.slice(0, 7)}`;
          return (
            <div key={s.sha} className="stash-row" onContextMenu={(e) => openMenu(s, e)}>
              <button className="commit-row" aria-pressed={s.sha === selected} onClick={() => onPick(s)}>
                <span className="commit-subject">{s.message}</span>
                <span className="commit-meta">
                  {!branch && <span className="mono ellipsis">{s.branch ?? "detached HEAD"}</span>}
                  {s.untracked && <span title="Holds untracked files too">+ untracked</span>}
                  <span title={new Date(s.date).toLocaleString()} style={{ whiteSpace: "nowrap" }}>{ago(s.date)}</span>
                </span>
              </button>
              {/* Same split as a branch: the suggested action, then drop over "…". */}
              <span className="tree-acts">
                <span className="acts">
                  <button className="act act-main" disabled={!to || apply.isPending} aria-label={pop} data-tip={pop} onClick={() => run(s, true)}>
                    {applying === s.sha ? <span className="spinner" /> : <Icon name="unstash" size={16} />}
                  </button>
                  <span className="act-stack">
                    <button className="act btn-danger" aria-label="Drop stash" data-tip="Drop stash" onClick={() => setDropping(s)}>
                      <Icon name="trash" size={14} />
                    </button>
                    <button className="act" aria-label={more} data-tip={more} aria-haspopup="menu" onClick={(e) => openMenu(s, e)}>
                      <Icon name="more" size={14} />
                    </button>
                  </span>
                </span>
              </span>
            </div>
          );
        })}
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
      {menu && <ContextMenu x={menu.x} y={menu.y} alignRight={menu.alignRight} label={`Actions for stash ${menu.s.sha.slice(0, 7)}`} items={items(menu.s)} onClose={() => setMenu(null)} />}
      {dropping && <DropStashModal pid={pid} stash={dropping} onDone={() => dropping.sha === selected && onPick(undefined)} onClose={() => setDropping(null)} />}
      {cleaning && <StashCleanupModal pid={pid} stashes={stashes} onDropped={(gone) => selected && gone.includes(selected) && onPick(undefined)} onClose={() => setCleaning(false)} />}
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

/** Pick stashes to drop at once. Nothing is picked up front: each holds work kept nowhere else. */
function StashCleanupModal({ pid, stashes, onDropped, onClose }: { pid: string; stashes: Stash[]; onDropped: (shas: string[]) => void; onClose: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const flip = (sha: string) => {
    const next = new Set(picked);
    if (next.has(sha)) next.delete(sha);
    else next.add(sha);
    setPicked(next);
  };
  const all = picked.size === stashes.length;
  // One at a time: dropping shifts the stash@{n} positions the others sit at.
  const drop = async () => {
    setBusy(true);
    const gone: string[] = [];
    try {
      for (const sha of picked) {
        await rpc("stashes.drop", { projectId: pid, sha });
        gone.push(sha);
      }
    } catch (e) {
      toast((e as Error).message, "error");
    }
    for (const k of [["overview", pid], ["files", pid], ["diff", pid]]) queryClient.invalidateQueries({ queryKey: k });
    if (gone.length) toast(`Dropped ${stashCount(gone.length)}`, "ok");
    onDropped(gone);
    onClose();
  };
  return (
    <Modal
      title="Clean up stashes"
      sub={stashCount(stashes.length)}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button className="btn btn-md btn-danger" disabled={!picked.size || busy} onClick={drop}>
            {busy && <span className="spinner" />}
            Drop {stashCount(picked.size)}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>Their changes are lost unless they were applied somewhere. Pick the ones you no longer need.</p>
      <label className="check">
        <input type="checkbox" checked={all} disabled={busy} onChange={() => setPicked(all ? new Set() : new Set(stashes.map((s) => s.sha)))} />
        <span>All {stashes.length}</span>
      </label>
      <ul className="col" style={{ margin: 0, padding: 0, listStyle: "none", gap: 4 }}>
        {stashes.map((s) => (
          <li key={s.sha}>
            <label className="check">
              <input type="checkbox" checked={picked.has(s.sha)} disabled={busy} onChange={() => flip(s.sha)} />
              <span className="ellipsis">{s.message}</span>
              <span className="mono faint ellipsis">{s.branch ?? "detached HEAD"}</span>
              <span className="faint" style={{ whiteSpace: "nowrap" }}>{ago(s.date)}</span>
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
