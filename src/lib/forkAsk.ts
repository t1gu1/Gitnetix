import { useSyncExternalStore } from "react";

import { RpcError } from "../api/transport";

/** A push GitHub refused because the user can't write to origin (`repo`, owner/repo): the app offers to push it through
 * their fork instead. */
export interface ForkAsk {
  projectId: string;
  branch: string;
  repo: string;
}

let ask: ForkAsk | null = null;
const listeners = new Set<() => void>();
const set = (a: ForkAsk | null) => {
  ask = a;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Offers a fork when `e` is GitHub refusing the push `vars` asked for. False for any other error. */
export function askFork(e: unknown, vars: unknown): boolean {
  const v = vars as { projectId?: string; branch?: string } | undefined;
  if (!(e instanceof RpcError && e.code === "no_push_access" && e.repo && v?.projectId && v.branch)) return false;
  set({ projectId: v.projectId, branch: v.branch, repo: e.repo });
  return true;
}

export const useForkAsk = () => useSyncExternalStore(subscribe, () => ask);

export const endForkAsk = () => set(null);
