import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useConfig, useProjects, useReorderProjects } from "../api/hooks";
import { PAGES, useNav } from "./nav";
import { saveView } from "./stored";

// The app's keyboard shortcuts, listed and changed in Settings › Shortcuts. Each is saved on its own and stays empty until
// changed (or after Reset), so each computer keeps its own default: ⌘ on macOS, Ctrl elsewhere.

export const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
const MODS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
/** Modifiers always in this order, so a saved shortcut and a key press compare as strings. */
const combo = (on: boolean[], code: string) => [...MODS.filter((_, i) => on[i]), code].join("+");
/** `code` with ⌘ on macOS, Ctrl elsewhere. */
const mod = (code: string) => combo([!MAC, false, false, MAC], code);

export interface Shortcut {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keys: string;
}

export const SHORTCUTS: Shortcut[] = [
  // ⌘⌥ on macOS, where ⌃← and ⌃→ switch desktops.
  { id: "nextProject", group: "Projects", label: "Next project", keys: MAC ? "Alt+Meta+ArrowRight" : "Ctrl+ArrowRight" },
  { id: "prevProject", group: "Projects", label: "Previous project", keys: MAC ? "Alt+Meta+ArrowLeft" : "Ctrl+ArrowLeft" },
  { id: "moveRight", group: "Projects", label: "Move project right", keys: MAC ? "Alt+Shift+Meta+ArrowRight" : "Ctrl+Shift+ArrowRight" },
  { id: "moveLeft", group: "Projects", label: "Move project left", keys: MAC ? "Alt+Shift+Meta+ArrowLeft" : "Ctrl+Shift+ArrowLeft" },
  // Ctrl on macOS too, where ⌘W closes the window.
  { id: "worktrees", group: "Projects", label: "Worktrees & agents", hint: "Again to go back to the project", keys: "Ctrl+KeyW" },
  ...PAGES.map((p, i) => ({ id: p.route.name, group: "Pages", label: p.label, keys: mod(`Digit${i + 1}`) })),
  { id: "newBranch", group: "Actions", label: "New branch", keys: mod("KeyN") },
  { id: "find", group: "Actions", label: "Find", hint: "In the branches, or in the open diff", keys: mod("KeyF") },
  { id: "dictation", group: "Actions", label: "Voice dictation", hint: "Again to put the words in", keys: mod("KeyD") },
  { id: "settings", group: "Actions", label: "Settings", keys: mod("Comma") },
  { id: "shortcuts", group: "Actions", label: "Keyboard shortcuts", keys: mod("Slash") },
  { id: "zoomIn", group: "Window", label: "Zoom in", keys: mod("Equal") },
  { id: "zoomOut", group: "Window", label: "Zoom out", keys: mod("Minus") },
  { id: "zoomReset", group: "Window", label: "Reset zoom", keys: mod("Digit0") },
];
export const DEFAULTS: Record<string, string> = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.keys]));

/** Keys the app keeps as they are: listed under the shortcuts, and refused for them. */
export const BUILT_IN: { label: string; hint?: string; keys: string }[] = [
  { label: "Commit", hint: "In the commit message", keys: mod("Enter") },
  // On macOS they are ⌘C, ⌘V and ⌘F, as everywhere there.
  ...(MAC
    ? []
    : [
        { label: "Copy in a terminal", keys: "Ctrl+Shift+KeyC" },
        { label: "Paste in a terminal", keys: "Ctrl+Shift+KeyV" },
        { label: "Find in a terminal", keys: "Ctrl+Shift+KeyF" },
      ]),
  { label: "Close, or go back", keys: "Escape" },
];

/** Dictation's keeps the name it had before this page, so keys set for it then stay. */
const storeKey = (id: string) => (id === "dictation" ? "gnx.dictation.keys" : `gnx.keys.${id}`);

/** Every shortcut's keys as set now, by id. */
export function useKeys() {
  const view = useConfig().data?.ui.view;
  return useMemo<Record<string, string>>(() => Object.fromEntries(SHORTCUTS.map((s) => [s.id, view?.[storeKey(s.id)] || s.keys])), [view]);
}

/** Saves a shortcut's keys; its default (or "") saves as empty, to follow the default of whichever computer opens it. */
export function useSetKeys() {
  const qc = useQueryClient();
  return (id: string, keys: string) => saveView(qc, storeKey(id), keys === DEFAULTS[id] ? "" : keys);
}

/** The name of what already has `keys`, but shortcut `id`: another shortcut or a built-in key. */
export const usedBy = (keys: string, id: string, now: Record<string, string>) =>
  SHORTCUTS.find((s) => s.id !== id && now[s.id] === keys)?.label ?? BUILT_IN.find((b) => b.keys === keys)?.label;

