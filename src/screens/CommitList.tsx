import { useEffect, useState, type MouseEvent } from "react";

import { useAction, useCommits } from "../api/hooks";
import type { Commit } from "../api/types";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Loading, Modal } from "../components/ui";
import { ago, plural } from "../lib/format";
import { copyToClipboard } from "../lib/toast";

type ResetMode = "soft" | "mixed" | "hard";

/**
 * A branch's own commits, in place of the branch tree. "All changes" on top is
 * the branch's combined diff; picking a commit shows just its files.
 */
export function CommitList({
  active,
  pid,
  branch,
  base,
  selected,
  checkedOut,
  current,
  onPick,
  onBack,
}: {
  active: boolean;
  pid: string;
  branch: string;
  /** Branch it is compared with ("" for a trunk: its recent history). */
  base: string;
  /** Picked commit; undefined = all changes. */
  selected?: string;
  /** The branch has a checkout: needed to revert or reset. */
  checkedOut: boolean;
  /** Branch of the main checkout, where cherry-picks land. */
  current?: string;
  onPick: (c?: Commit) => void;
  onBack: () => void;
}) {
  const commits = useCommits(pid, branch);
  const list = commits.data ?? [];
  const [menu, setMenu] = useState<{ x: number; y: number; c: Commit } | null>(null);
  const [reset, setReset] = useState<{ c: Commit; mode: ResetMode } | null>(null);
  const inv = [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]];
  const revert = useAction<{ sha: string }>("commits.revert", { invalidate: inv, success: (r) => `Reverted · ${r.sha.slice(0, 7)}` });
  const pick = useAction<{ sha: string }>("commits.cherryPick", { invalidate: inv, success: (r) => `Cherry-picked onto ${current} · ${r.sha.slice(0, 7)}` });

  const openMenu = (c: Commit, e: MouseEvent) => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Keyboard-opened context menus report (0, 0): anchor to the row instead.
    const fromKey = e.clientX === 0 && e.clientY === 0;
    setMenu({ x: fromKey ? r.left : e.clientX, y: fromKey ? r.bottom + 2 : e.clientY, c });
  };

  const items = (c: Commit): MenuItem[] => {
    const short = c.sha.slice(0, 7);
    const needCheckout = checkedOut ? undefined : "check out first";
    const onto = !current ? "nothing checked out" : current === branch ? "already on it" : undefined;
    return [
      { id: "copy", label: "Copy SHA", icon: "edit", hint: short, run: () => copyToClipboard(c.sha) },
      "sep",
      { id: "revert", label: "Revert commit", icon: "undo", hint: needCheckout, disabled: !checkedOut, run: () => revert.mutate({ projectId: pid, branch, sha: c.sha }) },
      {
        id: "pick",
        label: <>Cherry-pick onto <span className="mono">{current ?? "…"}</span></>,
        icon: "commit",
        hint: onto,
        disabled: !!onto,
        run: () => pick.mutate({ projectId: pid, onto: current, sha: c.sha }),
      },
      "sep",
      { id: "soft", label: "Reset here · soft", icon: "back", hint: needCheckout ?? "keep staged", disabled: !checkedOut, run: () => setReset({ c, mode: "soft" }) },
      { id: "mixed", label: "Reset here · mixed", icon: "back", hint: needCheckout ?? "keep unstaged", disabled: !checkedOut, run: () => setReset({ c, mode: "mixed" }) },
      { id: "hard", label: "Reset here · hard", icon: "trash", hint: needCheckout ?? "discard", danger: true, disabled: !checkedOut, run: () => setReset({ c, mode: "hard" }) },
    ];
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

  return (
    <section aria-label={`Commits of ${branch}`} className="ws-releases" data-pane data-active={active}>
      <div className="pane-head">
        <span className="row" style={{ gap: 6, minWidth: 0 }}>
          <button className="btn btn-sm btn-icon pane-toggle" aria-label="Back to branches" data-tip="Back to branches (Esc)" onClick={onBack}>
            <Icon name="back" size={13} />
          </button>
          <span className="mono ellipsis" style={{ fontSize: 12.5 }}>{branch}</span>
        </span>
        {commits.data && <span className="faint" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{plural(list.length, "commit")}</span>}
      </div>
      <div className="scroll commits" style={{ flex: "1 1 auto" }}>
        {commits.isLoading && <Loading />}
        {commits.error && <div style={{ padding: 12 }}><ErrorBox error={commits.error} /></div>}
        {base && list.length > 0 && (
          <button className="commit-row" aria-pressed={!selected} onClick={() => onPick(undefined)}>
            <span className="commit-subject">All changes</span>
            <span className="commit-meta">
              {plural(list.length, "commit")} combined, since <span className="mono">{base}</span>
            </span>
          </button>
        )}
        {list.map((c) => (
          <button key={c.sha} className="commit-row" aria-pressed={c.sha === selected} onClick={() => onPick(c)} onContextMenu={(e) => openMenu(c, e)}>
            {c.tags.length > 0 && (
              <span className="commit-tags">
                {c.tags.map((t) => (
                  <span key={t} className="commit-tag mono" title={`Tag ${t}`}>
                    <Icon name="tag" size={10} stroke={1.6} />
                    {t}
                  </span>
                ))}
              </span>
            )}
            <span className="commit-subject">{c.subject}</span>
            {c.body && <span className="commit-body">{c.body}</span>}
            <span className="commit-meta">
              <span className="mono">{c.sha.slice(0, 7)}</span>
              <span className="ellipsis">{c.author}</span>
              <span title={new Date(c.date).toLocaleString()} style={{ whiteSpace: "nowrap" }}>{ago(c.date)}</span>
            </span>
          </button>
        ))}
        {commits.data && list.length === 0 && <Empty>{base ? <>No commits that <span className="mono">{base}</span> doesn't have.</> : "No commits yet."}</Empty>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`Actions for ${menu.c.sha.slice(0, 7)}`} items={items(menu.c)} onClose={() => setMenu(null)} />}
      {reset && (
        <ResetModal
          pid={pid}
          branch={branch}
          commit={reset.c}
          dropped={list.findIndex((c) => c.sha === reset.c.sha)}
          mode={reset.mode}
          onMode={(mode) => setReset({ ...reset, mode })}
          onDone={() => onPick(undefined)}
          onClose={() => setReset(null)}
        />
      )}
    </section>
  );
}

const RESET_MODES: { mode: ResetMode; label: string; hint: string }[] = [
  { mode: "soft", label: "Soft", hint: "Their changes stay staged, ready to commit again" },
  { mode: "mixed", label: "Mixed", hint: "Their changes stay in your files, unstaged" },
  { mode: "hard", label: "Hard", hint: "Their changes and any uncommitted work are thrown away" },
];

function ResetModal({
  pid,
  branch,
  commit,
  dropped,
  mode,
  onMode,
  onDone,
  onClose,
}: {
  pid: string;
  branch: string;
  commit: Commit;
  /** Newer commits that leave the branch. */
  dropped: number;
  mode: ResetMode;
  onMode: (m: ResetMode) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  const short = commit.sha.slice(0, 7);
  const reset = useAction("commits.reset", {
    invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]],
    success: `Reset ${branch} to ${short} (${mode})`,
  });
  return (
    <Modal
      title={`Reset ${branch}`}
      sub={<><span className="mono">{short}</span> {commit.subject}</>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button
            className={`btn btn-md ${mode === "hard" ? "btn-danger" : "btn-primary"}`}
            disabled={reset.isPending}
            onClick={() => reset.mutate({ projectId: pid, branch, sha: commit.sha, mode }, { onSuccess: () => { onDone(); onClose(); } })}
          >
            {reset.isPending && <span className="spinner" />}
            Reset ({mode})
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Moves <span className="mono">{branch}</span> back to this commit.{" "}
        {dropped > 0 ? <>The {plural(dropped, "newer commit")} leave the branch.</> : "No commits leave the branch."} If they were pushed, the next push must be forced.
      </p>
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
      {reset.error && <ErrorBox error={reset.error} />}
    </Modal>
  );
}
