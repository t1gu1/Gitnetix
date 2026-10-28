import { useEffect, useSyncExternalStore } from "react";

/** What an action would do to the branches, for the commit graph to show before it runs. */
export type GraphIntent =
  | { kind: "rebase"; branch: string; onto: string }
  | { kind: "merge"; branch: string; into: string; squash?: boolean; rebase?: boolean; deleteBranch?: boolean; push?: boolean; stay?: boolean }
  | { kind: "sync"; branch: string; from: string }
  | { kind: "pull"; branch: string }
  | { kind: "push"; branch: string; force?: boolean; /** Switched to once published. */ home?: string }
  | { kind: "reset"; branch: string }
  | { kind: "resetTo"; branch: string; sha: string; mode: "soft" | "mixed" | "hard" }
  | { kind: "tag"; branch?: string; sha?: string; name?: string }
  | { kind: "deleteTag"; tag: string }
  | { kind: "create"; from: string }
  | { kind: "switch"; branch: string }
  | { kind: "delete"; branch: string; remote?: boolean; local?: boolean }
  | { kind: "stash"; branch: string }
  | { kind: "unstash"; branch: string }
  | { kind: "commit"; branch: string; message?: string; /** Every changed file, not just the staged ones. */ all: boolean; push?: boolean }
  | { kind: "revert"; branch: string; sha: string }
  | { kind: "cherryPick"; onto: string; sha: string }
  | { kind: "ship"; release: string; into: string; version: string; push?: boolean; changelog?: boolean }
  | { kind: "changelog"; branch: string; what: string };

/** Branches an intent needs the graph to hold. */
export function intentBranches(i: GraphIntent | null): string[] {
  if (!i) return [];
  switch (i.kind) {
    case "rebase":
      return [i.branch, i.onto];
    case "merge":
      return [i.branch, i.into];
    case "sync":
      return [i.branch, i.from];
    case "cherryPick":
      return [i.onto];
    case "ship":
      return [i.release, i.into];
    case "create":
      return [i.from];
    case "tag":
      return i.branch ? [i.branch] : [];
    case "deleteTag":
      return [];
    default:
      return [i.branch];
  }
}

const keyOf = (i: GraphIntent | null | undefined) => (i ? JSON.stringify(i) : "");

// The action under the pointer (or keyboard focus), the one just picked while it runs, and the branch row under the pointer.
let action: GraphIntent | null = null;
let held: { intent: GraphIntent; at: number } | null = null;
let branch: string | null = null;
let pinned: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

/** The graph shows what `i` would do, until `endPreview`. */
export function previewAction(i: GraphIntent | null | undefined) {
  if (!i || keyOf(i) === keyOf(action)) return;
  action = i;
  emit();
}

/** Stop showing `i` (any preview when none is given); another one shown since stays. */
export function endPreview(i?: GraphIntent | null) {
  if (!action || (i && keyOf(i) !== keyOf(action))) return;
  action = null;
  emit();
}

/** How long a picked action's preview stays while it runs, at most: the refreshed graph takes over once it lands. */
const HOLD_MS = 2500;

/** `i` was picked: keep showing it while it runs, so the graph doesn't go back to how things were before it lands. */
export function holdPreview(i: GraphIntent | null | undefined) {
  if (!i) return;
  const h = { intent: i, at: Date.now() };
  held = h;
  if (keyOf(action) === keyOf(i)) action = null;
  emit();
  setTimeout(() => held === h && releaseHeld(), HOLD_MS);
}

/** The picked action's preview is over: its result is in, or it took too long. */
export function releaseHeld() {
  if (!held) return;
  held = null;
  emit();
}

/** The branch row under the pointer; the graph brings that branch forward. */
export function hoverBranch(b: string | null) {
  if (b === branch) return;
  branch = b;
  emit();
}

/** The branch whose menu is open: the graph keeps it while the pointer goes from its row to the menu. */
export function pinBranch(b: string | null) {
  if (b === pinned) return;
  pinned = b;
  emit();
}

const getAction = () => action ?? held?.intent ?? null;
const getPinned = () => pinned;
const getHeld = () => held;
const getBranch = () => branch;

/** The action to preview: the one under the pointer, else one just picked that is still running. */
export const usePreviewAction = () => useSyncExternalStore(subscribe, getAction);
/** The picked action whose preview is held while it runs. */
export const useHeldPreview = () => useSyncExternalStore(subscribe, getHeld);
export const useHoveredBranch = () => useSyncExternalStore(subscribe, getBranch);
export const usePinnedBranch = () => useSyncExternalStore(subscribe, getPinned);

/** Pointer and keyboard-focus handlers that preview `i` while on the element. A menu focusing its first item as it opens under the pointer previews nothing. */
export function previewHandlers(i: GraphIntent | null | undefined) {
  if (!i) return {};
  return {
    onPointerEnter: () => previewAction(i),
    onPointerLeave: () => endPreview(i),
    onFocus: (e: { currentTarget: Element }) => e.currentTarget.matches(":focus-visible") && previewAction(i),
    onBlur: () => endPreview(i),
  };
}

/** While a dialog is open, the graph shows what it would do with the options picked in it. Call what it returns as the dialog's action starts: the preview stays while it runs. */
export function useDialogPreview(i: GraphIntent | null) {
  const key = keyOf(i);
  useEffect(() => {
    if (!i) return;
    // The menu item or button that opened the dialog held its preview: the dialog's own takes over, and goes if it's cancelled.
    releaseHeld();
    previewAction(i);
    return () => endPreview(i);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return () => holdPreview(i);
}