/** The pressed keys as a shortcut ("Ctrl+Shift+KeyM"), or null when they can't be one: it needs Ctrl, Alt or ⌘ plus a key
 *  that isn't a modifier. Letters go by what the layout prints on them (Ctrl+W is the W key on AZERTY too), the rest by place. */
export function comboOf(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.altKey || e.metaKey) || !e.code || /^(Control|Alt|Shift|Meta|OS)/.test(e.code)) return null;
  return combo([e.ctrlKey, e.altKey, e.shiftKey, e.metaKey], /^[a-z]$/i.test(e.key) ? `Key${e.key.toUpperCase()}` : e.code);
}

const NAMES: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Equal: "=",
  Minus: "-",
};
const SYMBOLS: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };

/** A shortcut's keys as printed on the keyboard: ["Ctrl", "→"], or ["⌥", "⌘", "→"] on macOS. */
export function keyCaps(keys: string) {
  const parts = keys.split("+");
  const code = parts.pop()!;
  const key = NAMES[code] ?? code.replace(/^(Key|Digit|Numpad)/, "");
  return [...parts.map((m) => (MAC ? SYMBOLS[m] : m === "Meta" ? "Super" : m)), key];
}

/** How a shortcut reads on this computer: ⌘D on macOS, Ctrl+D elsewhere. */
export const showKeys = (keys: string) => keyCaps(keys).join(MAC ? "" : "+");

/** Keys that move the caret or edit text. */
const EDITING = /^(Arrow|Home|End|Page|Backspace|Delete|Enter|Tab|Space)/;

/** The shortcuts that move around the app: projects, worktrees, pages, new branch, settings. Find, dictation and zoom have their own. */
export function useAppKeys() {
  const nav = useNav();
  const projects = useProjects().data;
  const keys = useKeys();
  const saveOrder = useReorderProjects();
  useEffect(() => {
    const open = (projects ?? []).filter((p) => !p.hidden);
    const step = (d: number) => {
      const n = open.length;
      // The worktrees tab is left of every project: from it, next is the first one and previous the last.
      const i = nav.inWorktrees ? -1 : open.findIndex((p) => p.id === nav.projectId);
      const at = i < 0 ? (d > 0 ? -1 : n) : i;
      if (n) nav.setProject(open[(at + d + n) % n].id);
    };
    const actions: Record<string, () => void> = {
      nextProject: () => step(1),
      prevProject: () => step(-1),
      settings: () => nav.go({ name: "menu" }),
      shortcuts: () => nav.go({ name: "menu", section: "shortcuts" }),
    };
    // The rest work on the open project.
    const pid = nav.projectId;
    if (pid) {
      actions.worktrees = () => (nav.inWorktrees ? nav.setProject(pid) : nav.go({ name: "worktrees" }));
      actions.newBranch = () => nav.openNewItem();
      for (const p of PAGES) actions[p.route.name] = () => nav.go(p.route);
      // The open project's tab trades places with its neighbour; it stays put at either end, and in Worktrees, where no tab is current.
      const move = (d: number) => {
        const i = open.findIndex((p) => p.id === pid);
        if (nav.inWorktrees || i < 0 || !open[i + d]) return;
        const order = [...open];
        [order[i], order[i + d]] = [order[i + d], order[i]];
        saveOrder([...order, ...(projects ?? []).filter((p) => p.hidden)].map((p) => p.id));
      };
      actions.moveRight = () => move(1);
      actions.moveLeft = () => move(-1);
    }
    const onKey = (e: KeyboardEvent) => {
      const c = comboOf(e);
      const id = c && Object.keys(actions).find((a) => keys[a] === c);
      if (!id) return;
      const at = e.target as Element;
      if (at.closest?.("[data-keys-input]") || document.querySelector("[role=dialog], [role=menu]")) return;
      // Left to a text box for the keys that move its caret, and to a terminal for Ctrl or Alt with a letter (Ctrl+W deletes a word
      // there). A shown terminal takes the focus, so its arrows stay the app's: Ctrl+→ goes on through the projects from it.
      if (at.closest?.("input, textarea:not(.xterm-helper-textarea), select, [contenteditable]") && EDITING.test(e.code)) return;
      if (at.closest?.(".xterm") && /^(Ctrl|Alt)\+Key[A-Z]$/.test(c)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) actions[id]();
    };
    // Captured, to come before the terminal, which keeps the keys it takes.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [nav, projects, keys, saveOrder]);
}
