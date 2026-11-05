import { useMemo, useSyncExternalStore } from "react";

import type { RebaseRun } from "../api/types";
import { plural } from "./format";
import { toast } from "./toast";

/** A rebase AI carries through, as last heard; `min`: shown as a chip in the corner. A failed one stays until dismissed. */
export interface ShownRun {
  run: RebaseRun;
  min: boolean;
  /** When it failed, for the time it took. */
  endedAt?: number;
}

// Kept outside any screen, like the background tasks: the window and its chip outlive page and project changes.
let shown: ReadonlyMap<string, ShownRun> = new Map();
const listeners = new Set<() => void>();
const set = (next: Map<string, ShownRun>) => {
  shown = next;
  listeners.forEach((l) => l());
};

export const runKey = (projectId: string, branch: string) => `${projectId} ${branch}`;

/** Rebases started from this window: their progress opens; others start as a chip. */
const startedHere = new Set<string>();
export const startedFromHere = (key: string, on: boolean) => (on ? startedHere.add(key) : startedHere.delete(key));

/** Takes in news of a run: from an event, or from the list asked at start. */
export function heard(run: RebaseRun) {
  const k = runKey(run.projectId, run.branch);
  const next = new Map(shown);
  const was = next.get(k);
  if (run.state === "running") next.set(k, { run, min: was?.min ?? !startedHere.has(k) });
  // Back open, wherever it was: the user has to see why it stopped.
  else if (run.state === "failed") next.set(k, { run, min: false, endedAt: Date.now() });
  else next.delete(k);
  set(next);
  // Started from here, the rebase's own answer says how it went.
  if (run.state === "done" && was && !startedHere.has(k)) toast(`Rebased ${run.branch} onto ${run.onto}${run.resolvedTotal ? `, AI resolved ${plural(run.resolvedTotal, "conflicted file")}` : ""}`, "ok");
}

export const shownRun = (key: string) => shown.get(key);

export function setMin(key: string, min: boolean) {
  const s = shown.get(key);
  if (s) set(new Map(shown).set(key, { ...s, min }));
}

/** Opens the window of `branch`'s run, if it has one. */
export const showRun = (projectId: string, branch: string) => setMin(runKey(projectId, branch), false);

export function dismiss(key: string) {
  const next = new Map(shown);
  next.delete(key);
  set(next);
}

/** A failed run tried again: shown running at once, before the engine says so. */
export function retrying(key: string) {
  const s = shown.get(key);
  if (s) set(new Map(shown).set(key, { run: { ...s.run, state: "running", error: null, resolved: 0, secondPass: [] }, min: false }));
}

export function useRuns(): ReadonlyMap<string, ShownRun> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => shown,
  );
}

/** Branches of project `projectId` a rebase AI is carrying through holds: the one it rebases and the one it goes onto.
 * Neither moves until it is done. */
export function useLocks(projectId?: string): ReadonlyMap<string, RebaseRun> {
  const all = useRuns();
  return useMemo(() => {
    const locks = new Map<string, RebaseRun>();
    for (const { run } of all.values()) {
      if (run.projectId !== projectId || run.state !== "running") continue;
      locks.set(run.onto, run);
      locks.set(run.branch, run);
    }
    return locks;
  }, [all, projectId]);
}

/** What hovering a branch a rebase holds says; `onto`: how the branch it goes onto reads (a release as its version). */
export const lockTip = (run: RebaseRun, branch: string, onto = run.onto) =>
  `Rebase & conflict resolving is running: AI is rebasing ${run.branch} onto ${onto}${run.steps ? `, commit ${run.step} of ${run.steps}` : ""}. ${
    branch === run.branch ? "This branch" : "This branch, the one it goes onto,"
  } stays locked until it is done. Click to see the progress.`;

/** Branches of project `projectId` AI is rebasing right now: nothing else should touch them meanwhile. */
export function useRebasing(projectId?: string): ReadonlyMap<string, RebaseRun> {
  const all = useRuns();
  return useMemo(
    () => new Map([...all.values()].filter((s) => s.run.projectId === projectId && s.run.state === "running").map((s) => [s.run.branch, s.run])),
    [all, projectId],
  );
}
