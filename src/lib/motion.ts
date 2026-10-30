import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useConfig } from "../api/hooks";
import { rpc } from "../api/transport";
import type { Config } from "../api/types";

/** The app's animations that can be turned off one by one, by id. The stylesheet stops each under `:root[data-anim-off~="<id>"]`. */
export const ANIMATIONS: { id: string; label: string; hint: string }[] = [
  { id: "path", label: "Branch path pulse", hint: "The streak running down the orange path to the checked-out branch, and its glow on arrival" },
  { id: "shine", label: "Current branch shine", hint: "The light sweeping over the checked-out branch's name and its group label, and over project names while the worktree list loads" },
  { id: "commit", label: "New commit pop", hint: "The commit link popping and glowing when a branch gets a new commit" },
  { id: "nudge", label: "Push button nudge", hint: "The push button wiggling while commits wait to be pushed" },
  { id: "wip", label: "WIP badge pulse", hint: "The WIP badge fading in and out while files have uncommitted changes" },
  { id: "activity", label: "Activity pulse", hint: "The dot pulsing next to running agents, AI work and checks, and a branch's AI working and waiting labels" },
  { id: "tabs", label: "Project tab drag", hint: "The stretch, pop and spring back when reordering project tabs" },
  { id: "menu", label: "Menu slide", hint: "The menu sliding in and out" },
  { id: "pages", label: "Page fade", hint: "Pages fading up into place when opened" },
  { id: "lists", label: "List entrances", hint: "Branches, files, commits and agent replies fading in as they appear, chart bars growing" },
  { id: "dialogs", label: "Dialog pop", hint: "Dialogs, context menus and notifications popping in" },
  { id: "panes", label: "Panel slide", hint: "On mobile, the Branches, Files and Diff panels sliding in when switching between them" },
  { id: "seg", label: "Tab highlight slide", hint: "The highlight, the page underline and the mobile tab bubble sliding from the previous tab to the newly selected one" },
  { id: "tooltips", label: "Tooltip fade", hint: "Tooltips fading in" },
  { id: "chevrons", label: "Folding arrows", hint: "Arrows turning as groups open and close" },
  { id: "wave", label: "Dictation wave", hint: "The bars moving with your voice while dictating, and their ripple while the words are written out" },
];

/** Whether an animation plays: not turned off here, nor by the system's reduced motion. For the ones the code waits on. */
export function animates(id: string) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  return !(document.documentElement.dataset.animOff ?? "").split(" ").includes(id);
}

/** Puts the turned-off animations on the root element, where the stylesheet looks for them. */
export function useApplyAnimations(off: string[] | undefined) {
  const v = (off ?? []).join(" ");
  useEffect(() => {
    if (v) document.documentElement.dataset.animOff = v;
    else delete document.documentElement.dataset.animOff;
  }, [v]);
}

/** After `ms` without pointer, wheel or keys, or while the window is hidden, puts `data-idle` on the root element: the stylesheet pauses the endless animations
 * there, any one of which keeps the webview drawing every frame. The next input plays them on from where they stood. */
export function usePauseWhenIdle(ms = 30_000) {
  useEffect(() => {
    const root = document.documentElement;
    let last = performance.now();
    let timer = 0;
    // Input only moves `last`: the pending check sleeps again for what is left.
    const check = () => {
      const left = last + ms - performance.now();
      if (left > 0) timer = window.setTimeout(check, left);
      else root.dataset.idle = "";
    };
    const wake = () => {
      last = performance.now();
      if (!("idle" in root.dataset)) return;
      delete root.dataset.idle;
      timer = window.setTimeout(check, ms);
    };
    const shown = () => {
      if (!document.hidden) return wake();
      clearTimeout(timer);
      root.dataset.idle = "";
    };
    const opts = { capture: true, passive: true };
    const inputs = ["pointermove", "pointerdown", "wheel", "keydown"];
    for (const t of inputs) window.addEventListener(t, wake, opts);
    document.addEventListener("visibilitychange", shown);
    timer = window.setTimeout(check, ms);
    return () => {
      for (const t of inputs) window.removeEventListener(t, wake, opts);
      document.removeEventListener("visibilitychange", shown);
      clearTimeout(timer);
      delete root.dataset.idle;
    };
  }, [ms]);
}

/** The turned-off animations and a toggle for one, saved to the app's config. */
export function useAnimations() {
  const qc = useQueryClient();
  const off = useConfig().data?.ui.animationsOff ?? [];
  const save = (next: string[]) => {
    qc.setQueryData<Config>(["config"], (c) => c && { ...c, ui: { ...c.ui, animationsOff: next } });
    rpc("ui.set", { animationsOff: next }).catch(() => qc.invalidateQueries({ queryKey: ["config"] }));
  };
  const toggle = (id: string) => save(off.includes(id) ? off.filter((x) => x !== id) : [...off, id]);
  const setAll = (on: boolean) => save(on ? [] : ANIMATIONS.map((a) => a.id));
  return { off, toggle, setAll };
}
