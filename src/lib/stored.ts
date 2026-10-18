import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useConfig } from "../api/hooks";
import { rpc } from "../api/transport";
import type { Config } from "../api/types";

/**
 * How a screen was left (pane width, collapsed section…), kept in the app's
 * config so it survives restarts. Reads fall back to `def` until the config
 * has loaded or when nothing is saved yet. `set(v, false)` updates the value
 * without saving it (e.g. mid-drag).
 */
export function useStored<T>(key: string, def: T, parse: (s: string) => T = JSON.parse, show: (v: T) => string = JSON.stringify) {
  const qc = useQueryClient();
  const cfg = useConfig().data;
  const saved = cfg?.ui.view?.[key];
  // Unsaved value, while a drag is under way.
  const [pending, setPending] = useState<{ key: string; value: T } | null>(null);
  const parsed = (s: string | undefined) => {
    if (s === undefined) return def;
    try {
      return parse(s);
    } catch {
      return def;
    }
  };
  const value = pending?.key === key ? pending.value : parsed(saved);

  const save = (s: string) => {
    qc.setQueryData<Config>(["config"], (c) => c && { ...c, ui: { ...c.ui, view: { ...c.ui.view, [key]: s } } });
    rpc("ui.setView", { key, value: s }).catch(() => {
      /* view state only: the screen still works, it just won't be restored */
    });
  };

  // Values from before view state moved into the config: carry them over once.
  useEffect(() => {
    if (!cfg || saved !== undefined) return;
    try {
      const old = localStorage.getItem(key);
      if (old === null) return;
      localStorage.removeItem(key);
      save(old);
    } catch {
      /* storage blocked: nothing to carry over */
    }
  }, [cfg, key, saved]);

  const set = (next: T, persist = true) => {
    if (!persist) return setPending({ key, value: next });
    setPending(null);
    save(show(next));
  };
  return [value, set] as const;
}

const parseFlag = (s: string) => s === "1";
const showFlag = (v: boolean | null) => (v ? "1" : "0");

/** A boolean kept between sessions. */
export const useStoredFlag = (key: string) => useStored(key, false, parseFlag, showFlag);

/** A boolean that stays null until the viewer first sets it. */
export const useStoredChoice = (key: string) => useStored<boolean | null>(key, null, parseFlag, showFlag);
