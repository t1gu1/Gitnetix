import { useSyncExternalStore } from "react";

import { queryClient } from "../api/hooks";
import { rpc } from "../api/transport";
import type { CleanupResult } from "../api/types";
import { toast } from "./toast";

// Branch cleanups running in the background, as "<projectId> <section>". Kept outside any screen
// so they carry on, and stay shown, while the user is on another screen or project.
let running: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const set = (next: ReadonlySet<string>) => {
  running = next;
  listeners.forEach((l) => l());
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
  set(new Set(running).add(key));
  rpc<CleanupResult>("branches.cleanup", { projectId, branches, force, remote })
    .then((r) => {
      for (const k of [["overview", projectId], ["files", projectId], ["worktrees"]]) queryClient.invalidateQueries({ queryKey: k });
      if (r.deleted.length) toast(`Deleted ${r.deleted.length} ${what}${r.deleted.length === 1 ? "" : "es"} in ${projectName}`, "ok");
      if (r.skipped.length) toast(`Kept ${r.skipped.length} in ${projectName}: ${r.skipped.map((s) => `${s.branch} (${s.reason})`).join("; ")}`, "error");
      onDeleted?.(r.deleted);
    })
    .catch((e: Error) => toast(e.message, "error"))
    .finally(() => {
      const next = new Set(running);
      next.delete(key);
      set(next);
    });
}

/** Whether a section of `projectId`'s branch tree has a cleanup running. */
export function useCleaning(projectId: string): (section: string) => boolean {
  const now = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => running,
  );
  return (section) => now.has(`${projectId} ${section}`);
}
