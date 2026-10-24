import { useSyncExternalStore } from "react";

import { Icon } from "../components/Icon";

type Kind = "info" | "ok" | "error";
interface Toast {
  id: number;
  text: string;
  kind: Kind;
  /** Playing its exit animation, removed right after. */
  leaving?: boolean;
}

let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** Length of the .toast[data-leaving] animation. */
const LEAVE_MS = 220;

function dismiss(id: number) {
  if (!toasts.some((t) => t.id === id && !t.leaving)) return;
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, LEAVE_MS);
}

export function toast(text: string, kind: Kind = "info", ms = kind === "error" ? 8000 : 4000) {
  const id = next++;
  toasts = [...toasts, { id, text, kind }];
  emit();
  setTimeout(() => dismiss(id), ms);
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
        <div key={t.id} className={`toast ${t.kind}`} data-leaving={t.leaving || undefined} onClick={() => dismiss(t.id)}>
          {t.kind !== "info" && <Icon name={t.kind === "ok" ? "check" : "close"} size={13} stroke={2} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
