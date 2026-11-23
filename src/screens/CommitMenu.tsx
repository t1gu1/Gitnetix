import { useState, type MouseEvent } from "react";

import { useAction, useTagV } from "../api/hooks";
import type { BranchView, Commit } from "../api/types";
import { ContextMenu, type Entry, type MenuItem } from "../components/ContextMenu";
import { ErrorBox, Modal } from "../components/ui";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { copyToClipboard } from "../lib/toast";

type ResetMode = "soft" | "mixed" | "hard";

/**
 * The right-click menu of a branch's commits, and the dialogs it opens: copy, a new branch from the commit, revert, cherry-pick
 * onto the main checkout's branch, the resets, tags. `list`: the branch's commits as shown, newest first, origin's unpulled
 * ones included; what a reset takes off the branch or brings back is counted from it. `base`: the base's name, for a reset to where the branch left it.
 * A shipped release's commits (`shipped`) reset the main checkout's branch instead, to try that release.
 * Render `el`; `open` on a commit's contextmenu event, `reset` from a button of its own.
 */
export function useCommitMenu({
  pid,
  branch,
  base,
  checkedOut,
  upstream,
  current,
  currentView,
  list,
  shipped,
  onReset,
}: {
  pid: string;
  branch: string;
  base: string;
  /** The branch has a checkout: needed to revert or reset. */
  checkedOut: boolean;
  /** The branch tracks one on origin: a reset can be force pushed there. */
  upstream: boolean;
  /** Branch of the main checkout, where cherry-picks land. */
  current?: string;
  /** Its view: what a reset onto a shipped commit loses. */
  currentView?: BranchView;
  list: Commit[];
  /** The tag of the shipped release `list` holds, not the branch's own commits: no reverts; resets move `current` there. */
  shipped?: string;
  onReset?: () => void;
}) {
  const nav = useNav();
  const [menu, setMenu] = useState<{ x: number; y: number; c: Commit } | null>(null);
  const [reset, setReset] = useState<{ c: Commit; mode: ResetMode } | null>(null);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [tagging, setTagging] = useState<Commit | null>(null);
  const inv = [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]];
  const revert = useAction<{ sha: string }>("commits.revert", { invalidate: inv, success: (r) => `Reverted · ${r.sha.slice(0, 7)}` });
  const pick = useAction<{ sha: string }>("commits.cherryPick", { invalidate: inv, success: (r) => `Cherry-picked onto ${current} · ${r.sha.slice(0, 7)}` });
  // Commits of the local branch; origin's unpulled ones are listed too: they can't be reverted, only hard reset to.
  const local = list.filter((c) => !c.unpulled);
  const unpulled = list.filter((c) => c.unpulled);
  // Rows of the local branch a reset to `c` takes off it: those above it, or all of them at the base.
  const above = (c: Commit) => (c.base ? local.length : local.findIndex((l) => l.sha === c.sha));
  // Rows with the commits folded under their merge: a reset moves those too.
  const withFolds = (rows: Commit[]) => rows.flatMap((c) => [c, ...(c.merged ?? [])]);

  const open = (c: Commit, e: MouseEvent) => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Keyboard-opened context menus report (0, 0): anchor to the row instead.
    const fromKey = e.clientX === 0 && e.clientY === 0;
    setMenu({ x: fromKey ? r.left : e.clientX, y: fromKey ? r.bottom + 2 : e.clientY, c });
  };

  const items = (c: Commit): Entry[] => {
    const short = c.sha.slice(0, 7);
    const needCheckout = shipped ? (current ? undefined : "nothing checked out") : checkedOut ? undefined : "check out first";
    // Origin's unpulled commits can't be reverted, and a soft or mixed reset forward onto one would
    // leave the commits it brings back as reversed changes: only a hard reset goes there.
    const needLocal = c.unpulled ? "pull first" : needCheckout;
    const onto = !current ? "nothing checked out" : current === branch ? "already on it" : undefined;
    const resets: MenuItem[] = [
      { id: "soft", label: "Reset here · soft", icon: "back", hint: needLocal ?? "keep staged", disabled: !!needLocal, run: () => setReset({ c, mode: "soft" }) },
      { id: "mixed", label: "Reset here · mixed", icon: "back", hint: needLocal ?? "keep unstaged", disabled: !!needLocal, run: () => setReset({ c, mode: "mixed" }) },
      { id: "hard", label: "Reset here · hard", icon: "trash", hint: needCheckout ?? "discard", danger: true, disabled: !!needCheckout, run: () => setReset({ c, mode: "hard" }) },
    ];
    const copy: MenuItem = { id: "copy", label: "Copy SHA", icon: "edit", hint: <span className="mono">{short}</span>, run: () => copyToClipboard(c.sha) };
    // Every commit listed is in `branch`'s history (a shipped release's: the default branch's), so the new branch merges there.
    const branchFrom: MenuItem = {
      id: "branchFrom",
      label: "Create a branch from that commit",
      icon: "plus",
      run: () => nav.openNewItem({ from: branch, at: { sha: c.sha, subject: c.subject, shipped: !!shipped } }),
    };
    // The base's commit: only there to reset back past the whole branch.
    if (c.base) return [copy, branchFrom, "sep", ...resets];
    const tags: MenuItem[] = [
      { id: "tag", label: "Create tag…", icon: "tag", run: () => setTagging(c) },
      ...c.tags.map((t): MenuItem => ({ id: `deleteTag:${t}`, label: <>Delete tag <span className="mono">{t}</span>…</>, icon: "trash", danger: true, run: () => setDeletingTag(t) })),
    ];
    const pickItem: MenuItem = {
      id: "pick",
      label: <>Cherry-pick onto <span className="mono">{current ?? "…"}</span></>,
      icon: "commit",
      hint: onto,
      disabled: !!onto,
      run: () => pick.mutate({ projectId: pid, onto: current, sha: c.sha }),
    };
    // A shipped commit's resets move the checked-out branch, not the list's own: named above them.
    if (shipped) return [copy, branchFrom, "sep", pickItem, "sep", ...(current ? [{ heading: <>Resets move <span className="mono">{current}</span></> }] : []), ...resets, "sep", ...tags];
    return [
      copy,
      branchFrom,
      "sep",
      { id: "revert", label: "Revert commit", icon: "undo", hint: needLocal, disabled: !!needLocal, run: () => revert.mutate({ projectId: pid, branch, sha: c.sha }) },
      pickItem,
      "sep",
      ...resets,
      "sep",
      ...tags,
    ];
  };

  const el = (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`Actions for ${menu.c.sha.slice(0, 7)}`} items={items(menu.c)} onClose={() => setMenu(null)} />}
      {reset && shipped && current && (
        <ResetModal
          pid={pid}
          branch={current}
          commit={reset.c}
          dropped={0}
          restored={0}
          lost={[]}
          shipped={{ tag: shipped, unpushed: currentView ? unpushedOf(currentView) : 0, upstream: !!currentView?.upstream }}
          mode={reset.mode}
          upstream={false}
          onMode={(mode) => setReset({ ...reset, mode })}
          onDone={() => onReset?.()}
          onClose={() => setReset(null)}
        />
      )}
      {reset && !shipped && (
        <ResetModal
          pid={pid}
          branch={branch}
          commit={reset.c}
          fork={reset.c.base ? base : undefined}
          dropped={withFolds(local.slice(0, above(reset.c))).length}
          restored={reset.c.unpulled ? withFolds(unpulled.slice(unpulled.findIndex((c) => c.sha === reset.c.sha))).length : 0}
          // Going forward onto origin drops every unpushed commit; going back, the ones above the target.
          lost={withFolds(reset.c.unpulled ? local : local.slice(0, above(reset.c))).filter((c) => c.unpushed)}
          mode={reset.mode}
          upstream={upstream}
          onMode={(mode) => setReset({ ...reset, mode })}
          onDone={() => onReset?.()}
          onClose={() => setReset(null)}
        />
      )}
      {deletingTag && <DeleteTagModal pid={pid} tag={deletingTag} onClose={() => setDeletingTag(null)} />}
      {tagging && <TagModal pid={pid} commit={tagging} onClose={() => setTagging(null)} />}
    </>
  );
  return { open, reset: (c: Commit, mode: ResetMode) => setReset({ c, mode }), el };
}

