import { useSyncExternalStore } from "react";

/** View key of the answer, kept in the app's config: asked once, on the desktop and the phone alike. */
export const AGENT_CONSENT = "agents.consent";

/** What the config says, kept in sync by the AgentConsent host. */
let given = false;
export const setAgentConsent = (yes: boolean) => {
  given = yes;
};

let open: { promise: Promise<boolean>; resolve: (ok: boolean) => void } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Whether an agent may start: asks the first time, then remembers. Starts made meanwhile share the one question. */
export function agentConsent(): Promise<boolean> {
  if (given) return Promise.resolve(true);
  if (!open) {
    let resolve!: (ok: boolean) => void;
    open = { promise: new Promise<boolean>((r) => (resolve = r)), resolve };
    emit();
  }
  return open.promise;
}

export const useAgentConsentAsk = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open !== null,
  );

export function endAgentConsent(ok: boolean) {
  const o = open;
  open = null;
  if (ok) given = true;
  emit();
  o?.resolve(ok);
}
