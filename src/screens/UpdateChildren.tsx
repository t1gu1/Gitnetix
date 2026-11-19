import { useState } from "react";

import { useAiOn } from "../api/hooks";
import type { BranchView, RebaseResult } from "../api/types";
import { Modal } from "../components/ui";
import { call, runTask } from "../lib/tasks";

/** A branch under the one that moved, `depth` levels down (1: its own child). */
export interface Child {
  view: BranchView;
  depth: number;
}

const count = (n: number) => `${n} branch${n === 1 ? "" : "es"}`;
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Local open branches under `name`, each one before the branches under it. Merged and shipped branches, ones only
 * on origin and ones an agent is working on are left out, with the branches under them.
 */
export function childrenOf(branches: BranchView[], name: string): Child[] {
  const out: Child[] = [];
  const seen = new Set([name]);
  const walk = (parent: string, depth: number) => {
    for (const b of branches) {
      if (b.parent !== parent || seen.has(b.name)) continue;
      seen.add(b.name);
      if (!b.local || !b.exists || b.merged || b.shipped || b.running) continue;
      out.push({ view: b, depth });
      walk(b.name, depth + 1);
    }
  };
  walk(name, 1);
  return out;
}

/**
 * Rebases each picked branch onto its parent, parents first, AI resolving the conflicts. A branch that fails stays as it
 * was, and so do the branches under it. With `push`, `root` and every branch rebased go to origin when they have an
 * upstream, forced when they were there already. Runs in the background; the toast says how it went.
 */
function updateChildren(pid: string, root: BranchView, picked: Child[], push: boolean, labelOf: (b: string) => string) {
  const from = labelOf(root.name);
  void runTask({
    label: `Updating ${count(picked.length)} under ${from}…`,
    conflictsIn: pid,
    invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid], ["worktrees"]],
    run: async (say) => {
      // Not updated, the branches under them skipped.
      const failed = new Map<string, string>();
      // Updated, with something left to know: a push refused, uncommitted changes that came back with conflicts.
      const notes: string[] = [];
      let updated = 0;
      const send = async (b: BranchView, force: boolean) => {
        if (!push || !b.upstream) return;
        say(`Pushing ${labelOf(b.name)}…`);
        await call("workspace.push", { projectId: pid, branch: b.name, force }).catch((e) => notes.push(`${labelOf(b.name)} not pushed: ${why(e)}`));
      };
      // A work branch with no parent of its own sits under the one its history is closest to. Once that parent is
      // rebased, its commits are new ones and the branch would land elsewhere: pin it where it is first.
      const names = new Set(picked.map((c) => c.view.name));
      for (const { view: b } of picked) {
        if (b.role === "branch" && b.parent && names.has(b.parent)) await call("branches.setParent", { projectId: pid, branch: b.name, parent: b.parent });
      }
      // Rebased itself, not pushed since: only a force push replaces origin's copy.
      await send(root, root.rewritten);
      for (const { view: b } of picked) {
        const parent = b.parent ?? "";
        if (failed.has(parent)) {
          failed.set(b.name, `skipped, ${labelOf(parent)} was not updated`);
          continue;
        }
        try {
          say(`Rebasing ${labelOf(b.name)} onto ${labelOf(parent)}…`);
          const r = await call<RebaseResult>("workspace.rebase", { projectId: pid, branch: b.name, resolve: true });
          if (r.conflicts.length) {
            // Stopped in its checkout: put it back as it was.
            await call("workspace.abort", { projectId: pid, branch: b.name }).catch(() => undefined);
            throw new Error(`conflicts in ${r.conflicts.join(", ")} AI could not resolve${r.errors.length ? ` (${r.errors.join("; ")})` : ""}`);
          }
          if (r.aborted) throw new Error("the rebase was stopped");
          if (r.stashConflicts.length) notes.push(`${labelOf(b.name)}: your uncommitted changes came back with conflicts in ${r.stashConflicts.join(", ")}`);
          updated++;
          // Already on origin before the rebase: only a force push replaces it.
          await send(b, !!r.forcePushTo);
        } catch (e) {
          failed.set(b.name, why(e));
        }
      }
      const problems = [...[...failed].map(([b, w]) => `${labelOf(b)}: ${w}.`), ...notes.map((n) => `${n}.`)];
      // An error toast stays until clicked: what went wrong isn't missed.
      if (problems.length) throw new Error(`Updated ${count(updated)} under ${from}. ${problems.join(" ")}`);
      return updated;
    },
    done: (n) => (n ? `Updated ${count(n)} under ${from}${push ? ", pushed the ones on origin" : ""}` : `The branches under ${from} were already up to date`),
  });
}

/** `branch` just took in new commits: asks whether the branches under it take them in too. */
export function UpdateChildrenModal({ pid, branch, branches, labelOf, onClose }: { pid: string; branch: string; branches: BranchView[]; labelOf: (b: string) => string; onClose: () => void }) {
  const [kids] = useState(() => childrenOf(branches, branch));
  const [picked, setPicked] = useState(() => new Set(kids.map((c) => c.view.name)));
  const [push, setPush] = useState(true);
  const ai = useAiOn("conflict");
  const root = branches.find((b) => b.name === branch);
  const from = labelOf(branch);
  const flip = (name: string) => {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setPicked(next);
  };
  return (
    <Modal
      title={`Update the branches under ${from}?`}
      sub={<>{from} has new commits</>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" autoFocus onClick={onClose}>Not now</button>
          <button
            className="btn btn-md btn-primary"
            disabled={!picked.size || !root}
            onClick={() => {
              if (root) updateChildren(pid, root, kids.filter((c) => picked.has(c.view.name)), push, labelOf);
              onClose();
            }}
          >
            Update {count(picked.size)}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Each branch is rebased onto its parent, top down, so the new commits reach every level.
      </p>
      <ul className="col" style={{ margin: 0, padding: 0, listStyle: "none", gap: 4 }}>
        {kids.map(({ view: b, depth }) => (
          <li key={b.name} style={{ paddingLeft: (depth - 1) * 18 }}>
            <label className="check">
              <input type="checkbox" checked={picked.has(b.name)} onChange={() => flip(b.name)} />
              <span className="mono ellipsis">{labelOf(b.name)}</span>
              {b.checkedOut && <span className="tag">{b.worktree ? "worktree" : "checked out"}</span>}
              {b.wip > 0 && <span className="c-warn" title="Uncommitted changes the update would touch stop it">WIP {b.wip}</span>}
            </label>
          </li>
        ))}
      </ul>
      <label className="check">
        <input type="checkbox" checked={push} onChange={() => setPush(!push)} />
        <span>Push the ones on origin, {from} included</span>
      </label>
      {push && (
        <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
          A rebased branch already on origin is force pushed, releases included: anyone with work on it rebases it too. Origin refuses it if it has commits the branch never had, or if the host protects the branch.
        </p>
      )}
      <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
        {ai
          ? "AI resolves the conflicts it runs into. A branch it can't update stays as it was, and so do the branches under it."
          : "No AI is set up to resolve conflicts: a branch that conflicts stays as it was, and so do the branches under it."}
      </p>
    </Modal>
  );
}
