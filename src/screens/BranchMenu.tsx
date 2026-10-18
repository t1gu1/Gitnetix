import { useState, type MouseEvent } from "react";

import { useAction } from "../api/hooks";
import type { BranchView } from "../api/types";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { copyToClipboard, toast } from "../lib/toast";

export type BranchDialog = "merge" | "delete" | "conflicts";

export interface BranchTarget {
  view: BranchView;
  /** Branch it merges into / rebases onto ("" for the default branch). */
  base: string;
  /** How to show `base` (a release branch reads as its version). */
  baseLabel: string;
  isDefault: boolean;
  /** Branch of an open release: can't be deleted. */
  isRelease?: boolean;
  /** Extra actions listed first in the menu (e.g. release actions). */
  extra?: MenuItem[];
  /** Suggested once nothing is more urgent (e.g. Ship for a release). */
  next?: Action;
  /** Other branches it could merge into instead. */
  moveTo?: { branch: string; label: string }[];
  /** Opens the branch's commit list. */
  showCommits?: () => void;
}

export type Action = Exclude<MenuItem, "sep"> & { short?: string; /** Plain-text tooltip for the split button. */ tip?: string };

interface BranchMutation {
  mutate(vars: { projectId: string; branch: string }, opts: { onSuccess: () => void }): void;
}

/**
 * Every branch action in one place: the context menu, and the primary
 * action the split button offers for the branch's role and state.
 */
