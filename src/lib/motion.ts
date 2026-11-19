import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useConfig } from "../api/hooks";
import { rpc } from "../api/transport";
import type { Config } from "../api/types";

/** The app's animations that can be turned off one by one, by id. The stylesheet stops each under `:root[data-anim-off~="<id>"]`. */
export const ANIMATIONS: { id: string; label: string; hint: string }[] = [
  { id: "path", label: "Branch path pulse", hint: "The streak running down the checked-out branch's line on the branch map" },
  { id: "shine", label: "Current branch shine", hint: "The light sweeping over the checked-out branch's name on the branch map, and over project names while the worktree list loads, and the colours flowing through the new agent session's project and branch names" },
  { id: "nudge", label: "Push button nudge", hint: "The push button wiggling while commits wait to be pushed" },
  { id: "wip", label: "WIP badge pulse", hint: "The WIP badge fading in and out while files have uncommitted changes" },
  { id: "activity", label: "Activity pulse", hint: "The dot pulsing next to running agents, AI work and checks, and a branch's AI working and waiting labels" },
  { id: "tabs", label: "Project tab drag", hint: "The stretch, pop and spring back when reordering project tabs" },
  { id: "menu", label: "Menu slide", hint: "The menu sliding in and out" },
  { id: "pages", label: "Page fade", hint: "Pages fading up into place when opened" },
  { id: "lists", label: "List entrances", hint: "Files, commits and agent replies fading in as they appear, chart bars growing" },
  { id: "dialogs", label: "Dialog pop", hint: "Dialogs, context menus and notifications popping in" },
  { id: "minimize", label: "Minimize to the corner", hint: "A minimized new branch dialog closing into its chip, which then slides to the bottom left corner" },
  { id: "panes", label: "Panel slide", hint: "On mobile, a branch's Timeline and Code panels sliding in when switching between them" },
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

/** A dialog as it stood just before it closed: where, and a copy of its box. */
export interface DialogShot {
  rect: DOMRect;
  copy: HTMLElement;
}

/** The dialog `shot` closing into `chip`, which it was minimized to: it shrinks to the chip's size where it stood, then the chip slides to its place
 *  in the corner. The chip stays hidden until it lands. Call it once the chip is laid out, before paint (a layout effect). */
export function flyIntoChip(shot: DialogShot, chip: HTMLElement) {
  if (!animates("minimize")) return;
  const { rect: from, copy } = shot;
  const to = chip.getBoundingClientRect();
  // The chip first shows on the dialog's middle.
  const mid = { left: from.left + (from.width - to.width) / 2, top: from.top + (from.height - to.height) / 2, width: to.width, height: to.height };
  const at = (r: { left: number; top: number; width: number; height: number }) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  const ease = getComputedStyle(document.documentElement).getPropertyValue("--ease").trim() || "ease-out";
  const scrim = document.createElement("div");
  scrim.className = "modal-scrim fly-scrim";
  const ghost = document.createElement("div");
  ghost.className = "fly-ghost";
  copy.classList.add("fly-dialog");
  Object.assign(copy.style, { width: `${from.width}px`, height: `${from.height}px` });
  const face = chip.cloneNode(true) as HTMLElement;
  face.classList.add("fly-face");
  ghost.append(copy, face);
  for (const el of [scrim, ghost]) {
    el.inert = true;
    el.setAttribute("aria-hidden", "true");
  }
  document.body.append(scrim, ghost);
  chip.style.visibility = "hidden";
  const shrink = 180;
  const slide = 300;
  scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: shrink, easing: ease, fill: "forwards" });
  copy.animate([{ opacity: 1, transform: "translate(-50%, -50%)" }, { opacity: 0, transform: "translate(-50%, -50%) scale(0.92)" }], { duration: shrink, easing: ease, fill: "forwards" });
  face.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], { duration: shrink, fill: "backwards" });
  ghost
    .animate([{ ...at(from), easing: ease }, { ...at(mid), offset: shrink / (shrink + slide), easing: ease }, at(to)], { duration: shrink + slide, fill: "both" })
    .finished.catch(() => undefined)
    .then(() => {
      scrim.remove();
      ghost.remove();
      chip.style.visibility = "";
    });
}

/** Puts the turned-off animations on the root element, where the stylesheet looks for them. */
export function useApplyAnimations(off: string[] | undefined) {
  const v = (off ?? []).join(" ");
  useEffect(() => {
    if (v) document.documentElement.dataset.animOff = v;
    else delete document.documentElement.dataset.animOff;
  }, [v]);
}

/** The endless animations' shared tick, in ms: their durations are whole ticks, so steps started on it land on the same frames. */
export const TICK = 1000 / 12;
export const onTick = (ms: number) => Math.round(ms / TICK) * TICK;

/** After `ms` without pointer, wheel or keys, or while the window is hidden, puts `data-idle` on the root element: the stylesheet pauses the endless animations
 * there, any one of which keeps the webview drawing every frame. The next input plays them on from where they stood.
 * Meanwhile it keeps them on the shared tick: each starts when its element shows (or resumes), off it, and would draw frames of its own. */
export function usePauseWhenIdle(ms = 30_000) {
  useEffect(() => {
    const root = document.documentElement;
    let last = performance.now();
    let timer = 0;
    const align = () => {
      for (const a of document.getAnimations()) {
        if (!(a instanceof CSSAnimation) || a.playState !== "running" || a.startTime === null || a.effect?.getTiming().iterations !== Infinity) continue;
        const at = onTick(Number(a.startTime));
        if (Math.abs(at - Number(a.startTime)) > 0.5) a.startTime = at;
      }
    };
    const aligner = window.setInterval(() => "idle" in root.dataset || align(), 2000);
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
      clearInterval(aligner);
      delete root.dataset.idle;
    };
  }, [ms]);
}

const watchIdle = (on: () => void) => {
  const o = new MutationObserver(on);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-idle"] });
  return () => o.disconnect();
};
const isIdle = () => "idle" in document.documentElement.dataset;

/** True while {@link usePauseWhenIdle} has the app idle (no input for 30 s, or the window hidden): polls only worth it for someone watching wait. */
export const useIdle = () => useSyncExternalStore(watchIdle, isIdle);

/** The turned-off animations and a toggle for one, saved to the app's config. */
export function useAnimations() {
  const qc = useQueryClient();
  // Ids no longer in ANIMATIONS (a removed one, still in a saved config) would throw off the all on / all off counts.
  const off = (useConfig().data?.ui.animationsOff ?? []).filter((id) => ANIMATIONS.some((a) => a.id === id));
  const save = (next: string[]) => {
    qc.setQueryData<Config>(["config"], (c) => c && { ...c, ui: { ...c.ui, animationsOff: next } });
    rpc("ui.set", { animationsOff: next }).catch(() => qc.invalidateQueries({ queryKey: ["config"] }));
  };
  const toggle = (id: string) => save(off.includes(id) ? off.filter((x) => x !== id) : [...off, id]);
  const setAll = (on: boolean) => save(on ? [] : ANIMATIONS.map((a) => a.id));
  return { off, toggle, setAll };
}
