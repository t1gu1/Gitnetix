import { useSyncExternalStore } from "react";

import type { TicketStudy } from "../api/types";

/** What the new ticket dialog opens on: a request typed in it, a branch's work (the ticket then becomes the branch's), or
 *  the draft a ticket study wrote, on its review step. */
export interface TicketAsk {
  projectId: string;
  branch?: string;
  study?: { id: string; to: TicketStudy; title: string; body: string };
}

let ask: TicketAsk | null = null;
const listeners = new Set<() => void>();
const set = (a: TicketAsk | null) => {
  ask = a;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const openNewTicket = (a: TicketAsk) => set(a);

export const useTicketAsk = () => useSyncExternalStore(subscribe, () => ask);

export const closeNewTicket = () => set(null);

/** The title and description of a ticket study's reply: its last ticket between a `[[TICKET]]` and an `[[END]]` line, laid out
 *  as the title's line, a blank line, then the description. None when the reply holds no ticket (a question, say). Like the
 *  engine's `split_ticket`. */
export function ticketDraft(reply: string): { title: string; body: string } | null {
  const at = reply.lastIndexOf("[[TICKET]]");
  if (at < 0) return null;
  let inner = reply.slice(at + "[[TICKET]]".length);
  const end = inner.indexOf("[[END]]");
  if (end >= 0) inner = inner.slice(0, end);
  inner = inner.trim();
  // A model that wraps it in a code fence anyway.
  if (inner.startsWith("```")) inner = inner.slice(inner.indexOf("\n") + 1).replace(/```\s*$/, "").trim();
  const nl = inner.indexOf("\n");
  const first = nl < 0 ? inner : inner.slice(0, nl);
  const title = first.replace(/^#+/, "").trim().replace(/^Title:/, "").trim().replace(/^\*+|\*+$/g, "").trim();
  return title ? { title, body: nl < 0 ? "" : inner.slice(nl + 1).trim() } : null;
}