export function useBranchActions(pid: string, openDialog: (d: BranchDialog, branch: string) => void) {
  const nav = useNav();
  const inv = [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]];
  const sw = useAction<unknown, { projectId: string; branch: string }>("workspace.switch", { invalidate: inv });
  const wt = useAction<{ path: string }, { projectId: string; branch: string }>("worktrees.create", { invalidate: [...inv, ["worktrees"]], success: (r) => `Worktree at ${r.path}` });
  const pull = useAction<{ output: string }, { projectId: string; branch: string }>("branches.pull", { invalidate: inv });
  const push = useAction<{ output: string }, { projectId: string; branch: string }>("workspace.push", { invalidate: inv });
  const rebase = useAction<{ conflicts: string[] }, { projectId: string; branch: string }>("workspace.rebase", {
    invalidate: inv,
    success: (r) => (r.conflicts.length ? `Rebase stopped on ${plural(r.conflicts.length, "conflict")}` : "Rebased, no conflicts"),
  });
  const sync = useAction<unknown, { projectId: string; branch: string }>("branches.sync", { invalidate: inv });
  const pr = useAction<{ number: number }, { projectId: string; branch: string }>("prs.create", { invalidate: [["prs", pid]], success: (r) => `Opened PR #${r.number}` });
  const move = useAction("branches.setParent", { invalidate: inv });
  const [menu, setMenu] = useState<{ x: number; y: number; alignRight: boolean; t: BranchTarget } | null>(null);

  const mutations = [sw, wt, pull, push, rebase, sync, pr];
  const busy = mutations.find((m) => m.isPending)?.variables?.branch;
  const run = (m: BranchMutation, branch: string, ok: string) => m.mutate({ projectId: pid, branch }, { onSuccess: () => toast(ok, "ok") });

  const all = (t: BranchTarget) => {
    const v = t.view;
    const b = v.name;
    const parent = t.baseLabel;
    const originOnly = v.remote && !v.local;
    return {
      switch: {
        id: "switch",
        label: originOnly ? "Check out from origin" : "Switch to branch",
        short: originOnly ? "Check out" : "Switch",
        tip: originOnly ? `Only on origin: create a local ${b} that tracks it and switch to it` : `Check out ${b}`,
        icon: "swap",
        run: () => run(sw, b, `Switched to ${b}`),
      },
      worktree: { id: "worktree", label: "Open in worktree", tip: `Open ${b} in its own worktree`, icon: "layers", run: () => wt.mutate({ projectId: pid, branch: b }) },
      pull: {
        id: "pull",
        label: v.upstream ? <>Pull from <span className="mono">{v.upstream}</span></> : "Pull",
        short: v.upstreamBehind ? `Pull ${v.upstreamBehind}` : "Pull",
        tip: !v.upstream ? "No upstream to pull from" : v.upstreamBehind ? `Pull ${plural(v.upstreamBehind, "commit")} from ${v.upstream}` : `Pull from ${v.upstream}`,
        icon: "refresh",
        hint: v.upstreamBehind ? `↓${v.upstreamBehind}` : undefined,
        disabled: !v.upstream,
        run: () => run(pull, b, `Pulled ${b}`),
      },
      push: {
        id: "push",
        label: v.upstream ? "Push" : "Publish to origin",
        short: v.upstream ? `Push ${v.upstreamAhead || ""}`.trim() : "Publish",
        tip: !v.upstream ? `Publish ${b} to origin` : v.upstreamAhead ? `Push ${plural(v.upstreamAhead, "commit")} to ${v.upstream}` : `Push to ${v.upstream}`,
        icon: "push",
        hint: v.upstreamAhead ? `↑${v.upstreamAhead}` : undefined,
        run: () => run(push, b, `Pushed ${b}`),
      },
      rebase: {
        id: "rebase",
        label: <>Rebase onto <span className="mono">{parent}</span></>,
        short: "Rebase",
        tip: !v.checkedOut ? `Check out ${b} to rebase it` : v.behind ? `Replay ${b} on top of ${parent} (${plural(v.behind, "commit")} behind)` : `Rebase onto ${parent}`,
        icon: "branch",
        hint: v.checkedOut ? (v.behind ? `${v.behind} behind` : undefined) : "check out first",
        disabled: !v.checkedOut || !t.base,
        run: () => rebase.mutate({ projectId: pid, branch: b }),
      },
      sync: {
        id: "sync",
        label: <>Merge <span className="mono">{parent}</span> into this</>,
        short: "Update",
        tip: v.behind ? `Merge the ${plural(v.behind, "new commit")} from ${parent} into ${b}` : `${b} already has everything in ${parent}`,
        icon: "refresh",
        hint: v.behind ? `↓${v.behind}` : undefined,
        disabled: !t.base || !v.behind,
        run: () => run(sync, b, `${b} is up to date with ${parent}`),
      },
      merge: {
        id: "merge",
        label: <>Merge into <span className="mono">{parent}</span>…</>,
        short: "Merge",
        tip: v.ahead ? `Merge ${plural(v.ahead, "commit")} into ${parent}` : `Nothing to merge into ${parent}`,
        icon: "merged",
        hint: v.ahead ? plural(v.ahead, "commit") : "nothing to merge",
        disabled: !t.base || !v.ahead,
        run: () => openDialog("merge", b),
      },
      conflicts: { id: "conflicts", label: "Resolve conflicts…", short: "Resolve", tip: `Resolve conflicts with ${parent}`, icon: "sparkle", run: () => openDialog("conflicts", b) },
      pr: {
        id: "pr",
        label: <>Open pull request into <span className="mono">{parent}</span></>,
        icon: "pr",
        disabled: !t.base,
        run: () => pr.mutate({ projectId: pid, branch: b }, { onSuccess: (r) => nav.go({ name: "prs", number: r.number }) }),
      },
      copy: { id: "copy", label: "Copy branch name", icon: "edit", run: () => copyToClipboard(b) },
      delete: {
        id: "delete",
        label: v.exists ? "Delete branch…" : "Forget branch…",
        short: v.exists ? "Delete" : "Forget",
        tip: !v.exists ? `${b} no longer exists: remove it from the list` : v.merged ? `${b} is merged into ${parent}: delete the local branch` : `Delete ${b}`,
        icon: "trash",
        danger: true,
        run: () => openDialog("delete", b),
      },
    } satisfies Record<string, Action>;
  };

  const items = (t: BranchTarget): MenuItem[] => {
    const a = all(t);
    const v = t.view;
    if (!v.exists) return [a.delete];
    const list: MenuItem[] = t.extra?.length ? [...t.extra, "sep"] : [];
    if (v.conflict) list.push(a.conflicts, "sep");
    if (!v.checkedOut) list.push(a.switch, a.worktree, "sep");
    if (v.local) {
      list.push(a.pull, a.push);
      if (t.base) {
        list.push("sep");
        // Shared branches (releases, dev) catch up by merging; work branches can also be rebased.
        if (v.role === "branch") list.push(a.rebase);
        list.push(a.sync);
        if (v.role !== "release") list.push(a.merge);
      }
    }
    if (t.base) list.push(a.pr);
    if (t.moveTo?.length) {
      list.push("sep");
      for (const m of t.moveTo) {
        list.push({ id: `move-${m.branch}`, label: <>Target <span className="mono">{m.label}</span></>, icon: "merged", run: () => move.mutate({ projectId: pid, branch: v.name, parent: m.branch }) });
      }
    }
    list.push("sep");
    if (t.showCommits) list.push({ id: "commits", label: "Show commits", icon: "commit", run: t.showCommits });
    list.push(a.copy);
    if (v.local && !t.isDefault && !t.isRelease) list.push("sep", a.delete);
    return list;
  };

  /** What the user most likely wants next for this branch. */
  const primary = (t: BranchTarget): Action => {
    const a = all(t);
    const v = t.view;
    if (!v.exists) return a.delete;
    if (v.conflict) return a.conflicts;
    if (!v.local) return a.switch;
    if (v.upstreamBehind > 0) return a.pull;
    const needsPush = v.upstreamAhead > 0 || (!v.upstream && v.ahead > 0);
    if (v.role !== "branch") {
      // Releases and trunks are shared: catch up with the base by merging, no checkout needed.
      if (v.behind > 0 && t.base) return a.sync;
      if (needsPush) return a.push;
      if (t.next && !t.next.disabled) return t.next;
      if (v.role === "trunk" && t.base && v.ahead > 0) return a.merge;
      if (!v.checkedOut) return a.switch;
      return v.upstream ? a.pull : a.push;
    }
    if (v.merged && !v.checkedOut) return a.delete;
    if (!v.checkedOut) return a.switch;
    if (needsPush) return a.push;
    if (v.behind > 0) return a.rebase;
    if (v.ahead > 0) return a.merge;
    return v.upstream ? a.pull : a.push;
  };

  const openMenu = (t: BranchTarget, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Keyboard-opened context menus report (0, 0): anchor to the element instead.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fromKey = e.type === "contextmenu" && e.clientX === 0 && e.clientY === 0;
    if (e.type !== "contextmenu") setMenu({ x: r.right, y: r.bottom + 2, alignRight: true, t });
    else setMenu({ x: fromKey ? r.left : e.clientX, y: fromKey ? r.bottom + 2 : e.clientY, alignRight: false, t });
  };

  const switchTo = (b: string) => run(sw, b, `Switched to ${b}`);

  const menuEl = menu && <ContextMenu x={menu.x} y={menu.y} alignRight={menu.alignRight} label={`Actions for ${menu.t.view.name}`} items={items(menu.t)} onClose={() => setMenu(null)} />;

  return { primary, openMenu, menuEl, busy, switchTo };
}

export type BranchActions = ReturnType<typeof useBranchActions>;

/** Primary action for the branch's state, plus a "…" button with every action. */
export function BranchSplit({ t, actions, size = "sm" }: { t: BranchTarget; actions: BranchActions; size?: "sm" | "md" }) {
  const p = actions.primary(t);
  const busy = actions.busy === t.view.name;
  const cls = size === "sm" ? "btn btn-sm" : "btn";
  return (
    <span className="split" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button className={`${cls} split-main${p.danger ? " btn-danger" : ""}`} disabled={p.disabled || busy} data-tip={p.tip ?? (typeof p.label === "string" ? p.label : undefined)} onClick={p.run}>
        {busy ? <span className="spinner" /> : p.icon && <Icon name={p.icon} size={12} />}
        <span>{p.short ?? p.label}</span>
      </button>
      <button className={`${cls} btn-icon split-more`} aria-label={`More actions for ${t.view.name}`} aria-haspopup="menu" onClick={(e) => actions.openMenu(t, e)}>
        <Icon name="more" size={13} />
      </button>
    </span>
  );
}
