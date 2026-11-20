import { useMemo, useState, type MouseEvent } from "react";

import { committed, droppedWorktree, patchOverview, patchWip, pushed, queryClient, settle, switchedOverview, useAction, useAgents, useAiOn, useOverview, usePendingBranches, useProjectPrefs, useTagV } from "../api/hooks";
import { RpcError } from "../api/transport";
import type { BranchView, MergeResult, Overview, RenameResult, Stash, StashApplied } from "../api/types";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { showRun, useLocks, useRebasing } from "../lib/rebaseRuns";
import { call, runTask, wtKey } from "../lib/tasks";
import { copyToClipboard, toast } from "../lib/toast";
import { publishName } from "./Publish";
import { startRebase } from "./RebaseRun";
import { childrenOf } from "./UpdateChildren";

export type BranchDialog = "commit" | "merge" | "delete" | "rename" | "continue" | "reset" | "forcePush" | "publish" | "target" | "rebase" | "rebaseOnto" | "abortSwitch" | "abort" | "switchWip" | "pullWip" | "children";

export interface BranchTarget {
  view: BranchView;
  /** Branch it merges into / rebases onto ("" for the default branch). */
  base: string;
  /** How to show `base` (a release branch reads as its version). */
  baseLabel: string;
  /** The default branch: can't be deleted. */
  isDefault: boolean;
  /** Extra actions listed first in the menu (e.g. a shipped release's tag). */
  extra?: MenuItem[];
  /** Other branches it could merge into instead. */
  moveTo?: { branch: string; label: string }[];
  /** Any branch can be picked as its target instead (every branch but the default one). */
  pickTarget?: boolean;
  /** Opens the stashes made on the branch (none: it has none). */
  showStashes?: () => void;
  /** Newest stash made on the branch. */
  latestStash?: Stash;
}

export type Action = Exclude<MenuItem, "sep"> & { short?: string; /** Plain-text tooltip for the split button. */ tip?: string };

interface BranchMutation {
  mutate(vars: { projectId: string; branch: string }, opts: { onSuccess: () => void }): void;
}

/** After a target change: offer to rebase onto the new target (only checked-out work branches get rebased; a worktree's branch catches up by merging). */
export const offersRebase = (v?: BranchView) => !!v && v.role === "branch" && v.checkedOut && !v.worktree;

/** Origin and local each have commits the other lacks (e.g. rebased): origin only takes it forced. */
const isDiverged = (v: BranchView) => !!v.upstream && v.upstreamAhead > 0 && v.upstreamBehind > 0;

/**
 * Commits on a branch, in whichever checkout it has: its staged files, or `all` its changes. An empty message lets AI write it.
 * The branch is pushed after when the project auto-pushes. Rejects when the commit fails (its error is shown already).
 */
export function useCommit(pid: string) {
  const inv = [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]];
  const commit = useAction<{ sha: string; message: string; aiWritten: boolean }, { projectId: string; branch: string; message: string; all: boolean }>("workspace.commit", {
    invalidate: inv,
    // The WIP list, badge and push count follow the commit at once instead of waiting for the full overview.
    patch: (qc, v) => {
      patchWip(qc, pid, v.branch, (l) => (v.all ? [] : l.filter((f) => !f.staged)));
      patchOverview(qc, pid, v.branch, committed);
    },
    success: (r) => `${r.aiWritten ? "AI wrote: " : "Committed: "}${r.message.split("\n")[0]}`,
  });
  const push = useAction<unknown, { projectId: string; branch: string }>("workspace.push", { invalidate: inv, patch: (qc, v) => patchOverview(qc, pid, v.branch, pushed), success: (_, v) => `Pushed ${v.branch}` });
  // Saved with the project, like the merge options.
  const autoPush = useProjectPrefs(pid).commit.autoPush;
  // mutateAsync, not mutate callbacks: those are dropped if the user switches branch before the commit ends.
  return (branch: string, message: string, all: boolean) =>
    commit.mutateAsync({ projectId: pid, branch, message, all }).then(() => {
      if (autoPush) push.mutate({ projectId: pid, branch });
    });
}

/**
 * Every branch action in one place: the context menu, and the primary
 * action the split button offers for the branch's role and state.
 */
