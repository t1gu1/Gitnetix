import { useSyncExternalStore } from "react";

import { Icon } from "../components/Icon";

type Kind = "info" | "ok" | "error" | "busy";
interface Toast {
  id: number;
  text: string;
  kind: Kind;
  /** A busy toast's project: the engine's news about the work running there shows in it. */
  projectId?: string;
  /** Playing its exit animation, removed right after. */
  leaving?: boolean;
}

let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** Length of the .toast[data-leaving] animation. */
const LEAVE_MS = 220;
const shownFor = (kind: Kind) => (kind === "error" ? 8000 : 4000);

function dismiss(id: number) {
  if (!toasts.some((t) => t.id === id && !t.leaving)) return;
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, LEAVE_MS);
}

function edit(id: number, change: Partial<Toast>) {
  toasts = toasts.map((t) => (t.id === id ? { ...t, ...change } : t));
  emit();
}

/** `ms` Infinity: it stays until clicked. */
export function toast(text: string, kind: Exclude<Kind, "busy"> = "info", ms = shownFor(kind)) {
  const id = next++;
  toasts = [...toasts, { id, text, kind }];
  emit();
  if (Number.isFinite(ms)) setTimeout(() => dismiss(id), ms);
}

/**
 * A toast with a spinner, kept while work runs: `say` changes its text, `end` turns it into how it went
 * (no text: it just goes). An error stays until clicked: the work may have ended while nobody watched.
 */
export function progress(text: string, projectId?: string) {
  const id = next++;
  toasts = [...toasts, { id, text, kind: "busy", projectId }];
  emit();
  return {
    say: (t: string) => edit(id, { text: t }),
    end: (t?: string, kind: "ok" | "error" = "ok") => {
      if (!t) return dismiss(id);
      edit(id, { text: t, kind });
      if (kind === "ok") setTimeout(() => dismiss(id), shownFor(kind));
    },
  };
}

/** Show `text` in the busy toast of the work running in `projectId`; false when there is none. */
export function sayIn(projectId: string, text: string) {
  const t = toasts.filter((x) => x.kind === "busy" && x.projectId === projectId).pop();
  if (t) edit(t.id, { text });
  return !!t;
}

export function copyToClipboard(text: string) {
  return navigator.clipboard?.writeText(text).then(() => toast("Copied", "ok"));
}

export function Toasts() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        // A busy toast stays until its work is done.
        <div key={t.id} className={`toast ${t.kind}`} data-leaving={t.leaving || undefined} onClick={() => t.kind !== "busy" && dismiss(t.id)}>
          {t.kind === "busy" ? <span className="spinner" /> : t.kind !== "info" && <Icon name={t.kind === "ok" ? "check" : "close"} size={13} stroke={2} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
