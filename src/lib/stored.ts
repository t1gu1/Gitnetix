import { useState } from "react";

/**
 * A value kept in this browser between sessions. Storage can be missing or
 * blocked, so reads fall back to `def` and failed writes are ignored.
 * `set(v, false)` updates the value without saving it (e.g. mid-drag).
 */
export function useStored<T>(key: string, def: T, parse: (s: string) => T = JSON.parse, show: (v: T) => string = JSON.stringify) {
  const [value, setValue] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? def : parse(s);
    } catch {
      return def;
    }
  });
  const set = (next: T, persist = true) => {
    setValue(next);
    if (!persist) return;
    try {
      localStorage.setItem(key, show(next));
    } catch {
      /* per-viewer convenience only */
    }
  };
  return [value, set] as const;
}

const parseFlag = (s: string) => s === "1";
const showFlag = (v: boolean | null) => (v ? "1" : "0");

/** A boolean kept in this browser between sessions. */
export const useStoredFlag = (key: string) => useStored(key, false, parseFlag, showFlag);

/** A boolean that stays null until the viewer first sets it. */
export const useStoredChoice = (key: string) => useStored<boolean | null>(key, null, parseFlag, showFlag);
