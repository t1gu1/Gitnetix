import { useSyncExternalStore } from "react";

type Kind = "info" | "ok" | "error";
interface Toast {
  id: number;
  text: string;
  kind: Kind;
}

let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, kind: Kind = "info") {
  const id = next++;
  toasts = [...toasts, { id, text, kind }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, kind === "error" ? 8000 : 4000);
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
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
