import { MutationObserver } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { queryClient } from "../api/hooks";
import { rpc } from "../api/transport";
import { progress } from "./toast";

// Rows that actions running in the background are taking away, one list per action. Kept outside any
// screen, like cleanups: the rows leave every list at the click, the action carries on whatever the
// user does next, and they come back if it fails.
let hides: readonly (readonly string[])[] = [];
let hidden: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const setHides = (next: readonly (readonly string[])[]) => {
  hides = next;
  hidden = new Set(next.flat());
  listeners.forEach((l) => l());
};

/** Keys of the rows an action takes away: a worktree by its folder, a branch, an agent session. */
export const wtKey = (path: string) => `wt ${path}`;
export const branchKey = (projectId: string, branch: string) => `branch ${projectId} ${branch}`;
export const agentKey = (id: string) => `agent ${id}`;

/** Keys of the rows to leave out right now. */
export function useHidden(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => hidden,
  );
}

/** One step of a task: runs like a `useAction` of `method`, so `useIsMutating` and `usePendingBranches` see it (a `branch` marks that row busy). */
export async function call<T = unknown>(method: string, vars: Record<string, unknown>): Promise<T> {
  const m = new MutationObserver<T, Error, Record<string, unknown>>(queryClient, { mutationKey: [method], mutationFn: (v) => rpc<T>(method, v) });
  try {
    return await m.mutate(vars);
  } finally {
    // Lets the cache drop it.
    m.reset();
  }
}

export interface Task<T> {
  /** Shown with a spinner until it is done. */
  label: string;
  /** Project where it may hit conflicts (a merge): the engine's news of AI resolving them shows in its toast. */
  conflictsIn?: string;
  /** Rows taken away at once (`wtKey`, `branchKey`, `agentKey`). */
  hide?: string[];
  /** Read again once done, whether it worked or not. */
  invalidate?: unknown[][];
  /**
   * The work, step by step; `say` tells which step it is on. Each step puts what it did in the cache
   * (`settle`): the hidden rows come back as the task ends, and must not show what was there before.
   */
  run: (say: (text: string) => void) => Promise<T>;
  /** The toast once it worked; none: it just goes. */
  done?: (r: T) => string | undefined;
}

/**
 * Run an action in the background: the dialog that started it closes and its rows go at once, while a
 * toast says how it is going until it is done, then how it went. When it fails, the rows come back and
 * the error stays until clicked. Resolves to what `run` returned, undefined once it failed.
 */
export async function runTask<T>({ label, conflictsIn, hide = [], invalidate = [], run, done }: Task<T>): Promise<T | undefined> {
  const toast = progress(label, conflictsIn);
  const mine = [...hide];
  setHides([...hides, mine]);
  try {
    const r = await run(toast.say);
    toast.end(done?.(r));
    return r;
  } catch (e) {
    toast.end(e instanceof Error ? e.message : String(e), "error");
    return undefined;
  } finally {
    setHides(hides.filter((h) => h !== mine));
    for (const k of invalidate) queryClient.invalidateQueries({ queryKey: k });
  }
}
