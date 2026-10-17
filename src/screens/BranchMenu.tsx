import { useState, type MouseEvent } from "react";

import { useAction } from "../api/hooks";
import type { BranchView } from "../api/types";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { kindOfBranch } from "../lib/kinds";
import { useNav } from "../lib/nav";
import { copyToClipboard, toast } from "../lib/toast";

export type BranchDialog = "merge" | "delete" | "conflicts";

export interface BranchTarget {
  view: BranchView;
  /** Branch it merges into / rebases onto. */
  base: string;
  isDefault: boolean;
  /** Branch of an open release: can't be deleted. */
  isRelease?: boolean;
  /** Extra actions listed first in the menu (e.g. release actions). */
  extra?: MenuItem[];
  /** Open releases an unattached branch can join. */
  attachTo?: string[];
}

type Action = Exclude<MenuItem, "sep"> & { short?: string };

interface BranchMutation {
  mutate(vars: { projectId: string; branch: string }, opts: { onSuccess: () => void }): void;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Every branch action in one place: the context menu, and the primary
 * action the split button offers for the branch's current state.
 */
export function useBranchActions(pid: string, openDialog: (d: BranchDialog, branch: string) => void) {
  const nav = useNav();
  const inv = [["overview", pid], ["files", pid], ["diff", pid]];
  const sw = useAction<unknown, { projectId: string; branch: string }>("workspace.switch", { invalidate: inv });
  const wt = useAction<{ path: string }, { projectId: string; branch: string }>("worktrees.create", { invalidate: [...inv, ["worktrees"]], success: (r) => `Worktree at ${r.path}` });
  const pull = useAction<{ output: string }, { projectId: string; branch: string }>("branches.pull", { invalidate: inv });
  const push = useAction<{ output: string }, { projectId: string; branch: string }>("workspace.push", { invalidate: inv });
  const rebase = useAction<{ conflicts: string[] }, { projectId: string; branch: string }>("workspace.rebase", {
    invalidate: inv,
    success: (r) => (r.conflicts.length ? `Rebase stopped on ${plural(r.conflicts.length, "conflict")}` : "Rebased, no conflicts"),
  });
  const pr = useAction<{ number: number }, { projectId: string; branch: string }>("prs.create", { invalidate: [["prs", pid]], success: (r) => `Opened PR #${r.number}` });
  const attach = useAction("items.attach", { invalidate: [["overview", pid]] });
  const [menu, setMenu] = useState<{ x: number; y: number; alignRight: boolean; t: BranchTarget } | null>(null);

  const mutations = [sw, wt, pull, push, rebase, pr];
  const busy = mutations.find((m) => m.isPending)?.variables?.branch;
  const run = (m: BranchMutation, branch: string, ok: string) => m.mutate({ projectId: pid, branch }, { onSuccess: () => toast(ok, "ok") });

  const all = (t: BranchTarget): Record<string, Action> => {
    const v = t.view;
    const b = v.name;
    const mergeable = !t.isDefault && t.base !== b;
    return {
      switch: { id: "switch", label: "Switch to branch", short: "Switch", icon: "swap", run: () => run(sw, b, `Switched to ${b}`) },
      worktree: { id: "worktree", label: "Open in worktree", icon: "layers", run: () => wt.mutate({ projectId: pid, branch: b }) },
      pull: {
        id: "pull",
        label: v.upstream ? <>Pull from <span className="mono">{v.upstream}</span></> : "Pull",
        short: v.upstreamBehind ? `Pull ${v.upstreamBehind}` : "Pull",
        icon: "refresh",
        hint: v.upstreamBehind ? `↓${v.upstreamBehind}` : undefined,
        disabled: !v.upstream,
        run: () => run(pull, b, `Pulled ${b}`),
      },
      push: {
        id: "push",
        label: v.upstream ? "Push" : "Publish to origin",
        short: v.upstream ? `Push ${v.upstreamAhead || ""}`.trim() : "Publish",
        icon: "push",
        hint: v.upstreamAhead ? `↑${v.upstreamAhead}` : undefined,
        run: () => run(push, b, `Pushed ${b}`),
      },
      rebase: {
        id: "rebase",
        label: <>Rebase onto <span className="mono">{t.base}</span></>,
        short: "Rebase",
        icon: "branch",
        hint: v.checkedOut ? (v.behind ? `${v.behind} behind` : undefined) : "check out first",
        disabled: !v.checkedOut || !mergeable,
        run: () => rebase.mutate({ projectId: pid, branch: b }),
      },
      merge: {
        id: "merge",
        label: <>Merge into <span className="mono">{t.base}</span>…</>,
        short: "Merge",
        icon: "check",
        hint: v.ahead ? plural(v.ahead, "commit") : "nothing to merge",
        disabled: !mergeable || !v.ahead,
        run: () => openDialog("merge", b),
      },
      conflicts: { id: "conflicts", label: "Resolve conflicts…", short: "Resolve", icon: "sparkle", run: () => openDialog("conflicts", b) },
      pr: {
        id: "pr",
        label: "Open pull request",
        icon: "pr",
        disabled: !mergeable,
        run: () => pr.mutate({ projectId: pid, branch: b }, { onSuccess: (r) => nav.go({ name: "prs", number: r.number }) }),
      },
      copy: { id: "copy", label: "Copy branch name", icon: "edit", run: () => copyToClipboard(b) },
      delete: { id: "delete", label: v.exists ? "Delete branch…" : "Forget branch…", icon: "trash", danger: true, run: () => openDialog("delete", b) },
    };
  };

  const items = (t: BranchTarget): MenuItem[] => {
    const a = all(t);
    if (!t.view.exists) return [a.delete];
    const list: MenuItem[] = t.extra?.length ? [...t.extra, "sep"] : [];
    if (t.view.conflict) list.push(a.conflicts, "sep");
    if (!t.view.checkedOut) list.push(a.switch, a.worktree, "sep");
    list.push(a.pull, a.push, "sep", a.rebase, a.merge, a.pr);
    for (const r of t.attachTo ?? []) {
      list.push({
        id: `attach-${r}`,
        label: <>Attach to v{r}</>,
        icon: "tag",
        run: () => attach.mutate({ projectId: pid, branch: t.view.name, release: r, kind: kindOfBranch(t.view.name) ?? "feat" }),
      });
    }
    list.push("sep", a.copy);
    if (!t.isDefault && !t.isRelease) list.push("sep", a.delete);
    return list;
  };

  /** What the user most likely wants next for this branch. */
  const primary = (t: BranchTarget): Action => {
    const a = all(t);
    const v = t.view;
    if (!v.exists) return { ...a.delete, short: "Forget" };
    if (v.conflict) return a.conflicts;
    if (v.upstreamBehind > 0) return a.pull;
    if (!v.checkedOut) return a.switch;
    if (v.upstreamAhead > 0 || (!v.upstream && v.ahead > 0)) return a.push;
    if (!a.rebase.disabled && v.behind > 0) return a.rebase;
    if (!a.merge.disabled) return a.merge;
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

  const menuEl = menu && <ContextMenu x={menu.x} y={menu.y} alignRight={menu.alignRight} label={`Actions for ${menu.t.view.name}`} items={items(menu.t)} onClose={() => setMenu(null)} />;

  return { primary, openMenu, menuEl, busy };
}

export type BranchActions = ReturnType<typeof useBranchActions>;

/** Primary action for the branch's state, plus a "…" button with every action. */
export function BranchSplit({ t, actions, size = "sm" }: { t: BranchTarget; actions: BranchActions; size?: "sm" | "md" }) {
  const p = actions.primary(t);
  const busy = actions.busy === t.view.name;
  const cls = size === "sm" ? "btn btn-sm" : "btn";
  return (
    <span className="split" onClick={(e) => e.stopPropagation()}>
      <button className={`${cls} split-main${p.danger ? " btn-danger" : ""}`} disabled={p.disabled || busy} title={typeof p.label === "string" ? p.label : undefined} onClick={p.run}>
        {busy ? <span className="spinner" /> : p.icon && <Icon name={p.icon} size={12} />}
        <span>{p.short ?? p.label}</span>
      </button>
      <button className={`${cls} btn-icon split-more`} aria-label={`More actions for ${t.view.name}`} aria-haspopup="menu" onClick={(e) => actions.openMenu(t, e)}>
        <Icon name="more" size={13} />
      </button>
    </span>
  );
}
