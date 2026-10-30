import { useIsMutating } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { useAction, useAgents } from "../api/hooks";
import type { BranchView, Overview, ReleaseView } from "../api/types";
import { shownStatus } from "../lib/agentLog";
import { AuthorFilter, authorsOf } from "../components/AuthorFilter";
import { Avatar } from "../components/Avatar";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Empty, releaseTagLabel } from "../components/ui";
import { plural, stashCount } from "../lib/format";
import { useNav } from "../lib/nav";
import { BranchSplit, type BranchActions, type BranchTarget } from "./BranchMenu";

/** Branches this many commits behind the default branch count as falling behind. */
const BEHIND_LIMIT = 25;
/** The tree's looping animations: the pulse down the orange path and the glow fading on the checked-out row, on the pulse's clock; the shines, on the page's. */
const PULSE_ANIMATIONS = new Set(["path-pulse", "path-glow-fade"]);
const SHINE_ANIMATIONS = new Set(["shine"]);
/** The pieces of the orange path, in document order (top to bottom), and which of them are its 7px elbows. */
const PATH_PIECES = ".tree-row[data-path], .tree-node[data-path], .tree-sep[data-path], .tree-merged + .tree-kids[data-path], .tree-toggle[data-path] + .tree-open";
const PATH_ELBOW = '.tree-open, .tree-kids[data-path="in"]';
const ELBOW_LENGTH = 7;
/** Pieces where the path only runs past (sibling branches, groups it skips), drawn dimmer; and how far, in pixels, their run fades in and out of it. */
const PATH_PAST = '.tree-node[data-path], .tree-row[data-path="past"], .tree-kids[data-path="past"]';
const PAST_FADE = 24;
/** Pace of the pulse down the path, in pixels per second, however long the path: each loop lasts as long as its run takes (--pulse-loop). */
const PULSE_SPEED = 90;
/** The pulse covers at least this many pixels of path per loop, so a short path still gets a pause between pulses. */
const PULSE_MIN_RUN = 360;
/** The Falling behind section shows once more than this many branches fall behind. */
const BEHIND_MIN_BRANCHES = 2;

/** Open sections per project, for this run of the app. */
const openSections = new Map<string, Set<string>>();
/** Per project, a branch whose sections open once it shows in the tree (one just created). */
const toReveal = new Map<string, string>();
/** Per project, the sections down to the checked-out branch when the tree last opened them. */
const pathOpened = new Map<string, string>();

/** Open the sections down to `branch` the next time the tree shows it, e.g. right after creating it. */
export function revealBranch(pid: string, branch: string) {
  toReveal.set(pid, branch);
}

/**
 * Open sections of a project. The first time it shows in a run of the app, everything starts
 * closed except the sections leading to `initial`'s checked-out branch.
 */
function useToggles(pid: string, initial: () => Set<string>) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  if (!openSections.has(pid)) openSections.set(pid, initial());
  // Read the map on each call: `openAll` swaps the set mid-render.
  const isOpen = (id: string) => openSections.get(pid)!.has(id);
  const toggle = (id: string) => {
    const next = new Set(openSections.get(pid)!);
    if (!next.delete(id)) next.add(id);
    openSections.set(pid, next);
    rerender();
  };
  // Called while rendering: the sections are open in this same render, no rerender needed.
  const openAll = (ids: string[]) => openSections.set(pid, new Set([...openSections.get(pid)!, ...ids]));
  return { isOpen, toggle, openAll };
}

/**
 * Children of a branch, in display order: releases, trunks, active work by recency; merged ones apart.
 * Shipped release branches move to the Shipped section, unless that section doesn't list them or
 * the checked-out branch or unmerged work sits below them.
 */
function childrenOf(o: Overview) {
  const names = new Set(o.branches.map((b) => b.name));
  const kids = new Map<string, BranchView[]>();
  const roots: BranchView[] = [];
  for (const b of o.branches) {
    // A parent that no longer exists hands its children to the default branch.
    const p = b.parent ? (names.has(b.parent) ? b.parent : o.defaultBranch) : null;
    if (!p || p === b.name || !names.has(p)) roots.push(b);
    else if (kids.has(p)) kids.get(p)!.push(b);
    else kids.set(p, [b]);
  }
  // Dates carry each committer's own UTC offset, so compare instants, not strings.
  const time = (b: BranchView) => Date.parse(b.date) || 0;
  const relOrder = (b: BranchView) => o.releases.findIndex((r) => r.open && r.branch === b.name);
  const rank = (b: BranchView) => (b.role === "release" ? 0 : b.role === "trunk" ? 1 : b.exists ? 2 : 3);
  const order = (a: BranchView, b: BranchView) => rank(a) - rank(b) || relOrder(a) - relOrder(b) || time(b) - time(a) || a.name.localeCompare(b.name);
  const listed = new Set(o.releases.filter((r) => !r.open).map((r) => r.version));
  const inUse = (b: BranchView): boolean => b.name === o.currentBranch || (kids.get(b.name) ?? []).some((c) => !c.merged || inUse(c));
  const shipped = new Map<string, BranchView>();
  for (const b of o.branches) if (b.shipped && listed.has(b.shipped) && !inUse(b)) shipped.set(b.shipped, b);
  const inTree = (b: BranchView) => !(b.shipped && shipped.get(b.shipped) === b);
  for (const [p, list] of kids) kids.set(p, list.filter(inTree).sort(order));
  const tops = roots.filter(inTree);
  tops.sort((a, b) => (a.name === o.defaultBranch ? -1 : b.name === o.defaultBranch ? 1 : order(a, b)));
  return { roots: tops, shipped, kids: (name: string) => kids.get(name) ?? [] };
}