export function useBranchActions(pid: string, openDialog: (d: BranchDialog, branch: string, onto?: string) => void) {
  const nav = useNav();
  const inv = [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]];
  const sw = useAction<{ conflicts: string[] }, { projectId: string; branch: string; abort?: boolean; wip?: "stash" | "carry" }>("workspace.switch", {
    invalidate: inv,
    // The map follows the checkout at once instead of waiting for the full overview.
    patch: (qc, v) => qc.setQueryData<Overview>(["overview", pid], (o) => o && switchedOverview(o, v.branch)),
    // Uncommitted changes in the way: ask whether they come along or wait in a stash.
    onError: (e, v) => {
      if (!(e instanceof RpcError && e.code === "would_overwrite")) return false;
      openDialog("switchWip", v.branch);
      return true;
    },
  });
  const wt = useAction<{ path: string }, { projectId: string; branch: string }>("worktrees.create", { invalidate: [...inv, ["worktrees"]], success: (r) => `Worktree at ${r.path}` });
  // Pull, push and stash show on the row at once; counts against the parent wait for the overview.
  const pull = useAction<{ output: string; conflicts: string[] }, { projectId: string; branch: string; wip?: "stash" | "carry" }>("branches.pull", {
    invalidate: inv,
    patch: (qc, v) => patchOverview(qc, pid, v.branch, (b) => ({ ...b, upstreamBehind: 0 })),
    // Uncommitted changes in the way: ask whether they stay or wait in a stash.
    onError: (e, v) => {
      if (!(e instanceof RpcError && e.code === "would_overwrite")) return false;
      openDialog("pullWip", v.branch);
      return true;
    },
  });
  const push = useAction<{ output: string }, { projectId: string; branch: string }>("workspace.push", { invalidate: inv, patch: (qc, v) => patchOverview(qc, pid, v.branch, pushed) });
  // The suggested reset: no dialog, the server refuses it if the branch has gained anything of its own since.
  const reset = useAction<unknown, { projectId: string; branch: string; safe: boolean }>("branches.reset", {
    invalidate: inv,
    patch: (qc, v) => patchOverview(qc, pid, v.branch, (b) => ({ ...b, upstreamAhead: 0, upstreamBehind: 0, upstreamRewritten: false })),
  });
  const sync = useAction<MergeResult, { projectId: string; branch: string }>("branches.sync", { invalidate: inv });
  const stash = useAction<unknown, { projectId: string; branch: string }>("branches.stash", {
    invalidate: inv,
    patch: (qc, v) => {
      patchWip(qc, pid, v.branch, () => []);
      patchOverview(qc, pid, v.branch, (b) => ({ ...b, stashes: b.stashes + 1 }));
    },
  });
  const unstash = useAction<StashApplied, { projectId: string; branch: string; sha: string; pop: boolean }>("stashes.apply", {
    invalidate: inv,
    success: (r) => (r.conflicts.length ? undefined : "Popped the latest stash"),
  });
  const pr = useAction<{ number: number }, { projectId: string; branch: string }>("prs.create", { invalidate: [["prs", pid]], success: (r) => `Opened PR #${r.number}` });
  const changelog = useAction<{ message: string }, { projectId: string; branch: string }>("changelog.update", { invalidate: inv, success: (r) => r.message });
  const commit = useCommit(pid);
  // AI writes commit messages: committing everything takes one click. Else the message is written in the branch's uncommitted work.
  const aiCommit = useAiOn("commit");
  const stampChangelog = useAction<{ message: string }, { projectId: string; branch: string; version: string }>("changelog.release", { invalidate: inv, success: (r) => r.message });
  const latestChangelog = useAction<{ message: string }, { projectId: string; branch: string }>("changelog.latest", { invalidate: inv, success: (r) => r.message });
  const ov = useOverview(pid).data;
  const hasChangelog = !!ov?.hasChangelog;
  const { label } = useTagV(pid);
  // Changelog entries are written by the AI that writes release notes.
  const canChangelog = useAiOn("release") && hasChangelog;
  const move = useAction("branches.setParent", { invalidate: inv });
  const follow = useAction<RenameResult, { projectId: string; branch: string; name: string }>("branches.rename", { invalidate: [...inv, ["worktrees"], ["agents"]] });
  const [menu, setMenu] = useState<{ x: number; y: number; alignRight: boolean; t: BranchTarget } | null>(null);
  // Worktrees whose agent is still at work: finishing them would pull the folder out from under it.
  const working = useAgents((l) => l.filter((a) => a.status === "running" || a.status === "paused").map((a) => a.cwd)).data;

  const mutations = [sw, wt, pull, push, reset, sync, stash, unstash, pr, changelog, stampChangelog, latestChangelog, follow];
  // Started elsewhere counts too: the commit box's auto push spins the branch's Push button, and so do merges, deletes and rebases running in the background.
  const elsewhere = usePendingBranches(["workspace.commit", "workspace.push", "workspace.switch", "worktrees.remove", "branches.merge", "branches.delete", "branches.publish", "workspace.rebase", "workspace.rebaseContinue"], pid);
  const busy = new Set([...mutations.flatMap((m) => (m.isPending && m.variables?.branch ? [m.variables.branch] : [])), ...elsewhere]);
  // Branches AI is rebasing: nothing else touches them, or their checkout, until it is done. Nor the branches they go onto.
  const rebasing = useRebasing(pid);
  const locks = useLocks(pid);
  const inMain = [...rebasing.keys()].find((b) => !ov?.branches.find((x) => x.name === b)?.worktree);
  const run = (m: BranchMutation, branch: string, ok: string) => m.mutate({ projectId: pid, branch }, { onSuccess: () => toast(ok, "ok") });
  /** `b` just took in new commits: offer to carry them down to the branches under it. */
  const offerChildren = (b: string) => ov && childrenOf(ov.branches, b).length > 0 && openDialog("children", b);
  // Git refuses to switch in the middle of a rebase, merge…: ask to abort it first. One AI is carrying through is left alone.
  const switchOrAsk = (b: string, ok: string) =>
    inMain ? toast(`AI is rebasing ${inMain} in this checkout: wait for it to finish, or abort it`, "error") : ov?.inProgress ? openDialog("abortSwitch", b) : run(sw, b, ok);
  const abortAndSwitch = (b: string) => sw.mutate({ projectId: pid, branch: b, abort: true }, { onSuccess: () => toast(`Aborted the ${ov?.inProgress ?? "operation"} and switched to ${b}`, "ok") });
  /** Switches with the uncommitted changes git refused to switch with: carried along, or left in a stash. */
  const switchWith = (b: string, wip: "stash" | "carry") =>
    sw.mutate(
      { projectId: pid, branch: b, wip },
      {
        onSuccess: (r) =>
          r.conflicts.length
            ? toast(`Switched to ${b} with ${plural(r.conflicts.length, "conflict")}: resolve them in the WIP files. The stash is kept.`, "error")
            : toast(wip === "carry" ? `Switched to ${b}, your changes came along` : `Stashed your changes, switched to ${b}`, "ok"),
      },
    );
  /** Pulls with the uncommitted changes git refused to pull with: kept on the pulled branch, or left in a stash. */
  const pullWith = (b: string, wip: "stash" | "carry") =>
    pull.mutate(
      { projectId: pid, branch: b, wip },
      {
        onSuccess: (r) => {
          if (r.conflicts.length) toast(`Pulled ${b} with ${plural(r.conflicts.length, "conflict")}: resolve them in the WIP files. The stash is kept.`, "error");
          else toast(wip === "carry" ? `Pulled ${b}, your changes are back on top` : `Stashed your changes, pulled ${b}`, "ok");
          // Git only stops a pull that brings commits: the branch moved.
          offerChildren(b);
        },
      },
    );
  /** Deletes the worktree (refused with uncommitted changes there), then checks its branch out here. In the background: its row goes at once. */
  const continueOn = (branch: string, path: string) => {
    // Mid rebase, merge… here: the worktree still goes, then the abort dialog asks.
    const ask = !!ov?.inProgress;
    void runTask({
      label: `Deleting the worktree of ${branch}…`,
      hide: [wtKey(path)],
      invalidate: [...inv, ["worktrees"], ["agents"]],
      run: async (say) => {
        // `branch` only marks the row busy; the worktree is found by its path.
        await call("worktrees.remove", { projectId: pid, branch, path });
        await droppedWorktree(queryClient, pid, branch, path);
        if (ask) return false;
        say(`Switching to ${branch}…`);
        await call("workspace.switch", { projectId: pid, branch }).catch((e: Error) => {
          throw new Error(`Worktree deleted, but switching to ${branch} failed: ${e.message}`);
        });
        await settle(queryClient, [["overview", pid]], () => queryClient.setQueryData<Overview>(["overview", pid], (o) => o && switchedOverview(o, branch)));
        return true;
      },
      done: (switched) => (switched ? `Worktree deleted, continuing on ${branch}` : `Deleted the worktree of ${branch}`),
    }).then((switched) => switched === false && openDialog("abortSwitch", branch));
  };

  // The branch checked out here: any other branch can be the one it gets rebased onto, unless AI is rebasing it already.
  const cur = (!inMain && ov?.currentBranch) || undefined;
  // By name: every tile of the map builds its actions, and a scan of thousands of branches each time made a redraw seconds long.
  const byName = useMemo(() => new Map((ov?.branches ?? []).map((y) => [y.name, y])), [ov?.branches]);
  /** A release branch reads as its version. */
  const labelOf = (name: string) => {
    const x = byName.get(name);
    return x?.role === "release" && x.release ? label(x.release) : name;
  };

  const all = (t: BranchTarget) => {
    const v = t.view;
    const b = v.name;
    const parent = t.baseLabel;
    const originOnly = v.remote && !v.local;
    const diverged = isDiverged(v);
    // A worktree's branch merges as its session ends: uncommitted changes count (committed or discarded first), then the worktree goes.
    const agentBusy = !!v.worktree && !!working?.includes(v.worktree);
    const toMerge = v.ahead || (v.worktree ? v.wip : 0);
    return {
      switch: {
        id: "switch",
        label: originOnly ? "Check out from origin" : "Switch to branch",
        short: originOnly ? "Check out" : "Switch",
        tip: originOnly ? `Only on origin: create a local ${b} that tracks it and switch to it` : `Check out ${b}`,
        icon: "swap",
        run: () => switchOrAsk(b, `Switched to ${b}`),
      },
      continue: {
        id: "continue",
        label: "Continue on branch & delete worktree",
        short: "Continue",
        tip: `Delete the worktree of ${b} and check ${b} out here. Uncommitted changes there get committed or discarded first`,
        icon: "swap",
        warn: true,
        run: () => openDialog("continue", b),
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
        run: () =>
          pull.mutate(
            { projectId: pid, branch: b },
            {
              onSuccess: () => {
                toast(`Pulled ${b}`, "ok");
                if (v.upstreamBehind) offerChildren(b);
              },
            },
          ),
      },
      reset: {
        id: "reset",
        label: <>Reset to <span className="mono">{v.upstream}</span>…</>,
        tip: `Move ${b} to where ${v.upstream} is, dropping what differs locally`,
        icon: "undo",
        danger: true,
        run: () => openDialog("reset", b),
      },
      push: {
        id: "push",
        label: v.upstream ? "Push" : "Publish to origin",
        short: v.upstream ? `Push ${v.upstreamAhead || ""}`.trim() : "Publish",
        tip: !v.upstream ? `Publish ${b} to origin` : v.upstreamAhead ? `Push ${plural(v.upstreamAhead, "commit")} to ${v.upstream}` : `Push to ${v.upstream}`,
        icon: "push",
        hint: v.upstreamAhead ? `↑${v.upstreamAhead}` : undefined,
        run: () => run(push, b, v.upstream ? `Pushed ${b}` : `Published ${b}`),
      },
      forcePush: {
        id: "forcePush",
        label: <>Force push to <span className="mono">{v.upstream}</span></>,
        short: "Force push",
        tip: `${v.rewritten ? `${b} was rewritten (rebased, reset): r` : "R"}eplace ${v.upstream} with ${b}. Refused if origin has commits that were never on ${b}`,
        icon: "push",
        hint: diverged ? `↑${v.upstreamAhead} ↓${v.upstreamBehind}` : undefined,
        danger: true,
        run: () => openDialog("forcePush", b),
      },
      commit: {
        id: "commit",
        label: "Stage & commit all",
        tip: !v.checkedOut
          ? `Check out ${b} to commit its changes`
          : v.inProgress
            ? `Finish or abort the ${v.inProgress} first`
            : !v.wip
              ? "No uncommitted changes"
              : `Stage the ${plural(v.wip, "uncommitted file")} on ${b} and commit them${aiCommit ? ". AI writes the message" : ", with a message you write"}`,
        icon: aiCommit ? "sparkle" : "commit",
        hint: !v.checkedOut ? "check out first" : v.inProgress ? `${v.inProgress} in progress` : v.wip ? plural(v.wip, "file") : "nothing to commit",
        disabled: !v.checkedOut || !v.wip || !!v.inProgress || locks.has(b),
        run: () => (aiCommit ? void commit(b, "", true).catch(() => {}) : openDialog("commit", b)),
      },
      stash: {
        id: "stash",
        label: "Stash changes",
        tip: !v.checkedOut ? `Check out ${b} to stash its changes` : v.wip ? `Set aside ${plural(v.wip, "uncommitted file")} on ${b}` : "No uncommitted changes",
        icon: "stash",
        hint: v.checkedOut ? (v.wip ? plural(v.wip, "file") : "nothing to stash") : "check out first",
        disabled: !v.checkedOut || !v.wip,
        run: () => run(stash, b, `Stashed changes on ${b}`),
      },
      unstash: {
        id: "unstash",
        label: "Pop latest stash",
        tip: t.latestStash ? `Put back “${t.latestStash.message}” and drop the stash` : `No stash made on ${b}`,
        icon: "unstash",
        hint: t.latestStash?.message,
        disabled: !t.latestStash,
        run: () =>
          t.latestStash &&
          unstash.mutate(
            { projectId: pid, branch: b, sha: t.latestStash.sha, pop: true },
            {
              onSuccess: (r) =>
                r.conflicts.length > 0 && toast(`Popped with ${plural(r.conflicts.length, "conflict")}: resolve them in the WIP files. The stash is kept.`, "error"),
            },
          ),
      },
      rebase: {
        id: "rebase",
        label: <>Rebase onto <span className="mono">{parent}</span></>,
        short: "Rebase",
        tip: !v.checkedOut ? `Check out ${b} to rebase it` : v.behind ? `Replay ${b} on top of ${parent} (${plural(v.behind, "commit")} behind)` : `Rebase onto ${parent}`,
        icon: "branch",
        hint: v.checkedOut ? (v.behind ? `${v.behind} behind` : undefined) : "check out first",
        disabled: !v.checkedOut || !t.base,
        run: () => void startRebase(pid, b),
      },
      rebaseActive: {
        id: "rebaseActive",
        label: <>Rebase <span className="mono">{cur && labelOf(cur)}</span> onto <span className="mono">{labelOf(b)}</span>…</>,
        tip: ov?.inProgress ? `Finish or abort the ${ov.inProgress} first` : `Replay the commits of ${cur} on top of ${labelOf(b)}. Its target stays as it is`,
        icon: "branch",
        hint: ov?.inProgress ? `${ov.inProgress} in progress` : undefined,
        disabled: !!ov?.inProgress,
        run: () => cur && openDialog("rebaseOnto", cur, b),
      },
      rebasePick: {
        id: "rebasePick",
        label: "Rebase onto a specific branch…",
        tip: ov?.inProgress ? `Finish or abort the ${ov.inProgress} first` : `Pick a branch to replay the commits of ${b} on top of. Its target stays as it is`,
        icon: "branch",
        hint: ov?.inProgress ? `${ov.inProgress} in progress` : undefined,
        disabled: !!ov?.inProgress,
        run: () => openDialog("rebaseOnto", b),
      },
      // Releases and trunks catch up the way work branches do: rebased onto the parent, asked first, then force pushed.
      update: {
        id: "update",
        label: <>Rebase onto <span className="mono">{parent}</span>…</>,
        short: "Update",
        tip: v.behind ? `Rebase ${b} onto the ${plural(v.behind, "new commit")} of ${parent}, AI resolving the conflicts${v.upstream ? ", then force push it" : ""}` : `${b} already has everything in ${parent}`,
        icon: "refresh",
        hint: v.behind ? `↓${v.behind}` : undefined,
        disabled: !t.base || !v.behind,
        run: () => openDialog("rebaseOnto", b, t.base),
      },
      sync: {
        id: "sync",
        label: <>Merge <span className="mono">{parent}</span> into this</>,
        short: "Update",
        tip: v.behind ? `Merge the ${plural(v.behind, "new commit")} from ${parent} into ${b}` : `${b} already has everything in ${parent}`,
        icon: "refresh",
        hint: v.behind ? `↓${v.behind}` : undefined,
        disabled: !t.base || !v.behind,
        run: () =>
          sync.mutate(
            { projectId: pid, branch: b },
            {
              onSuccess: (r) => {
                toast(`${b} is up to date with ${parent}`, "ok");
                if (!r.alreadyMerged) offerChildren(b);
              },
            },
          ),
      },
      merge: {
        id: "merge",
        label: <>{v.worktree ? "Finish and merge" : "Merge"} into <span className="mono">{parent}</span>…</>,
        short: v.worktree ? "Finish and merge" : "Merge",
        tip: agentBusy
          ? `The agent is still working in the worktree of ${b}`
          : !toMerge
            ? `Nothing to merge into ${parent}`
            : v.worktree
              ? `Merge ${b} into ${parent}, then delete its worktree. Uncommitted changes get committed or discarded first`
              : `Merge ${plural(v.ahead, "commit")} into ${parent}`,
        icon: "merged",
        hint: agentBusy ? "agent working" : !toMerge ? "nothing to merge" : v.ahead ? plural(v.ahead, "commit") : plural(v.wip, "file"),
        disabled: !t.base || !toMerge || agentBusy,
        run: () => openDialog("merge", b),
      },
      conflicts: {
        id: "conflicts",
        label: "Resolve with AI",
        short: "Resolve",
        tip: `AI resolves the conflicts with ${parent} and carries the rebase through every commit`,
        icon: "sparkle",
        run: () => void startRebase(pid, b, { resume: true }),
      },
      progress: {
        id: "progress",
        label: "Show rebase progress",
        short: "Progress",
        tip: locks.get(b) && `Rebase & conflict resolving is running: AI is rebasing ${locks.get(b)?.branch}. Show how far it is`,
        icon: "sparkle",
        run: () => {
          const r = locks.get(b);
          if (r) showRun(r.projectId, r.branch);
        },
      },
      abort: { id: "abort", label: `Abort ${v.inProgress ?? "operation"}…`, icon: "undo", danger: true, run: () => openDialog("abort", b) },
      pr: {
        id: "pr",
        label: <>Open pull request into <span className="mono">{parent}</span></>,
        icon: "pr",
        hint: diverged ? "force push first" : undefined,
        // Origin has a different history: the PR would show it, and pushing first is refused.
        disabled: !t.base || diverged,
        run: () => pr.mutate({ projectId: pid, branch: b }, { onSuccess: (r) => nav.go({ name: "prs", number: r.number }) }),
      },
      // An open release takes new work as a feature or fix in it; any other branch just starts one off itself.
      create: {
        id: "create",
        label: "Create a branch from here",
        tip: "Create a branch from here",
        icon: "plus",
        run: () => nav.openNewItem(v.role === "release" && v.release ? { release: v.release } : { from: b }),
      },
      changelog: {
        id: "changelog",
        label: "Update changelog",
        tip: `AI adds what ${b} changes${t.base && v.ahead ? ` over ${parent}` : " since its latest tag"} to the Unreleased section of CHANGELOG.md, committed on ${b}`,
        icon: "sparkle",
        run: () => changelog.mutate({ projectId: pid, branch: b }),
      },
      stampChangelog: {
        id: "stampChangelog",
        label: `Move unreleased changelog into ${v.release && label(v.release)}`,
        tip: `Rename the Unreleased section of CHANGELOG.md to ${v.release}, dated today, committed on ${b}. When ${v.release} already has entries, AI merges both, highlights first`,
        icon: "tag",
        run: () => v.release && stampChangelog.mutate({ projectId: pid, branch: b, version: v.release }),
      },
      latestChangelog: {
        id: "latestChangelog",
        label: `Add unreleased changelog to ${ov?.changelogVersion && label(ov.changelogVersion)}`,
        tip: `Merge the Unreleased section of CHANGELOG.md into ${ov?.changelogVersion}, committed on ${b}. AI combines it with the entries already there, highlights first`,
        icon: "tag",
        run: () => latestChangelog.mutate({ projectId: pid, branch: b }),
      },
      publish: {
        id: "publish",
        label: `${publishName(hasChangelog)}…`,
        tip: v.inProgress
          ? `Finish or abort the ${v.inProgress} first`
          : busy.has(b)
            ? `Wait for what is running on ${b} to finish`
            : hasChangelog
            ? `Turn the Unreleased section of CHANGELOG.md into a version dated today, tag the tip of ${b} with it, and push ${b} and the tag to origin`
            : `Tag the tip of ${b} with a version and push ${b} and the tag to origin`,
        icon: "ship",
        hint: v.inProgress ? `${v.inProgress} in progress` : undefined,
        // A publish still running on it (its dialog closed): a second one would race it.
        disabled: !!v.inProgress || busy.has(b),
        run: () => openDialog("publish", b),
      },
      copy: { id: "copy", label: "Copy branch name", icon: "edit", run: () => copyToClipboard(b) },
      // `worktree` is the folder path; its last segment is the workspace name.
      copyWorkspace: { id: "copyWorkspace", label: "Copy workspace name", icon: "copy", run: () => v.worktree && copyToClipboard(v.worktree.split(/[\\/]/).pop() ?? v.worktree) },
      rename: {
        id: "rename",
        label: v.role === "release" ? "Rename release…" : "Rename branch…",
        tip: v.role === "release" ? `Give ${v.release} another version, its branch and planned work along` : `Rename ${b}${v.remote ? ", on origin too for everyone" : ""}`,
        icon: "edit",
        run: () => openDialog("rename", b),
      },
      follow: {
        id: "follow",
        label: <>Follow rename to <span className="mono">{v.renamedTo}</span></>,
        short: "Follow rename",
        tip: `${v.upstream} is gone and origin/${v.renamedTo} is at the same commit: rename ${b} to ${v.renamedTo} and track it`,
        icon: "swap",
        warn: true,
        run: () => v.renamedTo && follow.mutate({ projectId: pid, branch: b, name: v.renamedTo }, {
              onSuccess: (r) => {
                if (nav.selectedBranch === b) nav.selectBranch(v.renamedTo!);
                toast(`Renamed ${b} to ${v.renamedTo}`, "ok");
                if (r.changelogError) toast(`Renamed, but committing CHANGELOG.md failed: ${r.changelogError}`, "error");
              },
            }),
      },
      ticket: { id: "ticket", label: <>Show ticket <span className="mono">{v.ticket}</span></>, icon: "ticket", run: () => v.ticket && nav.go({ name: "tickets", key: v.ticket }) },
      delete: {
        id: "delete",
        label: v.exists ? "Delete branch…" : "Forget branch…",
        short: v.exists ? "Delete" : "Forget",
        tip: !v.exists ? `${b} no longer exists: remove it from the list` : originOnly ? `Delete ${b} on origin` : v.merged && !v.likelyMerged ? `${b} is merged into ${parent}: delete the local branch` : `Delete ${b}`,
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
    // Nothing that would touch it until AI is done rebasing it, or rebasing a branch onto it; the run's window offers the abort.
    if (locks.has(v.name)) return [a.progress, "sep", a.copy];
    const list: MenuItem[] = t.extra?.length ? [...t.extra, "sep"] : [];
    // The conflict dialog carries a rebase on; other operations are finished from the WIP files.
    if (v.conflict && v.inProgress === "rebase") list.push(a.conflicts);
    if (v.inProgress) list.push(a.abort, "sep");
    if (v.renamedTo) list.push(a.follow, "sep");
    if (!v.checkedOut) list.push(a.switch, a.worktree);
    else if (v.worktree) list.push(a.continue);
    list.push(a.create, "sep");
    if (v.local) {
      list.push(a.pull);
      // Out of step with origin: offer to throw away the local side.
      if (v.upstream && (v.upstreamAhead || v.upstreamBehind)) list.push(a.reset);
      // Rewritten (rebased, reset): origin refuses a plain push.
      if (!v.rewritten || v.protected) list.push(a.push);
      // Work branches can replace origin's copy; shared ones only once rewritten here.
      if (!v.protected && v.upstream && (v.rewritten || (v.role === "branch" && v.upstreamAhead))) list.push(a.forcePush);
      if (v.checkedOut) list.push(a.commit, a.stash);
      if (v.checkedOut && t.latestStash) list.push(a.unstash);
      if (t.base) {
        list.push("sep");
        // Releases and trunks rebase through the dialog (Update) or merge; work branches rebase in their checkout; worktrees merge.
        if (v.role === "branch" && !v.worktree) list.push(a.rebase);
        if (v.role !== "branch") list.push(a.update);
        list.push(a.sync);
        list.push(a.merge);
      }
    }
    // Rebase the checked-out branch onto this one; on the checked-out branch itself, onto one picked.
    if (cur) {
      // Joins the rebase group; otherwise starts its own.
      if (v.local && !t.base) list.push("sep");
      list.push(v.name === cur ? a.rebasePick : a.rebaseActive);
    }
    // A worktree's branch ends by merging or deleting it, not through a PR.
    if (t.base && !v.worktree) list.push(a.pr);
    if (v.local && hasChangelog && v.role === "release" && v.release) list.push(a.stampChangelog);
    if (v.local && hasChangelog && v.name === ov?.defaultBranch && ov.changelogVersion) list.push(a.latestChangelog);
    if (t.moveTo?.length || t.pickTarget) {
      list.push("sep");
      for (const m of t.moveTo ?? []) {
        list.push({ id: `move-${m.branch}`, label: <>Target <span className="mono">{m.label}</span></>, icon: "merged", run: () => move.mutate({ projectId: pid, branch: v.name, parent: m.branch }, { onSuccess: () => offersRebase(v) && openDialog("rebase", v.name, m.branch) }) });
      }
      if (t.pickTarget) list.push({ id: "move-any", label: "Target a specific branch…", icon: "merged", run: () => openDialog("target", v.name) });
    }
    list.push("sep");
    if (v.ticket) list.push(a.ticket);
    if (t.showStashes) list.push({ id: "stashes", label: "Show stashes", icon: "stash", hint: v.stashes ? String(v.stashes) : undefined, run: t.showStashes });
    if (v.local && canChangelog) list.push(a.changelog);
    // The only way to tag a branch, a worktree's too: it is tagged where it stands.
    if (v.local) list.push(a.publish);
    list.push(a.copy);
    if (v.worktree) list.push(a.copyWorkspace);
    // Shipped releases keep their branch's name.
    if (!t.isDefault && !v.shipped) list.push(a.rename);
    // Any branch but the default one, unless the git host protects it.
    if (!t.isDefault && !v.protected) list.push("sep", a.delete);
    return list;
  };

  /** What the user most likely wants next for this branch. */
  const primary = (t: BranchTarget): Action => {
    const a = all(t);
    const v = t.view;
    if (!v.exists) return a.delete;
    if (locks.has(v.name)) return a.progress;
    if (v.conflict && v.inProgress === "rebase") return a.conflicts;
    // Uncommitted work comes first: committed before anything moves the branch. Not while an agent still works there.
    if (v.wip > 0 && v.checkedOut && !v.inProgress && !v.running) return a.commit;
    if (!v.local) return a.switch;
    if (v.renamedTo) return a.follow;
    // A rebased work branch: pulling would bring the old commits back, so suggest replacing origin's copy.
    if (v.role === "branch" && !v.protected && v.rewritten) return a.forcePush;
    // Origin moved on and the branch has nothing of its own: take origin's copy as is. Not over uncommitted work.
    if (v.upstreamBehind > 0 && (!v.upstreamAhead || v.upstreamRewritten) && !v.wip && !v.inProgress && !v.running)
      return {
        ...a.reset,
        label: <>Reset to <span className="mono">{v.upstream}</span></>,
        short: "Reset to origin",
        tip: `Reset ${v.name} to ${v.upstream}: it has nothing of its own to lose`,
        danger: false,
        run: () => reset.mutate({ projectId: pid, branch: v.name, safe: true }, { onSuccess: () => toast(`Reset ${v.name} to ${v.upstream}`, "ok") }),
      };
    if (v.upstreamBehind > 0) return a.pull;
    const needsPush = v.upstreamAhead > 0 || (!v.upstream && v.ahead > 0);
    if (v.role !== "branch") {
      // Releases and trunks catch up with the base by a rebase, no checkout needed.
      if (v.behind > 0 && t.base) return a.update;
      if (needsPush) return a.push;
      // Nothing to pull or push: like work branches, suggest merging what is ahead into the base.
      if (t.base && v.ahead > 0) return a.merge;
      if (!v.checkedOut) return a.switch;
      return v.upstream ? a.pull : a.push;
    }
    if (v.merged && !v.likelyMerged && !v.checkedOut && !v.protected) return a.delete;
    if (!v.checkedOut) return a.switch;
    if (v.worktree) return a.continue;
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

  const switchTo = (b: string) => switchOrAsk(b, `Switched to ${b}`);

  /** Start a new branch off this one; gone branches have nothing to start from. */
  const create = (t: BranchTarget): Action | undefined => (t.view.exists ? all(t).create : undefined);

  const menuEl = menu && <ContextMenu x={menu.x} y={menu.y} alignRight={menu.alignRight} label={`Actions for ${menu.t.view.name}`} items={items(menu.t)} onClose={() => setMenu(null)} />;

  /** One action of the menu, for a button of its own. */
  const action = (t: BranchTarget, id: "stash" | "pr" | "merge"): Action => all(t)[id];

  /** Ask before replaying `b` on top of `onto`. */
  const askRebase = (b: string, onto: string) => openDialog("rebaseOnto", b, onto);

  return { primary, create, action, openMenu, menuEl, busy, rebasing, locks, switchTo, continueOn, abortAndSwitch, switchWith, pullWith, askRebase };
}

export type BranchActions = ReturnType<typeof useBranchActions>;

/**
 * Icon-only actions filling the row's height: the primary action for the branch's state,
 * then a "+" to start a branch off it stacked over a "…" with every action.
 */
export function BranchSplit({ t, actions }: { t: BranchTarget; actions: BranchActions }) {
  const p = actions.primary(t);
  const add = actions.create(t);
  // AI rebasing it: the button spins, still there to show how far it is. Rebasing a branch onto it: a lock.
  const rebasing = actions.rebasing.has(t.view.name);
  const held = actions.locks.has(t.view.name) && !rebasing;
  const busy = actions.busy.has(t.view.name) && !rebasing;
  const spin = busy || rebasing;
  const tip = p.tip ?? (typeof p.label === "string" ? p.label : undefined);
  const more = `More actions for ${t.view.name}`;
  // Commits waiting to go to origin: the Push button shakes now and then so they aren't forgotten.
  const v = t.view;
  const nudge = p.id === "push" && !busy && !p.disabled && (v.upstreamAhead > 0 || (!v.upstream && v.ahead > 0));
  return (
    <span className="acts" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button className={`act act-main${p.danger ? " btn-danger" : p.warn ? " act-warn" : ""}${nudge ? " act-nudge" : ""}`} disabled={p.disabled || busy} aria-label={tip} data-tip={tip} onClick={p.run}>
        {spin ? <span className="spinner" /> : <Icon name={held ? "lock" : (p.icon ?? "check")} size={16} />}
      </button>
      <span className="act-stack">
        {add && (
          <button className="act" aria-label={add.tip} data-tip={add.tip} onClick={add.run}>
            <Icon name="plus" size={14} />
          </button>
        )}
        <button className="act" aria-label={more} data-tip={more} aria-haspopup="menu" onClick={(e) => actions.openMenu(t, e)}>
          <Icon name="more" size={14} />
        </button>
      </span>
    </span>
  );
}