/** Commits of `b` origin never got: with no upstream, its own (the default branch's: those past the latest tag). */
const unpushedOf = (b: BranchView) => (b.upstream ? b.upstreamAhead : b.parent ? b.ahead : (b.unreleased ?? 0));

const RESET_MODES: { mode: ResetMode; label: string; hint: string }[] = [
  { mode: "soft", label: "Soft", hint: "Their changes stay staged, ready to commit again" },
  { mode: "mixed", label: "Mixed", hint: "Their changes stay in your files, unstaged" },
  { mode: "hard", label: "Hard", hint: "Their changes and any uncommitted work are thrown away" },
];

function ResetModal({
  pid,
  branch,
  commit,
  fork,
  dropped,
  restored,
  lost,
  shipped,
  mode,
  upstream,
  onMode,
  onDone,
  onClose,
}: {
  pid: string;
  branch: string;
  commit: Commit;
  /** The base branch, when `commit` is where the branch left it: the reset drops all the branch's commits. */
  fork?: string;
  /** Newer commits that leave the branch on a reset back. */
  dropped: number;
  /** Origin's commits a reset forward brings onto the branch (0: a reset back). */
  restored: number;
  /** Never pushed commits that leave the branch: a hard reset loses them. */
  lost: Commit[];
  /** `commit` is one shipped release `tag` holds: the branch moves there to try it, losing its `unpushed` commits on a hard reset. */
  shipped?: { tag: string; unpushed: number; upstream: boolean };
  mode: ResetMode;
  upstream: boolean;
  onMode: (m: ResetMode) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  const short = commit.sha.slice(0, 7);
  const reset = useAction("commits.reset", {
    invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]],
    success: `Reset ${branch} to ${short} (${mode})`,
  });
  const [forcePush, setForcePush] = useState(false);
  // At origin's tip, the branch already matches origin: nothing to push.
  const canPush = upstream && !commit.origin;
  const push = useAction("workspace.push", { invalidate: [["overview", pid], ["commits", pid]], success: `Force pushed ${branch}` });
  const done = () => { onDone(); onClose(); };
  const pending = reset.isPending || push.isPending;
  return (
    <Modal
      title={`Reset ${branch}`}
      sub={<><span className="mono">{short}</span> {commit.subject}</>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" autoFocus={mode === "hard"} onClick={onClose}>
            Back
          </button>
          <button
            className={`btn btn-md ${mode === "hard" ? "btn-danger" : "btn-primary"}`}
            disabled={pending}
            onClick={() =>
              reset.mutate(
                { projectId: pid, branch, sha: commit.sha, mode, shipped: !!shipped },
                // A failed push keeps the modal open on its error; the reset already happened.
                { onSuccess: () => (forcePush && canPush ? push.mutate({ projectId: pid, branch, force: true }, { onSuccess: done }) : done()) },
              )
            }
          >
            {pending && <span className="spinner" />}
            Reset ({mode}){forcePush && canPush && " & force push"}
          </button>
        </>
      }
    >
      {restored > 0 ? (
        <p style={{ margin: 0, lineHeight: 1.55 }}>
          Moves <span className="mono">{branch}</span> forward to this commit, bringing back {plural(restored, "commit")} from origin.
          Uncommitted work is thrown away.
        </p>
      ) : (
        <>
          {shipped ? (
            <p style={{ margin: 0, lineHeight: 1.55 }}>
              Moves <span className="mono">{branch}</span> to this commit, shipped in <span className="mono">{shipped.tag}</span>, to try that release.
              Its newer commits leave the branch{shipped.upstream ? "; Reset to origin brings them back" : ""}. Nothing is pushed.
            </p>
          ) : fork ? (
            <p style={{ margin: 0, lineHeight: 1.55 }}>
              Moves <span className="mono">{branch}</span> back to where it left <span className="mono">{fork}</span>.{" "}
              {dropped === 1 ? "Its commit leaves" : <>All {dropped} of its commits leave</>} the branch. If they were pushed, the next push must be forced.
            </p>
          ) : (
            <p style={{ margin: 0, lineHeight: 1.55 }}>
              Moves <span className="mono">{branch}</span> back to this commit.{" "}
              {dropped > 0 ? <>The {plural(dropped, "newer commit")} leave the branch.</> : "No commits leave the branch."} If they were pushed, the next push must be forced.
            </p>
          )}
          <div role="radiogroup" aria-label="Reset mode" className="col" style={{ gap: 6 }}>
            {RESET_MODES.map((m) => (
              <button key={m.mode} className="radio-card" role="radio" aria-checked={mode === m.mode} onClick={() => onMode(m.mode)}>
                <span className="radio-dot" />
                <span className="col" style={{ gap: 2 }}>
                  <span style={{ fontWeight: 500 }} className={m.mode === "hard" ? "c-del" : undefined}>{m.label}</span>
                  <span className="hint">{m.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {shipped && mode === "hard" && shipped.unpushed > 0 && (
        <div className="err-box warn">
          {shipped.unpushed === 1 ? "1 commit" : `${shipped.unpushed} commits`} on <span className="mono">{branch}</span> never pushed: a hard reset loses{" "}
          {shipped.unpushed === 1 ? "it" : "them"}.
        </div>
      )}
      {mode === "hard" && lost.length > 0 && (
        <div className="err-box warn">
          {lost.length === 1 ? "This commit was" : `These ${lost.length} commits were`} never pushed: a hard reset loses {lost.length === 1 ? "it" : "them"}.
          <ul className="lost-commits">
            {lost.map((c) => (
              <li key={c.sha} className="ellipsis">
                <span className="mono">{c.sha.slice(0, 7)}</span> {c.subject}
              </li>
            ))}
          </ul>
        </div>
      )}
      {canPush && (
        <label className="check">
          <input type="checkbox" checked={forcePush} onChange={() => setForcePush(!forcePush)} />
          <span>Force push to origin after the reset</span>
        </label>
      )}
      {reset.error && <ErrorBox error={reset.error} />}
      {push.error && <ErrorBox error={push.error} />}
    </Modal>
  );
}

/** Tag one commit and push the tag. A branch tip is tagged through Create tag & Update changelog. */
export function TagModal({ pid, commit, onClose }: { pid: string; commit: Commit; onClose: () => void }) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const { label } = useTagV(pid);
  const what = commit.sha.slice(0, 7);
  const tag = useAction("commits.tag", { invalidate: [["overview", pid], ["commits", pid]], success: `Tagged ${what} as ${name.trim()} and pushed it` });
  const submit = () => name.trim() && tag.mutate({ projectId: pid, sha: commit.sha, name: name.trim(), message }, { onSuccess: onClose });
  return (
    <Modal
      title="Create tag"
      sub={<><span className="mono">{what}</span> {commit.subject}</>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-primary" disabled={!name.trim() || tag.isPending} onClick={submit}>
            {tag.isPending && <span className="spinner" />}
            Create and push
          </button>
        </>
      }
    >
      <form className="col" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field">
          <label htmlFor="tag-name">Name</label>
          <input id="tag-name" className="input mono" placeholder={label("1.2.0")} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tag-msg">Message</label>
          <input id="tag-msg" className="input" placeholder="Defaults to the name" value={message} onChange={(e) => setMessage(e.target.value)} />
        </div>
      </form>
      {tag.error && <ErrorBox error={tag.error} />}
    </Modal>
  );
}

export function DeleteTagModal({ pid, tag, onClose }: { pid: string; tag: string; onClose: () => void }) {
  const del = useAction("tags.delete", { invalidate: [["overview", pid], ["commits", pid]], success: `Deleted tag ${tag}` });
  return (
    <Modal
      title="Delete tag"
      sub={<span className="mono">{tag}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" autoFocus onClick={onClose}>
            Back
          </button>
          <button className="btn btn-md btn-danger" disabled={del.isPending} onClick={() => del.mutate({ projectId: pid, name: tag }, { onSuccess: onClose })}>
            {del.isPending && <span className="spinner" />}
            Delete tag
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Deletes <span className="mono">{tag}</span> locally and on origin, for everyone who uses it. The commits it points at stay.
      </p>
      {del.error && <ErrorBox error={del.error} />}
    </Modal>
  );
}
