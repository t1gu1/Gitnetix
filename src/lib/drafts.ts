import { useEffect, useSyncExternalStore } from "react";

import type { Attachment } from "../components/AgentLog";

/** What was typed and attached in an agent's prompt box, not sent yet; `form` holds a dialog's other fields. */
interface Draft {
  text: string;
  files: Attachment[];
  form?: object;
}

const EMPTY: Draft = { text: "", files: [] };
// This run's drafts; each is read from disk the first time its box shows.
const mem = new Map<string, Draft>();
// Every box showing a draft redraws when it changes.
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const changed = () => listeners.forEach((l) => l());

// IndexedDB, not the app config: files keep their contents, so a pasted screenshot is still there after a restart.
let db: Promise<IDBDatabase> | undefined;
function store(mode: IDBTransactionMode) {
  db ??= new Promise((ok, fail) => {
    const r = indexedDB.open("gnx-drafts", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("drafts");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  return db.then((d) => d.transaction("drafts", mode).objectStore("drafts"));
}

const read = (s: IDBObjectStore, key: string) =>
  new Promise<unknown>((ok, fail) => {
    const r = s.get(key);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });

// Each part apart: a keystroke rewrites the text alone, not the attached images.
const PART = { text: "t", files: "f", form: "o" } as const;

async function load(key: string): Promise<Draft> {
  const s = await store("readonly");
  const [text, files, form] = await Promise.all([read(s, `t ${key}`), read(s, `f ${key}`), read(s, `o ${key}`)]);
  return { text: typeof text === "string" ? text : "", files: Array.isArray(files) ? files : [], form: form && typeof form === "object" ? form : undefined };
}

// Empty text, no files or no form: nothing kept.
function save(k: string, v: unknown) {
  store("readwrite")
    .then((s) => (v === undefined || (v as { length?: number }).length === 0 ? s.delete(k) : s.put(v, k)))
    .catch(() => {
      /* drafts only: the box still works, it just forgets on restart */
    });
}

/** The draft under `key` (a project's branch, or a dialog): it stays when its box goes away, across pages, projects and restarts. */
export function useDraft<F extends object = never>(key: string) {
  const d = useSyncExternalStore(subscribe, () => mem.get(key)) ?? EMPTY;
  useEffect(() => {
    if (mem.has(key)) return;
    load(key).then(
      (loaded) => {
        // Typed into before it loaded: what was typed stays.
        if (mem.has(key)) return;
        mem.set(key, loaded);
        changed();
      },
      () => {},
    );
  }, [key]);
  // `key` as of this render: a send finishing after a branch switch clears the branch it was sent from.
  const update = (next: Partial<Draft>) => {
    const was = mem.get(key) ?? EMPTY;
    mem.set(key, { ...was, ...next });
    for (const p of Object.keys(next) as (keyof Draft)[]) if (next[p] !== was[p]) save(`${PART[p]} ${key}`, next[p]);
    changed();
  };
  return {
    text: d.text,
    files: d.files,
    form: d.form as F | undefined,
    setText: (t: string | ((was: string) => string)) => update({ text: typeof t === "function" ? t((mem.get(key) ?? EMPTY).text) : t }),
    setFiles: (files: Attachment[]) => update({ files }),
    setForm: (form: F | undefined) => update({ form }),
  };
}