function look(b: BranchView, isDefault: boolean, shipped: boolean): { icon: string; cls: string } {
  if (!b.exists) return { icon: "close", cls: "c-del" };
  if (shipped) return { icon: "tag", cls: "" };
  if (b.merged) return { icon: "merged", cls: "c-add" };
  if (b.role === "release") return { icon: "tag", cls: "c-acc" };
  if (b.role === "trunk") return { icon: isDefault ? "home" : "commit", cls: "" };
  return { icon: "branch", cls: "" };
}

export function BranchTree({
  active,
  o,
  selected,
  actions,
  target,
  onSelect,
  onNewRelease,
  onCleanup,
  onCleanupBehind,
  onCleanupShipped,
  isCleaning,
  cleanupLeft,
  tagItems,
  onStashes,
  building,
  updating,
  progress,
}: {
  active: boolean;
  o: Overview;
  selected?: string;
  actions: BranchActions;
  target: (b: string) => BranchTarget;
  onSelect: (b: string) => void;
  onNewRelease: () => void;
  /** Clean up the merged children of `parent`, shown as `label`. */
  onCleanup: (parent: string, label: string, branches: BranchView[]) => void;
  /** Clean up (delete) branches falling behind: the ones in `section`, far behind `base`. */
  onCleanupBehind: (section: string, base: string, branches: BranchView[]) => void;
  /** Clean up (delete) shipped release branches still around; their tags stay. */
  onCleanupShipped: (branches: BranchView[]) => void;
  /** Whether a cleanup is running on a section ("merged:<parent>", "behind:<parent>", "behind" or "shipped"); it stays locked until done. */
  isCleaning: (section: string) => boolean;
  /** Branches a running cleanup has left on a section; undefined when none runs. */
  cleanupLeft: (section: string) => number | undefined;
  /** Actions for a shipped release's tag; the first one (check out) also runs on double-click. */
  tagItems: (tag: string, checkedOut: boolean) => MenuItem[];
  /** Opens every stash of the project. */
  onStashes: () => void;
  /** First look at the project: branches are not filed under their parents yet. */
  building?: boolean;
  /** The overview is being read again (after an action, a fetch, a change in git). */
  updating?: boolean;
  /** Branches worked out so far of those a long rebuild redoes. */
  progress?: { done: number; total: number } | null;
}) {
  const pid = o.project.id;
  const [query, setQuery] = useState("");
  // Everyone who authored a branch tip; the ones picked are shown, none picked = all.
  const authors = useMemo(() => authorsOf(o.branches), [o.branches]);
  const [who, setWho] = useState<string[]>([]);
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; alignRight: boolean; tag: string; checkedOut: boolean } | null>(null);
  const openTagMenu = (tag: string, checkedOut: boolean, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Same anchoring as the branch menu: the pointer on right-click, under the button (or element, from the keyboard) otherwise.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fromKey = e.type === "contextmenu" && e.clientX === 0 && e.clientY === 0;
    if (e.type !== "contextmenu") setTagMenu({ x: r.right, y: r.bottom + 2, alignRight: true, tag, checkedOut });
    else setTagMenu({ x: fromKey ? r.left : e.clientX, y: fromKey ? r.bottom + 2 : e.clientY, alignRight: false, tag, checkedOut });
  };
  const fetchOrigin = useAction("branches.fetch", { invalidate: [["overview", pid]], success: () => "Fetched origin" });
  const { roots, shipped: shippedBranches, kids } = useMemo(() => childrenOf(o), [o]);
  // Shipped releases: the branch row (with what merged into it) while it is still around, else a plain entry.
  const shipped = o.releases.filter((r) => !r.open);
  const tops = useMemo(() => [...roots, ...shippedBranches.values()], [roots, shippedBranches]);

  // Live branches that drifted far from their base, furthest behind first. A release or trunk with
  // enough of them groups its own (`behindOf`); the rest fall back to the section after the tree.
  const { behind, behindOf } = useMemo(() => {
    const names = new Set(o.branches.map((b) => b.name));
    const byParent = new Map<string, BranchView[]>();
    for (const b of o.branches) {
      const parent = b.parent && names.has(b.parent) ? b.parent : o.defaultBranch;
      if (b.name === o.defaultBranch || !b.exists || b.merged || b.behind < BEHIND_LIMIT) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), b]);
    }
    const furthest = (list: BranchView[]) => list.sort((a, b) => b.behind - a.behind || a.name.localeCompare(b.name));
    const behindOf = new Map<string, BranchView[]>();
    const rest: BranchView[] = [];
    for (const [parent, list] of byParent) {
      if (parent !== o.defaultBranch && list.length > BEHIND_MIN_BRANCHES) behindOf.set(parent, furthest(list));
      else rest.push(...list);
    }
    return { behind: rest.length > BEHIND_MIN_BRANCHES ? furthest(rest) : [], behindOf };
  }, [o]);
  /** Section of the tree child `c` of `parent` sits in. */
  const sectionOf = (parent: string, c: BranchView) =>
    c.merged ? `merged:${parent}` : behindOf.get(parent)?.includes(c) ? `behind:${parent}` : behind.includes(c) ? "behind" : parent;
  // Protected, checked-out, busy or dirty branches stay put.
  const cleanable = (b: BranchView) => !b.protected && !b.checkedOut && !b.running && b.wip === 0;

  const q = query.trim().toLowerCase();
  const picked = authors.filter((a) => who.includes(a.email));
  const emails = picked.flatMap((a) => a.emails).join("\n");
  const matches = useMemo(() => {
    if (!q && !emails) return null;
    const mine = new Set(emails.split("\n"));
    const hit = new Set<string>();
    const walk = (b: BranchView): boolean => {
      // Branches falling behind show in their own section (alone, without children): a match there keeps no parent, and only one of their own keeps them.
      const child = !behind.includes(b) && kids(b.name).map((c) => walk(c) && !behind.includes(c)).some(Boolean);
      if (behind.includes(b)) kids(b.name).forEach(walk);
      const self = (!q || b.name.toLowerCase().includes(q) || (b.release ?? "").includes(q)) && (!emails || b.role !== "branch" || !!b.shipped || mine.has(b.email.toLowerCase()));
      if (self || child) hit.add(b.name);
      return self || child;
    };
    tops.forEach(walk);
    return hit;
  }, [q, emails, tops, kids, behind]);
  // Picking authors only hides branches: trunks and releases stay, and so does the tree's layout (unlike a search).
  const shown = (b: BranchView) => !matches || matches.has(b.name);
  const behindShown = behind.filter(shown);
  const behindRemovable = behindShown.filter(cleanable);
  // The checked-out branch and every branch above it, marked whether or not their children are showing.
  const path = useMemo(() => {
    const on = new Set<string>();
    const walk = (b: BranchView): boolean => {
      if (matches && !matches.has(b.name)) return false;
      const hit = kids(b.name).map(walk).some(Boolean) || b.name === o.currentBranch;
      if (hit) on.add(b.name);
      return hit;
    };
    tops.forEach(walk);
    return on;
  }, [tops, kids, o.currentBranch, matches]);
  // Shipped holds the checked-out release tag, or a shipped branch the path runs through: the path then runs down past
  // everything above it, into Shipped and to that release.
  // A shipped release without its branch any more: kept by an author pick, by a search only when its version matches.
  const shippedShown = (r: ReleaseView) => {
    const b = shippedBranches.get(r.version);
    return b ? shown(b) : !q || `v${r.version}`.includes(q);
  };
  const shippedOnPath = shipped.findIndex((r) => shippedShown(r) && (r.checkedOut || path.has(shippedBranches.get(r.version)?.name ?? "")));
  const shippedActive = shippedOnPath >= 0;
  const pastShipped = shippedActive;
  const shippedRemovable = [...shippedBranches.values()].filter((b) => b.exists && shown(b) && cleanable(b));
  // Only the groups the path runs through start open: live children or the merged ones.
  const pathSections: string[] = [];
  for (const name of path) for (const c of kids(name)) if (path.has(c.name)) pathSections.push(sectionOf(name, c));
  const { isOpen, toggle, openAll } = useToggles(pid, () => new Set(pathSections));
  // The path moved to other groups (a pull merged the branch, a checkout, branches filed under their parents): open them too.
  const pathKey = pathSections.join("\n");
  if (!matches && pathOpened.get(pid) !== pathKey) {
    pathOpened.set(pid, pathKey);
    openAll(pathSections);
  }
  // While searching, every group holding a match is open; what the user closes then is kept apart, and forgotten with the search.
  const [shut, setShut] = useState<{ q: string; keys: Set<string> }>({ q: "", keys: new Set() });
  const opened = (key: string) => (q ? !(shut.q === q && shut.keys.has(key)) : isOpen(key));
  const flip = (key: string) => {
    if (!q) return toggle(key);
    const keys = new Set(shut.q === q ? shut.keys : []);
    if (!keys.delete(key)) keys.add(key);
    setShut({ q, keys });
  };
  // A branch just created: open every section above it once the overview lists it.
  const reveal = toReveal.get(pid);
  if (reveal && o.branches.some((b) => b.name === reveal)) {
    toReveal.delete(pid);
    const sections: string[] = [];
    const walk = (b: BranchView): boolean =>
      kids(b.name).some((c) => {
        const hit = c.name === reveal || walk(c);
        if (hit) sections.push(sectionOf(b.name, c));
        return hit;
      });
    tops.some(walk);
    openAll(sections);
  }

  // Uncommitted files anywhere below a branch, surfaced on its toggle while its children are hidden.
  const hiddenWip = (b: BranchView): number => kids(b.name).reduce((n, c) => n + c.wip + hiddenWip(c), 0);

  // Siblings listed above the one the path runs into: the path runs down past them.
  const pastPath = (list: BranchView[]) => {
    const i = list.findIndex((c) => path.has(c.name));
    return (c: BranchView) => node(c, list.indexOf(c) < i);
  };

  const node = (b: BranchView, past = false): ReactNode => {
    if (!shown(b)) return null;
    const children = kids(b.name).filter(shown);
    const lagging = (behindOf.get(b.name) ?? []).filter(shown);
    // Branches falling behind sit in their group, or in the section after the tree, not among the live ones.
    const live = children.filter((c) => !c.merged && !lagging.includes(c) && !behind.includes(c));
    const merged = children.filter((c) => c.merged);
    const hasKids = children.length > 0;
    const open = opened(b.name);
    const wipBelow = open ? 0 : live.reduce((n, c) => n + c.wip + hiddenWip(c), 0);
    const mergedKey = `merged:${b.name}`;
    const mergedOpen = opened(mergedKey);
    const cleaning = isCleaning(mergedKey);
    const version = b.role === "release" ? b.release : b.shipped;
    const mergedLabel = version ? `v${version}` : b.name;
    // Protected and checked-out branches stay put, and so do the ones only likely merged.
    const removable = merged.filter((c) => !c.protected && !c.checkedOut && !c.likelyMerged);
    const behindKey = `behind:${b.name}`;
    const behindOpen = opened(behindKey);
    const laggingRemovable = lagging.filter(cleanable);
    // Where the orange path leaves this branch: into a merged or lagging child, or past those groups to a live one.
    const pathLive = live.some((c) => path.has(c.name));
    const pathMerged = merged.some((c) => path.has(c.name));
    const pathBehind = lagging.some((c) => path.has(c.name));
    return (
      <div key={b.name} role="group" className="tree-node" data-path={past ? "past" : undefined}>
        <Row
          b={b}
          t={target(b.name)}
          isDefault={b.name === o.defaultBranch}
          tag={releaseTag(o.releases, b)}
          shipped={b.shipped ?? undefined}
          selected={b.name === selected}
          current={b.name === o.currentBranch}
          onPath={path.has(b.name)}
          hit={q}
          actions={actions}
          onSelect={() => onSelect(b.name)}
        />
        {hasKids && (
          // Merged children come first, then the show/hide toggle for the live ones; the nesting line starts below it.
          <div className="tree-sub">
            {merged.length > 0 && (
              <>
                <div className="tree-row tree-group tree-merged" data-path={pathMerged ? "in" : pathLive || pathBehind ? "past" : undefined}>
                  <button className="tree-merged-toggle" aria-expanded={mergedOpen} onClick={() => flip(mergedKey)}>
                    <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span>
                    <span className="group-label" data-active={pathMerged || undefined}>Merged into {mergedLabel}</span>
                    <span className="faint">{merged.length}</span>
                  </button>
                  {(removable.length > 0 || cleaning) && <CleanupButton left={cleanupLeft(mergedKey)} title={`Delete the ${removable.length} merged branch${removable.length === 1 ? "" : "es"} under ${mergedLabel}, locally and on origin`} onClick={() => onCleanup(b.name, mergedLabel, removable)} />}
                </div>
                {mergedOpen && (
                  <div className="tree-kids" data-path={pathMerged ? "in" : pathLive || pathBehind ? "past" : undefined} aria-busy={cleaning || undefined} inert={cleaning}>
                    {merged.map(pastPath(merged))}
                  </div>
                )}
              </>
            )}
            {lagging.length > 0 && (
              <>
                <div className="tree-row tree-group tree-merged tree-behind" data-path={pathBehind ? "in" : pathLive ? "past" : undefined}>
                  <button className="tree-merged-toggle" aria-expanded={behindOpen} title={`Branches ${BEHIND_LIMIT} or more commits behind ${mergedLabel}. Update or rebase them to catch up.`} onClick={() => flip(behindKey)}>
                    <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span>
                    <span className="group-label" data-active={pathBehind || undefined}>Falling behind {mergedLabel}</span>
                    <span className="faint">{lagging.length}</span>
                  </button>
                  {(laggingRemovable.length > 0 || isCleaning(behindKey)) && (
                    <CleanupButton left={cleanupLeft(behindKey)} title={`Pick which of the ${plural(laggingRemovable.length, "branch")} falling behind ${mergedLabel} to delete`} onClick={() => onCleanupBehind(behindKey, mergedLabel, laggingRemovable)} />
                  )}
                </div>
                {behindOpen && (
                  <div className="tree-kids" data-path={pathBehind ? "in" : pathLive ? "past" : undefined} aria-busy={isCleaning(behindKey) || undefined} inert={isCleaning(behindKey)}>
                    {lagging.map(pastPath(lagging))}
                  </div>
                )}
              </>
            )}
            {live.length > 0 && (
              <button className="tree-row tree-group tree-toggle" data-path={pathLive || undefined} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the child branches of ${b.name}`} onClick={() => flip(b.name)}>
                <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span>
                <span className="child-label" data-active={pathLive || undefined}>Child branches</span>
                <span className="faint">{live.length}</span>
                {wipBelow > 0 && <span className="wip-badge" title={`${plural(wipBelow, "file")} with uncommitted changes in hidden branches`}>(WIP {wipBelow})</span>}
              </button>
            )}
            {live.length > 0 && open && (
              <div className="tree-open">
                <div className="tree-kids">{live.map(pastPath(live))}</div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // One pulse runs the whole orange path at a steady pace: each piece is told how far down the path it starts (--pulse-off),
  // and draws the pulse where it falls inside it. The checked-out row also learns when the pulse reaches its middle (--pulse-arrive).
  // Rows mounted later (a group opened again, a branch checked out) would start their loops then, out of step with the rest,
  // so every loop is pinned to one start time instead, and they all run on one clock. When the path changes (a group opened
  // or closed), the clock moves so the pulse goes on from the same spot on the same piece, and the loop's length follows to keep the pace.
  const pane = useRef<HTMLElement>(null);
  const clock = useRef<PulseClock | null>(null);
  /** Where each piece sat along the path at the last sync, gaps included. */
  const layout = useRef(new Map<Element, PathPiece>());
  useLayoutEffect(() => {
    const root = pane.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      clearTimeout(timer);
      const pieces = [...root.querySelectorAll<HTMLElement>(PATH_PIECES)];
      const top = pieces[0]?.getBoundingClientRect().top ?? 0;
      let elbows = 0;
      const past = pieces.map((el) => el.matches(PATH_PAST));
      const laid = pieces.map((el, i) => {
        const r = el.getBoundingClientRect();
        // A run of dim pieces fades in from the bright path at its top and back out at its bottom; a lone one does both.
        if (past[i]) {
          const first = !past[i - 1];
          const last = !past[i + 1];
          const fade = `${Math.min(PAST_FADE, first && last ? r.height / 2 : r.height)}px`;
          el.style.setProperty("--dim-in", first ? fade : "0px");
          el.style.setProperty("--dim-out", last ? fade : "0px");
        }
        const off = r.top - top + elbows * ELBOW_LENGTH;
        // Where the piece's first dot falls, so they keep a 3px beat down the path; an elbow's end pixels are the lines' own, so it adds 6px.
        const dots = Math.round(r.top - top) + elbows * (ELBOW_LENGTH - 1);
        el.style.setProperty("--dot", `${(3 - (dots % 3)) % 3}px`);
        const elbow = el.matches(PATH_ELBOW);
        if (elbow) elbows++;
        return { el, off, len: elbow ? ELBOW_LENGTH : r.height, height: r.height };
      });

      // Where the pulse is now, carried over to the new layout.
      const now = Number(document.timeline.currentTime ?? 0);
      const prev = clock.current;
      const was = prev ? (((now - prev.start) % prev.loop) + prev.loop) % prev.loop / 1000 * PULSE_SPEED : 0;
      const kept = laid.flatMap((p) => {
        const old = layout.current.get(p.el);
        return old ? [{ ...p, old }] : [];
      });
      const { along, gap } = prev ? carryPulse(kept, was) : { along: 0, gap: null };

      let end = 0;
      const arrivals: [HTMLElement, number][] = [];
      const next = new Map<Element, PathPiece>();
      for (const p of laid) {
        const off = gap && p.off >= gap.at - 0.5 ? p.off + gap.len : p.off;
        p.el.style.setProperty("--pulse-off", `${off}px`);
        next.set(p.el, { off, len: p.len });
        end = Math.max(end, off + p.len);
        if (p.el.matches(".tree-row[data-current]")) arrivals.push([p.el, off + p.height / 2 + 6]);
      }
      if (gap) end = Math.max(end, gap.at + gap.len);
      layout.current = next;
      // Past the end of the path the pulse runs on out of sight until the loop starts over.
      const run = Math.max(PULSE_MIN_RUN, end + 12);
      const loop = (run / PULSE_SPEED) * 1000;
      // Already past the end of the new loop: the next one starts.
      const at = along < run ? along : 0;
      if (!prev) clock.current = { start: 0, loop };
      else if (prev.loop !== loop || Math.abs(at - was) > 0.5) clock.current = { start: now - (at / PULSE_SPEED) * 1000, loop };
      // Once the pulse is through the gap, sync again so the gap closes behind it.
      if (gap) timer = setTimeout(sync, ((gap.at + gap.len - at) / PULSE_SPEED) * 1000 + 50);
      const { start } = clock.current!;
      root.style.setProperty("--pulse-run", `${run}px`);
      root.style.setProperty("--pulse-loop", `${loop}ms`);
      for (const [el, at] of arrivals) el.style.setProperty("--pulse-arrive", `${(at / PULSE_SPEED) * 1000}ms`);
      // From the document: WebKit can leave the pseudo-elements' animations out of an element's subtree.
      for (const a of document.getAnimations()) {
        if (!(a instanceof CSSAnimation)) continue;
        const at = PULSE_ANIMATIONS.has(a.animationName) ? start : SHINE_ANIMATIONS.has(a.animationName) ? 0 : null;
        const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
        if (at !== null && a.startTime !== at && target && root.contains(target)) a.startTime = at;
      }
    };
    sync();
    // Rows change height as the pane is resized and their text wraps.
    const ro = new ResizeObserver(sync);
    ro.observe(root);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  });

  return (
    <section ref={pane} aria-label="Branches" className="ws-releases" data-pane data-active={active} aria-busy={building || undefined}>
      {building && (
        <div className="tree-building" role="status">
          <span className="spinner" />
          <span>Sorting branches…</span>
        </div>
      )}
      <div className="pane-head">
        <span className="row" style={{ gap: 6 }}>
          <span className="label">Branches</span>
          {updating && !building && (
            <span className="tree-updating faint" role="status">
              <span className="spinner" />
              {progress && progress.done < progress.total ? `Updating ${progress.done}/${progress.total} branches…` : "Updating…"}
            </span>
          )}
        </span>
        <span className="acts">
          {o.stashes.length > 0 && (
            <button className="act act-text" aria-label={`Show ${stashCount(o.stashes.length)}`} data-tip={`${stashCount(o.stashes.length)} set aside`} onClick={onStashes}>
              <Icon name="stash" size={14} />
              <span>{o.stashes.length}</span>
            </button>
          )}
          <button className="act act-main" aria-label="Fetch origin" data-tip="Fetch origin" disabled={fetchOrigin.isPending || !o.remote} onClick={() => fetchOrigin.mutate({ projectId: pid })}>
            {fetchOrigin.isPending ? <span className="spinner" /> : <Icon name="refresh" size={16} />}
          </button>
          <button className="act act-main act-text" onClick={onNewRelease}>
            <Icon name="plus" size={14} />
            <span>Release</span>
          </button>
        </span>
      </div>
      <div className="tree-filter">
        <Icon name="search" size={14} className="faint" />
        <input type="search" className="input" placeholder="Filter branches" aria-label="Filter branches" value={query} onChange={(e) => setQuery(e.target.value)} />
        <AuthorFilter authors={authors} who={who} onChange={setWho} tip="Show only the branches of these authors" />
      </div>
      <div className="scroll tree" style={{ flex: "1 1 auto" }}>
        {roots.map((b) => node(b, pastShipped))}
        {matches?.size === 0 && !shipped.some(shippedShown) && <Empty>{q ? <>No branch matches “{query}”{picked.length > 0 && " by them"}.</> : "No branch by them."}</Empty>}
        {behindShown.length > 0 && (
          <>
            <div className="tree-row tree-group tree-merged tree-behind" data-path={pastShipped ? "past" : undefined}>
              <button className="tree-merged-toggle" aria-expanded={opened("behind")} title={`Branches ${BEHIND_LIMIT} or more commits behind their base (${o.defaultBranch}, or a release with few of them). Update or rebase them to catch up.`} onClick={() => flip("behind")}>
                <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span>
                <span className="group-label" data-active={behindShown.some((b) => b.name === o.currentBranch) || undefined}>Branches falling behind</span>
                <span className="faint">{behindShown.length}</span>
              </button>
              {(behindRemovable.length > 0 || isCleaning("behind")) && (
                <CleanupButton left={cleanupLeft("behind")} title={`Pick which of the ${plural(behindRemovable.length, "branch")} falling behind to delete`} onClick={() => onCleanupBehind("behind", o.defaultBranch, behindRemovable)} />
              )}
            </div>
            {opened("behind") && (
              <div className="tree-node" data-path={pastShipped ? "past" : undefined} aria-busy={isCleaning("behind") || undefined} inert={isCleaning("behind")}>
                {behindShown.map((b) => (
                  <Row
                    key={`behind:${b.name}`}
                    b={b}
                    t={target(b.name)}
                    isDefault={false}
                    tag={releaseTag(o.releases, b)}
                    selected={b.name === selected}
                    current={b.name === o.currentBranch}
                    onPath={false}
                    hit={q}
                    actions={actions}
                    onSelect={() => onSelect(b.name)}
                  />
                ))}
              </div>
            )}
          </>
        )}
        {shipped.some(shippedShown) && (
          <>
            <div className="tree-sep" role="separator" data-path={shippedActive || undefined} />
            <div className="tree-row tree-group" data-path={shippedActive || undefined}>
              <button className="tree-merged-toggle" aria-expanded={opened("shipped")} onClick={() => flip("shipped")}>
                <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span>
                <span className="shipped-label" data-active={shippedActive || undefined}>Shipped</span>
                <span className="faint">{shipped.filter(shippedShown).length}</span>
              </button>
              {(shippedRemovable.length > 0 || isCleaning("shipped")) && (
                <CleanupButton left={cleanupLeft("shipped")} title={`Delete the ${shippedRemovable.length} shipped release branch${shippedRemovable.length === 1 ? "" : "es"}, locally and on origin. Their tags stay.`} onClick={() => onCleanupShipped(shippedRemovable)} />
              )}
            </div>
            {opened("shipped") && (
              <div className="tree-node" aria-busy={isCleaning("shipped") || undefined} inert={isCleaning("shipped")}>
                {shipped.map((r, i) => {
                  if (!shippedShown(r)) return null;
                  const b = shippedBranches.get(r.version);
                  if (b) return node(b, i < shippedOnPath);
                  const tag = r.tagName;
                  const checkout = tag ? tagItems(tag, r.checkedOut)[0] : undefined;
                  return (
                    <div
                      key={`${r.version}-${r.tag}`}
                      className="tree-row tree-static"
                      data-role="release"
                      data-current={r.checkedOut || undefined}
                      data-path={i < shippedOnPath ? "past" : r.checkedOut || undefined}
                      onContextMenu={tag ? (e) => openTagMenu(tag, r.checkedOut, e) : undefined}
                      onDoubleClick={checkout && checkout !== "sep" && !checkout.disabled ? checkout.run : undefined}
                    >
                      <span className="tree-btn">
                        <span className="tree-icon"><Icon name="tag" size={14} /></span>
                        <span className="tree-main">
                          <span className="tree-name"><span className="mono ellipsis">v{r.version}</span><span className={`tag${r.tag === "released" ? " released" : ""}`}>{releaseTagLabel(r.tag)}</span></span>
                          <span className="branch-meta">
                            <span className="mono">{r.base}</span>
                            {r.checkedOut && <span className="c-current">checked out</span>}
                            {r.note && <span>{r.note}</span>}
                          </span>
                        </span>
                      </span>
                      {tag && checkout && checkout !== "sep" && (
                        <span className="tree-acts">
                          <span className="acts" onDoubleClick={(e) => e.stopPropagation()}>
                            <button className="act act-main" disabled={checkout.disabled} aria-label={`Check out ${tag}`} data-tip={`Check out the commit ${tag} points at (detached HEAD)`} onClick={checkout.run}>
                              <Icon name="swap" size={16} />
                            </button>
                            <span className="act-stack">
                              <button className="act" aria-label={`More actions for ${tag}`} data-tip={`More actions for ${tag}`} aria-haspopup="menu" onClick={(e) => openTagMenu(tag, r.checkedOut, e)}>
                                <Icon name="more" size={14} />
                              </button>
                            </span>
                          </span>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
      {tagMenu && <ContextMenu x={tagMenu.x} y={tagMenu.y} alignRight={tagMenu.alignRight} label={`Actions for ${tagMenu.tag}`} items={tagItems(tagMenu.tag, tagMenu.checkedOut)} onClose={() => setTagMenu(null)} />}
    </section>
  );
}

type PathPiece = { off: number; len: number };
type PulseClock = { start: number; loop: number };

/**
 * Where the pulse goes on in a new layout of the path, `was` pixels down the old one: on the piece it was on (kept from both
 * layouts, in order, with where it sat before), as far into it. Out of a part that just closed (its pieces gone, or the bottom of a
 * piece that shrank), it goes on through a gap left where that part was, as long as the part, out of sight, and comes out below it.
 */
function carryPulse(kept: (PathPiece & { old: PathPiece })[], was: number): { along: number; gap: { at: number; len: number } | null } {
  let i = -1;
  while (i + 1 < kept.length && kept[i + 1].old.off <= was) i++;
  if (i < 0) return { along: was, gap: null };
  const a = kept[i];
  const b = kept[i + 1];
  const into = was - a.old.off;
  if (into <= a.len) return { along: a.off + into, gap: null };
  if (!b) {
    // Nothing kept below: past the end, with the closed part's length still to run before the loop starts over.
    const hidden = Math.min(into, a.old.len) - a.len;
    return { along: a.off + into, gap: hidden > 0.5 ? { at: a.off + a.len, len: hidden } : null };
  }
  // Between two kept pieces: the stretch between them was this long, and now is that long; the gap makes up the difference.
  const from = a.off + a.len;
  const len = b.old.off - (a.old.off + a.len) - (b.off - from);
  return { along: from + (was - a.old.off - a.len), gap: len > 0.5 ? { at: b.off, len } : null };
}

function releaseTag(releases: ReleaseView[], b: BranchView) {
  const r = b.role === "release" ? releases.find((x) => x.open && x.branch === b.name) : undefined;
  return r ? <span className={`tag${r.tag === "next" ? " accent" : ""}`}>{releaseTagLabel(r.tag)}</span> : null;
}

/** A section's "Clean up": a spinner while its cleanup runs in the background. */
function CleanupButton({ left, title, onClick }: { left: number | undefined; title: string; onClick: () => void }) {
  const busy = left !== undefined;
  return (
    <button className="act act-main tree-cleanup" aria-label={busy ? `Cleaning up, ${plural(left, "branch")} left` : "Clean up"} title={busy ? `Deleting branches… ${plural(left, "branch")} left` : title} disabled={busy} aria-busy={busy || undefined} onClick={onClick}>
      {busy ? (
        <>
          <span className="spinner" />
          <span className="tree-cleanup-left">{left}</span>
        </>
      ) : (
        <Icon name="brush" size={14} />
      )}
    </button>
  );
}

/** `name` with the search marked in it; all of it when the search only matches the full branch name or release. */
function marked(name: string, b: BranchView, hit?: string): ReactNode {
  if (!hit) return name;
  const i = name.toLowerCase().indexOf(hit);
  if (i >= 0) return <>{name.slice(0, i)}<mark className="tree-hit">{name.slice(i, i + hit.length)}</mark>{name.slice(i + hit.length)}</>;
  return b.name.toLowerCase().includes(hit) || (b.release ?? "").includes(hit) ? <mark className="tree-hit">{name}</mark> : name;
}

/** One branch, laid out the same whatever its role: icon, name + status line, actions. */
function Row({
  b,
  t,
  isDefault,
  tag,
  shipped,
  selected,
  current,
  onPath,
  hit,
  actions,
  onSelect,
}: {
  b: BranchView;
  t: BranchTarget;
  isDefault: boolean;
  tag: ReactNode;
  /** Version this (shipped) release branch went out as. */
  shipped?: string;
  selected: boolean;
  current: boolean;
  /** It is, or holds somewhere below it, the checked-out branch. */
  onPath: boolean;
  /** Search being typed: the part of the name it matches is highlighted. */
  hit?: string;
  actions: BranchActions;
  onSelect: () => void;
}) {
  const { icon, cls } = look(b, isDefault, !!shipped);
  const name = shipped ? `v${shipped}` : b.role === "release" && b.release ? `v${b.release}` : b.role === "branch" && b.kind ? b.short : b.name;
  return (
    <div
      className="tree-row"
      data-current={current || undefined}
      data-path={onPath || undefined}
      data-dim={b.merged || !b.exists || undefined}
      data-role={shipped ? "release" : b.role}
      onContextMenu={(e) => actions.openMenu(t, e)}
    >
      <button className="tree-btn" aria-pressed={selected} onClick={onSelect} onDoubleClick={() => b.exists && !b.checkedOut && actions.switchTo(b.name)}>
        <span className="tree-lead">
          <span className={`tree-icon ${cls}`}><Icon name={icon} size={14} /></span>
          <Avatar name={b.author} email={b.email} />
        </span>
        <span className="tree-main">
          <span className="tree-name">
            {b.role === "branch" && b.kind && <span className={`kind-chip ${b.kind === "fix" ? "c-del" : "c-mod"}`}>{b.kind}</span>}
            <span className="mono ellipsis">{marked(name, b, hit)}</span>
            {shipped ? <span className="tag released">{releaseTagLabel("released")}</span> : tag}
          </span>
          <BranchMeta b={b} parent={t.baseLabel} current={current} showName={!!shipped} onCommits={t.showCommits} onStashes={t.showStashes} />
        </span>
      </button>
      <span className="tree-acts">
        <BranchSplit t={t} actions={actions} />
      </span>
    </div>
  );
}

/** How long after a merge ends the commit animations it held back play, so they land once the dialog is gone and the tree has settled. */
const MERGE_SETTLE_MS = 450;

/**
 * Counts each time `value` grows past what was last seen (0 until then), so a key from it replays a CSS animation. Never fires on mount.
 * While `hold` is on, growth is kept back and counted once it turns off, after MERGE_SETTLE_MS.
 */
function useGrowth(value: number, hold: boolean): number {
  const last = useRef(value);
  const held = useRef(false);
  const [grew, setGrew] = useState(0);
  useEffect(() => {
    if (value > last.current) {
      // Still settling: the pending replay covers it too.
      if (hold || held.current) held.current = true;
      else setGrew((n) => n + 1);
    }
    last.current = value;
  }, [value, hold]);
  useEffect(() => {
    if (hold || !held.current) return;
    const id = setTimeout(() => {
      held.current = false;
      setGrew((n) => n + 1);
    }, MERGE_SETTLE_MS);
    return () => clearTimeout(id);
  }, [hold]);
  return grew;
}

/** Status line under a branch, same order for every role. */
function BranchMeta({
  b,
  parent,
  current,
  showName,
  onCommits,
  onStashes,
}: {
  b: BranchView;
  parent: string;
  current: boolean;
  showName?: boolean;
  onCommits?: () => void;
  onStashes?: () => void;
}) {
  const tracked = b.exists && !b.merged && !!parent;
  // A new commit landed: the commit link pops and glows. Ahead counts for a tracked branch, the tip's date for a trunk.
  // A merge refreshes the tree several times as it goes: the animation waits for it to finish.
  const merging = useIsMutating({ mutationKey: ["branches.merge"] }) > 0;
  const grew = useGrowth(parent ? b.ahead : Date.parse(b.date) || 0, merging);
  const growCls = grew > 0 ? " meta-link-grow" : "";
  const wip = b.wip > 0 && <span className="wip-badge" title={`${plural(b.wip, "file")} with uncommitted changes`}>WIP {b.wip}</span>;
  const conflict = b.conflict && <span className="c-del">conflict</span>;
  const nav = useNav();
  // Off a worktree, the agent works in the main checkout.
  const agent = useAgents((l) => l.find((a) => (b.worktree ? a.cwd === b.worktree : a.projectId === nav.projectId && a.branch === b.name))).data;
  // The state links to its row, selected, on the Worktrees & agents page: a worktree's goes by its path, an agent's elsewhere by its id.
  const row = b.worktree ?? agent?.id;
  const openRow = row ? (e: MouseEvent) => { e.stopPropagation(); nav.go({ name: "worktrees", key: row }); } : undefined;
  const state = b.running ? "working" : b.waiting ? (agent && shownStatus(agent, b) === "done" ? "done" : "waiting") : undefined;
  return (
    <span className="branch-meta">
      {b.likelyMerged && <span className="tag" title={`A pull request carrying its ticket went into ${parent} after its last commit. Not proof: it is never cleaned up as merged.`}>likely</span>}
      {b.local && !b.remote && <span className="tag local" title={`${b.name} doesn't exist on origin. Push it to share it.`}>local</span>}
      {b.remote && !b.local && <span className="tag accent" title={`${b.name} was never fetched into a local branch. Check it out to work on it locally.`}>origin</span>}
      {(b.role === "release" || showName) && <span className="mono">{b.name}</span>}
      {current && <span className="c-current">checked out</span>}
      {b.worktree ? (
        // Its checkout's state: the agent's status, icon in its color, or "worktree" with no agent working or waiting there.
        <span className={`row meta-link meta-link-icon${b.running ? " c-acc" : state ? " c-add" : ""}`} style={{ gap: 4 }} data-tip={`${b.worktree}. Click to open it in Worktrees & agents.`} onClick={openRow} onDoubleClick={(e) => e.stopPropagation()}>
          <Icon name="layers" size={11} stroke={1.4} />
          {state ? <span className="ai-fade">{state}</span> : "worktree"}
        </span>
      ) : b.running && (
        <span
          className={`row c-acc${openRow ? " meta-link meta-link-icon" : ""}`}
          style={{ gap: 4 }}
          data-tip={openRow && "Open its session in Worktrees & agents"}
          onClick={openRow}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <span className="pulse" style={{ width: 5, height: 5 }} />
          <span className="ai-fade">AI working</span>
        </span>
      )}
      {conflict}
      {wip}
      {!b.exists && <span className="c-del">branch deleted</span>}
      {b.merged && (
        <span className="pill c-add" title={`All its commits are in ${parent}`}>
          <Icon name="merged" size={10} stroke={1.6} />
          merged
        </span>
      )}
      {tracked && b.ahead > 0 && (
        // Inside the row's button, so a span: the context menu offers the same for keyboards.
        <span
          key={grew}
          className={`${onCommits ? "meta-link" : ""}${growCls}`.trim() || undefined}
          data-tip={`${plural(b.ahead, "commit")} not in ${parent} yet${onCommits ? ". Click to list them." : ""}`}
          onClick={onCommits && ((e) => { e.stopPropagation(); onCommits(); })}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {plural(b.ahead, "commit")}
        </span>
      )}
      {tracked && b.ahead === 0 && b.role === "branch" && <span>no commits yet</span>}
      {b.exists && !parent && onCommits && (
        // A trunk has no base to count against: offer its recent history instead.
        <span
          key={grew}
          className={`meta-link${growCls}`}
          data-tip={`Browse the recent commits of ${b.name}`}
          onClick={(e) => { e.stopPropagation(); onCommits(); }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          all commits
        </span>
      )}
      {b.stashes > 0 && (
        <span
          className={`row${onStashes ? " meta-link meta-link-icon" : ""}`}
          style={{ gap: 3 }}
          data-tip={`${stashCount(b.stashes)} made on ${b.name}${onStashes ? ". Click to list them." : ""}`}
          onClick={onStashes && ((e) => { e.stopPropagation(); onStashes(); })}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Icon name="stash" size={11} stroke={1.5} />
          {b.stashes}
        </span>
      )}
      {tracked && b.behind > 0 && (
        <span className="c-warn" title={`${parent} has ${plural(b.behind, "commit")} that ${b.name} doesn't. Update or rebase to catch up.`}>
          ↓{b.behind} from {parent}
        </span>
      )}
      {b.upstreamBehind > 0 && (
        <span className="tag local" title={`${plural(b.upstreamBehind, "commit")} on origin not in the local ${b.name}. Pull to catch up.`}>
          local ↓{b.upstreamBehind}
        </span>
      )}
      {b.upstreamAhead > 0 && (
        <span className="tag accent" title={`${plural(b.upstreamAhead, "local commit")} never pushed: origin is behind. Push to update it.`}>
          origin ↓{b.upstreamAhead}
        </span>
      )}
      {b.ticket && <span className="mono">{b.ticket}</span>}
    </span>
  );
}
