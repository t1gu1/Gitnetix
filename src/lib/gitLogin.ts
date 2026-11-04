import { useSyncExternalStore } from "react";

import { RpcError } from "../api/transport";

/** An HTTPS host git couldn't sign in to, and the actions to run again once the user gave a login. */
export interface LoginAsk {
  host: string;
  /** The host turned down the login git had (a stale saved one, a token without access). */
  refused: boolean;
  retries: (() => void)[];
}

let ask: LoginAsk | null = null;
const listeners = new Set<() => void>();
const set = (a: LoginAsk | null) => {
  ask = a;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Asks for a login when `e` is git failing to sign in over HTTPS, and runs `retry` once it is saved. False for any other error. */
export function askGitLogin(e: unknown, retry: () => void): boolean {
  if (!(e instanceof RpcError && e.code === "git_login" && e.host)) return false;
  // One host at a time: another host's error shows as a toast.
  if (ask && ask.host !== e.host) return false;
  set({ host: e.host, refused: !!ask?.refused || e.message.includes("Authentication failed"), retries: [...(ask?.retries ?? []), retry] });
  return true;
}

export const useGitLoginAsk = () => useSyncExternalStore(subscribe, () => ask);

/** Close the ask; `retry` runs again the actions that waited for it. */
export function endGitLogin(retry: boolean) {
  const a = ask;
  set(null);
  if (retry) a?.retries.forEach((r) => r());
}
