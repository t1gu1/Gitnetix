import { useSyncExternalStore } from "react";

import { queryClient } from "../api/hooks";
import { rpc, subscribe } from "../api/transport";
import type { CleanupResult, GitnetixEvent } from "../api/types";
import { toast } from "./toast";

// Branch cleanups running in the background, as "<projectId> <section>". Kept outside any screen
// so they carry on, and stay shown, while the user is on another screen or project. Each holds
// the branches the engine has not got to yet.
let running: ReadonlyMap<string, ReadonlySet<string>> = new Map();
const listeners = new Set<() => void>();
const set = (next: ReadonlyMap<string, ReadonlySet<string>>) => {
  running = next;
  listeners.forEach((l) => l());
};
let unsubscribe: (() => void) | null = null;
const onStep = (e: GitnetixEvent) => {
  if (e.type !== "cleanupStep") return;
  const next = new Map(running);
  for (const [key, left] of running) {
    if (!key.startsWith(`${e.projectId} `) || !left.has(e.branch)) continue;
    const rest = new Set(left);
    rest.delete(e.branch);
    next.set(key, rest);
  }
  set(next);
};

export interface Cleanup {
  projectId: string;
  /** Shown in the toasts, so a cleanup finishing in another project still reads right. */
  projectName: string;
  /** Tree section locked meanwhile: "merged:<parent>" or "behind". */
  section: string;
  branches: string[];
  force?: boolean;
  remote: boolean;
  /** What a deleted branch is called in the toast, e.g. "merged branch". */
  what: string;
  onDeleted?: (branches: string[]) => void;
}

export function startCleanup({ projectId, projectName, section, branches, force, remote, what, onDeleted }: Cleanup) {
  const key = `${projectId} ${section}`;
  if (running.has(key)) return;
  unsubscribe ??= subscribe(onStep);
  set(new Map(running).set(key, new Set(branches)));
  rpc<CleanupResult>("branches.cleanup", { projectId, branches, force, remote })
    .then((r) => {
      for (const k of [["overview", projectId], ["files", projectId], ["worktrees"]]) queryClient.invalidateQueries({ queryKey: k });
      if (r.deleted.length) toast(`Deleted ${r.deleted.length} ${what}${r.deleted.length === 1 ? "" : "es"} in ${projectName}`, "ok");
      if (r.skipped.length) toast(`Kept ${r.skipped.length} in ${projectName}: ${r.skipped.map((s) => `${s.branch} (${s.reason})`).join("; ")}`, "error");
      onDeleted?.(r.deleted);
    })
    .catch((e: Error) => toast(e.message, "error"))
    .finally(() => {
      const next = new Map(running);
      next.delete(key);
      set(next);
      if (!next.size) {
        unsubscribe?.();
        unsubscribe = null;
      }
    });
}

/** How many branches a cleanup running on a section of `projectId`'s branch tree has left; undefined when none runs. */
export function useCleaning(projectId: string): (section: string) => number | undefined {
  const now = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => running,
  );
  return (section) => now.get(`${projectId} ${section}`)?.size;
}
